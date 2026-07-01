// Document extraction/write + Browser extension install/download routes.
// Extracted from server.js as a single bundle (low cross-coupling, both
// purely file-handling endpoints).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { buildShellEnv } from '../lib/shell-env.js';
import { faunaTmpFile } from '../lib/fauna-tmp.js';
import { renderOfficeToPdf, isOfficeRenderable } from '../lib/office-render.js';

const _require = createRequire(import.meta.url);
const { augmentedPath: _AUGMENTED_PATH } = buildShellEnv(process.platform === 'win32');
// execSync env that includes Homebrew + common Unix dirs so pdftotext,
// pandoc, textutil, etc. resolve even from inside the Electron bundle
// where the inherited PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.
const _EXEC_ENV = { ...process.env, PATH: _AUGMENTED_PATH };
function _tryExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', env: _EXEC_ENV, timeout: 15000, ...opts }).trim();
  } catch (_) {
    return '';
  }
}

function _stripXml(s) {
  return String(s)
    .replace(/<a:br\s*\/?>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function registerDocsAndExtRoutes(app, { faunaConfigDir, appDir }) {
  // ── Document extraction / write ─────────────────────────────────────────
  // POST { path } → extract text from a docx/doc/rtf/odt file
  app.post('/api/extract-document', async (req, res) => {
    const { path: docPath } = req.body || {};
    if (!docPath) return res.status(400).json({ error: 'path required' });
    const abs = path.isAbsolute(docPath) ? docPath : path.join(os.homedir(), docPath);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File not found' });
    const ext = path.extname(abs).toLowerCase().slice(1);
    try {
      let content = '';
      // Try pandoc first (most accurate for docx/odt)
      const pandocOut = path.join(os.tmpdir(), `fauna_doc_${Date.now()}.txt`);
      try {
        execSync(`pandoc -f ${ext === 'doc' ? 'doc' : 'docx'} -t plain -o ${JSON.stringify(pandocOut)} ${JSON.stringify(abs)} 2>/dev/null`, { timeout: 15000 });
        content = fs.readFileSync(pandocOut, 'utf8');
        try { fs.unlinkSync(pandocOut); } catch (_) {}
      } catch (_) {
        // Fallback: textutil (macOS only, supports doc/docx/rtf)
        try {
          const txtOut = abs.replace(/\.[^.]+$/, '') + '.txt';
          execSync(`textutil -convert txt -output ${JSON.stringify(txtOut)} ${JSON.stringify(abs)} 2>/dev/null`, { timeout: 15000 });
          if (fs.existsSync(txtOut)) { content = fs.readFileSync(txtOut, 'utf8'); try { fs.unlinkSync(txtOut); } catch (_) {} }
        } catch (_2) {
          // Last resort: strings
          try { content = execSync(`strings ${JSON.stringify(abs)} 2>/dev/null`, { encoding: 'utf8', timeout: 10000 }); } catch (_3) {}
        }
      }
      res.json({ ok: true, content, path: abs, editable: ['docx','odt'].includes(ext) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST { path, content } → write text content back to a document
  app.post('/api/write-document-text', async (req, res) => {
    const { path: docPath, content } = req.body || {};
    if (!docPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    const abs = path.isAbsolute(docPath) ? docPath : path.join(os.homedir(), docPath);
    try {
      // Stage the new content under ~/Documents/Fauna/tmp so a failed pandoc
      // conversion leaves a recoverable copy (vs. /var/folders which the OS
      // can purge at any time). See server/lib/fauna-tmp.js.
      const tmpTxt = faunaTmpFile('.txt', 'doc_in');
      fs.writeFileSync(tmpTxt, content, 'utf8');
      const ext = path.extname(abs).toLowerCase().slice(1);
      try {
        execSync(`pandoc -f plain -t ${ext === 'odt' ? 'odt' : 'docx'} -o ${JSON.stringify(abs)} ${JSON.stringify(tmpTxt)} 2>/dev/null`, { timeout: 15000 });
      } catch (_) {
        // Fallback: just write as .txt alongside (the path stays the same)
        fs.writeFileSync(abs, content, 'utf8');
      }
      // Intentionally keep tmpTxt — the janitor in server/lib/fauna-tmp.js
      // sweeps anything older than 30 days, but until then the user has a
      // plain-text recovery copy if pandoc mangled the docx output.
      res.json({ ok: true, path: abs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Deck (.pptx) text extraction / write via python-pptx ────────────────
  // There is no linkable renderer inside Microsoft PowerPoint.app (its engine
  // lives in the app's private, code-signed frameworks; the only bundled
  // plug-in is a Notification-Center widget, and PowerPoint ships no QuickLook
  // generator). So for lightweight, install-free in-pane editing we round-trip
  // the slide TEXT through python-pptx: extract per-shape text, let the user
  // edit it, write it back to the same shapes. No layout fidelity — full-
  // fidelity editing is "Open in PowerPoint".
  const _DECK_EXTRACT_PY = [
    'import sys, json',
    'try:',
    '    from pptx import Presentation',
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "error": "python-pptx not available: " + str(e)})); sys.exit(0)',
    'try:',
    '    prs = Presentation(sys.argv[1])',
    '    out = []; n = 0',
    '    for si, slide in enumerate(prs.slides, start=1):',
    '        n += 1',
    '        out.append("=== Slide %d ===" % si)',
    '        for shi, shape in enumerate(slide.shapes):',
    '            try:',
    '                if not shape.has_text_frame: continue',
    '            except Exception:',
    '                continue',
    '            out.append("[[S%d:%d]]" % (si, shi))',
    '            out.append(shape.text_frame.text)',
    '        try:',
    '            if slide.has_notes_slide:',
    '                notes = slide.notes_slide.notes_text_frame.text',
    '                if notes and notes.strip():',
    '                    out.append("[[N%d]]" % si); out.append(notes)',
    '        except Exception:',
    '            pass',
    '    print(json.dumps({"ok": True, "content": "\\n".join(out), "slideCount": n}))',
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "error": str(e)})); sys.exit(0)',
  ].join('\n');

  const _DECK_WRITE_PY = [
    'import sys, json, re',
    'try:',
    '    from pptx import Presentation',
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "error": "python-pptx not available: " + str(e)})); sys.exit(0)',
    'try:',
    '    p = sys.argv[1]',
    '    content = sys.stdin.read()',
    '    prs = Presentation(p)',
    '    slides = list(prs.slides)',
    '    blocks = []; cur = None; buf = []',
    '    def flush():',
    '        if cur is not None: blocks.append((cur, "\\n".join(buf)))',
    '    for line in content.split("\\n"):',
    '        m = re.match(r"^\\[\\[([SN]\\d+(?::\\d+)?)\\]\\]\\s*$", line)',
    '        if m:',
    '            flush(); cur = m.group(1); buf = []',
    '        elif re.match(r"^=== Slide \\d+ ===\\s*$", line):',
    '            continue',
    '        else:',
    '            if cur is not None: buf.append(line)',
    '    flush()',
    '    for key, text in blocks:',
    '        text = text.strip("\\n")',
    '        if key.startswith("S"):',
    '            s_str, sh_str = key[1:].split(":")',
    '            si = int(s_str) - 1; shi = int(sh_str)',
    '            if 0 <= si < len(slides):',
    '                shapes = list(slides[si].shapes)',
    '                if 0 <= shi < len(shapes) and shapes[shi].has_text_frame:',
    '                    tf = shapes[shi].text_frame',
    '                    paras = text.split("\\n")',
    '                    tf.text = paras[0] if paras else ""',
    '                    for extra in paras[1:]:',
    '                        para = tf.add_paragraph(); para.text = extra',
    '        elif key.startswith("N"):',
    '            si = int(key[1:]) - 1',
    '            if 0 <= si < len(slides):',
    '                slides[si].notes_slide.notes_text_frame.text = text',
    '    prs.save(p)',
    '    print(json.dumps({"ok": True}))',
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "error": str(e)})); sys.exit(0)',
  ].join('\n');

  // Async (non-blocking) python runner. Using spawnSync here would freeze the
  // whole Electron process (the server runs in-process), and the first
  // python-pptx import — which pulls in lxml/PIL — can take several seconds
  // cold, so a sync call reads as an app-wide "hang". spawn keeps the event
  // loop free so the UI spinner animates and other requests still resolve.
  function _runDeckPython(scriptSource, args, input) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('python3', ['-c', scriptSource, ...args], { env: _EXEC_ENV });
      } catch (error) {
        resolve({ error, stdout: '', stderr: '' });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const MAX_BUFFER = 32 * 1024 * 1024;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        finish({ error: new Error('python timed out'), stdout, stderr });
      }, 20000);
      child.stdout.on('data', (d) => {
        stdout += d;
        if (stdout.length > MAX_BUFFER) { try { child.kill('SIGKILL'); } catch (_) {} finish({ error: new Error('maxBuffer exceeded'), stdout, stderr }); }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (error) => finish({ error, stdout, stderr }));
      child.on('close', () => finish({ error: null, stdout, stderr }));
      if (input !== undefined) {
        try { child.stdin.write(input); } catch (_) {}
      }
      try { child.stdin.end(); } catch (_) {}
    });
  }

  function _resolveDeckAbs(deckPath) {
    return path.isAbsolute(deckPath) ? deckPath : path.join(os.homedir(), deckPath);
  }

  // POST { path } → { ok, content, path, slideCount, editable }
  app.post('/api/deck-extract', async (req, res) => {
    const { path: deckPath } = req.body || {};
    if (!deckPath) return res.status(400).json({ ok: false, error: 'path required' });
    const abs = _resolveDeckAbs(deckPath);
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'File not found' });
    if (path.extname(abs).toLowerCase() !== '.pptx') {
      return res.json({ ok: false, error: 'Only .pptx text editing is supported' });
    }
    const r = await _runDeckPython(_DECK_EXTRACT_PY, [abs]);
    if (r.error) return res.status(500).json({ ok: false, error: 'python3 not available: ' + r.error.message });
    let parsed = null;
    try { parsed = JSON.parse((r.stdout || '').trim()); } catch (_) {}
    if (!parsed) return res.status(500).json({ ok: false, error: (r.stderr || 'extract failed').slice(0, 400) });
    if (!parsed.ok) return res.json(parsed);
    res.json({ ok: true, content: parsed.content || '', path: abs, slideCount: parsed.slideCount || 0, editable: true });
  });

  // POST { path, content } → { ok, path }
  app.post('/api/deck-write', async (req, res) => {
    const { path: deckPath, content } = req.body || {};
    if (!deckPath || content === undefined) return res.status(400).json({ ok: false, error: 'path and content required' });
    const abs = _resolveDeckAbs(deckPath);
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'File not found' });
    if (path.extname(abs).toLowerCase() !== '.pptx') {
      return res.json({ ok: false, error: 'Only .pptx text editing is supported' });
    }
    const r = await _runDeckPython(_DECK_WRITE_PY, [abs], String(content));
    if (r.error) return res.status(500).json({ ok: false, error: 'python3 not available: ' + r.error.message });
    let parsed = null;
    try { parsed = JSON.parse((r.stdout || '').trim()); } catch (_) {}
    if (!parsed) return res.status(500).json({ ok: false, error: (r.stderr || 'write failed').slice(0, 400) });
    res.json(parsed.ok ? { ok: true, path: abs } : parsed);
  });

  // GET ?path=<file> → render any office document (docx/pptx/xlsx/…) to a
  // cached PDF via LibreOffice and stream it inline for the artifact pane's
  // PDF viewer. HEAD is used by the client to probe availability cheaply.
  app.head('/api/office-render', (req, res) => {
    const p = req.query.path;
    if (!p) return res.status(400).end();
    const abs = _resolveDeckAbs(String(p));
    if (!fs.existsSync(abs) || !isOfficeRenderable(abs)) return res.status(404).end();
    res.setHeader('Content-Type', 'application/pdf');
    res.status(200).end();
  });

  app.get('/api/office-render', async (req, res) => {
    const p = req.query.path;
    if (!p) return res.status(400).json({ ok: false, error: 'path required' });
    const abs = _resolveDeckAbs(String(p));
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'File not found' });
    if (!isOfficeRenderable(abs)) return res.status(415).json({ ok: false, error: 'unsupported format: ' + path.extname(abs) });
    try {
      const out = await renderOfficeToPdf({ srcPath: abs });
      if (!out.ok) {
        return res.status(out.needsInstall ? 501 : 500).json({ ok: false, error: out.error, needsInstall: !!out.needsInstall, hint: out.hint || null });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.sendFile(out.pdfPath);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  // POST { name, mime, base64 } → extract text from a base64-encoded attachment
  app.post('/api/extract-attachment', async (req, res) => {
    const { name = 'file', mime = 'application/octet-stream', base64 } = req.body || {};
    if (!base64) return res.status(400).json({ error: 'base64 required' });
    const ext  = (name.split('.').pop() || '').toLowerCase();
    let buf;
    try { buf = Buffer.from(base64, 'base64'); }
    catch (e) { return res.status(400).json({ error: 'invalid base64' }); }
    // Stage attachments under ~/Documents/Fauna/tmp so a failed extraction
    // leaves a recoverable copy. The janitor sweeps them after 30 days.
    const tmp  = faunaTmpFile('.' + (ext || 'bin'), 'attach');
    try {
      fs.writeFileSync(tmp, buf);
      let text = '';
      if (['pdf'].includes(ext)) {
        text = _tryExec(`pdftotext ${JSON.stringify(tmp)} -`);
        if (!text) {
          // mdimport-based fallback for sandboxed/no-poppler hosts.
          text = _tryExec(`mdls -name kMDItemTextContent -raw ${JSON.stringify(tmp)}`);
          if (text === '(null)') text = '';
        }
      } else if (['doc','docx','odt','rtf','pages'].includes(ext)) {
        text = _tryExec(`pandoc -t plain ${JSON.stringify(tmp)}`);
        if (!text) text = _tryExec(`textutil -convert txt -stdout ${JSON.stringify(tmp)}`, { timeout: 10000 });
        if (!text && ext === 'docx') {
          // unzip → word/document.xml → strip tags
          const xml = _tryExec(`unzip -p ${JSON.stringify(tmp)} word/document.xml`, { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
          if (xml) text = _stripXml(xml.replace(/<\/w:p>/g, '\n'));
        }
      } else if (['pptx','ppt','key','odp'].includes(ext)) {
        // unzip each slide xml and concatenate
        const entries = _tryExec(`unzip -Z1 ${JSON.stringify(tmp)}`, { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
        const slideRe = /^ppt\/slides\/slide\d+\.xml$/;
        const notesRe = /^ppt\/notesSlides\/notesSlide\d+\.xml$/;
        const slides = entries.split('\n').filter(l => slideRe.test(l))
          .sort((a, b) => parseInt(a.match(/slide(\d+)/)[1], 10) - parseInt(b.match(/slide(\d+)/)[1], 10));
        const parts = [];
        for (const s of slides) {
          const xml = _tryExec(`unzip -p ${JSON.stringify(tmp)} ${JSON.stringify(s)}`, { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
          const txt = _stripXml(xml);
          const n = s.match(/slide(\d+)/)[1];
          if (txt) parts.push(`# Slide ${n}\n${txt}`);
        }
        const notes = entries.split('\n').filter(l => notesRe.test(l));
        for (const n of notes) {
          const xml = _tryExec(`unzip -p ${JSON.stringify(tmp)} ${JSON.stringify(n)}`, { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
          const txt = _stripXml(xml);
          const idx = n.match(/notesSlide(\d+)/)[1];
          if (txt) parts.push(`## Slide ${idx} notes\n${txt}`);
        }
        text = parts.join('\n\n');
      } else if (['xlsx','xlsm','xlsb','ods'].includes(ext)) {
        // unzip xl/sharedStrings.xml + xl/worksheets/sheet*.xml; strip tags.
        const entries = _tryExec(`unzip -Z1 ${JSON.stringify(tmp)}`, { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
        const sharedXml = _tryExec(`unzip -p ${JSON.stringify(tmp)} xl/sharedStrings.xml`, { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
        const sharedStrings = [];
        if (sharedXml) {
          const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
          let m;
          while ((m = re.exec(sharedXml)) !== null) {
            sharedStrings.push(m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'"));
          }
        }
        const sheets = entries.split('\n').filter(l => /^xl\/worksheets\/sheet\d+\.xml$/.test(l))
          .sort((a, b) => parseInt(a.match(/sheet(\d+)/)[1], 10) - parseInt(b.match(/sheet(\d+)/)[1], 10));
        const parts = [];
        for (const s of sheets) {
          const xml = _tryExec(`unzip -p ${JSON.stringify(tmp)} ${JSON.stringify(s)}`, { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
          if (!xml) continue;
          // Parse rows
          const rows = [];
          const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
          let rm;
          while ((rm = rowRe.exec(xml)) !== null) {
            const cells = [];
            const cellRe = /<c[^>]*?(?:\st="([^"]+)")?[^>]*>([\s\S]*?)<\/c>/g;
            let cm;
            while ((cm = cellRe.exec(rm[1])) !== null) {
              const t = cm[1]; const inner = cm[2];
              const vMatch = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
              const isMatch = /<is[^>]*>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(inner);
              let val = '';
              if (isMatch) val = isMatch[1];
              else if (vMatch) {
                if (t === 's') {
                  const idx = parseInt(vMatch[1], 10);
                  if (!isNaN(idx) && sharedStrings[idx] !== undefined) val = sharedStrings[idx];
                } else val = vMatch[1];
              }
              cells.push(val);
            }
            if (cells.length) rows.push(cells.join('\t'));
          }
          const n = s.match(/sheet(\d+)/)[1];
          if (rows.length) parts.push(`# Sheet ${n}\n${rows.join('\n')}`);
        }
        text = parts.join('\n\n');
        if (!text) text = _tryExec(`strings ${JSON.stringify(tmp)} | head -500`, { timeout: 10000 });
      } else if (ext === 'csv' || ext === 'tsv') {
        text = buf.slice(0, 500000).toString('utf8');
      } else {
        // Generic: try as text
        text = buf.slice(0, 200000).toString('utf8');
      }
      // Never 500 for a missing converter — the renderer can still attach the
      // file as a binary blob. Just return empty text with a hint.
      res.json({
        ok: true,
        text: text || '',
        name,
        mime,
        ...(text ? {} : { note: `No text extracted (converter for .${ext} not installed or file unreadable).` }),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    // Intentionally do NOT unlink `tmp` — the janitor in server/lib/fauna-tmp.js
    // sweeps files older than 30 days. Keeping the staged attachment around
    // means a failed extraction is still recoverable from ~/Documents/Fauna/tmp.
  });

  // ── Browser extension install / download ────────────────────────────────
  const BROWSER_EXT_INSTALL_DIR = path.join(faunaConfigDir, 'browser-extension');
  const BROWSER_EXT_SRC_DIR     = path.join(appDir, 'browser-extension');

  function getBrowserExtSrcDir() {
    const packed = path.join(process.resourcesPath || '', 'browser-extension');
    if (fs.existsSync(packed)) return packed;
    return BROWSER_EXT_SRC_DIR;
  }

  app.get('/api/browser-ext/info', (req, res) => {
    const installed = fs.existsSync(path.join(BROWSER_EXT_INSTALL_DIR, 'manifest.json'));
    res.json({
      installed,
      installDir:  installed ? BROWSER_EXT_INSTALL_DIR : null,
      bundledDir:  getBrowserExtSrcDir(),
    });
  });

  app.post('/api/browser-ext/install', (req, res) => {
    try {
      const src = getBrowserExtSrcDir();
      if (!fs.existsSync(src)) return res.status(404).json({ error: 'Bundled extension not found' });
      fs.mkdirSync(BROWSER_EXT_INSTALL_DIR, { recursive: true });
      // Copy all files (shallow — no subdirectory icons handled separately)
      for (const file of fs.readdirSync(src)) {
        const s = path.join(src, file);
        const d = path.join(BROWSER_EXT_INSTALL_DIR, file);
        if (fs.statSync(s).isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          for (const sub of fs.readdirSync(s)) {
            fs.copyFileSync(path.join(s, sub), path.join(d, sub));
          }
        } else {
          fs.copyFileSync(s, d);
        }
      }
      res.json({ ok: true, installDir: BROWSER_EXT_INSTALL_DIR });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/browser-ext/download', async (req, res) => {
    try {
      const { dialog, BrowserWindow } = _require('electron');
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win || undefined, {
        title: 'Choose folder to save browser extension',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.cancelled || !result.filePaths || !result.filePaths.length) {
        return res.json({ ok: false, cancelled: true });
      }
      const dest = path.join(result.filePaths[0], 'fauna-browser-extension');
      const src  = getBrowserExtSrcDir();
      if (!fs.existsSync(src)) return res.status(404).json({ error: 'Bundled extension not found' });
      fs.mkdirSync(dest, { recursive: true });
      for (const file of fs.readdirSync(src)) {
        const s = path.join(src, file);
        const d = path.join(dest, file);
        if (fs.statSync(s).isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          for (const sub of fs.readdirSync(s)) fs.copyFileSync(path.join(s, sub), path.join(d, sub));
        } else {
          fs.copyFileSync(s, d);
        }
      }
      res.json({ ok: true, downloadDir: dest });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

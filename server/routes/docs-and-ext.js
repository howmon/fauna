// Document extraction/write + Browser extension install/download routes.
// Extracted from server.js as a single bundle (low cross-coupling, both
// purely file-handling endpoints).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { buildShellEnv } from '../lib/shell-env.js';
import { faunaTmpFile } from '../lib/fauna-tmp.js';

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
      } else if (['doc','docx','odt','rtf','pages'].includes(ext)) {
        text = _tryExec(`pandoc -t plain ${JSON.stringify(tmp)}`);
        if (!text) text = _tryExec(`textutil -convert txt -stdout ${JSON.stringify(tmp)}`, { timeout: 10000 });
      } else if (['xls','xlsx','csv'].includes(ext)) {
        text = _tryExec(`strings ${JSON.stringify(tmp)} | head -200`, { timeout: 10000 });
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

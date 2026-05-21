// Document extraction/write + Browser extension install/download routes.
// Extracted from server.js as a single bundle (low cross-coupling, both
// purely file-handling endpoints).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

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
      // Try pandoc to convert plain text back to docx format
      const tmpTxt = path.join(os.tmpdir(), `fauna_doc_in_${Date.now()}.txt`);
      fs.writeFileSync(tmpTxt, content, 'utf8');
      const ext = path.extname(abs).toLowerCase().slice(1);
      try {
        execSync(`pandoc -f plain -t ${ext === 'odt' ? 'odt' : 'docx'} -o ${JSON.stringify(abs)} ${JSON.stringify(tmpTxt)} 2>/dev/null`, { timeout: 15000 });
      } catch (_) {
        // Fallback: just write as .txt alongside (the path stays the same)
        fs.writeFileSync(abs, content, 'utf8');
      }
      try { fs.unlinkSync(tmpTxt); } catch (_) {}
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
    const buf  = Buffer.from(base64, 'base64');
    const tmp  = path.join(os.tmpdir(), `fauna_attach_${Date.now()}.${ext || 'bin'}`);
    try {
      fs.writeFileSync(tmp, buf);
      let text = '';
      if (['pdf'].includes(ext)) {
        text = execSync(`pdftotext ${JSON.stringify(tmp)} - 2>/dev/null`, { encoding: 'utf8', timeout: 15000 }).trim();
      } else if (['doc','docx','odt','rtf','pages'].includes(ext)) {
        try {
          text = execSync(`pandoc -t plain ${JSON.stringify(tmp)} 2>/dev/null`, { encoding: 'utf8', timeout: 15000 }).trim();
        } catch (_) {
          try { text = execSync(`textutil -convert txt -stdout ${JSON.stringify(tmp)} 2>/dev/null`, { encoding: 'utf8', timeout: 10000 }).trim(); } catch (_2) {}
        }
      } else if (['xls','xlsx','csv'].includes(ext)) {
        text = execSync(`strings ${JSON.stringify(tmp)} 2>/dev/null | head -200`, { encoding: 'utf8', timeout: 10000 }).trim();
      } else {
        // Generic: try as text
        text = buf.slice(0, 200000).toString('utf8');
      }
      res.json({ ok: true, text, name, mime });
    } catch (e) {
      res.status(500).json({ error: e.message });
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
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

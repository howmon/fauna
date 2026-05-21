// Markdown → PDF generation + YouTube thumbnail proxy.
//
// /api/markdown-to-pdf renders markdown via marked, then prints via Electron
// BrowserWindow (preferred) or playwright-core Chromium (fallback).
//
// /api/youtube-thumbnail proxies hqdefault thumbnails with a 1-day in-memory
// cache and a fallback SVG when the id is invalid/placeholder or upstream
// returns a non-image.

import fs from 'fs';
import path from 'path';
import { marked } from 'marked';

function _markdownToPdfHtml(markdown) {
  // Pre-process mermaid blocks so marked doesn't swallow them or truncate the document.
  // marked treats unclosed/unknown fences as raw code, causing everything after to not render.
  let mdClean = markdown;
  const mermaidSections = [];
  mdClean = mdClean.replace(/```mermaid\n([\s\S]*?)```/g, (_m, code) => {
    const i = mermaidSections.length;
    mermaidSections.push(code.trim());
    return `\`\`\`\nmermaid diagram (section ${i + 1})\n\`\`\``;
  });
  mdClean = mdClean.replace(/```mermaid\n([\s\S]*)$/, (_m, code) => {
    const i = mermaidSections.length;
    mermaidSections.push(code.trim());
    return `\`\`\`\nmermaid diagram (section ${i + 1})\n\`\`\``;
  });

  const htmlBody = marked(mdClean);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#1a1a1a;max-width:800px;margin:40px auto;padding:0 40px}
h1,h2,h3,h4{margin-top:1.4em;margin-bottom:.4em}h1{font-size:2em;border-bottom:2px solid #e0e0e0;padding-bottom:.3em}h2{font-size:1.5em;border-bottom:1px solid #e8e8e8;padding-bottom:.2em}
code{background:#f5f5f5;padding:2px 5px;border-radius:3px;font-size:.9em}
pre{background:#f5f5f5;padding:14px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f0f0f0}
blockquote{border-left:4px solid #ccc;margin:0;padding:0 1em;color:#666}
</style></head><body>${htmlBody}</body></html>`;
}

async function _writePdfWithElectron(_ElectronBrowserWindow, fullHtml, absPath, pageSize, landscape) {
  if (!_ElectronBrowserWindow) throw new Error('Electron BrowserWindow is not available');
  let win;
  try {
    win = new _ElectronBrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml));
    await new Promise(r => setTimeout(r, 200));
    const pdfBuffer = await win.webContents.printToPDF({
      pageSize,
      landscape,
      printBackground: true,
      margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 },
    });
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, pdfBuffer);
    return pdfBuffer.length;
  } finally {
    try { win && win.destroy(); } catch (_) {}
  }
}

async function _writePdfWithPlaywright(fullHtml, absPath, pageSize, landscape) {
  const pw = await import('playwright-core');
  const chromium = pw.chromium || pw.default?.chromium;
  if (!chromium) throw new Error('playwright-core loaded but chromium not found');
  const _EDGE_PATH   = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  const _CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const BROWSER_PATH = fs.existsSync(_EDGE_PATH) ? _EDGE_PATH : _CHROME_PATH;
  if (!fs.existsSync(BROWSER_PATH)) throw new Error('No supported Chrome/Edge executable found for PDF generation');
  const browser = await chromium.launch({
    executablePath: BROWSER_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: 'load' });
    await page.pdf({
      path: absPath,
      format: pageSize,
      landscape,
      printBackground: true,
      margin: { top: '0.4in', bottom: '0.4in', left: '0.5in', right: '0.5in' },
    });
    const stat = fs.statSync(absPath);
    return stat.size;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── YouTube thumbnail proxy ───────────────────────────────────────────────
const YOUTUBE_THUMB_FALLBACK_SVG = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <rect width="480" height="360" rx="28" fill="#f4f4f5"/>
  <rect x="176" y="130" width="128" height="100" rx="22" fill="#d4d4d8"/>
  <path d="M226 156l54 24-54 24z" fill="#71717a"/>
</svg>
`.trim());
const youtubeThumbnailCache = new Map();

function _isPlaceholderYouTubeId(id) {
  const raw = String(id || '').trim().toLowerCase();
  return !raw || /(^|[\/_=-])(placeholder|sample|example|dummy|todo|tbd)([\/?&#._-]|$)/.test(raw) ||
         /^0{6,}$/.test(raw) || raw === 'aaaaaaaaaaa' || raw === '-----------' || raw === '___________';
}

function _isValidYouTubeId(id) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(id || '')) && !_isPlaceholderYouTubeId(id);
}

function _sendYoutubeFallbackThumbnail(res) {
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).send(YOUTUBE_THUMB_FALLBACK_SVG);
}

export function registerMarkdownPdfAndYoutubeRoutes(app, { express, getElectronBrowserWindow }) {
  app.post('/api/markdown-to-pdf', express.json({ limit: '10mb' }), async (req, res) => {
    let { markdown, markdownPath, outputPath, pageSize = 'A4', landscape = false } = req.body || {};
    if (!markdown && markdownPath) {
      const absMarkdownPath = path.resolve(markdownPath);
      try { markdown = fs.readFileSync(absMarkdownPath, 'utf8'); }
      catch (err) { return res.status(400).json({ ok: false, error: 'failed to read markdownPath: ' + err.message }); }
    }
    if (!markdown) return res.status(400).json({ error: 'markdown is required' });
    if (!outputPath) return res.status(400).json({ error: 'outputPath is required' });
    const absPath = path.resolve(outputPath);
    const fullHtml = _markdownToPdfHtml(markdown);
    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      const _ElectronBrowserWindow = getElectronBrowserWindow();
      const bytes = _ElectronBrowserWindow
        ? await _writePdfWithElectron(_ElectronBrowserWindow, fullHtml, absPath, pageSize, landscape)
        : await _writePdfWithPlaywright(fullHtml, absPath, pageSize, landscape);
      if (!fs.existsSync(absPath) || fs.statSync(absPath).size <= 0) throw new Error('PDF file was not created');
      res.json({ ok: true, path: absPath, bytes });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/youtube-thumbnail', async (req, res) => {
    const id = String(req.query.id || '').trim();
    if (!_isValidYouTubeId(id)) return _sendYoutubeFallbackThumbnail(res);

    const cached = youtubeThumbnailCache.get(id);
    if (cached) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).send(cached.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const upstream = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Fauna/1.0 thumbnail-proxy' },
      });
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      if (!upstream.ok || !/^image\//i.test(contentType)) return _sendYoutubeFallbackThumbnail(res);
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length < 2048) return _sendYoutubeFallbackThumbnail(res);
      youtubeThumbnailCache.set(id, { contentType, body });
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).send(body);
    } catch (_) {
      return _sendYoutubeFallbackThumbnail(res);
    } finally {
      clearTimeout(timer);
    }
  });
}

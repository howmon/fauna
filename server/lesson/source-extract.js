// Extract plain text from a lesson source — local file (pptx/pdf/md/txt/html)
// or a remote URL. Used by fauna_lesson_create so the model can ground the
// generated lesson in actual slide content rather than the topic string alone.
//
// macOS-first; we shell out to bundled binaries rather than adding npm deps:
//   * pptx  → built-in `unzip` to read ppt/slides/slide*.xml, strip tags
//   * pdf   → mdls kMDItemTextContent (Spotlight extracts text on import)
//   * html  → tag-strip; if URL, fetch first
//   * md/txt→ readFileSync verbatim
//   * docx  → unzip word/document.xml, strip tags

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

const MAX_CHARS = 60000; // cap before we feed to LLM context

function _run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} exit ${code}: ${err.slice(-200)}`)));
  });
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

function _stripHtml(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function _extractPptx(file) {
  // List slide xml entries.
  const list = await _run('/usr/bin/unzip', ['-Z1', file]);
  const slides = list.split('\n').filter(l => /^ppt\/slides\/slide\d+\.xml$/.test(l))
    .sort((a, b) => {
      const ai = parseInt(a.match(/slide(\d+)/)[1], 10);
      const bi = parseInt(b.match(/slide(\d+)/)[1], 10);
      return ai - bi;
    });
  const parts = [];
  for (const s of slides) {
    try {
      const xml = await _run('/usr/bin/unzip', ['-p', file, s]);
      const text = _stripXml(xml);
      const n = s.match(/slide(\d+)/)[1];
      if (text) parts.push(`# Slide ${n}\n${text}`);
    } catch (_) {}
  }
  // Also pull speaker notes if present.
  const noteEntries = list.split('\n').filter(l => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(l));
  for (const n of noteEntries) {
    try {
      const xml = await _run('/usr/bin/unzip', ['-p', file, n]);
      const text = _stripXml(xml);
      const idx = n.match(/notesSlide(\d+)/)[1];
      if (text) parts.push(`## Slide ${idx} notes\n${text}`);
    } catch (_) {}
  }
  return parts.join('\n\n');
}

async function _extractDocx(file) {
  const xml = await _run('/usr/bin/unzip', ['-p', file, 'word/document.xml']);
  return _stripXml(xml.replace(/<\/w:p>/g, '\n'));
}

async function _extractPdf(file) {
  // Spotlight's mdimport produces text for most PDFs.
  try {
    const out = await _run('/usr/bin/mdls', ['-name', 'kMDItemTextContent', '-raw', file]);
    if (out && out.trim() && out.trim() !== '(null)') return out.trim();
  } catch (_) {}
  // Fallback: macOS bundles `pdftotext` only via Homebrew; try it if present.
  for (const bin of ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext']) {
    if (fs.existsSync(bin)) {
      try { return (await _run(bin, ['-layout', file, '-'])).trim(); } catch (_) {}
    }
  }
  throw new Error('PDF text extraction unavailable (install poppler `brew install poppler` for pdftotext, or pre-convert to .txt/.md)');
}

async function _extractUrl(url) {
  // Use Node fetch (Electron's Node 18+). Set a reasonable UA so most sites serve real content.
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 Fauna/2.0 (LessonExtract)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const body = await res.text();
  if (ct.includes('html') || /<html/i.test(body.slice(0, 4096))) return _stripHtml(body);
  if (ct.includes('json')) return body;
  return body;
}

/**
 * Resolve a source spec into plain text. `source` can be:
 *   - A URL (http(s)://…)
 *   - An absolute path or ~/relative path to a local file
 *   - Raw text (≥ 200 chars or contains no path separator) — returned as-is
 * Returns { ok, text, kind, source, truncated }.
 */
export async function extractSourceText(source, opts = {}) {
  if (!source) return { ok: false, error: 'source is empty' };
  const raw = String(source).trim();

  // Raw text path: looks like prose, not a path/URL.
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/') && !raw.startsWith('~') && raw.length > 200) {
    return _result(raw, 'raw', raw);
  }

  if (/^https?:\/\//i.test(raw)) {
    const text = await _extractUrl(raw);
    return _result(text, 'url', raw);
  }

  // Local file
  const file = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  if (!fs.existsSync(file)) throw new Error(`source file not found: ${file}`);
  const ext = path.extname(file).toLowerCase();
  let text;
  let kind = ext.replace('.', '') || 'file';
  switch (ext) {
    case '.pptx': text = await _extractPptx(file); break;
    case '.docx': text = await _extractDocx(file); break;
    case '.pdf':  text = await _extractPdf(file); break;
    case '.html': case '.htm': text = _stripHtml(fs.readFileSync(file, 'utf8')); break;
    case '.md': case '.markdown':
    case '.txt': case '.text': case '':
      text = fs.readFileSync(file, 'utf8'); break;
    default:
      // Try as utf-8 text; if it has lots of NUL bytes, give up.
      try {
        const buf = fs.readFileSync(file);
        if (buf.includes(0)) throw new Error('binary');
        text = buf.toString('utf8');
      } catch (_) {
        throw new Error(`unsupported source type: ${ext}`);
      }
  }

  // For deck-like sources, also rasterize each slide into a PNG that the
  // lesson widget can use as a verbatim backdrop. Failures are non-fatal —
  // the lesson still works in text-only mode.
  let slideImages = null;
  let rasterError = null;
  if (ext === '.pptx' || ext === '.ppt' || ext === '.key' || ext === '.odp') {
    try {
      const { rasterizePptx } = await import('./pptx-rasterize.js');
      const r = await rasterizePptx({
        pptxPath: file,
        userDataDir: opts.userDataDir,
        autoInstall: opts.autoInstall !== false, // default ON — first-run auto-install
        onProgress: opts.onProgress,
      });
      if (r.ok) {
        slideImages = r.slides.map(s => s.pngPath);
      } else {
        rasterError = r.error + (r.hint ? ' (install hint: ' + r.hint.cmd + ')' : '');
      }
    } catch (e) {
      rasterError = 'rasterize failed: ' + (e.message || String(e));
    }
  }

  return _result(text, kind, file, { slideImages, rasterError });
}

function _result(text, kind, source, extra) {
  let truncated = false;
  let out = String(text || '').trim();
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS);
    truncated = true;
  }
  const result = { ok: true, text: out, kind, source, truncated, length: out.length };
  if (extra && extra.slideImages && extra.slideImages.length) result.slideImages = extra.slideImages;
  if (extra && extra.rasterError) result.rasterError = extra.rasterError;
  return result;
}

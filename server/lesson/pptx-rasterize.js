// pptx → per-slide PNG rasterizer.
//
// Pipeline:
//   .pptx (or .ppt / .key / .odp)  ──soffice──▶  .pdf  ──pdf-to-img──▶  PNG[]
//
// We deliberately avoid native canvas / sharp dependencies — `pdf-to-img`
// uses pdfjs-dist internally with its own pure-JS rasterizer so this works
// on any platform where soffice is installed.
//
// Output format: { ok, slides: [{ index, pngPath, width, height }] }
// or { ok:false, error, hint? }.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveSoffice } from './soffice-runtime.js';

function _sha1Short(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}

/** Convert .pptx → .pdf via soffice. Returns absolute path to the .pdf. */
async function _pptxToPdf({ pptxPath, sofficeBin, outDir }) {
  await fsp.mkdir(outDir, { recursive: true });
  // soffice --headless --convert-to pdf <file> --outdir <dir>
  // Use a unique user-profile dir so concurrent invocations don't collide on
  // soffice's singleton lock (~/Library/Application Support/LibreOffice/4/user).
  const profileDir = path.join(outDir, '.soffice-profile');
  const userInstallUrl = 'file://' + profileDir;
  const args = [
    '--headless',
    '--nologo', '--nofirststartwizard', '--norestore',
    '-env:UserInstallation=' + userInstallUrl,
    '--convert-to', 'pdf:impress_pdf_Export',
    '--outdir', outDir,
    pptxPath,
  ];
  return new Promise((resolve, reject) => {
    const ch = spawn(sofficeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    ch.stdout.on('data', d => { stdout += d.toString(); });
    ch.stderr.on('data', d => { stderr += d.toString(); });
    const killTimer = setTimeout(() => { try { ch.kill('SIGKILL'); } catch (_) {} }, 120_000);
    ch.on('close', code => {
      clearTimeout(killTimer);
      if (code !== 0) return reject(new Error('soffice exited with code ' + code + ': ' + stderr.slice(0, 500)));
      // soffice writes <basename>.pdf into outDir
      const base = path.basename(pptxPath, path.extname(pptxPath));
      const pdfPath = path.join(outDir, base + '.pdf');
      if (!fs.existsSync(pdfPath)) return reject(new Error('soffice succeeded but PDF not found at ' + pdfPath + ' (stdout=' + stdout.slice(0, 200) + ')'));
      resolve(pdfPath);
    });
    ch.on('error', reject);
  });
}

/** Rasterize a PDF into one PNG per page using pdf-to-img. */
async function _pdfToPngs({ pdfPath, outDir, scale = 2.0 }) {
  // Dynamic import so this module loads even if pdf-to-img isn't installed
  // (callers should check with `hasPptxSupport()` first).
  const { pdf } = await import('pdf-to-img');
  await fsp.mkdir(outDir, { recursive: true });
  const document = await pdf(pdfPath, { scale });
  const slides = [];
  let i = 0;
  for await (const image of document) {
    i += 1;
    const pngPath = path.join(outDir, 'slide-' + String(i).padStart(3, '0') + '.png');
    await fsp.writeFile(pngPath, image);
    slides.push({ index: i, pngPath });
  }
  return slides;
}

/**
 * Full pipeline: pptx → array of PNG paths (one per slide).
 *
 * @param {object} opts
 * @param {string} opts.pptxPath        Absolute path to .pptx / .ppt / .key / .odp.
 * @param {string} [opts.cacheDir]      Base cache dir. Slides written to
 *                                      <cacheDir>/<sha1>/slide-NNN.png. Defaults to OS tmp.
 * @param {string} [opts.userDataDir]   Electron app.getPath('userData'); passed to soffice resolver.
 * @param {number} [opts.scale=2.0]     pdfjs render scale. 2.0 ≈ 1920px wide slide → good for 1280x720 canvas.
 * @returns {Promise<{ok:true, slides:Array<{index:number,pngPath:string}>, cacheDir:string, count:number}
 *                 | {ok:false, error:string, hint?:object}>}
 */
export async function rasterizePptx({ pptxPath, cacheDir, userDataDir, scale = 2.0 } = {}) {
  if (!pptxPath || !fs.existsSync(pptxPath)) {
    return { ok: false, error: 'pptxPath not found: ' + pptxPath };
  }

  const soffice = await resolveSoffice({ userDataDir });
  if (!soffice.ok) {
    return { ok: false, error: 'LibreOffice (soffice) not found — required to convert PowerPoint slides into images.', hint: soffice.hint };
  }

  // Cache key: hash of file path + mtime + size so re-uploads of the same
  // deck don't re-run the slow conversion.
  let stat;
  try { stat = fs.statSync(pptxPath); }
  catch (e) { return { ok: false, error: 'stat failed: ' + e.message }; }
  const key = _sha1Short(pptxPath + ':' + stat.size + ':' + Math.floor(stat.mtimeMs));
  const baseCache = cacheDir || path.join(os.tmpdir(), 'fauna-lesson-slides');
  const outDir = path.join(baseCache, key);

  // Cache hit?
  try {
    const existing = fs.readdirSync(outDir).filter(f => /^slide-\d+\.png$/.test(f)).sort();
    if (existing.length > 0) {
      return {
        ok: true,
        slides: existing.map((f, i) => ({ index: i + 1, pngPath: path.join(outDir, f) })),
        cacheDir: outDir,
        count: existing.length,
        cached: true,
      };
    }
  } catch (_) { /* outDir doesn't exist yet — proceed */ }

  try {
    const pdfPath = await _pptxToPdf({ pptxPath, sofficeBin: soffice.bin, outDir });
    const slides = await _pdfToPngs({ pdfPath, outDir, scale });
    // Best-effort cleanup of intermediate PDF and soffice profile dir
    try { fs.unlinkSync(pdfPath); } catch (_) {}
    try { fs.rmSync(path.join(outDir, '.soffice-profile'), { recursive: true, force: true }); } catch (_) {}
    return { ok: true, slides, cacheDir: outDir, count: slides.length, cached: false };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** Quick capability probe — used by lesson router & UI. */
export async function hasPptxSupport({ userDataDir } = {}) {
  const s = await resolveSoffice({ userDataDir });
  return s.ok;
}

export const SUPPORTED_EXTENSIONS = ['.pptx', '.ppt', '.key', '.odp'];

export function isPptxLike(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

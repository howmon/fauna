// Universal office → PDF renderer.
//
// LibreOffice (`soffice --headless --convert-to pdf`) opens ANY format it
// understands — docx, doc, odt, rtf, pptx, ppt, odp, xlsx, xls, ods, csv … —
// so a single code path gives a faithful VISUAL preview of any office
// document. The resulting PDF is displayed inline by the artifact pane's
// existing PDF viewer (an <iframe> on /api/preview-file), so no new renderer
// is needed on the client.
//
// This is render-only (one-way). Editing stays either text-level (docx /
// deck text round-trips) or "Open in the native app".
//
// Output PDFs are cached under <tmp>/fauna-office-pdf/<sha1>.pdf keyed by
// path + size + mtime so re-opening the same unchanged file is instant.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveSoffice, installHint } from '../lesson/soffice-runtime.js';

// Extensions LibreOffice can open and that we offer a visual PDF preview for.
const RENDERABLE = new Set([
  '.docx', '.doc', '.odt', '.rtf',
  '.pptx', '.ppt', '.odp', '.key',
  '.xlsx', '.xls', '.ods', '.csv',
]);

export function isOfficeRenderable(filePath) {
  if (!filePath) return false;
  return RENDERABLE.has(path.extname(filePath).toLowerCase());
}

function _sha1Short(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/** Convert an office file → PDF via soffice. Returns absolute path to the PDF. */
function _sofficeToPdf({ srcPath, sofficeBin, outDir }) {
  const profileDir = path.join(outDir, '.soffice-profile');
  const args = [
    '--headless',
    '--nologo', '--nofirststartwizard', '--norestore',
    '-env:UserInstallation=file://' + profileDir,
    '--convert-to', 'pdf',
    '--outdir', outDir,
    srcPath,
  ];
  return new Promise((resolve, reject) => {
    const ch = spawn(sofficeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    ch.stdout.on('data', d => { stdout += d.toString(); });
    ch.stderr.on('data', d => { stderr += d.toString(); });
    const killTimer = setTimeout(() => { try { ch.kill('SIGKILL'); } catch (_) {} }, 120_000);
    ch.on('close', code => {
      clearTimeout(killTimer);
      if (code !== 0) return reject(new Error('soffice exited ' + code + ': ' + stderr.slice(0, 400)));
      const base = path.basename(srcPath, path.extname(srcPath));
      const pdfPath = path.join(outDir, base + '.pdf');
      if (!fs.existsSync(pdfPath)) return reject(new Error('soffice produced no PDF (stdout=' + stdout.slice(0, 200) + ')'));
      resolve(pdfPath);
    });
    ch.on('error', reject);
  });
}

/**
 * Render an office document to a (cached) PDF.
 * @returns {Promise<{ok:true, pdfPath:string, cached:boolean}
 *                 | {ok:false, error:string, needsInstall?:boolean, hint?:object}>}
 */
export async function renderOfficeToPdf({ srcPath, userDataDir } = {}) {
  if (!srcPath || !fs.existsSync(srcPath)) {
    return { ok: false, error: 'file not found: ' + srcPath };
  }
  if (!isOfficeRenderable(srcPath)) {
    return { ok: false, error: 'unsupported format: ' + path.extname(srcPath) };
  }

  const soffice = await resolveSoffice({ userDataDir });
  if (!soffice.ok) {
    return { ok: false, error: 'LibreOffice (soffice) not installed — required to render office documents.', needsInstall: true, hint: soffice.hint || installHint() };
  }

  let stat;
  try { stat = fs.statSync(srcPath); }
  catch (e) { return { ok: false, error: 'stat failed: ' + e.message }; }

  const key = _sha1Short(srcPath + ':' + stat.size + ':' + Math.floor(stat.mtimeMs));
  const outDir = path.join(os.tmpdir(), 'fauna-office-pdf', key);
  const cachedPdf = path.join(outDir, 'render.pdf');

  if (fs.existsSync(cachedPdf) && fs.statSync(cachedPdf).size > 0) {
    return { ok: true, pdfPath: cachedPdf, cached: true };
  }

  try {
    await fsp.mkdir(outDir, { recursive: true });
    const producedPdf = await _sofficeToPdf({ srcPath, sofficeBin: soffice.bin, outDir });
    // Normalise to a stable filename so the cache lookup above is simple.
    if (producedPdf !== cachedPdf) {
      await fsp.rename(producedPdf, cachedPdf).catch(async () => {
        await fsp.copyFile(producedPdf, cachedPdf);
        try { await fsp.unlink(producedPdf); } catch (_) {}
      });
    }
    try { fs.rmSync(path.join(outDir, '.soffice-profile'), { recursive: true, force: true }); } catch (_) {}
    return { ok: true, pdfPath: cachedPdf, cached: false };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

export async function hasOfficeRenderSupport({ userDataDir } = {}) {
  const s = await resolveSoffice({ userDataDir });
  return s.ok;
}

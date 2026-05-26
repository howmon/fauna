// Fauna temp-file directory.
//
// We used to write transient working files (voice audio for whisper, pandoc
// input for document writes, base64 attachments for text extraction, etc.)
// into the OS temp dir (e.g. /var/folders/... on macOS). That folder is
// volatile — the OS or sandbox can purge it at any time — and on macOS the
// app isn't always granted access to it. When a temp file disappeared mid-
// workflow the user would see a "file not found" error and have no way to
// recover the source.
//
// Instead we now write all transient files under ~/Documents/Fauna/tmp,
// which the app already requests permission for. A periodic janitor sweeps
// anything older than 30 days so the folder doesn't grow unbounded but the
// user still has a ~month-long window to recover anything that went sideways.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_AGE_DAYS = 30;

function _docsFaunaRoot() {
  return process.env.FAUNA_DOCS || path.join(os.homedir(), 'Documents', 'Fauna');
}

/**
 * Returns ~/Documents/Fauna/tmp, creating it (and parents) if needed.
 * Falls back to os.tmpdir() only if the documents location is unwritable
 * (e.g. permission denied on a sandboxed system).
 */
export function getFaunaTmpDir() {
  const dir = path.join(_docsFaunaRoot(), 'tmp');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    // Last-resort fallback so callers never crash. The OS temp dir is
    // volatile but at least the operation can complete.
    return os.tmpdir();
  }
}

/**
 * Build a temp file path inside the Fauna tmp dir.
 * @param {string} suffix - e.g. ".wav", ".docx", ".pdf"
 * @param {string} [prefix="fauna"]
 */
export function faunaTmpFile(suffix = '', prefix = 'fauna') {
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 8);
  const name = `${prefix}_${ts}_${rnd}${suffix.startsWith('.') || !suffix ? suffix : '.' + suffix}`;
  return path.join(getFaunaTmpDir(), name);
}

/**
 * Remove any files in the Fauna tmp dir older than `maxAgeDays`.
 * Safe to call repeatedly; never throws.
 * Returns { scanned, removed, freedBytes }.
 */
export function cleanupOldFaunaTmp(maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  const result = { scanned: 0, removed: 0, freedBytes: 0 };
  let dir;
  try { dir = getFaunaTmpDir(); } catch (_) { return result; }
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return result; }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    result.scanned++;
    if (st.mtimeMs >= cutoff) continue;
    try {
      const size = st.isFile() ? st.size : 0;
      if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
      result.removed++;
      result.freedBytes += size;
    } catch (_) { /* ignore — file may be in use */ }
  }
  return result;
}

/**
 * Start a daily janitor that runs on boot and then every 24h.
 * Returns a stop() handle for tests.
 */
export function startFaunaTmpJanitor(maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  // Initial sweep on next tick so it doesn't block startup.
  setImmediate(() => {
    try { cleanupOldFaunaTmp(maxAgeDays); } catch (_) {}
  });
  const handle = setInterval(() => {
    try { cleanupOldFaunaTmp(maxAgeDays); } catch (_) {}
  }, 24 * 60 * 60 * 1000);
  if (typeof handle.unref === 'function') handle.unref();
  return { stop: () => clearInterval(handle) };
}

// server/lib/json-store.js
// Shared atomic JSON persistence used by heartbeat.js, workflow-manager.js,
// and task-manager.js. Centralises the temp-file + rename pattern that
// prevents corruption on crash mid-write (PR1.1 / PR2.1).

import fs from 'fs';
import path from 'path';

/**
 * Read a JSON file. Returns `fallback` (deep-copyable) if the file is missing
 * or unreadable. Never throws.
 * @template T
 * @param {string} filePath
 * @param {T} fallback
 * @returns {T}
 */
export function loadJson(filePath, fallback) {
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(txt);
  } catch (_) {
    // Return a fresh copy so callers can mutate without polluting fallback.
    try { return JSON.parse(JSON.stringify(fallback)); }
    catch (_) { return fallback; }
  }
}

/**
 * Write a JSON file atomically (temp file + rename), creating the parent
 * directory if needed. Throws on failure after cleaning up the temp file.
 *
 * @param {string} filePath
 * @param {unknown} data
 * @param {object} [opts]
 * @param {string} [opts.backupPath]  Optional secondary copy written after the
 *   primary rename succeeds. Used by task-manager.js.
 * @param {number} [opts.indent=2]    JSON.stringify indent.
 */
export function saveJsonAtomic(filePath, data, opts = {}) {
  const { backupPath, indent = 2 } = opts;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (backupPath) fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const body = JSON.stringify(data, null, indent);
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  if (backupPath) {
    // Backup is best-effort — do not fail the primary write if it errors.
    try { fs.writeFileSync(backupPath, body); } catch (_) {}
  }
}

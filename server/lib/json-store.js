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

// ── Revision-controlled variants (Gap 5 — optimistic concurrency) ────────
//
// Every document written via saveJsonWithRevision carries a hidden `_revision`
// counter. `loadJsonWithRevision` returns both the data and the current
// revision number. `saveJsonWithRevision` only commits when the revision
// matches the one the caller read — preventing silent last-write-wins
// races between two tabs, mobile + desktop, or concurrent task workers.
//
// The `_revision` key is stripped from data before returning to callers so
// application code never sees it.

/**
 * @template T
 * @param {string} filePath
 * @param {T} fallback
 * @returns {{ data: T, revision: number }}
 */
export function loadJsonWithRevision(filePath, fallback) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    raw = null;
  }
  if (raw === null || raw === undefined) {
    try { raw = JSON.parse(JSON.stringify(fallback)); } catch (_) { raw = fallback; }
    return { data: raw, revision: 0 };
  }
  const revision = typeof raw._revision === 'number' ? raw._revision : 0;
  const data = { ...raw };
  delete data._revision;
  return { data, revision };
}

/** Error thrown when a write attempt fails due to a concurrent modification. */
export class StoreConflictError extends Error {
  /** @param {string} filePath @param {number} expected @param {number} actual */
  constructor(filePath, expected, actual) {
    super(`StoreConflict: expected revision ${expected}, got ${actual} for ${filePath}`);
    this.name = 'StoreConflictError';
    this.code = 'STORE_CONFLICT';
    this.expected = expected;
    this.actual = actual;
    this.filePath = filePath;
  }
}

/**
 * Atomically write `data` only when the on-disk revision equals
 * `expectedRevision`. Throws StoreConflictError on mismatch.
 *
 * @param {string}  filePath
 * @param {unknown} data
 * @param {number}  expectedRevision  — from a prior loadJsonWithRevision call
 * @param {object}  [opts]            — forwarded to saveJsonAtomic
 * @returns {{ revision: number }}    — the new revision number
 */
export function saveJsonWithRevision(filePath, data, expectedRevision, opts = {}) {
  // Read the current on-disk revision inside the same sync call to minimise
  // the TOCTOU window (Node.js is single-threaded; this is race-free within
  // one process, and atomic rename prevents partial-write corruption across
  // processes).
  let currentRevision = 0;
  try {
    const cur = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (cur && typeof cur._revision === 'number') currentRevision = cur._revision;
  } catch (_) { /* file doesn't exist yet — revision 0 */ }

  if (currentRevision !== expectedRevision) {
    throw new StoreConflictError(filePath, expectedRevision, currentRevision);
  }

  const newRevision = currentRevision + 1;
  saveJsonAtomic(filePath, { ...data, _revision: newRevision }, opts);
  return { revision: newRevision };
}

// Reversible tool-output offload (headroom CCR idea).
//
// When compress-tool-output.js drops content from an oversized tool result,
// the dropped data is gone from the model's view — and a confused agent may
// re-run the command to get it back, wasting tokens. To make compression
// lossless-on-demand, we stash the FULL original to disk keyed by a short
// content hash and hand the model a retrieval pointer. If it actually needs
// the dropped rows it calls `fauna_retrieve_output(hash)`; otherwise the
// compressed view is all it ever pays for.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const CACHE_DIR = path.join(CONFIG_DIR, 'tool-cache');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // prune entries older than 7 days
const MAX_ENTRIES = 500;                    // hard cap on retained files

let _pruned = false;

function ensureDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) { /* best effort */ }
}

// Lazily prune stale/excess entries once per process.
function pruneOnce() {
  if (_pruned) return;
  _pruned = true;
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const now = Date.now();
    let files = fs.readdirSync(CACHE_DIR)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => {
        const full = path.join(CACHE_DIR, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
        return { full, mtime };
      });
    // Age-based prune.
    for (const f of files) {
      if (now - f.mtime > MAX_AGE_MS) {
        try { fs.unlinkSync(f.full); } catch (_) {}
        f.deleted = true;
      }
    }
    files = files.filter((f) => !f.deleted);
    // Count-based prune (oldest first).
    if (files.length > MAX_ENTRIES) {
      files.sort((a, b) => a.mtime - b.mtime);
      for (const f of files.slice(0, files.length - MAX_ENTRIES)) {
        try { fs.unlinkSync(f.full); } catch (_) {}
      }
    }
  } catch (_) { /* non-fatal */ }
}

/**
 * Stash the full original tool output. Returns a 12-char content hash that
 * `retrieveOutput` resolves, or null if persistence failed (caller should
 * then skip the retrieval marker).
 * @param {string} text
 * @returns {string|null}
 */
export function stashOutput(text) {
  if (typeof text !== 'string' || !text) return null;
  ensureDir();
  pruneOnce();
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  const file = path.join(CACHE_DIR, `${hash}.txt`);
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
    else { try { fs.utimesSync(file, new Date(), new Date()); } catch (_) {} } // touch for LRU
    return hash;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a previously stashed output by hash.
 * @param {string} hash
 * @returns {string|null}
 */
export function retrieveOutput(hash) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{6,64}$/i.test(hash)) return null;
  const file = path.join(CACHE_DIR, `${hash.slice(0, 12)}.txt`);
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

export const _internal = { CACHE_DIR };

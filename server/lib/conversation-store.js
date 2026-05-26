// Conversation storage abstraction.
//
// Provides a uniform { list, get, put, del } interface over two backends:
//
//   - `legacy`  : the original single-file layout (conversations.json).
//                 Always available. Default for existing installs so old
//                 binaries and downgrades keep working.
//   - `split`   : per-conversation file layout (conversations/<id>.json)
//                 plus a thin conversations/index.json. Constant-time per
//                 save, no full-file rewrites.
//
// Selection via env:
//   FAUNA_CONV_STORAGE=single      → legacy only        (default for existing installs)
//   FAUNA_CONV_STORAGE=split       → split + dual-write to legacy file as backup
//   FAUNA_CONV_STORAGE=split-only  → split only, no legacy writes
//
// Cross-cutting concerns implemented here (apply to both backends):
//   - Async writes via fs.promises (no event-loop stalls).
//   - Per-conversation Promise-chain mutex so concurrent PUTs don't lose data.
//   - Atomic writes via tmp + rename.
//   - Payload caps: rejects oversized bodies before they hit disk.

import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';

// ── Payload caps ──────────────────────────────────────────────────────────
// Caps are intentionally generous; they exist to keep a runaway client from
// blowing past Node's JSON.stringify limits or filling the disk. The renderer
// already trims aggressively in public/js/conversations.js.
export const MAX_CONVERSATION_BYTES   = 25 * 1024 * 1024; // 25 MB per conv
export const MAX_MESSAGE_BYTES        = 5  * 1024 * 1024; // 5  MB per message
export const MAX_TITLE_LEN            = 500;

export class PayloadTooLargeError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'PayloadTooLargeError';
    this.detail = detail;
  }
}

function _validate(conv) {
  if (!conv || typeof conv !== 'object') throw new PayloadTooLargeError('Invalid conversation object');
  if (typeof conv.title === 'string' && conv.title.length > MAX_TITLE_LEN) {
    conv.title = conv.title.slice(0, MAX_TITLE_LEN);
  }
  if (Array.isArray(conv.messages)) {
    for (let i = 0; i < conv.messages.length; i++) {
      const m = conv.messages[i];
      if (m && typeof m.content === 'string' && m.content.length > MAX_MESSAGE_BYTES) {
        throw new PayloadTooLargeError(
          `Message #${i} content exceeds ${MAX_MESSAGE_BYTES} bytes`,
          { index: i, length: m.content.length, cap: MAX_MESSAGE_BYTES }
        );
      }
    }
  }
  // Quick rough size guard via JSON.stringify length — Node strings are
  // UTF-16 internally, so byte length is at most 4× this. Multiplying by 2
  // gives a conservative upper bound.
  const approxBytes = JSON.stringify(conv).length * 2;
  if (approxBytes > MAX_CONVERSATION_BYTES) {
    throw new PayloadTooLargeError(
      `Conversation body exceeds ~${MAX_CONVERSATION_BYTES} bytes`,
      { approxBytes, cap: MAX_CONVERSATION_BYTES }
    );
  }
}

// ── Per-id mutex ──────────────────────────────────────────────────────────
// Each id gets a tail Promise. New writes chain off the tail; the entry is
// pruned when no work is pending so the map can't leak.
function makeIdMutex() {
  const tails = new Map();
  return function runExclusive(id, fn) {
    const prev = tails.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    tails.set(id, next);
    // The cleanup chain's own promise is allowed to reject (because `next`
    // can reject and `finally` re-throws). Swallow it here so it doesn't
    // surface as an unhandled rejection — the caller still receives the
    // rejection via the returned `next`.
    next.finally(() => {
      if (tails.get(id) === next) tails.delete(id);
    }).catch(() => {});
    return next;
  };
}

// ── Atomic async write helper ─────────────────────────────────────────────
async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, filePath);
}

// ── Legacy backend (single conversations.json) ────────────────────────────
function createLegacyBackend({ configDir }) {
  const file = path.join(configDir, 'conversations.json');
  // A single mutex tail for the whole file — every mutation is global.
  const fileMutex = makeIdMutex();

  function _readAll() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (_) {
      return [];
    }
  }

  async function _writeAll(list) {
    await atomicWriteJson(file, Array.isArray(list) ? list : []);
  }

  return {
    name: 'legacy',
    async list({ full = false } = {}) {
      const all = _readAll().sort((a, b) =>
        (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      if (full) return all;
      return all.map(c => ({
        id: c.id, title: c.title, model: c.model, projectId: c.projectId,
        createdAt: c.createdAt, updatedAt: c.updatedAt,
        messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
      }));
    },
    async get(id) {
      return _readAll().find(c => c.id === id) || null;
    },
    async put(id, conv) {
      _validate(conv);
      return fileMutex('__file__', async () => {
        const all = _readAll();
        const idx = all.findIndex(c => c.id === id);
        const merged = idx >= 0 ? { ...all[idx], ...conv, id } : { ...conv, id };
        if (!merged.createdAt) merged.createdAt = Date.now();
        merged.updatedAt = conv.updatedAt || Date.now();
        if (idx >= 0) all[idx] = merged; else all.push(merged);
        await _writeAll(all);
        return merged;
      });
    },
    async del(id) {
      return fileMutex('__file__', async () => {
        const all = _readAll();
        const next = all.filter(c => c.id !== id);
        await _writeAll(next);
        return all.length - next.length;
      });
    },
  };
}

// ── Split backend (per-conversation files + index) ────────────────────────
function createSplitBackend({ configDir, legacyDualWrite = null }) {
  const dir = path.join(configDir, 'conversations');
  const indexFile = path.join(dir, 'index.json');
  const bodyDir = dir; // <id>.json siblings to index.json
  const idMutex = makeIdMutex();
  const indexMutex = makeIdMutex();

  function _bodyPath(id) {
    // Sanitize id to prevent path traversal. Conversation ids in this app
    // are alphanumeric + dashes, so anything else is treated as invalid.
    if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error('Invalid conversation id: ' + id);
    return path.join(bodyDir, `${id}.json`);
  }

  function _readIndex() {
    try {
      const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (Array.isArray(data)) return { schema: 0, conversations: data };
      return data && typeof data === 'object'
        ? { schema: data.schema || 1, conversations: Array.isArray(data.conversations) ? data.conversations : [] }
        : { schema: 1, conversations: [] };
    } catch (_) {
      return { schema: 1, conversations: [] };
    }
  }

  async function _writeIndex(idx) {
    await atomicWriteJson(indexFile, idx);
  }

  function _readBody(id) {
    try { return JSON.parse(fs.readFileSync(_bodyPath(id), 'utf8')); }
    catch (_) { return null; }
  }

  function _slim(conv) {
    return {
      id: conv.id,
      title: conv.title,
      model: conv.model,
      projectId: conv.projectId || null,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
    };
  }

  return {
    name: 'split',
    async list({ full = false } = {}) {
      const idx = _readIndex();
      const sorted = idx.conversations.slice().sort((a, b) =>
        (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      if (!full) return sorted;
      // full=true loads every body — rare path (export, debug, dual-write).
      return sorted.map(meta => _readBody(meta.id)).filter(Boolean);
    },
    async get(id) {
      return _readBody(id);
    },
    async put(id, conv) {
      _validate(conv);
      const merged = await idMutex(id, async () => {
        const existing = _readBody(id);
        const out = existing ? { ...existing, ...conv, id } : { ...conv, id };
        if (!out.createdAt) out.createdAt = Date.now();
        out.updatedAt = conv.updatedAt || Date.now();
        await atomicWriteJson(_bodyPath(id), out);
        return out;
      });
      await indexMutex('__index__', async () => {
        const idx = _readIndex();
        const i = idx.conversations.findIndex(c => c.id === id);
        const row = _slim(merged);
        if (i >= 0) idx.conversations[i] = row; else idx.conversations.push(row);
        idx.schema = 1;
        await _writeIndex(idx);
      });
      // Optional dual-write to the legacy single file so a downgraded
      // binary still sees current data. Off by default; enabled when
      // FAUNA_CONV_STORAGE=split (without -only).
      if (legacyDualWrite) {
        legacyDualWrite.put(id, merged).catch(() => {});
      }
      return merged;
    },
    async del(id) {
      const removed = await idMutex(id, async () => {
        try { await fsp.unlink(_bodyPath(id)); return 1; }
        catch (_) { return 0; }
      });
      await indexMutex('__index__', async () => {
        const idx = _readIndex();
        idx.conversations = idx.conversations.filter(c => c.id !== id);
        await _writeIndex(idx);
      });
      if (legacyDualWrite) {
        legacyDualWrite.del(id).catch(() => {});
      }
      return removed;
    },
  };
}

// ── Factory ───────────────────────────────────────────────────────────────
// mode falls through this precedence:
//   1. explicit `mode` argument
//   2. process.env.FAUNA_CONV_STORAGE
//   3. 'single' (no behavior change for existing installs)
export function createConversationStore({ configDir, mode } = {}) {
  const resolved = (mode || process.env.FAUNA_CONV_STORAGE || 'single').toLowerCase();
  if (resolved === 'split-only') {
    return createSplitBackend({ configDir, legacyDualWrite: null });
  }
  if (resolved === 'split') {
    const legacy = createLegacyBackend({ configDir });
    return createSplitBackend({ configDir, legacyDualWrite: legacy });
  }
  // Default and 'single' → legacy single-file behavior.
  return createLegacyBackend({ configDir });
}

// ── One-time migration: legacy → split ────────────────────────────────────
// Idempotent: if the split layout already exists and isn't empty, returns
// { ok: true, skipped: true }. Otherwise reads the legacy file, copies it
// to a timestamped backup, writes each conv to its own file, and builds the
// index. The legacy file is **left in place** untouched so a downgrade or
// rollback is trivial.
//
// Returns:
//   { ok, migrated, skipped, backupPath, errors: [] }
export async function migrateLegacyToSplit({ configDir, force = false } = {}) {
  const legacyFile = path.join(configDir, 'conversations.json');
  const splitDir = path.join(configDir, 'conversations');
  const indexFile = path.join(splitDir, 'index.json');

  const errors = [];
  let migrated = 0;

  // Idempotency check.
  if (!force) {
    try {
      const stat = await fsp.stat(indexFile);
      if (stat.size > 2) { // any non-empty index counts
        return { ok: true, skipped: true, reason: 'split layout already present', migrated: 0, errors };
      }
    } catch (_) { /* index doesn't exist yet — proceed */ }
  }

  // No legacy file → nothing to migrate; just create an empty index.
  let legacyData;
  try { legacyData = JSON.parse(await fsp.readFile(legacyFile, 'utf8')); }
  catch (_) { legacyData = []; }
  if (!Array.isArray(legacyData)) legacyData = [];

  await fsp.mkdir(splitDir, { recursive: true });

  // Backup the legacy file (only if it has content).
  let backupPath = null;
  if (legacyData.length) {
    backupPath = path.join(configDir, `conversations.json.legacy-${Date.now()}`);
    try { await fsp.copyFile(legacyFile, backupPath); }
    catch (e) { errors.push({ stage: 'backup', error: e.message }); }
  }

  const indexRows = [];
  for (const conv of legacyData) {
    if (!conv || typeof conv !== 'object' || typeof conv.id !== 'string') {
      errors.push({ stage: 'parse', id: conv?.id ?? '?', error: 'missing or invalid id' });
      continue;
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(conv.id)) {
      errors.push({ stage: 'sanitize', id: conv.id, error: 'invalid id characters' });
      continue;
    }
    try {
      const bodyPath = path.join(splitDir, `${conv.id}.json`);
      await atomicWriteJson(bodyPath, conv);
      indexRows.push({
        id: conv.id,
        title: conv.title || '',
        model: conv.model || null,
        projectId: conv.projectId || null,
        createdAt: conv.createdAt || Date.now(),
        updatedAt: conv.updatedAt || conv.createdAt || Date.now(),
        messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
      });
      migrated++;
    } catch (e) {
      errors.push({ stage: 'write-body', id: conv.id, error: e.message });
    }
  }

  try {
    await atomicWriteJson(indexFile, { schema: 1, conversations: indexRows });
  } catch (e) {
    errors.push({ stage: 'write-index', error: e.message });
    return { ok: false, migrated, errors, backupPath };
  }

  // Sanity check: every legacy conv should now have a body file.
  if (legacyData.length && migrated !== legacyData.length) {
    return { ok: errors.length === 0, migrated, errors, backupPath, partial: true };
  }
  return { ok: true, migrated, errors, backupPath };
}

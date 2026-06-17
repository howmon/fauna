// ── Sync Engine — cross-device sync of conversations, projects, etc. ───────
//
// Design (full plan in /memories/repo/sync-plan.md):
//
//   Local change      ──►  enqueue(ns, id, op)  ──►  journal.jsonl
//                                                       │
//                                                       ▼
//   pushLoop()  ──►  PUT /api/sync/objects/{ns}/{id}    │
//                    (If-Match for LWW; 409 → merge)    │
//                                                       ▼
//   pullLoop()  ──►  GET /api/sync/changes?since=…  ──► applyRemote(change)
//
// Concepts:
//   * Namespace = logical bucket ('conversation', 'project', …). The engine
//     is namespace-agnostic; each consumer registers an adapter that knows
//     how to load/save/serialize/merge its rows.
//   * HLC (hybrid logical clock) provides per-write monotonic versions so
//     last-writer-wins is well-defined even when two devices race.
//   * Journal is an append-only JSONL of unflushed work. Crash-safe: if the
//     app dies mid-push, the next launch resumes from the file.
//
// What the engine does NOT do:
//   * It does not parse the payload schema. Adapters handle that.
//   * It does not authenticate. agentstore-client.js owns the bearer.
//   * It does not initiate the first user login. The UI does, then calls
//     `start()`.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { EventEmitter } from 'events';

import * as agentstore from './agentstore-client.js';

// ── Config ────────────────────────────────────────────────────────────────
const DEFAULT_PULL_INTERVAL_MS = 30_000;
const DEFAULT_PUSH_DEBOUNCE_MS = 750;
const MAX_PUSH_BATCH = 50;

function _syncDir() {
  return process.env.FAUNA_SYNC_DIR ||
    path.join(os.homedir(), '.config', 'fauna', 'sync');
}
function _hlcFile() { return path.join(_syncDir(), 'hlc.json'); }
function _journalFile() { return path.join(_syncDir(), 'journal.jsonl'); }
function _cursorFile() { return path.join(_syncDir(), 'cursors.json'); }
function _nodeIdFile() { return path.join(_syncDir(), 'node-id.txt'); }

// ── Hybrid Logical Clock ───────────────────────────────────────────────────
//
// HLC tick is packed into a single integer that fits inside JS's safe-int
// range (2^53) so it round-trips through JSON cleanly while still slotting
// into the server's `client_version` bigint column:
//
//   tick = (wallMs - HLC_EPOCH) * 65536 + counter
//
// We subtract an epoch (2025-01-01) before shifting because the raw Date.now()
// value (~1.7e12 in 2026) would overflow 2^53 once multiplied by 65536. After
// the epoch shift the multiplicand is ~5e10 in 2026, giving us:
//
//   max tick ≈ (years_since_epoch * 3.15e10) * 65536
//
// which stays under Number.MAX_SAFE_INTEGER (9e15) for ~430 years.
//
// Monotonic guarantee: if the wall clock goes backwards (NTP adjust), we
// keep using the last observed ms and just bump the counter. Counter
// overflow at 65k ticks in the same ms advances to the next ms.
const HLC_EPOCH = Date.UTC(2025, 0, 1); // 1735689600000
const HLC_COUNTER_BITS = 16;
const HLC_COUNTER_MAX = (1 << HLC_COUNTER_BITS) - 1; // 65535
const HLC_COUNTER_MULT = 1 << HLC_COUNTER_BITS;      // 65536
let _hlc = null;
let _hlcLoaded = false;

function _loadHlc() {
  if (_hlcLoaded) return _hlc;
  try {
    _hlc = JSON.parse(fs.readFileSync(_hlcFile(), 'utf8'));
  } catch (_) {
    _hlc = { wallMs: Date.now(), counter: 0 };
  }
  if (!_hlc || typeof _hlc.wallMs !== 'number') {
    _hlc = { wallMs: Date.now(), counter: 0 };
  }
  _hlcLoaded = true;
  return _hlc;
}

async function _saveHlc() {
  await fsp.mkdir(_syncDir(), { recursive: true });
  const tmp = _hlcFile() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(_hlc));
  await fsp.rename(tmp, _hlcFile());
}

// Sync variant — used inside tick() so a crash between tick and the next
// flush can't repeat HLC values. Matches the journal's sync-append pattern.
function _saveHlcSync() {
  try {
    fs.mkdirSync(_syncDir(), { recursive: true });
    fs.writeFileSync(_hlcFile(), JSON.stringify(_hlc));
  } catch (_) { /* best effort — next tick will retry */ }
}

/** Returns the next HLC tick as a uint64-as-Number. Safe up to 2^53. */
export function tick() {
  _loadHlc();
  const now = Date.now();
  if (now > _hlc.wallMs) {
    _hlc.wallMs = now;
    _hlc.counter = 0;
  } else {
    _hlc.counter += 1;
    if (_hlc.counter >= HLC_COUNTER_MAX) {
      _hlc.wallMs += 1;
      _hlc.counter = 0;
    }
  }
  // Persist synchronously so a crash before the next event-loop tick
  // can't repeat an HLC value on the next launch. Cheap (~1 KB file).
  _saveHlcSync();
  // Epoch-shift the wallMs before packing so the multiplied value fits
  // inside Number.MAX_SAFE_INTEGER. See the HLC comment block above for
  // the math.
  const shifted = _hlc.wallMs - HLC_EPOCH;
  return (shifted * HLC_COUNTER_MULT) + _hlc.counter;
}

function _nodeId() {
  try {
    return fs.readFileSync(_nodeIdFile(), 'utf8').trim();
  } catch (_) {
    const id = crypto.randomBytes(8).toString('hex');
    try {
      fs.mkdirSync(_syncDir(), { recursive: true });
      fs.writeFileSync(_nodeIdFile(), id);
    } catch (_) { /* tolerate readonly env */ }
    return id;
  }
}

// ── Cursors (per-namespace delta-pull marker) ─────────────────────────────
let _cursors = null;
function _loadCursors() {
  if (_cursors) return _cursors;
  try {
    _cursors = JSON.parse(fs.readFileSync(_cursorFile(), 'utf8'));
  } catch (_) {
    _cursors = {};
  }
  return _cursors;
}
async function _saveCursors() {
  await fsp.mkdir(_syncDir(), { recursive: true });
  const tmp = _cursorFile() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(_cursors));
  await fsp.rename(tmp, _cursorFile());
}

// ── Journal ────────────────────────────────────────────────────────────────
//
// Append-only JSONL. Each line is one pending push:
//   { ns, id, op, hlc, ts }      where op = 'upsert' | 'delete'
//
// On boot we read the entire file into memory and de-dupe (keep latest per
// ns/id). After a successful push pass we rewrite the file from the
// in-memory queue (only entries that haven't pushed yet remain).
class Journal {
  constructor() {
    this._pending = new Map();     // key=`${ns}:${id}` → entry
    this._loaded = false;
  }

  _key(ns, id) { return `${ns}:${id}`; }

  load() {
    if (this._loaded) return;
    try {
      const txt = fs.readFileSync(_journalFile(), 'utf8');
      for (const line of txt.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (entry && entry.ns && entry.id) {
            this._pending.set(this._key(entry.ns, entry.id), entry);
          }
        } catch (_) { /* skip corrupt line */ }
      }
    } catch (_) { /* no journal yet */ }
    this._loaded = true;
  }

  enqueue(ns, id, op) {
    this.load();
    const entry = { ns, id, op, hlc: tick(), ts: Date.now() };
    this._pending.set(this._key(ns, id), entry);
    // Append synchronously so a crash before the next flush still preserves
    // the work. Worst case we replay a no-op.
    try {
      fs.mkdirSync(_syncDir(), { recursive: true });
      fs.appendFileSync(_journalFile(), JSON.stringify(entry) + '\n');
    } catch (e) {
      // Don't let a journal write failure break the user's edit. We'll
      // catch up on the next push because the entry is still in memory.
      console.warn('[sync] journal append failed:', e?.message || e);
    }
  }

  drainBatch(limit = MAX_PUSH_BATCH) {
    this.load();
    return Array.from(this._pending.values()).slice(0, limit);
  }

  remove(ns, id, hlc) {
    const key = this._key(ns, id);
    const entry = this._pending.get(key);
    // Only remove if HLC matches — guards against losing a write that
    // happened DURING the push pass.
    if (entry && entry.hlc === hlc) {
      this._pending.delete(key);
    }
  }

  async rewriteFile() {
    await fsp.mkdir(_syncDir(), { recursive: true });
    const tmp = _journalFile() + '.tmp';
    const lines = Array.from(this._pending.values())
      .map(e => JSON.stringify(e))
      .join('\n');
    await fsp.writeFile(tmp, lines ? lines + '\n' : '');
    await fsp.rename(tmp, _journalFile());
  }

  size() {
    this.load();
    return this._pending.size;
  }
}

// ── Adapter registry ──────────────────────────────────────────────────────
//
// Each consumer registers an adapter:
//
//   registerAdapter('conversation', {
//     async load(id)               { return localStore.get(id); },
//     async save(id, obj, opts)    { await localStore.put(id, obj, opts); },
//     async delete(id, opts)       { await localStore.del(id, opts); },
//     serialize(obj)               { return pathPortability.serializeForWire(obj); },
//     deserialize(payload)         { return pathPortability.deserializeFromWire(payload); },
//     merge(local, remote)         { return remote; },   // optional — default LWW
//     async listAllIds()           { return [...]; },    // for first-time bootstrap
//   });
//
// Adapters can flag a `save` / `delete` call as coming from the sync
// engine by passing `{ fromSync: true }`. Local stores SHOULD pass that
// through into their own change-event emission so the engine doesn't
// re-enqueue the change in an infinite loop.
const _adapters = new Map();

export function registerAdapter(namespace, adapter) {
  if (!namespace || typeof namespace !== 'string') {
    throw new Error('registerAdapter: namespace required');
  }
  if (!adapter || typeof adapter.load !== 'function' || typeof adapter.save !== 'function') {
    throw new Error('registerAdapter: adapter must implement load() and save()');
  }
  _adapters.set(namespace, adapter);
}

export function getAdapter(ns) { return _adapters.get(ns); }

// ── Engine state ──────────────────────────────────────────────────────────
const emitter = new EventEmitter();
export const events = emitter;

const _journal = new Journal();

let _running = false;
let _pullTimer = null;
let _pushDebounce = null;
let _inFlightPush = false;
let _inFlightPull = false;

let _config = {
  pullIntervalMs: DEFAULT_PULL_INTERVAL_MS,
  pushDebounceMs: DEFAULT_PUSH_DEBOUNCE_MS,
};

// ── Public API ────────────────────────────────────────────────────────────

/** Returns true if a user is logged in and the engine has been started. */
export function isRunning() { return _running; }

/** Returns a snapshot of pending push queue + cursors, for debugging/UI. */
export function getStatus() {
  return {
    running: _running,
    loggedIn: agentstore.getSession().loggedIn,
    nodeId: _nodeId(),
    pendingPush: _journal.size(),
    cursors: { ..._loadCursors() },
    namespaces: Array.from(_adapters.keys()),
  };
}

/**
 * Mark a local change as needing push. Adapters call this from inside
 * their save/delete code paths.
 *
 *   syncEngine.enqueueChange('conversation', convId, 'upsert');
 *
 * No-op if the engine isn't running (so non-logged-in users don't write
 * to the journal at all).
 */
export function enqueueChange(ns, id, op) {
  if (!_running) return;
  if (!_adapters.has(ns)) return;
  _journal.enqueue(ns, id, op);
  emitter.emit('queued', { ns, id, op });
  _schedulePush();
}

/** Start the engine. Idempotent. */
export async function start(opts = {}) {
  if (_running) return getStatus();
  if (!agentstore.getSession().loggedIn) {
    throw new Error('sync-engine: cannot start, not logged in');
  }
  _config = { ..._config, ...opts };

  await fsp.mkdir(_syncDir(), { recursive: true });
  _journal.load();
  _loadCursors();
  _nodeId(); // ensure persisted

  _running = true;
  emitter.emit('start', getStatus());

  // Kick a pull immediately; subsequent pulls are scheduled by the loop.
  _scheduledPullLoop().catch(err => emitter.emit('error', err));

  // If we crashed mid-push last run there are still entries — drain them.
  if (_journal.size() > 0) _schedulePush();

  return getStatus();
}

/** Stop the engine. Pending journal entries persist for the next start. */
export async function stop() {
  if (!_running) return;
  _running = false;
  if (_pullTimer) { clearTimeout(_pullTimer); _pullTimer = null; }
  if (_pushDebounce) { clearTimeout(_pushDebounce); _pushDebounce = null; }
  emitter.emit('stop');
}

/** Force an immediate pull+push pass. Useful for "Sync Now" buttons. */
export async function syncNow() {
  if (!_running) throw new Error('sync-engine: not running');
  await Promise.all([_pullOnce(), _pushOnce()]);
  return getStatus();
}

// ── Internal: scheduling ──────────────────────────────────────────────────

function _schedulePush() {
  if (!_running) return;
  if (_pushDebounce) clearTimeout(_pushDebounce);
  _pushDebounce = setTimeout(() => {
    _pushDebounce = null;
    _pushOnce().catch(err => emitter.emit('error', err));
  }, _config.pushDebounceMs);
}

async function _scheduledPullLoop() {
  if (!_running) return;
  try {
    await _pullOnce();
  } catch (err) {
    emitter.emit('error', err);
  }
  if (!_running) return;
  _pullTimer = setTimeout(() => _scheduledPullLoop(), _config.pullIntervalMs);
}

// ── Internal: push ────────────────────────────────────────────────────────

async function _pushOnce() {
  if (!_running || _inFlightPush) return;
  if (_journal.size() === 0) return;
  _inFlightPush = true;
  emitter.emit('push:start');
  try {
    const batch = _journal.drainBatch();
    for (const entry of batch) {
      if (!_running) break;
      try {
        await _pushOne(entry);
        _journal.remove(entry.ns, entry.id, entry.hlc);
      } catch (err) {
        // Permanent (4xx other than 409): drop from journal so we don't
        // wedge the queue. Transient: leave in journal for next pass.
        if (err && err.status && err.status >= 400 && err.status < 500 && err.status !== 409) {
          emitter.emit('push:drop', { entry, error: err.message, status: err.status });
          _journal.remove(entry.ns, entry.id, entry.hlc);
        } else {
          emitter.emit('push:error', { entry, error: err.message });
          // Stop the batch on the first transient — backoff handled by the
          // pull loop's interval. The journal entry stays so we retry.
          break;
        }
      }
    }
    await _journal.rewriteFile();
  } finally {
    _inFlightPush = false;
    emitter.emit('push:end', { pending: _journal.size() });
  }
}

async function _pushOne(entry) {
  const adapter = _adapters.get(entry.ns);
  if (!adapter) return; // namespace de-registered between enqueue and push

  const objPath = `/api/sync/objects/${encodeURIComponent(entry.ns)}/${encodeURIComponent(entry.id)}`;

  if (entry.op === 'delete') {
    await agentstore.request('DELETE', objPath, null, {
      headers: { 'X-Client-Version': String(entry.hlc) },
    });
    return;
  }

  const local = await adapter.load(entry.id);
  if (local == null) {
    // Local row was deleted between enqueue and push — convert to delete.
    await agentstore.request('DELETE', objPath, null, {
      headers: { 'X-Client-Version': String(entry.hlc) },
    });
    return;
  }

  const serialized = adapter.serialize ? adapter.serialize(local) : local;
  const rawBody = JSON.stringify(serialized);
  // Get last-known server version, if we tracked one. Stored on the
  // adapter as `adapter._lastVersion` map for simplicity — adapters that
  // care about If-Match correctness should expose `getLastSeenVersion(id)`.
  const ifMatch = typeof adapter.getLastSeenVersion === 'function'
    ? adapter.getLastSeenVersion(entry.id)
    : null;
  const headers = { 'X-Client-Version': String(entry.hlc) };
  if (ifMatch != null) headers['If-Match'] = String(ifMatch);

  try {
    const res = await agentstore.requestRaw('PUT', objPath, rawBody, { headers });
    if (typeof adapter.setLastSeenVersion === 'function') {
      adapter.setLastSeenVersion(entry.id, res?.clientVersion ?? entry.hlc);
    }
  } catch (err) {
    if (err && err.status === 409) {
      // Conflict — pull-merge-retry. Single retry; if it conflicts again
      // we drop to the journal and the next pass will pick it up.
      const remote = err.body || {};
      const remoteDeserialized = adapter.deserialize
        ? adapter.deserialize(remote.serverPayload)
        : remote.serverPayload;

      // Pick the merge winner:
      //   * adapter.merge → caller-defined (e.g. message union)
      //   * remote HLC > local HLC → server wins (true LWW; drop local push)
      //   * else                    → local wins (re-push)
      let merged;
      let serverWon = false;
      if (adapter.merge) {
        merged = adapter.merge(local, remoteDeserialized);
      } else if (Number(remote.serverVersion || 0) > Number(entry.hlc)) {
        merged = remoteDeserialized;
        serverWon = true;
      } else {
        merged = local;
      }

      if (typeof adapter.setLastSeenVersion === 'function') {
        adapter.setLastSeenVersion(entry.id, remote.serverVersion);
      }

      // Always apply the merged state locally so the UI converges, then
      // decide whether to retry the push.
      await adapter.save(entry.id, merged, { fromSync: true });

      if (serverWon) {
        // Local change was older; nothing more to push. Drop the journal
        // entry by returning normally.
        emitter.emit('conflict:resolved', { ns: entry.ns, id: entry.id, winner: 'server' });
        return;
      }

      const rawRetry = JSON.stringify(adapter.serialize ? adapter.serialize(merged) : merged);
      const retryRes = await agentstore.requestRaw('PUT', objPath, rawRetry, {
        headers: { 'X-Client-Version': String(entry.hlc) },
      });
      if (typeof adapter.setLastSeenVersion === 'function') {
        adapter.setLastSeenVersion(entry.id, retryRes?.clientVersion ?? entry.hlc);
      }
      emitter.emit('conflict:resolved', { ns: entry.ns, id: entry.id, winner: 'local' });
    } else {
      throw err;
    }
  }
}

// ── Internal: pull ────────────────────────────────────────────────────────

async function _pullOnce() {
  if (!_running || _inFlightPull) return;
  _inFlightPull = true;
  emitter.emit('pull:start');
  try {
    for (const ns of _adapters.keys()) {
      if (!_running) break;
      await _pullNamespace(ns);
    }
  } finally {
    _inFlightPull = false;
    emitter.emit('pull:end');
  }
}

async function _pullNamespace(ns) {
  const adapter = _adapters.get(ns);
  if (!adapter) return;
  const cursors = _loadCursors();
  let cursor = cursors[ns] || null;
  let hasMore = true;
  let guard = 0;

  while (hasMore && _running && guard < 50) {
    guard++;
    const qs = new URLSearchParams({ ns });
    if (cursor) qs.set('since', cursor);
    let res;
    try {
      res = await agentstore.request('GET', `/api/sync/changes?${qs.toString()}`, null);
    } catch (err) {
      if (err && err.status === 401) {
        emitter.emit('auth:expired');
        await stop();
        return;
      }
      throw err;
    }
    const changes = Array.isArray(res?.changes) ? res.changes : [];
    for (const change of changes) {
      await _applyRemote(ns, adapter, change);
    }
    cursor = res?.nextCursor || cursor;
    if (cursor) {
      cursors[ns] = cursor;
      await _saveCursors().catch(() => {});
    }
    hasMore = !!res?.hasMore;
  }
}

async function _applyRemote(ns, adapter, change) {
  try {
    if (change.deleted) {
      if (typeof adapter.delete === 'function') {
        await adapter.delete(change.objectId, { fromSync: true });
      }
    } else {
      const payload = adapter.deserialize ? adapter.deserialize(change.payload) : change.payload;
      // If we have a merge function and a local copy, merge first.
      let next = payload;
      if (adapter.merge && typeof adapter.load === 'function') {
        const local = await adapter.load(change.objectId);
        if (local != null) next = adapter.merge(local, payload);
      }
      await adapter.save(change.objectId, next, { fromSync: true });
    }
    if (typeof adapter.setLastSeenVersion === 'function') {
      adapter.setLastSeenVersion(change.objectId, change.clientVersion);
    }
    emitter.emit('apply', { ns, id: change.objectId, deleted: !!change.deleted });
  } catch (err) {
    emitter.emit('apply:error', { ns, id: change.objectId, error: err.message });
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────
export function _resetForTests() {
  _hlc = null;
  _hlcLoaded = false;
  _cursors = null;
  _adapters.clear();
  _running = false;
  if (_pullTimer) { clearTimeout(_pullTimer); _pullTimer = null; }
  if (_pushDebounce) { clearTimeout(_pushDebounce); _pushDebounce = null; }
}

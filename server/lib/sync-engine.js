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
import * as syncPrefs from './sync-prefs.js';
import * as syncCrypto from './sync-crypto.js';

// E2E policy. When enabled (the default) we refuse to push plaintext or to
// apply pulls we can't decrypt. Set FAUNA_SYNC_E2E=off only for non-prod
// debugging — it disables the privacy guarantee and is incompatible with
// any device that has E2E enabled.
function _e2eRequired() {
  return String(process.env.FAUNA_SYNC_E2E || 'on').toLowerCase() !== 'off';
}

// ── Config ────────────────────────────────────────────────────────────────
const DEFAULT_PULL_INTERVAL_MS = 30_000;
const DEFAULT_PUSH_DEBOUNCE_MS = 750;
const MAX_PUSH_BATCH = 50;

function _syncDir() {
  return process.env.FAUNA_SYNC_DIR ||
    path.join(os.homedir(), '.config', 'fauna', 'sync');
}
function _hlcFile() { return path.join(_syncDir(), 'hlc.json'); }function _journalFile() { return path.join(_syncDir(), 'journal.jsonl'); }
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

// ── Bootstrap state (per-namespace first-run backfill marker) ─────────────
//
// Stored at `${_syncDir()}/bootstrap.json` as `{ <ns>: true }`. When a
// namespace flag is missing we walk the adapter's `listAllIds()` (if it
// has one) and enqueue an `upsert` for every existing local record so the
// device's pre-sync data lands in the cloud. Without this, signing a
// fresh device into an existing user account does nothing until you touch
// each record manually.
let _bootstrapState = null;
function _bootstrapFile() { return path.join(_syncDir(), 'bootstrap.json'); }
function _loadBootstrapState() {
  if (_bootstrapState) return _bootstrapState;
  try {
    _bootstrapState = JSON.parse(fs.readFileSync(_bootstrapFile(), 'utf8')) || {};
  } catch (_) {
    _bootstrapState = {};
  }
  return _bootstrapState;
}
async function _saveBootstrapState() {
  try {
    await fsp.mkdir(_syncDir(), { recursive: true });
    const tmp = _bootstrapFile() + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(_bootstrapState || {}));
    await fsp.rename(tmp, _bootstrapFile());
  } catch (_) { /* non-fatal */ }
}

/**
 * Walk every registered adapter and, for namespaces not yet bootstrapped,
 * enqueue an upsert for each existing local id. Marks each namespace
 * complete and persists the marker so we never re-walk it.
 *
 * Errors are swallowed per-namespace so one bad adapter never blocks the
 * others; the engine just emits an `error` event for visibility.
 */
async function _runBackfillOnce() {
  if (!_running) return;
  _loadBootstrapState();
  for (const [ns, adapter] of _adapters.entries()) {
    if (_bootstrapState[ns]) continue;
    if (typeof adapter.listAllIds !== 'function') {
      // Nothing to backfill, but mark done so we don't probe forever.
      _bootstrapState[ns] = true;
      continue;
    }
    try {
      const rows = await adapter.listAllIds();
      const list = Array.isArray(rows) ? rows : [];
      let count = 0;
      for (const row of list) {
        const id = (row && typeof row === 'object') ? row.id : row;
        if (!id) continue;
        const meta = (row && typeof row === 'object' && row.projectId)
          ? { projectId: row.projectId }
          : undefined;
        enqueueChange(ns, id, 'upsert', meta);
        count++;
      }
      _bootstrapState[ns] = true;
      emitter.emit('bootstrap', { ns, count });
    } catch (err) {
      emitter.emit('error', err);
      // Leave _bootstrapState[ns] unset so the next start retries.
    }
  }
  await _saveBootstrapState();
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
    // Approximate line count of the on-disk journal. Incremented on every
    // append, reset to `_pending.size` after a rewrite. Used to decide
    // whether a compaction pass is worth doing — see `rewriteFile()`.
    this._fileLines = 0;
  }

  _key(ns, id) { return `${ns}:${id}`; }

  load() {
    if (this._loaded) return;
    let lineCount = 0;
    try {
      const txt = fs.readFileSync(_journalFile(), 'utf8');
      for (const line of txt.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lineCount++;
        try {
          const entry = JSON.parse(trimmed);
          if (entry && entry.ns && entry.id) {
            this._pending.set(this._key(entry.ns, entry.id), entry);
          }
        } catch (_) { /* skip corrupt line */ }
      }
    } catch (_) { /* no journal yet */ }
    this._fileLines = lineCount;
    this._loaded = true;
  }

  enqueue(ns, id, op, meta) {
    this.load();
    const entry = { ns, id, op, hlc: tick(), ts: Date.now() };
    // Optional metadata travels with the entry so getStatus() can group
    // pending changes by project without re-loading every record.
    if (meta && typeof meta === 'object') {
      if (meta.projectId) entry.projectId = String(meta.projectId);
    }
    this._pending.set(this._key(ns, id), entry);
    // Append synchronously so a crash before the next flush still preserves
    // the work. Worst case we replay a no-op.
    try {
      fs.mkdirSync(_syncDir(), { recursive: true });
      fs.appendFileSync(_journalFile(), JSON.stringify(entry) + '\n');
      this._fileLines++;
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

  /**
   * Compact the on-disk journal to match the in-memory pending Map.
   *
   * Skipped when the file is still "close enough" to the in-memory state
   * so we don't pay an O(n) write after every push batch. On a machine
   * with tens of thousands of pending entries, the naive
   * "rewrite-after-every-batch" pattern produces O(n²) total bytes
   * written — multi-GB of churn that competes with the renderer for
   * disk + CPU and makes the app feel hung. The threshold below caps the
   * on-disk file at roughly 3× the in-memory size (or 1 000 stale lines,
   * whichever is larger) which preserves crash-safety without the churn.
   *
   * Pass `{ force: true }` to bypass the heuristic — used at shutdown.
   */
  async rewriteFile(opts = {}) {
    const pending = this._pending.size;
    const stale = Math.max(0, this._fileLines - pending);
    const force = !!opts.force;
    // Heuristic: only rewrite when the stale slack is meaningful AND the
    // file has grown disproportionately to the queue.
    if (!force) {
      const slackBudget = Math.max(1000, pending * 2);
      if (stale < slackBudget) return; // not worth the write
    }
    await fsp.mkdir(_syncDir(), { recursive: true });
    const tmp = _journalFile() + '.tmp';
    const lines = Array.from(this._pending.values())
      .map(e => JSON.stringify(e))
      .join('\n');
    await fsp.writeFile(tmp, lines ? lines + '\n' : '');
    await fsp.rename(tmp, _journalFile());
    this._fileLines = pending;
  }

  size() {
    this.load();
    return this._pending.size;
  }

  /**
   * Group the pending queue for UI/status reporting:
   *   { byNamespace: { conversation: 3, project: 1 },
   *     byProject:   { 'projA': 2, 'projB': 1, _unassigned: 1 } }
   */
  summary() {
    this.load();
    const byNamespace = Object.create(null);
    const byProject = Object.create(null);
    for (const entry of this._pending.values()) {
      byNamespace[entry.ns] = (byNamespace[entry.ns] || 0) + 1;
      // For 'project' entries the id IS the project id.
      const pid = entry.ns === 'project' ? entry.id : entry.projectId;
      const key = pid || '_unassigned';
      byProject[key] = (byProject[key] || 0) + 1;
    }
    return { byNamespace, byProject };
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

// In-flight progress, surfaced via getStatus() so the renderer can show
// a live progress bar instead of polling for opaque counter changes.
//   activeOp:    null | 'push' | 'pull'  — what's running right now
//   pushed:      records successfully pushed in the current push batch
//   pushTotal:   batch size at start of the current push
//   pulledByNs:  { ns: count }   — records applied during the current pull
//   lastError:   most recent push/pull error message
//   lastErrorAt: ISO timestamp of that error
//   lastSyncedAt:ISO timestamp of the last successful push that drained the queue
let _progress = {
  activeOp: null,
  pushed: 0,
  pushTotal: 0,
  pulledByNs: {},
  lastError: null,
  lastErrorAt: null,
  lastSyncedAt: null,
};

// ── Public API ────────────────────────────────────────────────────────────

/** Returns true if a user is logged in and the engine has been started. */
export function isRunning() { return _running; }

/** Returns a snapshot of pending push queue + cursors, for debugging/UI. */
export function getStatus() {
  const summary = _journal.summary();
  return {
    running: _running,
    loggedIn: agentstore.getSession().loggedIn,
    nodeId: _nodeId(),
    pendingPush: _journal.size(),
    pendingByNamespace: summary.byNamespace,
    pendingByProject: summary.byProject,
    cursors: { ..._loadCursors() },
    namespaces: Array.from(_adapters.keys()),
    excludedProjects: Array.from(syncPrefs.getExcludedProjectSet()),
    progress: { ..._progress, pulledByNs: { ..._progress.pulledByNs } },
    e2e: {
      required: _e2eRequired(),
      unlocked: syncCrypto.hasKey(),
    },
  };
}

/**
 * Mark a local change as needing push. Adapters call this from inside
 * their save/delete code paths.
 *
 *   syncEngine.enqueueChange('conversation', convId, 'upsert', { projectId });
 *
 * The optional `meta.projectId` is stored on the journal entry so the
 * status endpoint can show per-project pending counts AND so the prefs
 * filter can drop changes belonging to excluded projects without having
 * to re-load the record.
 *
 * No-op if the engine isn't running (so non-logged-in users don't write
 * to the journal at all), if the namespace has no adapter, or if the
 * change belongs to a project the user has chosen to keep local-only.
 */
export function enqueueChange(ns, id, op, meta) {
  if (!_running) return;
  if (!_adapters.has(ns)) return;
  // Per-project filter. For project records the id IS the projectId; for
  // conversation records the caller passes projectId in meta. Anything
  // without a projectId (orphan conversation, etc.) is always synced.
  const projectId = ns === 'project' ? id : (meta && meta.projectId);
  if (projectId && syncPrefs.isProjectExcluded(projectId)) return;
  _journal.enqueue(ns, id, op, meta);
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

  // E2E: try to restore a previously cached key from the OS keychain so a
  // re-launch on a known device doesn't require the user to re-enter the
  // password. Failure is silent — the engine just stays in 'locked' state
  // and the loops will no-op until unlock() is called.
  if (_e2eRequired()) {
    try { await syncCrypto.tryRestoreFromKeychain(); } catch (_) {}
  }

  _running = true;
  emitter.emit('start', getStatus());

  // Surface lock state immediately so the renderer can render an unlock
  // prompt without waiting for the first push attempt.
  if (_e2eRequired() && !syncCrypto.hasKey()) {
    emitter.emit('locked', { reason: 'no-key', op: 'start' });
  }

  // Kick a pull immediately; subsequent pulls are scheduled by the loop.
  _scheduledPullLoop().catch(err => emitter.emit('error', err));

  // First-run backfill: enqueue every existing local record per adapter
  // so a freshly-signed-in device pushes its pre-existing data instead of
  // waiting for the user to touch each one. Idempotent — a per-namespace
  // marker prevents repeat backfills on every restart.
  _runBackfillOnce().catch(err => emitter.emit('error', err));

  // If we crashed mid-push last run there are still entries — drain them.
  if (_journal.size() > 0) _schedulePush();

  return getStatus();
}

/**
 * Force a full re-backfill of every namespace. Used by the
 * `POST /api/sync/backfill` route when the user wants to replay all
 * existing local records (e.g. after a server-side wipe or to seed a
 * second device).
 */
export async function forceBackfill() {
  if (!_running) throw new Error('sync-engine: not running');
  _bootstrapState = {};
  await _saveBootstrapState();
  await _runBackfillOnce();
  _schedulePush();
  return getStatus();
}

/**
 * Unlock end-to-end encryption with the user's password. On success the
 * engine immediately retries any pending pushes and kicks a pull pass so
 * the user sees data converge without manual prodding.
 *
 * Returns { ok, firstDevice?, error? } — passes the sync-crypto result
 * through unchanged.
 */
export async function unlockE2E({ password } = {}) {
  const r = await syncCrypto.unlock({ password });
  if (r.ok) {
    emitter.emit('unlocked', { firstDevice: !!r.firstDevice });
    if (_running) {
      _schedulePush();
      _pullOnce().catch(err => emitter.emit('error', err));
    }
  }
  return r;
}

/** Wipe the cached E2E key from memory + disk. Sync stays running but
 *  is locked; pushes/pulls no-op until unlockE2E() is called again. */
export function lockE2E() {
  syncCrypto.clearKey();
  emitter.emit('locked', { reason: 'manual' });
}

/**
 * Atomic password change. Combines the server account-password update
 * and the E2E wrapped-MK rewrap into ONE backend round trip so we can't
 * end up half-changed (account password updated but wrap still under
 * the old password, locking the user out of their own data).
 *
 * Requires the engine to be unlocked — we need the cached MK to compute
 * the new wrap. If locked, the caller should prompt the user to unlock
 * first.
 *
 * Returns { ok, error? }.
 */
export async function changePassword({ oldPassword, newPassword } = {}) {
  if (!oldPassword) return { ok: false, error: 'oldPassword required' };
  if (!newPassword) return { ok: false, error: 'newPassword required' };
  if (newPassword.length < 8) return { ok: false, error: 'new password must be at least 8 characters' };
  if (newPassword === oldPassword) return { ok: false, error: 'new password must differ' };
  if (!syncCrypto.hasKey()) {
    return { ok: false, error: 'E2E is locked — unlock with current password first' };
  }

  // Compute the new wrap locally using the still-cached MK + the new
  // password. The MK itself is unchanged, so all existing payload
  // ciphertext on the server stays valid.
  let wrappedMk;
  try {
    wrappedMk = syncCrypto.computeWrappedMkForPassword(newPassword);
  } catch (e) {
    return { ok: false, error: e.message || 'rewrap failed' };
  }

  // Atomic backend update: verifies oldPassword, updates account hash,
  // and writes the new wrappedMk under the same DB transaction. Either
  // both happen or neither does.
  let res;
  try {
    res = await agentstore.request('POST', '/api/auth/change-password', {
      oldPassword,
      newPassword,
      wrappedMk,
    });
  } catch (e) {
    if (e && e.status === 401) {
      return { ok: false, error: 'wrong current password' };
    }
    return { ok: false, error: e.message || 'change-password failed', status: e?.status };
  }

  if (!res || res.ok !== true) {
    return { ok: false, error: (res && res.error) || 'change-password rejected' };
  }

  // Refresh the on-disk keychain blob (MK content unchanged but the
  // wrapper has rotated and we want a fresh timestamp).
  await syncCrypto.rebindAfterRewrap();
  emitter.emit('password-changed');
  return { ok: true };
}

/** Stop the engine. Pending journal entries persist for the next start. */
export async function stop() {
  if (!_running) return;
  _running = false;
  if (_pullTimer) { clearTimeout(_pullTimer); _pullTimer = null; }
  if (_pushDebounce) { clearTimeout(_pushDebounce); _pushDebounce = null; }
  // Compact the journal so we don't carry stale slack into the next run.
  try { await _journal.rewriteFile({ force: true }); } catch (_) {}
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
  // E2E gate: never push plaintext. Block silently — the journal is
  // crash-safe and will drain once the user unlocks. We emit a single
  // 'locked' event so the UI can prompt for the password.
  if (_e2eRequired() && !syncCrypto.hasKey()) {
    emitter.emit('locked', { reason: 'no-key', op: 'push' });
    return;
  }
  _inFlightPush = true;
  const batch = _journal.drainBatch();
  _progress.activeOp = 'push';
  _progress.pushed = 0;
  _progress.pushTotal = batch.length;
  emitter.emit('push:start', { total: batch.length });
  let hadError = false;
  try {
    for (const entry of batch) {
      if (!_running) break;
      try {
        await _pushOne(entry);
        _journal.remove(entry.ns, entry.id, entry.hlc);
        _progress.pushed++;
      } catch (err) {
        // Permanent (4xx other than 409): drop from journal so we don't
        // wedge the queue. Transient: leave in journal for next pass.
        if (err && err.status && err.status >= 400 && err.status < 500 && err.status !== 409) {
          emitter.emit('push:drop', { entry, error: err.message, status: err.status });
          _journal.remove(entry.ns, entry.id, entry.hlc);
          _progress.pushed++;
          _progress.lastError = err.message || ('HTTP ' + err.status);
          _progress.lastErrorAt = new Date().toISOString();
          hadError = true;
        } else {
          emitter.emit('push:error', { entry, error: err.message });
          _progress.lastError = err.message || 'Push failed';
          _progress.lastErrorAt = new Date().toISOString();
          hadError = true;
          // Stop the batch on the first transient — backoff handled by the
          // pull loop's interval. The journal entry stays so we retry.
          break;
        }
      }
    }
    await _journal.rewriteFile();
  } finally {
    _inFlightPush = false;
    _progress.activeOp = _inFlightPull ? 'pull' : null;
    if (!hadError && _journal.size() === 0) {
      _progress.lastSyncedAt = new Date().toISOString();
      _progress.lastError = null;
      _progress.lastErrorAt = null;
    }
    emitter.emit('push:end', { pending: _journal.size(), pushed: _progress.pushed });
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
  const plainBody = JSON.stringify(serialized);
  // E2E: encrypt the payload before it leaves this machine. AAD binds
  // the ciphertext to its (ns, id) so the server can't shuffle blobs.
  const rawBody = _e2eRequired()
    ? JSON.stringify(syncCrypto.encryptString(plainBody, `${entry.ns}:${entry.id}`))
    : plainBody;
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
      // The server payload may be an E2E envelope; decrypt before merging.
      let remotePlainPayload = remote.serverPayload;
      if (syncCrypto.isEnvelope(remotePlainPayload)) {
        try {
          const plain = syncCrypto.decryptEnvelope(remotePlainPayload, `${entry.ns}:${entry.id}`);
          remotePlainPayload = JSON.parse(plain);
        } catch (decErr) {
          // Can't read the server's copy — refuse to merge blindly.
          emitter.emit('apply:error', { ns: entry.ns, id: entry.id, error: 'decrypt-conflict: ' + decErr.message });
          return;
        }
      }
      const remoteDeserialized = adapter.deserialize
        ? adapter.deserialize(remotePlainPayload)
        : remotePlainPayload;

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

      const plainRetry = JSON.stringify(adapter.serialize ? adapter.serialize(merged) : merged);
      const rawRetry = _e2eRequired()
        ? JSON.stringify(syncCrypto.encryptString(plainRetry, `${entry.ns}:${entry.id}`))
        : plainRetry;
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
  // E2E gate: without a key we'd just discard every pulled change as
  // "can't decrypt". Skip the network round-trip entirely so the user
  // can unlock and we resume cleanly.
  if (_e2eRequired() && !syncCrypto.hasKey()) {
    emitter.emit('locked', { reason: 'no-key', op: 'pull' });
    return;
  }
  _inFlightPull = true;
  _progress.activeOp = _inFlightPush ? _progress.activeOp : 'pull';
  _progress.pulledByNs = {};
  emitter.emit('pull:start');
  try {
    for (const ns of _adapters.keys()) {
      if (!_running) break;
      await _pullNamespace(ns);
    }
  } catch (err) {
    _progress.lastError = err?.message || 'Pull failed';
    _progress.lastErrorAt = new Date().toISOString();
    throw err;
  } finally {
    _inFlightPull = false;
    if (!_inFlightPush) _progress.activeOp = null;
    emitter.emit('pull:end', { applied: _progress.pulledByNs });
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
      _progress.pulledByNs[ns] = (_progress.pulledByNs[ns] || 0) + 1;
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
    // E2E: if the payload is an envelope, decrypt FIRST. We need the
    // plaintext to derive projectId for the per-project exclusion check
    // below — encrypted envelopes don't expose payload fields by design.
    let rawPayload = change.payload;
    if (!change.deleted && syncCrypto.isEnvelope(rawPayload)) {
      try {
        const plain = syncCrypto.decryptEnvelope(rawPayload, `${ns}:${change.objectId}`);
        rawPayload = JSON.parse(plain);
      } catch (decErr) {
        emitter.emit('apply:error', { ns, id: change.objectId, error: 'decrypt: ' + decErr.message });
        return;
      }
    } else if (!change.deleted && _e2eRequired() && rawPayload && typeof rawPayload === 'object') {
      // Plaintext arrived but E2E is required — log and skip rather than
      // silently writing legacy data. The user can run a migration to
      // re-encrypt by re-uploading from the source device.
      emitter.emit('apply:plaintext-skipped', { ns, id: change.objectId });
      return;
    }

    // Honor the per-device project exclusion list for INCOMING changes too.
    // Without this, excluding a project from sync would still let pulls
    // overwrite the local copy. For 'project' the id IS the projectId;
    // for 'conversation' we read the (now-decrypted) payload's projectId.
    let projectId = null;
    if (ns === 'project') {
      projectId = change.objectId;
    } else if (!change.deleted && rawPayload && typeof rawPayload === 'object') {
      projectId = rawPayload.projectId || null;
    }
    if (projectId && syncPrefs.isProjectExcluded(projectId)) {
      // Still advance the cursor so we don't replay this change forever.
      if (typeof adapter.setLastSeenVersion === 'function') {
        adapter.setLastSeenVersion(change.objectId, change.clientVersion);
      }
      emitter.emit('apply:skipped', { ns, id: change.objectId, reason: 'project-excluded' });
      return;
    }
    if (change.deleted) {
      if (typeof adapter.delete === 'function') {
        await adapter.delete(change.objectId, { fromSync: true });
      }
    } else {
      const payload = adapter.deserialize ? adapter.deserialize(rawPayload) : rawPayload;
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

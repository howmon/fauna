// ── Checkpoint sync adapter ───────────────────────────────────────────────
//
// Syncs project-checkpoint **metadata + patch diff** across devices.
// Binary blobs and full-file snapshots remain LOCAL ONLY — they can be
// large (up to 16 MB each, see project-checkpoints.js) and a remote
// restore against a divergent file tree would silently corrupt the
// destination.  So this adapter is "archive + browse", not
// "cross-device restore":
//
//   * Each device pushes its own checkpoints to the cloud
//   * Other devices CACHE the meta + patch so the user can SEE
//     "what did I do on the laptop last night"
//   * Restore is still a same-device-only operation
//
// Wire-format ID:    <projectId>:<deviceId>:<number>
//   The deviceId comes from sync-engine._nodeId(), so two devices
//   that both happen to assign checkpoint #42 to the same project
//   don't collide.
//
// On-disk cache:     $FAUNA_SYNC_DIR/checkpoints/<projectId>/<deviceId>/<number>.json
//   Stored separately from RECOVERY_DIR so the local checkpoint browser
//   never confuses a remote-archive entry for a restorable local one.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

import * as syncEngine    from './sync-engine.js';
import * as checkpointLib from './project-checkpoints.js';

// No wire-side size cap on patch bodies. Cloud sync needs to handle
// arbitrarily large diffs; the real ceiling is the agentstore backend's
// `client_max_body_size` / `post_max_size`. If a push fails because the
// backend rejects the payload, that surfaces as a normal sync error
// the user can see in the Cloud Sync panel.

const NAMESPACE = 'checkpoint';

function _archiveDir() {
  const base = process.env.FAUNA_SYNC_DIR ||
    path.join(os.homedir(), '.config', 'fauna', 'sync');
  return path.join(base, 'checkpoints');
}

function _archivePath(projectId, deviceId, number) {
  return path.join(_archiveDir(), _safeFsName(projectId), _safeFsName(deviceId), number + '.json');
}

function _safeFsName(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200);
}

function _parseId(id) {
  // Composite: <projectId>:<deviceId>:<number>
  // projectId and deviceId are opaque but neither contains a ':' in
  // practice (UUIDs / project slugs). If a future projectId DOES include
  // a colon, we'd need a different separator — punt for now.
  const parts = String(id || '').split(':');
  if (parts.length < 3) return null;
  const number = Number(parts[parts.length - 1]);
  if (!Number.isFinite(number)) return null;
  const deviceId = parts[parts.length - 2];
  const projectId = parts.slice(0, -2).join(':');
  return { projectId, deviceId, number };
}

function _makeId(projectId, deviceId, number) {
  return projectId + ':' + deviceId + ':' + Number(number);
}

// ── Public install ────────────────────────────────────────────────────────

let _installed = false;
let _unsubscribe = null;

export function installCheckpointAdapter() {
  if (_installed) return;
  _installed = true;

  const myDeviceId = _myDeviceId();

  syncEngine.registerAdapter(NAMESPACE, {
    /** Load the local payload for outgoing push, or the cached remote
     *  payload for an existing record.  Returns null if neither exists. */
    async load(id) {
      const parsed = _parseId(id);
      if (!parsed) return null;
      if (parsed.deviceId === myDeviceId) {
        return _loadLocal(parsed.projectId, parsed.number, myDeviceId);
      }
      return _loadArchive(parsed.projectId, parsed.deviceId, parsed.number);
    },

    /** Apply an incoming remote change.  Never overwrites our own local
     *  checkpoints — those are authoritative on this device.  Foreign
     *  device records land in the archive cache. */
    async save(id, obj, opts = {}) {
      const parsed = _parseId(id);
      if (!parsed) return;
      if (parsed.deviceId === myDeviceId) {
        // Ignore — the local file IS the source of truth.
        return;
      }
      const dest = _archivePath(parsed.projectId, parsed.deviceId, parsed.number);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = dest + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(obj || {}, null, 2));
      await fsp.rename(tmp, dest);
    },

    async delete(id, _opts = {}) {
      const parsed = _parseId(id);
      if (!parsed) return;
      if (parsed.deviceId === myDeviceId) {
        // Local delete is driven by checkpointLib.deleteCheckpoint itself —
        // a sync-driven delete of our own record means another device of
        // ours saw it removed.  Match that here by removing the local
        // checkpoint too. Safe because deleteCheckpoint is idempotent.
        try { checkpointLib.deleteCheckpoint(parsed.projectId, parsed.number); } catch (_) {}
        return;
      }
      try { await fsp.rm(_archivePath(parsed.projectId, parsed.deviceId, parsed.number), { force: true }); } catch (_) {}
    },

    serialize(payload) { return payload; },
    deserialize(payload) { return payload; },

    // Bootstrap hook for future cold-start backfill. The engine doesn't
    // call this today; when it does, we'll need a project list to walk
    // checkpointLib.listCheckpoints() per project. Stub to [] for now —
    // existing checkpoints surface naturally via the change-listener as
    // soon as the user creates/deletes one.
    async listAllIds() { return []; },
  });

  // Subscribe to checkpointLib so future create/delete on this device
  // flows into the sync journal.
  _unsubscribe = checkpointLib.onCheckpointChange(function (op, projectId, number) {
    const id = _makeId(projectId, myDeviceId, number);
    try {
      syncEngine.enqueueChange(NAMESPACE, id, op === 'delete' ? 'delete' : 'upsert', { projectId });
    } catch (_) { /* engine not running, etc. */ }
  });
}

export function _uninstallForTests() {
  if (typeof _unsubscribe === 'function') _unsubscribe();
  _unsubscribe = null;
  _installed = false;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _myDeviceId() {
  // The engine persists a stable node-id; use that as the device key.
  // We deliberately don't re-derive it here — single source of truth.
  try { return syncEngine.getStatus().nodeId || 'unknown-device'; }
  catch (_) { return 'unknown-device'; }
}

function _loadLocal(projectId, number, myDeviceId) {
  let meta = null;
  try { meta = checkpointLib.readCheckpointMeta(projectId, number); } catch (_) {}
  if (!meta) return null;
  let patch = '';
  try { patch = checkpointLib.readCheckpointPatch(projectId, number) || ''; } catch (_) {}
  return {
    projectId,
    deviceId: myDeviceId,
    number: Number(number),
    meta,
    patch,
    syncedAt: new Date().toISOString(),
  };
}

function _loadArchive(projectId, deviceId, number) {
  try {
    const raw = fs.readFileSync(_archivePath(projectId, deviceId, number), 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

/**
 * List all known checkpoints for a project — local + every device's
 * archived copies. Each entry carries an `origin` field with the
 * device id and an `isLocal` flag the UI can use to gate the
 * restore button.
 */
export async function listAllForProject(projectId) {
  const myDeviceId = _myDeviceId();
  const out = [];
  // Local
  try {
    const local = checkpointLib.listCheckpoints(projectId) || [];
    for (const cp of local) {
      out.push({
        id: _makeId(projectId, myDeviceId, cp.number),
        projectId,
        deviceId: myDeviceId,
        number: cp.number,
        title: cp.title,
        createdAt: cp.createdAt,
        trigger: cp.trigger,
        fileCount: cp.fileCount,
        totalBytes: cp.totalBytes,
        isLocal: true,
        origin: 'this-device',
      });
    }
  } catch (_) {}
  // Remote archive
  try {
    const projDir = path.join(_archiveDir(), _safeFsName(projectId));
    const devices = await fsp.readdir(projDir).catch(() => []);
    for (const dev of devices) {
      if (dev === _safeFsName(myDeviceId)) continue; // already covered by local
      const files = await fsp.readdir(path.join(projDir, dev)).catch(() => []);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const payload = JSON.parse(fs.readFileSync(path.join(projDir, dev, f), 'utf8'));
          if (!payload || !payload.meta) continue;
          out.push({
            id: _makeId(projectId, payload.deviceId || dev, payload.number),
            projectId,
            deviceId: payload.deviceId || dev,
            number: payload.number,
            title: payload.meta.title,
            createdAt: payload.meta.createdAt,
            trigger: payload.meta.trigger,
            fileCount: payload.meta.fileCount,
            totalBytes: payload.meta.totalBytes,
            isLocal: false,
            origin: payload.deviceId || dev,
          });
        } catch (_) { /* skip corrupt entry */ }
      }
    }
  } catch (_) {}
  // Newest first.
  out.sort(function (a, b) {
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return out;
}

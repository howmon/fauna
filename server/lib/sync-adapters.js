// ── Sync Adapters — bind local stores to the cross-device sync engine ─────
//
// Each adapter exposes the {load, save, delete, serialize, deserialize,
// getLastSeenVersion, setLastSeenVersion} contract that sync-engine.js
// expects. Adapters are also responsible for emitting `enqueueChange()`
// when a LOCAL edit happens — that part is wired by patching the
// route layer rather than the store itself, so applying a remote pull
// (`{fromSync: true}`) doesn't loop back into the journal.
//
// The version map per namespace is persisted to
//   ~/.config/fauna/sync/versions/<ns>.json
// so an If-Match conditional PUT survives across restarts. Loss of this
// file just degrades to unconditional PUTs (the server detects nothing
// changed and accepts; or if there's a true conflict, the next pull will
// reconcile). Not catastrophic.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

import * as syncEngine from './sync-engine.js';
import * as pathPortability from './path-portability.js';
import { installCheckpointAdapter } from './sync-checkpoint-adapter.js';

function _versionsDir() {
  return process.env.FAUNA_SYNC_DIR
    ? path.join(process.env.FAUNA_SYNC_DIR, 'versions')
    : path.join(os.homedir(), '.config', 'fauna', 'sync', 'versions');
}

function _versionsFile(ns) {
  return path.join(_versionsDir(), `${ns}.json`);
}

function _makeVersionMap(ns) {
  let cache = null;
  let dirty = false;
  let flushTimer = null;

  function _load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(_versionsFile(ns), 'utf8')) || {};
    } catch (_) {
      cache = {};
    }
    return cache;
  }

  function _scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      if (!dirty) return;
      dirty = false;
      try {
        await fsp.mkdir(_versionsDir(), { recursive: true });
        const tmp = _versionsFile(ns) + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(cache));
        await fsp.rename(tmp, _versionsFile(ns));
      } catch (e) {
        console.warn('[sync-adapters] version flush failed for', ns, e?.message || e);
      }
    }, 500);
  }

  return {
    get(id) { return _load()[id] ?? null; },
    set(id, v) {
      _load();
      if (v == null) delete cache[id];
      else cache[id] = Number(v);
      dirty = true;
      _scheduleFlush();
    },
    drop(id) {
      _load();
      if (id in cache) {
        delete cache[id];
        dirty = true;
        _scheduleFlush();
      }
    },
  };
}

// ── Conversation adapter ──────────────────────────────────────────────────
//
// The conversation store is created in server/routes/conversations.js and
// passed to install...(). We don't import it directly so this module
// stays decoupled from the route layer (and so tests can pass a mock).

export function installConversationAdapter({ store, onApplied }) {
  if (!store) throw new Error('installConversationAdapter: store required');
  const versions = _makeVersionMap('conversation');

  syncEngine.registerAdapter('conversation', {
    async load(id) {
      try { return await store.get(id); } catch (_) { return null; }
    },
    async save(id, obj, opts = {}) {
      // Make sure incoming payload has the correct id (defensive against
      // tampering on the wire). The conversation store keys off the
      // params, not the body, but we keep the body in sync too.
      const conv = { ...(obj || {}), id };
      await store.put(id, conv);
      if (typeof onApplied === 'function' && opts.fromSync) {
        try { onApplied('upsert', conv); } catch (_) {}
      }
    },
    async delete(id, opts = {}) {
      try { await store.del(id); } catch (_) { /* already gone */ }
      versions.drop(id);
      if (typeof onApplied === 'function' && opts.fromSync) {
        try { onApplied('delete', { id }); } catch (_) {}
      }
    },
    // Conversations are LWW for v1. Future: merge messages[] by stable id.
    serialize(conv) { return conv; },
    deserialize(payload) { return payload; },
    getLastSeenVersion(id) { return versions.get(id); },
    setLastSeenVersion(id, v) { versions.set(id, v); },
    // Bootstrap: list every existing local conversation so the engine can
    // backfill them on first sync. Each entry carries the projectId so
    // the per-project sync filter applies during the backfill too.
    async listAllIds() {
      try {
        const all = await store.list({ full: true });
        const rows = Array.isArray(all) ? all : (all && Array.isArray(all.items) ? all.items : []);
        return rows.map(c => ({ id: c.id, projectId: c.projectId || null })).filter(x => x.id);
      } catch (_) { return []; }
    },
  });
}

// ── Project adapter ───────────────────────────────────────────────────────
//
// Uses path-portability to rewrite rootPath / clonePath on the wire so a
// project pulled on a different OS lands at the equivalent local path.
// Unknown roots come through annotated with `<key>_deviceLocal: true` so
// the UI can prompt the user to relocate.

export function installProjectAdapter({ projectManager, onApplied }) {
  if (!projectManager) throw new Error('installProjectAdapter: projectManager required');
  const versions = _makeVersionMap('project');

  const PORTABLE_KEYS = ['rootPath', 'clonePath'];

  syncEngine.registerAdapter('project', {
    async load(id) {
      try { return projectManager.getProject(id); } catch (_) { return null; }
    },
    async save(id, obj, opts = {}) {
      // Decide insert vs update based on whether the project already exists.
      const existing = projectManager.getProject(id);
      const incoming = { ...(obj || {}), id };
      // Don't let a sync payload silently re-clone source repos — that's
      // a deliberate user action via Phase 5 (cross-machine bootstrap).
      // Strip transient/derived fields the local code will recompute.
      delete incoming.lastSyncResult;
      delete incoming.sourceFilesLoadedAt;
      if (existing) {
        projectManager.updateProject(id, incoming);
      } else {
        // _adoptProject() inserts the record verbatim with the wire id,
        // skipping the source-cloning side effects of createProject().
        // Cross-machine bootstrap (Phase 5) handles clone prompts.
        projectManager._adoptProject(incoming);
      }
      if (typeof onApplied === 'function' && opts.fromSync) {
        try { onApplied('upsert', incoming); } catch (_) {}
      }
    },
    async delete(id, opts = {}) {
      try { projectManager.deleteProject(id); } catch (_) {}
      versions.drop(id);
      if (typeof onApplied === 'function' && opts.fromSync) {
        try { onApplied('delete', { id }); } catch (_) {}
      }
    },
    serialize(project) {
      return pathPortability.serializeForWire(project, PORTABLE_KEYS);
    },
    deserialize(payload) {
      return pathPortability.deserializeFromWire(payload, PORTABLE_KEYS);
    },
    getLastSeenVersion(id) { return versions.get(id); },
    setLastSeenVersion(id, v) { versions.set(id, v); },
    // Bootstrap: list every existing local project so the engine can
    // backfill them on first sync.
    async listAllIds() {
      try {
        const fn = (typeof projectManager.listProjects === 'function')
          ? projectManager.listProjects.bind(projectManager)
          : (typeof projectManager.getAllProjects === 'function')
            ? projectManager.getAllProjects.bind(projectManager)
            : null;
        if (!fn) return [];
        const all = fn() || [];
        return all.map(p => ({ id: p.id, projectId: p.id })).filter(x => x.id);
      } catch (_) { return []; }
    },
  });
}

// ── Convenience: install everything at once from main/server bootstrap ────
export function installAllAdapters({ conversationStore, projectManager, onConversationApplied, onProjectApplied }) {
  if (conversationStore) installConversationAdapter({ store: conversationStore, onApplied: onConversationApplied });
  if (projectManager)    installProjectAdapter({ projectManager, onApplied: onProjectApplied });
  // Checkpoint adapter has no external deps — it subscribes to
  // project-checkpoints.js via its built-in change-listener registry.
  installCheckpointAdapter();
}

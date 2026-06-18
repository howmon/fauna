// ── Project file sync adapter ─────────────────────────────────────────────
//
// Phase 5 / "true folder sync". Treats each file in a project's working
// folder as a syncable record under the `project_file` namespace.
//
// Composite object id: `${projectId}:${relPath}`   (relPath POSIX-style)
// Payload shape:       `{ projectId, relPath, content, encoding, hash, size, mtime, mode }`
// Encoding:            'base64' always — keeps binary-safe and keeps the
//                      adapter trivial. Server caps payloads at ~30 MB so
//                      we soft-cap individual files at 20 MB raw (becomes
//                      ~27 MB base64), configurable via env.
//
// Anti-loop strategy
// ──────────────────
// 1.  Every time we write a remote payload to disk we record its sha1 in
//     `_recentlyWritten` (5 s TTL) and in `_localHashes`.
// 2.  The periodic scanner re-hashes only files whose mtime/size differ
//     from the cache; matches against `_recentlyWritten` to suppress the
//     immediate echo from a sync-write.
// 3.  Net result: a file modified on A pushes once, applies on B, and
//     B's next scan finds the same hash → no re-push. No infinite loop.
//
// Cross-device path resolution
// ────────────────────────────
// Project records already sync via `sync-adapters.js` and carry a
// `rootPath` that's normalized through `path-portability.js`. On the
// receiving device that resolves to e.g. `~/Documents/Fauna/<name>` for
// portable paths. If the receiving project record hasn't arrived yet (we
// got files first), we stash to `~/Documents/Fauna/_pending/<projectId>`
// so nothing is lost — the user can move it once the project lands.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as syncEngine from './sync-engine.js';

// Directories whose contents are always skipped. Mirrors the list in
// project-checkpoints.js — keep in sync if you add more.
const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn',
  'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '.cache', '.parcel-cache', '.turbo', '.vite', '.rollup.cache',
  'coverage', '.nyc_output',
  'target', '__pycache__', '.venv', 'venv', 'env',
  '.gradle', '.idea', '.vscode',
  'tmp', 'temp', '.tmp',
  'logs',
]);
const IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db',
  '.env', '.env.local', '.env.development.local', '.env.production.local',
]);

// Raw-byte ceiling per file. base64 inflates by ~33%, server cap is ~30 MB.
const MAX_FILE_BYTES = Number(process.env.FAUNA_SYNC_FILE_MAX_BYTES) || (20 * 1024 * 1024);
// Periodic local-edit scan cadence.
const SCAN_INTERVAL_MS = Number(process.env.FAUNA_SYNC_FILE_SCAN_MS) || 10_000;
const RECENT_TTL_MS = 5000;

// ── State ─────────────────────────────────────────────────────────────────
// LWW version map fed by the engine's getLastSeenVersion / setLastSeenVersion
// contract. Engine persists nothing for us — it's enough that we remember
// for this process so duplicate pulls don't re-write.
const _versions = new Map();
// Disk snapshot keyed by compositeId → { hash, size, mtime }. Populated by
// the scanner and by save(); used to detect dirty files cheaply.
const _localHashes = new Map();
// Anti-echo: hash of a payload we just wrote, with TTL.
const _recentlyWritten = new Map(); // id → { hash, ts }
let _scanTimer = null;
let _scanning = false;
let _installed = false;
let _projectManagerRef = null;

// Composite id format is `${projectId}:b64:${base64url(relPath)}` so the
// resulting URL segment (after encodeURIComponent) contains no '/' chars.
// Apache and nginx both decode %2F → '/' before route matching by default,
// which would otherwise turn /api/sync/objects/project_file/<id> into a
// multi-segment path the Laravel router can't match → 404 PAGE NOT FOUND.
// The `b64:` marker keeps _splitId backward-compatible with any legacy ids
// (and the simpler test fixtures) that still use the bare relPath form.
function _b64urlEncode(str) {
  return Buffer.from(String(str), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _b64urlDecode(s) {
  let b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4;
  if (pad) b += '='.repeat(4 - pad);
  try { return Buffer.from(b, 'base64').toString('utf8'); }
  catch (_) { return null; }
}
function _compositeId(projectId, relPath) {
  return `${projectId}:b64:${_b64urlEncode(relPath)}`;
}
function _splitId(id) {
  const idx = (typeof id === 'string') ? id.indexOf(':') : -1;
  if (idx === -1) return null;
  const projectId = id.slice(0, idx);
  const rest = id.slice(idx + 1);
  if (rest.startsWith('b64:')) {
    const decoded = _b64urlDecode(rest.slice(4));
    if (decoded == null) return null;
    return { projectId, relPath: decoded };
  }
  // Legacy / test-fixture form: bare relPath after the first ':'. Kept so
  // existing rows on the server (and the simple ids used in unit tests)
  // continue to round-trip.
  return { projectId, relPath: rest };
}
function _sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}
function _isIgnoredPath(relPath) {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORE_DIRS.has(parts[i])) return true;
  }
  if (IGNORE_FILES.has(parts[parts.length - 1])) return true;
  return false;
}
function _safeName(name) {
  return String(name || '').trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || 'project';
}
function _pendingRoot(projectId) {
  return path.join(os.homedir(), 'Documents', 'Fauna', '_pending', projectId);
}
function _markWritten(id, hash) {
  _recentlyWritten.set(id, { hash, ts: Date.now() });
}
function _wasJustWritten(id, hash) {
  const rec = _recentlyWritten.get(id);
  if (!rec) return false;
  if (Date.now() - rec.ts > RECENT_TTL_MS) { _recentlyWritten.delete(id); return false; }
  return rec.hash === hash;
}

// Recursive walk that skips the IGNORE list. Returns POSIX-style relative
// paths. Bounded only by what's on disk; the engine batches push so a
// huge project just streams up over many push cycles.
export function walkProject(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of entries) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      if (IGNORE_FILES.has(ent.name)) continue;
      const relChild = rel ? path.posix.join(rel, ent.name) : ent.name;
      if (ent.isSymbolicLink()) continue;          // skip symlinks
      if (ent.isDirectory()) { stack.push(relChild); continue; }
      if (!ent.isFile()) continue;
      out.push(relChild);
    }
  }
  return out;
}

// Resolve the local working root for a project. Creates `~/Documents/Fauna/
// _pending/<projectId>` if the project record hasn't synced yet (so files
// arriving before their project don't get dropped).
function _resolveRoot(projectId) {
  const pm = _projectManagerRef;
  if (!pm) return null;
  let project = null;
  try { project = pm.getProject(projectId); } catch (_) {}
  let root = (project && project.rootPath) || null;
  if (!root) {
    if (project) {
      // Project exists but has no rootPath yet — getAllProjects() normally
      // backfills, so trigger that. Re-read after.
      try { pm.getAllProjects(); } catch (_) {}
      try { project = pm.getProject(projectId); } catch (_) {}
      root = (project && project.rootPath) || null;
    }
  }
  if (!root) root = _pendingRoot(projectId);
  try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
  return root;
}

// ── Public install ────────────────────────────────────────────────────────

export function installFileAdapter({ projectManager, onApplied } = {}) {
  if (!projectManager) throw new Error('installFileAdapter: projectManager required');
  if (_installed) return;
  _projectManagerRef = projectManager;
  _installed = true;

  syncEngine.registerAdapter('project_file', {
    async load(id) {
      const split = _splitId(id);
      if (!split) return null;
      if (_isIgnoredPath(split.relPath)) return null;
      const root = _resolveRoot(split.projectId);
      if (!root) return null;
      const abs = _safeJoin(root, split.relPath);
      if (!abs) return null;
      try {
        const stat = await fsp.stat(abs);
        if (!stat.isFile()) return null;
        if (stat.size > MAX_FILE_BYTES) return null;
        const buf = await fsp.readFile(abs);
        const hash = _sha1(buf);
        return {
          projectId: split.projectId,
          relPath: split.relPath,
          encoding: 'base64',
          content: buf.toString('base64'),
          size: stat.size,
          mtime: stat.mtimeMs,
          mode: stat.mode,
          hash,
        };
      } catch (_) { return null; }
    },

    async save(id, payload, opts = {}) {
      if (!payload || typeof payload !== 'object') return;
      const split = _splitId(id);
      if (!split) return;
      const relPath = (typeof payload.relPath === 'string' && payload.relPath) || split.relPath;
      if (_isIgnoredPath(relPath)) return;
      const root = _resolveRoot(split.projectId);
      if (!root) return;
      const abs = _safeJoin(root, relPath);
      if (!abs) return;
      // Canonical cache key so the scanner's _compositeId(...) lookups
      // match entries inserted here, regardless of whether the caller
      // passed a legacy `projectId:relPath` id or the new b64 form.
      const cacheKey = _compositeId(split.projectId, relPath);

      // Decode payload to bytes once.
      const content = (typeof payload.content === 'string') ? payload.content : '';
      const enc = payload.encoding === 'utf8' ? 'utf8' : 'base64';
      const buf = Buffer.from(content, enc);
      const hash = (typeof payload.hash === 'string' && payload.hash) || _sha1(buf);

      // Skip the write if the on-disk copy already matches — prevents
      // mtime churn and noisy editor reloads.
      try {
        const existing = await fsp.readFile(abs);
        if (_sha1(existing) === hash) {
          _localHashes.set(cacheKey, { hash, size: existing.length, mtime: Date.now() });
          _markWritten(cacheKey, hash);
          if (typeof onApplied === 'function' && opts.fromSync) {
            try { onApplied('upsert', { id, projectId: split.projectId, relPath }); } catch (_) {}
          }
          return;
        }
      } catch (_) { /* file doesn't exist yet — fall through */ }

      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, buf);
      // Restore mtime so the receiving editor doesn't flag every pulled
      // file as "just modified". Best-effort.
      if (typeof payload.mtime === 'number' && payload.mtime > 0) {
        try {
          const mt = new Date(payload.mtime);
          await fsp.utimes(abs, mt, mt);
        } catch (_) {}
      }
      _markWritten(cacheKey, hash);
      _localHashes.set(cacheKey, { hash, size: buf.length, mtime: Date.now() });
      if (typeof onApplied === 'function' && opts.fromSync) {
        try { onApplied('upsert', { id, projectId: split.projectId, relPath }); } catch (_) {}
      }
    },

    async delete(id, opts = {}) {
      const split = _splitId(id);
      if (!split) return;
      const root = _resolveRoot(split.projectId);
      if (!root) return;
      const abs = _safeJoin(root, split.relPath);
      if (!abs) return;
      try { await fsp.unlink(abs); } catch (_) {}
      _localHashes.delete(_compositeId(split.projectId, split.relPath));
      if (typeof onApplied === 'function' && opts.fromSync) {
        try { onApplied('delete', { id, projectId: split.projectId, relPath: split.relPath }); } catch (_) {}
      }
    },

    serialize(payload) { return payload; },
    deserialize(payload) { return payload; },
    getLastSeenVersion(id) { return _versions.get(id) || 0; },
    setLastSeenVersion(id, v) { _versions.set(id, v); },

    // Bootstrap: every existing local file across every project.
    async listAllIds() {
      const out = [];
      const projects = _listProjects();
      for (const p of projects) {
        if (!p || !p.id) continue;
        const root = _resolveRoot(p.id);
        if (!root) continue;
        let rels = [];
        try { rels = walkProject(root); } catch (_) {}
        for (const rel of rels) {
          // Pre-populate the local-hash cache so the first scan after
          // start doesn't re-enqueue everything we just bootstrapped.
          try {
            const abs = path.join(root, rel);
            const stat = fs.statSync(abs);
            if (stat.size > MAX_FILE_BYTES) continue;
            const buf = fs.readFileSync(abs);
            const hash = _sha1(buf);
            _localHashes.set(_compositeId(p.id, rel), { hash, size: stat.size, mtime: stat.mtimeMs });
          } catch (_) {}
          out.push({ id: _compositeId(p.id, rel), projectId: p.id });
        }
      }
      return out;
    },
  });

  _startScanLoop();
}

function _listProjects() {
  const pm = _projectManagerRef;
  if (!pm) return [];
  try {
    if (typeof pm.listProjects === 'function') return pm.listProjects() || [];
    if (typeof pm.getAllProjects === 'function') return pm.getAllProjects() || [];
  } catch (_) {}
  return [];
}

// path.resolve + containment check. Returns null if the target escapes
// the root (defense against `..` in payload.relPath).
function _safeJoin(root, relPath) {
  const normRoot = path.resolve(root);
  const abs = path.resolve(root, relPath);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) return null;
  return abs;
}

// ── Local-edit scanner ────────────────────────────────────────────────────
// Periodic walk of every project root. Compares stat → cached hash →
// re-hashes only when (size, mtime) differ. Diffs against `_localHashes`
// to detect new / modified / deleted files and enqueues changes.

function _startScanLoop() {
  if (_scanTimer) return;
  _scanTimer = setInterval(() => { _scanOnce().catch(() => {}); }, SCAN_INTERVAL_MS);
  _scanTimer.unref?.();
}

export async function _scanOnce() {
  if (_scanning) return;
  _scanning = true;
  try {
    const projects = _listProjects();
    for (const p of projects) {
      if (!p || !p.id || !p.rootPath) continue;
      const root = p.rootPath;
      const liveIds = new Set();
      let rels = [];
      try { rels = walkProject(root); } catch (_) { continue; }
      for (const rel of rels) {
        const id = _compositeId(p.id, rel);
        liveIds.add(id);
        try {
          const abs = path.join(root, rel);
          const stat = await fsp.stat(abs);
          if (stat.size > MAX_FILE_BYTES) continue;
          const prev = _localHashes.get(id);
          // Fast path: same (size, mtime) → assume unchanged.
          if (prev && prev.size === stat.size && Math.abs(prev.mtime - stat.mtimeMs) < 1) continue;
          const buf = await fsp.readFile(abs);
          const hash = _sha1(buf);
          if (prev && prev.hash === hash) {
            _localHashes.set(id, { hash, size: stat.size, mtime: stat.mtimeMs });
            continue;
          }
          if (_wasJustWritten(id, hash)) {
            _localHashes.set(id, { hash, size: stat.size, mtime: stat.mtimeMs });
            continue;
          }
          _localHashes.set(id, { hash, size: stat.size, mtime: stat.mtimeMs });
          syncEngine.enqueueChange('project_file', id, 'upsert', { projectId: p.id });
        } catch (_) {}
      }
      // Anything previously known under this project but no longer on disk
      // → enqueue delete.
      for (const id of Array.from(_localHashes.keys())) {
        if (!id.startsWith(p.id + ':')) continue;
        if (liveIds.has(id)) continue;
        _localHashes.delete(id);
        syncEngine.enqueueChange('project_file', id, 'delete', { projectId: p.id });
      }
    }
  } finally {
    _scanning = false;
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────

export function _resetForTests() {
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
  _versions.clear();
  _localHashes.clear();
  _recentlyWritten.clear();
  _installed = false;
  _projectManagerRef = null;
}

export const _internals = {
  IGNORE_DIRS, IGNORE_FILES, MAX_FILE_BYTES, SCAN_INTERVAL_MS,
  _localHashes, _recentlyWritten, _versions,
  _compositeId, _splitId, _sha1, _isIgnoredPath, _safeJoin,
};

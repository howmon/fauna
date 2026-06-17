// ── Sync Preferences — per-user/per-device controls over what syncs ───────
//
// Persists to ~/.config/fauna/sync/prefs.json (or $FAUNA_SYNC_DIR/prefs.json
// for tests). Currently tracks one thing: the set of project IDs to keep
// LOCAL-ONLY. A conversation tagged with one of those project IDs is also
// kept local-only (the conversation→project link comes from the conv
// record's `projectId` field).
//
// Excluded projects are tracked per-device, NOT synced. If you exclude
// "Project X" on your laptop, your desktop still sees and pushes it
// unless you exclude it there too. This is intentional — "don't sync this
// big project from MY laptop where it lives" is the most common use case.
//
// Shape on disk:
//   { excludedProjects: ["id1", "id2", ...], schema: 1 }

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

function _prefsDir() {
  return process.env.FAUNA_SYNC_DIR ||
    path.join(os.homedir(), '.config', 'fauna', 'sync');
}
function _prefsFile() { return path.join(_prefsDir(), 'prefs.json'); }

let _cache = null;
let _excluded = null; // Set<string> mirror of _cache.excludedProjects

function _load() {
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(_prefsFile(), 'utf8'));
    _cache = (raw && typeof raw === 'object') ? raw : {};
  } catch (_) {
    _cache = {};
  }
  if (!Array.isArray(_cache.excludedProjects)) _cache.excludedProjects = [];
  _excluded = new Set(_cache.excludedProjects);
  return _cache;
}

async function _save() {
  await fsp.mkdir(_prefsDir(), { recursive: true });
  const tmp = _prefsFile() + '.tmp-' + process.pid + '-' + Date.now();
  await fsp.writeFile(tmp, JSON.stringify(_cache, null, 2));
  await fsp.rename(tmp, _prefsFile());
}

/** Returns a defensive copy of the current prefs. Never throws. */
export function getPrefs() {
  _load();
  return { excludedProjects: Array.from(_excluded), schema: 1 };
}

/** Returns the live Set of excluded project IDs. Hot path — no copy. */
export function getExcludedProjectSet() {
  _load();
  return _excluded;
}

/** True if the given project id is in the excluded set. Cheap. */
export function isProjectExcluded(projectId) {
  if (!projectId) return false;
  _load();
  return _excluded.has(String(projectId));
}

/**
 * Replace the excluded-projects list. `ids` must be an array of strings.
 * Returns the new prefs snapshot.
 */
export async function setExcludedProjects(ids) {
  _load();
  const next = Array.from(new Set(
    (ids || [])
      .filter(function (v) { return v !== null && v !== undefined && v !== ''; })
      .map(String)
  ));
  _cache.excludedProjects = next;
  _excluded = new Set(next);
  await _save();
  return getPrefs();
}

/**
 * Add or remove a single project from the excluded list. `excluded === true`
 * stops syncing it; `false` resumes. Returns the new prefs snapshot.
 */
export async function setProjectExcluded(projectId, excluded) {
  if (!projectId) throw new Error('projectId required');
  _load();
  const id = String(projectId);
  if (excluded) _excluded.add(id);
  else _excluded.delete(id);
  _cache.excludedProjects = Array.from(_excluded);
  await _save();
  return getPrefs();
}

/** Clears the in-memory cache. Test-only — production never needs this. */
export function _resetForTests() {
  _cache = null;
  _excluded = null;
}

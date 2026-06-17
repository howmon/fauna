// server/lib/project-checkpoints.js
//
// Project-level checkpoints — a Copilot-worktree-inspired safety net for
// users who haven't committed (or even initialised git). Stores small delta
// packs in a sidecar so the user's project tree stays clean.
//
// Layout per project:
//
//   ~/.copilotchat-recovery/projects/<projectId>/
//     index.json
//     cp-0042-2026-06-17T09-33-12Z/
//       meta.json
//       patch.diff          ← unified diff for tracked modifications/deletes
//       blobs/              ← full content for untracked-added & binary files
//       notes.md            ← optional free text
//
// `.gitignore` is honoured for free when the project is a git repo (we lean
// on `git ls-files` / `git diff`). Non-git projects use a small built-in
// ignore list to keep node_modules/.git/dist/etc out of the snapshot.

import fs   from 'fs';
import os   from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';

import { RECOVERY_DIR } from '../copilot/auth.js';

const ROOT_DIR = path.join(RECOVERY_DIR, 'projects');

// Per-file unified-diff size cap (256 KB) — matches Copilot's truncation
// pattern. Larger diffs are marked `isTruncated:true` and excluded from the
// patch (the blob version is still kept when possible).
const MAX_PATCH_BYTES_PER_FILE = 256 * 1024;

// Per-blob byte cap (16 MB). Anything larger is recorded in meta but not
// snapshotted; restore will warn rather than silently lose data.
const MAX_BLOB_BYTES = 16 * 1024 * 1024;

// Hard ceiling on files captured per checkpoint (defence against pathological
// "I just unpacked a tarball" mistakes).
const MAX_FILES_PER_CHECKPOINT = 5000;

// Default retention.
const DEFAULT_MAX_COUNT = 50;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

// Built-in ignore list for non-git projects. Anything under one of these dir
// names anywhere in the tree is skipped. Add to taste.
const FALLBACK_IGNORE_DIRS = new Set([
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
const FALLBACK_IGNORE_EXACT_FILES = new Set([
  '.DS_Store', 'Thumbs.db',
]);

// ── Public API ───────────────────────────────────────────────────────────

// Change-listener registry. Lets sync-adapters.js subscribe to checkpoint
// mutations without creating a circular import. Listener signature:
//   fn(op, projectId, number)   where op = 'upsert' | 'delete'
const _changeListeners = new Set();

export function onCheckpointChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _changeListeners.add(fn);
  return function unsubscribe() { _changeListeners.delete(fn); };
}

function _emitChange(op, projectId, number) {
  for (const fn of _changeListeners) {
    try { fn(op, projectId, number); } catch (e) {
      console.warn('[project-checkpoints] listener threw:', e?.message || e);
    }
  }
}

export function projectCheckpointDir(projectId) {
  return path.join(ROOT_DIR, _safeId(projectId));
}

export function listCheckpoints(projectId) {
  const idx = _readIndex(projectId);
  return idx.checkpoints.slice().sort((a, b) => b.number - a.number);
}

export function readCheckpointMeta(projectId, number) {
  const entry = _findEntry(projectId, number);
  if (!entry) return null;
  const metaPath = path.join(projectCheckpointDir(projectId), entry.dirname, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
  catch (_) { return null; }
}

export function readCheckpointPatch(projectId, number) {
  const entry = _findEntry(projectId, number);
  if (!entry) return null;
  const patchPath = path.join(projectCheckpointDir(projectId), entry.dirname, 'patch.diff');
  if (!fs.existsSync(patchPath)) return '';
  return fs.readFileSync(patchPath, 'utf8');
}

export function deleteCheckpoint(projectId, number) {
  const idx = _readIndex(projectId);
  const i   = idx.checkpoints.findIndex(c => c.number === number);
  if (i < 0) return false;
  const dir = path.join(projectCheckpointDir(projectId), idx.checkpoints[i].dirname);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  idx.checkpoints.splice(i, 1);
  _writeIndex(projectId, idx);
  _emitChange('delete', projectId, Number(number));
  return true;
}

/**
 * Capture a project checkpoint.
 *
 * @param {object} project       — Fauna project record (must have id, rootPath).
 * @param {object} [opts]
 * @param {string} [opts.title]  — human-readable label.
 * @param {string} [opts.trigger]— 'manual' | 'auto' | 'pre-restore' | 'pre-apply-patch' | 'pre-shell'.
 * @param {string} [opts.note]   — optional free text saved to notes.md.
 * @param {boolean}[opts.includeUntracked] — override project setting.
 * @returns {object} checkpoint meta.
 */
export function createCheckpoint(project, opts = {}) {
  if (!project || !project.id) throw new Error('createCheckpoint: project.id required');
  if (!project.rootPath || !fs.existsSync(project.rootPath)) {
    throw new Error('createCheckpoint: project has no rootPath on disk');
  }

  const projectId   = project.id;
  const rootPath    = project.rootPath;
  const settings    = _settingsFor(project);
  const includeUntracked = (typeof opts.includeUntracked === 'boolean')
    ? opts.includeUntracked
    : settings.includeUntracked;

  const isGitRepo  = _isGitRepo(rootPath);
  const gitMeta    = isGitRepo ? _readGitMeta(rootPath) : { head: null, branch: null };

  // 1) Collect candidate files
  const changes = isGitRepo
    ? _collectGitChanges(rootPath, includeUntracked)
    : _collectFsChanges(rootPath); // fallback: any non-ignored file is a "modification"

  if (changes.length > MAX_FILES_PER_CHECKPOINT) {
    throw new Error(
      'createCheckpoint: too many files (' + changes.length + ' > ' + MAX_FILES_PER_CHECKPOINT + '). ' +
      'Check your .gitignore — or commit/clean first.'
    );
  }

  // 2) Build patch + blobs
  const idx        = _readIndex(projectId);
  const number     = (idx.lastNumber || 0) + 1;
  const ts         = new Date().toISOString().replace(/[:.]/g, '-');
  const dirname    = 'cp-' + String(number).padStart(4, '0') + '-' + ts;
  const cpDir      = path.join(projectCheckpointDir(projectId), dirname);
  const blobsDir   = path.join(cpDir, 'blobs');
  fs.mkdirSync(cpDir, { recursive: true });

  const files = [];
  let patchParts = [];
  let totalBytes = 0;

  for (const ch of changes) {
    const absPath = path.join(rootPath, ch.path);
    let exists = false;
    let stat   = null;
    try { stat = fs.statSync(absPath); exists = stat.isFile(); } catch (_) {}

    const rec = {
      path: ch.path,
      changeType: ch.changeType,
      oldPath: ch.oldPath || undefined,
      size: stat ? stat.size : 0,
      binary: false,
      inPatch: false,
      inBlob: false,
      isTruncated: false,
    };

    // For deletes: include in patch only (synthesised below from git diff).
    // For non-git fallback we don't know HEAD content, so we can only snapshot
    // current file content as a blob.
    if (isGitRepo && ch.changeType !== 'untracked') {
      // Ask git for the per-file unified diff. Renames produce one combined entry.
      const diff = _gitDiffOneFile(rootPath, ch.path, ch.oldPath);
      if (diff && Buffer.byteLength(diff, 'utf8') <= MAX_PATCH_BYTES_PER_FILE) {
        patchParts.push(diff);
        rec.inPatch = true;
      } else if (diff) {
        rec.isTruncated = true;
      }
    }

    // Always snapshot the current file content as a blob when it exists. This
    // is the workhorse for restore: forward/3way restore copies the blob over
    // the working file (no `git apply` flakiness with index-mismatch). The
    // patch is kept purely for preview + reverse-via-HEAD.
    if (exists && ch.changeType !== 'deleted') {
      if (stat.size <= MAX_BLOB_BYTES) {
        const blobAbs = path.join(blobsDir, ch.path);
        fs.mkdirSync(path.dirname(blobAbs), { recursive: true });
        fs.copyFileSync(absPath, blobAbs);
        rec.inBlob = true;
        rec.binary = _looksBinary(absPath);
        totalBytes += stat.size;
      } else {
        rec.isTruncated = true;
      }
    }

    files.push(rec);
  }

  const patchText = patchParts.join('\n');
  if (patchText) {
    fs.writeFileSync(path.join(cpDir, 'patch.diff'), patchText, 'utf8');
    totalBytes += Buffer.byteLength(patchText, 'utf8');
  }

  if (opts.note) {
    fs.writeFileSync(path.join(cpDir, 'notes.md'), String(opts.note), 'utf8');
  }

  const meta = {
    number,
    title: String(opts.title || _autoTitle(opts.trigger, files.length)).slice(0, 200),
    createdAt: new Date().toISOString(),
    trigger: opts.trigger || 'manual',
    rootPath,
    isGitRepo,
    gitHead: gitMeta.head,
    gitBranch: gitMeta.branch,
    fileCount: files.length,
    totalBytes,
    files,
  };
  fs.writeFileSync(path.join(cpDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  // 3) Update index, run GC
  idx.lastNumber = number;
  idx.checkpoints.push({
    number,
    dirname,
    title: meta.title,
    createdAt: meta.createdAt,
    trigger: meta.trigger,
    fileCount: meta.fileCount,
    totalBytes: meta.totalBytes,
  });
  _writeIndex(projectId, idx);
  _gc(projectId, settings);
  _emitChange('upsert', projectId, number);
  return meta;
}

/**
 * Restore a checkpoint.
 *
 * @param {object} project — must have id, rootPath.
 * @param {number} number  — checkpoint number.
 * @param {object} opts
 * @param {'preview'|'reverse'|'forward'|'3way'} opts.mode — 'preview' is no-op.
 * @returns {object} { ok, mode, applied:[], conflicts:[], warnings:[], previousCheckpoint? }
 */
export function restoreCheckpoint(project, number, opts = {}) {
  const mode = opts.mode || 'preview';
  if (!['preview', 'reverse', 'forward', '3way'].includes(mode)) {
    throw new Error('Invalid restore mode: ' + mode);
  }
  if (!project || !project.id) throw new Error('restoreCheckpoint: project.id required');
  if (!project.rootPath || !fs.existsSync(project.rootPath)) {
    throw new Error('restoreCheckpoint: project has no rootPath on disk');
  }
  const meta = readCheckpointMeta(project.id, number);
  if (!meta) throw new Error('Checkpoint not found: ' + number);

  if (mode === 'preview') {
    return {
      ok: true,
      mode,
      patch: readCheckpointPatch(project.id, number),
      files: meta.files,
      title: meta.title,
      createdAt: meta.createdAt,
    };
  }

  // Snapshot current state first so the restore itself is undoable.
  let previousCheckpoint = null;
  try {
    previousCheckpoint = createCheckpoint(project, {
      title: 'Before restore of #' + number + ' (' + meta.title + ')',
      trigger: 'pre-restore',
    }).number;
  } catch (e) {
    // Non-fatal: if we can't snapshot (e.g. >5000 changed files), record a
    // warning but proceed if the caller insisted.
    if (!opts.force) {
      throw new Error('Could not auto-snapshot before restore: ' + e.message + ' — pass force=true to override.');
    }
  }

  const cpDir    = path.join(projectCheckpointDir(project.id), _findEntry(project.id, number).dirname);
  const blobsDir = path.join(cpDir, 'blobs');
  const result = { ok: true, mode, applied: [], conflicts: [], warnings: [], previousCheckpoint };
  const isGitRepo = _isGitRepo(project.rootPath);

  for (const rec of meta.files) {
    const abs     = path.join(project.rootPath, rec.path);
    const blobAbs = path.join(blobsDir, rec.path);

    if (mode === 'reverse') {
      // Undo this checkpoint's changes — return to pre-checkpoint state.
      try {
        if (rec.changeType === 'untracked' || rec.changeType === 'added') {
          // The file was added in the checkpoint → reverse = remove it from
          // the working tree. Only delete when current content matches what
          // we captured (don't clobber newer edits unless mode is 'forward').
          if (fs.existsSync(abs)) {
            if (!rec.inBlob || _filesEqual(abs, blobAbs)) {
              fs.unlinkSync(abs);
              result.applied.push({ path: rec.path, op: 'removed' });
            } else {
              result.conflicts.push({ path: rec.path, reason: 'differs from checkpoint blob — leaving in place' });
            }
          }
        } else if (rec.changeType === 'deleted') {
          // The file was deleted in the checkpoint → reverse = restore from HEAD.
          if (isGitRepo) {
            const r = spawnSync('git', ['checkout', 'HEAD', '--', rec.path], { cwd: project.rootPath, encoding: 'utf8' });
            if (r.status === 0) result.applied.push({ path: rec.path, op: 'restored-from-HEAD' });
            else result.warnings.push('git checkout HEAD failed for ' + rec.path + ': ' + (r.stderr || '').trim());
          } else {
            result.warnings.push('Cannot reverse delete of ' + rec.path + ' (not a git repo)');
          }
        } else {
          // modified / renamed → reverse = restore HEAD content for tracked
          // files. The blob captured in the checkpoint is the post-image, so
          // we don't want it; we want the pre-image, which lives in HEAD.
          if (isGitRepo) {
            const r = spawnSync('git', ['checkout', 'HEAD', '--', rec.path], { cwd: project.rootPath, encoding: 'utf8' });
            if (r.status === 0) result.applied.push({ path: rec.path, op: 'restored-from-HEAD' });
            else result.warnings.push('git checkout HEAD failed for ' + rec.path + ': ' + (r.stderr || '').trim());
          } else {
            result.warnings.push('Cannot reverse modification of ' + rec.path + ' (not a git repo, no pre-image stored)');
          }
        }
      } catch (e) { result.warnings.push('reverse failed for ' + rec.path + ': ' + e.message); }
      continue;
    }

    // forward / 3way: take the working tree TO the checkpoint's post-image.
    // We have the post-image as a blob (when small enough) — copy it over.
    try {
      if (rec.changeType === 'deleted') {
        // The file was deleted in the checkpoint → restore = remove it now.
        if (fs.existsSync(abs)) {
          if (mode === '3way' && _fileExistsAndDiffersFromHead(project.rootPath, rec.path, isGitRepo)) {
            result.conflicts.push({ path: rec.path, reason: 'file has uncommitted changes — left untouched (3way)' });
            continue;
          }
          fs.unlinkSync(abs);
          result.applied.push({ path: rec.path, op: 'removed' });
        }
        continue;
      }
      if (!rec.inBlob) {
        if (rec.isTruncated) {
          result.warnings.push('Skipping ' + rec.path + ' — content was too large to snapshot.');
        } else {
          result.warnings.push('Skipping ' + rec.path + ' — no blob captured.');
        }
        continue;
      }
      if (mode === '3way' && fs.existsSync(abs) && !_filesEqual(abs, blobAbs)) {
        // Conservative: in 3way mode, do not clobber a current file that
        // differs from the checkpoint blob unless it also differs from HEAD
        // (which means the user has new edits we'd lose).
        if (_fileExistsAndDiffersFromHead(project.rootPath, rec.path, isGitRepo)) {
          result.conflicts.push({ path: rec.path, reason: 'file has uncommitted changes — left untouched (use Force-restore to overwrite)' });
          continue;
        }
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(blobAbs, abs);
      result.applied.push({ path: rec.path, op: 'restored' });
    } catch (e) { result.warnings.push('restore failed for ' + rec.path + ': ' + e.message); }
  }

  if (!result.applied.length && !result.conflicts.length) {
    result.warnings.push('Nothing to apply.');
  }
  return result;
}

function _fileExistsAndDiffersFromHead(rootPath, p, isGitRepo) {
  if (!isGitRepo) return false;
  const r = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', p], { cwd: rootPath, encoding: 'utf8' });
  // Exit 1 = differs, 0 = no diff, other = error (treat as no diff so we don't block).
  return r.status === 1;
}

// ── Internals ────────────────────────────────────────────────────────────

function _safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
}

function _settingsFor(project) {
  const s = (project && project.checkpoints) || {};
  return {
    autoSnapshotOnAgentTurn:   s.autoSnapshotOnAgentTurn   !== false, // default on
    autoSnapshotOnDestructive: s.autoSnapshotOnDestructive !== false, // default on
    maxCount: Number.isFinite(s.maxCount) && s.maxCount > 0 ? s.maxCount : DEFAULT_MAX_COUNT,
    maxBytes: Number.isFinite(s.maxBytes) && s.maxBytes > 0 ? s.maxBytes : DEFAULT_MAX_BYTES,
    includeUntracked: s.includeUntracked !== false, // default on
  };
}

export function getCheckpointSettings(project) {
  return _settingsFor(project);
}

function _indexPath(projectId) {
  return path.join(projectCheckpointDir(projectId), 'index.json');
}

function _readIndex(projectId) {
  const p = _indexPath(projectId);
  if (!fs.existsSync(p)) return { lastNumber: 0, checkpoints: [] };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || !Array.isArray(j.checkpoints)) return { lastNumber: 0, checkpoints: [] };
    if (!Number.isFinite(j.lastNumber)) j.lastNumber = j.checkpoints.reduce((m, c) => Math.max(m, c.number || 0), 0);
    return j;
  } catch (_) { return { lastNumber: 0, checkpoints: [] }; }
}

function _writeIndex(projectId, idx) {
  const p = _indexPath(projectId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.~tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, p);
}

function _findEntry(projectId, number) {
  const idx = _readIndex(projectId);
  return idx.checkpoints.find(c => c.number === Number(number)) || null;
}

function _gc(projectId, settings) {
  let idx = _readIndex(projectId);
  // Sort oldest first for eviction; keep newest.
  idx.checkpoints.sort((a, b) => a.number - b.number);

  // Trim by count
  while (idx.checkpoints.length > settings.maxCount) {
    const evicted = idx.checkpoints.shift();
    _rmCheckpointDir(projectId, evicted.dirname);
  }
  // Trim by total bytes
  let total = idx.checkpoints.reduce((s, c) => s + (c.totalBytes || 0), 0);
  while (idx.checkpoints.length > 1 && total > settings.maxBytes) {
    const evicted = idx.checkpoints.shift();
    _rmCheckpointDir(projectId, evicted.dirname);
    total -= (evicted.totalBytes || 0);
  }
  _writeIndex(projectId, idx);
}

function _rmCheckpointDir(projectId, dirname) {
  const dir = path.join(projectCheckpointDir(projectId), dirname);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function _autoTitle(trigger, fileCount) {
  const t = trigger || 'manual';
  return t.charAt(0).toUpperCase() + t.slice(1) + ' snapshot (' + fileCount + ' file' + (fileCount === 1 ? '' : 's') + ')';
}

// ── Git interrogation ────────────────────────────────────────────────────

function _isGitRepo(rootPath) {
  try {
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootPath, encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() === 'true';
  } catch (_) { return false; }
}

function _readGitMeta(rootPath) {
  let head = null, branch = null;
  try {
    head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: rootPath, encoding: 'utf8' }).trim();
  } catch (_) {}
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootPath, encoding: 'utf8' }).trim();
  } catch (_) {}
  return { head, branch };
}

// Collect changes via git: tracked-modified, tracked-deleted, renamed, and
// (when requested) untracked-but-not-ignored. Returns objects with shape:
//   { path, changeType: 'modified'|'added'|'deleted'|'renamed'|'untracked', oldPath? }
function _collectGitChanges(rootPath, includeUntracked) {
  const out = [];
  // `git status --porcelain=v1 -z` is the most compact stable format.
  // Add `-uall` so untracked dirs expand to individual files; `--ignored=no`
  // is the default but explicit for clarity.
  const args = ['status', '--porcelain=v1', '-z'];
  if (includeUntracked) args.push('-uall'); else args.push('-uno');
  let raw;
  try { raw = execFileSync('git', args, { cwd: rootPath, encoding: 'utf8' }); }
  catch (_) { return out; }

  // Parse NUL-delimited records. Renames have TWO NUL-separated paths.
  const parts = raw.split('\u0000');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    // Format: "XY path" (single space after status)
    const x = rec.charAt(0);
    const y = rec.charAt(1);
    const p = rec.slice(3);
    if (x === 'R' || y === 'R') {
      // Rename — next part is the old path
      const oldPath = parts[i + 1] || '';
      i++;
      out.push({ path: p, changeType: 'renamed', oldPath });
      continue;
    }
    if (x === '?' && y === '?') {
      out.push({ path: p, changeType: 'untracked' });
      continue;
    }
    if (x === 'A' || y === 'A') { out.push({ path: p, changeType: 'added' }); continue; }
    if (x === 'D' || y === 'D') { out.push({ path: p, changeType: 'deleted' }); continue; }
    if (x === 'M' || y === 'M') { out.push({ path: p, changeType: 'modified' }); continue; }
    // Fall-through: treat as modified
    out.push({ path: p, changeType: 'modified' });
  }
  return out;
}

function _gitDiffOneFile(rootPath, p, oldPath) {
  // For renames we ask for a combined diff using both paths.
  const args = ['diff', '--no-color', '--no-ext-diff', '--unified=3', '--', oldPath ? oldPath : p];
  if (oldPath) args.push(p);
  try {
    // Use spawnSync to avoid shell-escaping issues with weird filenames.
    const r = spawnSync('git', args, { cwd: rootPath, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) {
      // Try `--cached` for staged adds.
      const r2 = spawnSync('git', ['diff', '--cached', '--no-color', '--unified=3', '--', p], {
        cwd: rootPath, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      });
      return r2.stdout || '';
    }
    return r.stdout;
  } catch (_) { return ''; }
}

// ── Non-git fallback ─────────────────────────────────────────────────────

function _collectFsChanges(rootPath) {
  // No HEAD to diff against — every non-ignored file is a candidate. The
  // recursion is intentionally shallow about hidden dirs (only skips those
  // in FALLBACK_IGNORE_DIRS) so dotfiles like .env or .github get captured.
  const out  = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(rootPath, rel), { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of entries) {
      if (FALLBACK_IGNORE_DIRS.has(ent.name)) continue;
      if (FALLBACK_IGNORE_EXACT_FILES.has(ent.name)) continue;
      const relChild = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) { stack.push(relChild); continue; }
      if (!ent.isFile()) continue;
      out.push({ path: relChild.replace(/\\/g, '/'), changeType: 'modified' });
      if (out.length >= MAX_FILES_PER_CHECKPOINT + 1) return out;
    }
  }
  return out;
}

// ── Utility ──────────────────────────────────────────────────────────────

function _looksBinary(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(512);
    const n  = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) { if (buf[i] === 0) return true; }
    return false;
  } catch (_) { return false; }
}

function _filesEqual(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    const ha = crypto.createHash('sha1').update(fs.readFileSync(a)).digest('hex');
    const hb = crypto.createHash('sha1').update(fs.readFileSync(b)).digest('hex');
    return ha === hb;
  } catch (_) { return false; }
}

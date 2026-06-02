// ── Connectors — pull external sources into the context store ──────────────
//
// Phase 5. A connector is a thin adapter that reads files from an external
// system and feeds each file (with a stable sourceId) into ingestDocument.
// Re-running a connector replaces prior chunks for unchanged sourceIds via
// the context-store's docId mechanism (sha1 of sourceId::sourcePath), so
// sync is naturally idempotent.
//
// Built-in connectors:
//   * github  — uses the user's existing `gh` CLI auth. Walks a repo tree
//               and ingests files matching include globs (default: docs +
//               source). Avoids cloning by using `gh api`.
//   * folder  — walks a local directory respecting include/exclude globs.
//
// Scheduling is intentionally out of scope here: callers can wire these
// functions into task-manager (kind='heartbeat') if they want periodic
// re-sync. The connectors are stateless / pull-based.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ingestDocument } from './context-store.js';

const DEFAULT_INCLUDE = [
  /\.md$/i, /\.markdown$/i, /\.txt$/i, /\.rst$/i,
  /\.js$/i, /\.mjs$/i, /\.cjs$/i, /\.ts$/i, /\.tsx$/i, /\.jsx$/i,
  /\.py$/i, /\.go$/i, /\.rs$/i, /\.java$/i, /\.rb$/i, /\.php$/i,
  /\.json$/i, /\.ya?ml$/i, /\.toml$/i,
];
const DEFAULT_EXCLUDE = [
  /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)dist\//,
  /(^|\/)build\//, /(^|\/)\.next\//, /(^|\/)\.cache\//,
  /(^|\/)coverage\//, /\.lock$/, /package-lock\.json$/,
];

const MAX_FILE_BYTES = 256 * 1024;   // skip files larger than 256KB
const MAX_FILES_PER_RUN = 200;       // safety cap on a single sync

function _matches(patterns, str) {
  return patterns.some(p => p instanceof RegExp ? p.test(str) : str.includes(p));
}

function _shouldInclude(relPath, include, exclude) {
  if (_matches(exclude, relPath)) return false;
  return _matches(include, relPath);
}

// ── GitHub via the `gh` CLI ────────────────────────────────────────────────

function _runGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`gh ${args.join(' ')} exited ${code}: ${err.trim()}`));
      resolve(out);
    });
  });
}

/**
 * Sync a GitHub repository into the context store.
 *
 * @param {object} opts
 * @param {string} opts.repo                — "owner/name"
 * @param {string} [opts.branch='HEAD']
 * @param {string} [opts.containerTag='global']
 * @param {RegExp[]|string[]} [opts.include=DEFAULT_INCLUDE]
 * @param {RegExp[]|string[]} [opts.exclude=DEFAULT_EXCLUDE]
 * @param {number} [opts.maxFiles=MAX_FILES_PER_RUN]
 * @param {Function} [opts.embedder]        — test hook (forwarded)
 * @param {Function} [opts.runner]          — override _runGh for tests
 * @returns {Promise<{ok, repo, branch, ingested, skipped, errors}>}
 */
export async function syncGitHubRepo(opts = {}) {
  if (!opts.repo || !opts.repo.includes('/')) {
    return { ok: false, error: 'repo must be "owner/name"' };
  }
  const runner = opts.runner || _runGh;
  const include = opts.include || DEFAULT_INCLUDE;
  const exclude = opts.exclude || DEFAULT_EXCLUDE;
  const maxFiles = opts.maxFiles ?? MAX_FILES_PER_RUN;
  const branch = opts.branch || 'HEAD';
  const containerTag = opts.containerTag || 'global';

  // List the tree. `gh api repos/{repo}/git/trees/{branch}?recursive=1`
  // returns a flat list of {path, type, sha, size}.
  let tree;
  try {
    const raw = await runner(['api', `repos/${opts.repo}/git/trees/${branch}?recursive=1`]);
    tree = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `tree fetch failed: ${e.message}` };
  }
  const entries = (tree?.tree || []).filter(e => e.type === 'blob');

  const picks = entries
    .filter(e => e.size <= MAX_FILE_BYTES && _shouldInclude(e.path, include, exclude))
    .slice(0, maxFiles);

  let ingested = 0;
  const skipped = entries.length - picks.length;
  const errors = [];
  for (const entry of picks) {
    try {
      // Fetch raw file content via gh api.
      const raw = await runner([
        'api', `repos/${opts.repo}/contents/${entry.path}?ref=${branch}`,
        '-H', 'Accept: application/vnd.github.raw',
      ]);
      const r = await ingestDocument({
        text: raw,
        sourceId: `github:${opts.repo}@${branch}:${entry.path}`,
        sourcePath: entry.path,
        sourceType: 'github',
        title: `${opts.repo}:${entry.path}`,
        containerTag,
      }, { embedder: opts.embedder });
      if (r.ok) ingested++;
      else errors.push({ path: entry.path, error: r.error });
    } catch (e) {
      errors.push({ path: entry.path, error: e.message });
    }
  }

  return {
    ok: true, repo: opts.repo, branch, ingested, skipped, errors,
  };
}

// ── Local folder ───────────────────────────────────────────────────────────

function* _walk(root, rel = '') {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
  catch (_) { return; }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      yield* _walk(root, childRel);
    } else if (e.isFile()) {
      yield childRel;
    }
  }
}

/**
 * Sync a local folder into the context store.
 *
 * @param {object} opts
 * @param {string} opts.path
 * @param {string} [opts.containerTag='global']
 * @param {RegExp[]|string[]} [opts.include=DEFAULT_INCLUDE]
 * @param {RegExp[]|string[]} [opts.exclude=DEFAULT_EXCLUDE]
 * @param {number} [opts.maxFiles=MAX_FILES_PER_RUN]
 * @param {Function} [opts.embedder]
 * @returns {Promise<{ok, root, ingested, skipped, errors}>}
 */
export async function syncLocalFolder(opts = {}) {
  const root = opts.path;
  if (!root || !fs.existsSync(root)) {
    return { ok: false, error: 'path does not exist' };
  }
  const include = opts.include || DEFAULT_INCLUDE;
  const exclude = opts.exclude || DEFAULT_EXCLUDE;
  const maxFiles = opts.maxFiles ?? MAX_FILES_PER_RUN;
  const containerTag = opts.containerTag || 'global';

  const all = [];
  for (const rel of _walk(root)) {
    if (all.length >= maxFiles) break;
    if (_shouldInclude(rel, include, exclude)) all.push(rel);
  }

  let ingested = 0;
  let skipped = 0;
  const errors = [];
  for (const rel of all) {
    const abs = path.join(root, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch (_) { skipped++; continue; }
    if (stat.size > MAX_FILE_BYTES) { skipped++; continue; }
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); }
    catch (e) { errors.push({ path: rel, error: e.message }); continue; }
    try {
      const r = await ingestDocument({
        text,
        sourceId: `folder:${abs}`,
        sourcePath: rel,
        sourceType: 'folder',
        title: rel,
        containerTag,
      }, { embedder: opts.embedder });
      if (r.ok) ingested++;
      else errors.push({ path: rel, error: r.error });
    } catch (e) {
      errors.push({ path: rel, error: e.message });
    }
  }

  return { ok: true, root, ingested, skipped, errors };
}

export const _internals = { DEFAULT_INCLUDE, DEFAULT_EXCLUDE, _shouldInclude, _walk };

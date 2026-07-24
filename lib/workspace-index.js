import fs from 'fs';
import path from 'path';

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',
  '.cache', '.turbo', '.venv', 'venv', '__pycache__', 'target', 'vendor',
]);
const TEXT_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|c|cc|cpp|cxx|h|hh|hpp|cs|rb|php|vue|svelte|html?|css|scss|less|json|ya?ml|toml|md|txt|sh|zsh|fish|sql|graphql)$/i;
const WATCHED_CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 30 * 1000;  // 30 s — guard against rapid rebuilds when fs.watch is unavailable
const MAX_FILE_BYTES = 2_000_000;
const _indexes = new Map();
const _files = new Map();
const _watchers = new Map();

function _ensureWatcher(root) {
  if (_watchers.has(root)) return _watchers.get(root) !== null;
  try {
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      const changedPath = filename ? path.join(root, String(filename)) : root;
      invalidateWorkspaceIndex(changedPath);
    });
    watcher.on('error', () => {});
    watcher.unref?.();
    _watchers.set(root, watcher);
    return true;
  } catch (_) {
    _watchers.set(root, null);
    return false;
  }
}

function _walk(root, relDir, files, includeIgnoredFiles) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true }); }
  catch (_) { return; }
  for (const entry of entries) {
    const rel = relDir ? path.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (includeIgnoredFiles || (!DEFAULT_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))) {
        _walk(root, rel, files, includeIgnoredFiles);
      }
      continue;
    }
    if (entry.isFile() && TEXT_EXT_RE.test(entry.name)) files.push(rel);
  }
}

function _readEntry(root, rel) {
  const absolutePath = path.join(root, rel);
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const cached = _files.get(absolutePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
    const text = fs.readFileSync(absolutePath, 'utf8');
    if (text.includes('\u0000')) return null;
    const entry = {
      path: rel.split(path.sep).join('/'),
      absolutePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      text,
      lines: text.split('\n'),
    };
    _files.set(absolutePath, entry);
    return entry;
  } catch (_) {
    return null;
  }
}

export function readIndexedFile(filePath) {
  const absolutePath = path.resolve(filePath);
  let stat;
  try { stat = fs.statSync(absolutePath); }
  catch (error) { return { ok: false, error: error.message }; }
  if (!stat.isFile()) return { ok: false, error: 'Path is not a file: ' + absolutePath };
  const cached = _files.get(absolutePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return { ok: true, entry: cached, cache: { hit: true } };
  }
  if (stat.size > MAX_FILE_BYTES) {
    try {
      const text = fs.readFileSync(absolutePath, 'utf8');
      if (text.includes('\u0000')) return { ok: false, error: 'File is binary or unreadable: ' + absolutePath };
      return {
        ok: true,
        entry: { path: path.basename(absolutePath), absolutePath, size: stat.size, mtimeMs: stat.mtimeMs, text, lines: text.split('\n') },
        cache: { hit: false, stored: false },
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  const entry = _readEntry(path.dirname(absolutePath), path.basename(absolutePath));
  if (!entry) return { ok: false, error: 'File is binary or unreadable: ' + absolutePath };
  return { ok: true, entry, cache: { hit: false } };
}

export function getWorkspaceIndex(opts = {}) {
  const root = path.resolve(opts.cwd || process.cwd());
  const includeIgnoredFiles = opts.includeIgnoredFiles === true;
  const key = root + '\u0000' + (includeIgnoredFiles ? 'all' : 'source');
  const now = Date.now();
  const cached = _indexes.get(key);
  const watched = _ensureWatcher(root);
  const cacheTtlMs = watched ? WATCHED_CACHE_TTL_MS : FALLBACK_CACHE_TTL_MS;
  if (!opts.force && cached && now - cached.builtAt < cacheTtlMs) {
    return { root, entries: cached.entries, cache: { hit: true, ageMs: now - cached.builtAt, files: cached.entries.length } };
  }

  const paths = [];
  _walk(root, '', paths, includeIgnoredFiles);
  const previousByPath = new Map((cached?.entries || []).map(entry => [entry.path, entry]));
  const entries = [];
  let filesRead = 0;
  let filesReused = 0;
  for (const rel of paths) {
    const normalized = rel.split(path.sep).join('/');
    const previous = previousByPath.get(normalized);
    let stat;
    try { stat = fs.statSync(path.join(root, rel)); } catch (_) { continue; }
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
      entries.push(previous);
      filesReused++;
      continue;
    }
    const entry = _readEntry(root, rel);
    if (entry) {
      entries.push(entry);
      filesRead++;
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  _indexes.set(key, { builtAt: now, entries });
  return { root, entries, cache: { hit: false, ageMs: 0, files: entries.length, filesRead, filesReused } };
}

export function invalidateWorkspaceIndex(targetPath) {
  if (!targetPath) {
    _indexes.clear();
    _files.clear();
    return;
  }
  const absolute = path.resolve(targetPath);
  _files.delete(absolute);
  for (const [key] of _indexes) {
    const root = key.split('\u0000')[0];
    if (absolute === root || absolute.startsWith(root + path.sep) || root.startsWith(absolute + path.sep)) {
      _indexes.delete(key);
    }
  }
}

export function clearWorkspaceIndexes() {
  _indexes.clear();
  _files.clear();
  for (const watcher of _watchers.values()) watcher?.close();
  _watchers.clear();
}

export function searchWorkspace(opts = {}) {
  const query = String(opts.query || '').trim();
  if (!query) return { ok: false, error: 'query required' };
  const index = getWorkspaceIndex(opts);
  const phrase = query.toLowerCase();
  const tokens = [...new Set((phrase.match(/[a-z_$][\w$-]*/g) || []).filter(token => token.length > 1))];
  const maxResults = Math.max(1, Math.min(Number(opts.maxResults) || 20, 100));
  const candidates = [];
  for (const file of index.entries) {
    const pathLower = file.path.toLowerCase();
    let best = null;
    for (let lineIndex = 0; lineIndex < file.lines.length; lineIndex++) {
      const line = file.lines[lineIndex];
      const lower = line.toLowerCase();
      let score = lower.includes(phrase) ? 12 : 0;
      for (const token of tokens) {
        if (lower.includes(token)) score += 3;
        if (pathLower.includes(token)) score += 2;
      }
      if (!score || (best && best.score >= score)) continue;
      const start = Math.max(0, lineIndex - 1);
      const end = Math.min(file.lines.length, lineIndex + 2);
      best = {
        path: file.path,
        line: lineIndex + 1,
        score,
        snippet: file.lines.slice(start, end).join('\n').slice(0, 1000),
      };
    }
    if (best) candidates.push(best);
  }
  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line);
  return {
    ok: true,
    root: index.root,
    query,
    results: candidates.slice(0, maxResults),
    count: Math.min(candidates.length, maxResults),
    truncated: candidates.length > maxResults,
    engine: 'workspace-index-ranked',
    cache: index.cache,
  };
}
import fs from 'fs';
import path from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage']);
const CODE_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs)$/i;

function _walk(root, files = [], relDir = '') {
  let entries;
  try { entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true }); }
  catch (_) { return files; }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) _walk(root, files, path.join(relDir, ent.name));
    } else if (ent.isFile()) {
      const rel = path.join(relDir, ent.name);
      if (CODE_EXT_RE.test(rel)) files.push(rel);
    }
  }
  return files;
}

function _wordRegex(symbol) {
  return new RegExp('\\b' + String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
}

function _lineKind(line, name) {
  if (new RegExp('\\bclass\\s+' + name + '\\b').test(line)) return 'class';
  if (new RegExp('\\bfunction\\s+' + name + '\\b').test(line)) return 'function';
  if (new RegExp('\\b(?:const|let|var)\\s+' + name + '\\b').test(line)) return 'variable';
  if (new RegExp('\\b(?:interface|type)\\s+' + name + '\\b').test(line)) return 'type';
  return 'reference';
}

export function workspaceSymbols(opts = {}) {
  const root = path.resolve(opts.cwd || process.cwd());
  const query = String(opts.query || '').trim();
  const queryRe = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const symbols = [];
  for (const rel of _walk(root)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const patterns = [
        /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
        /\b(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/g,
        /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
        /\b(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/g,
      ];
      for (const pattern of patterns) {
        let m;
        while ((m = pattern.exec(line))) {
          if (queryRe && !queryRe.test(m[1])) continue;
          symbols.push({ name: m[1], kind: _lineKind(line, m[1]), path: rel, line: i + 1, text: line.trim() });
          if (symbols.length >= (opts.maxResults || 200)) return { ok: true, root, symbols, truncated: true };
        }
      }
    }
  }
  return { ok: true, root, symbols, truncated: false };
}

export function symbolReferences(opts = {}) {
  const root = path.resolve(opts.cwd || process.cwd());
  const symbol = String(opts.symbol || '').trim();
  if (!symbol) return { ok: false, error: 'symbol required' };
  const re = _wordRegex(symbol);
  const refs = [];
  for (const rel of _walk(root)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) refs.push({ path: rel, line: i + 1, kind: _lineKind(lines[i], symbol), text: lines[i].trim() });
      if (refs.length >= (opts.maxResults || 500)) return { ok: true, root, symbol, references: refs, truncated: true, engine: 'static-js-ts' };
    }
  }
  return { ok: true, root, symbol, references: refs, truncated: false, engine: 'static-js-ts' };
}

export function symbolDefinition(opts = {}) {
  const refs = symbolReferences(opts);
  if (!refs.ok) return refs;
  const definitions = refs.references.filter(r => r.kind !== 'reference');
  return { ok: true, root: refs.root, symbol: refs.symbol, definitions, engine: refs.engine };
}

export function renameSymbol(opts = {}) {
  const root = path.resolve(opts.cwd || process.cwd());
  const symbol = String(opts.symbol || '').trim();
  const newName = String(opts.newName || '').trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return { ok: false, error: 'valid symbol required' };
  if (!/^[A-Za-z_$][\w$]*$/.test(newName)) return { ok: false, error: 'valid newName required' };
  const re = _wordRegex(symbol);
  const changed = [];
  for (const rel of _walk(root)) {
    const abs = path.join(root, rel);
    const original = fs.readFileSync(abs, 'utf8');
    re.lastIndex = 0;
    if (!re.test(original)) continue;
    const updated = original.replace(_wordRegex(symbol), newName);
    fs.writeFileSync(abs, updated, 'utf8');
    changed.push({ path: rel, replacements: (original.match(_wordRegex(symbol)) || []).length });
  }
  return { ok: true, root, symbol, newName, changed, engine: 'static-js-ts' };
}
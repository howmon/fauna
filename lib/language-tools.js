import fs from 'fs';
import path from 'path';
import { getWorkspaceIndex, invalidateWorkspaceIndex } from './workspace-index.js';

const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|c|cc|cpp|cxx|h|hh|hpp|cs|rb|php|vue|svelte)$/i;

function _wordRegex(symbol) {
  return new RegExp('\\b' + String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
}

function _lineKind(line, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp('\\b(?:class|struct|enum|trait)\\s+' + escaped + '\\b').test(line)) return 'class';
  if (new RegExp('\\b(?:function|def|func|fn)\\s+' + escaped + '\\b').test(line)) return 'function';
  if (new RegExp('\\b(?:const|let|var)\\s+' + escaped + '\\b').test(line)) return 'variable';
  if (new RegExp('\\b(?:interface|type|protocol)\\s+' + escaped + '\\b').test(line)) return 'type';
  return 'reference';
}

const SYMBOL_PATTERNS = [
  /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:def|func|fn)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:struct|enum|trait|protocol)\s+([A-Za-z_$][\w$]*)/g,
];

export function workspaceSymbols(opts = {}) {
  const index = getWorkspaceIndex(opts);
  const root = index.root;
  const query = String(opts.query || '').trim();
  const queryRe = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const symbols = [];
  for (const file of index.entries.filter(entry => CODE_EXT_RE.test(entry.path))) {
    const lines = file.lines;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of SYMBOL_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(line))) {
          if (queryRe && !queryRe.test(m[1])) continue;
          symbols.push({ name: m[1], kind: _lineKind(line, m[1]), path: file.path, line: i + 1, text: line.trim() });
          if (symbols.length >= (opts.maxResults || 200)) return { ok: true, root, symbols, truncated: true, engine: 'workspace-index', cache: index.cache };
        }
      }
    }
  }
  return { ok: true, root, symbols, truncated: false, engine: 'workspace-index', cache: index.cache };
}

export function symbolReferences(opts = {}) {
  const index = getWorkspaceIndex(opts);
  const root = index.root;
  const symbol = String(opts.symbol || '').trim();
  if (!symbol) return { ok: false, error: 'symbol required' };
  const re = _wordRegex(symbol);
  const refs = [];
  for (const file of index.entries.filter(entry => CODE_EXT_RE.test(entry.path))) {
    const lines = file.lines;
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) refs.push({ path: file.path, line: i + 1, kind: _lineKind(lines[i], symbol), text: lines[i].trim() });
      if (refs.length >= (opts.maxResults || 500)) return { ok: true, root, symbol, references: refs, truncated: true, engine: 'workspace-index', cache: index.cache };
    }
  }
  return { ok: true, root, symbol, references: refs, truncated: false, engine: 'workspace-index', cache: index.cache };
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
  const index = getWorkspaceIndex(opts);
  for (const file of index.entries.filter(entry => CODE_EXT_RE.test(entry.path))) {
    const abs = file.absolutePath;
    const original = file.text;
    re.lastIndex = 0;
    if (!re.test(original)) continue;
    const updated = original.replace(_wordRegex(symbol), newName);
    fs.writeFileSync(abs, updated, 'utf8');
    changed.push({ path: file.path, replacements: (original.match(_wordRegex(symbol)) || []).length });
  }
  invalidateWorkspaceIndex(root);
  return { ok: true, root, symbol, newName, changed, engine: 'workspace-index' };
}
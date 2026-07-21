import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { workspaceSymbols, symbolDefinition, symbolReferences, renameSymbol } from '../lib/language-tools.js';
import { clearWorkspaceIndexes, getWorkspaceIndex, searchWorkspace } from '../lib/workspace-index.js';

const _created = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-lang-'));
  _created.push(dir);
  fs.writeFileSync(path.join(dir, 'app.ts'), [
    'export function greet(name) {',
    '  return helper(name);',
    '}',
    'const helper = (value) => value;',
    'greet("Ada");',
  ].join('\n'), 'utf8');
  return dir;
}

afterEach(() => {
  clearWorkspaceIndexes();
  while (_created.length) {
    try { fs.rmSync(_created.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('language tools', () => {
  it('lists workspace symbols', () => {
    const dir = fixture();
    const r = workspaceSymbols({ cwd: dir, query: 'greet' });
    expect(r.ok).toBe(true);
    expect(r.symbols[0]).toMatchObject({ name: 'greet', kind: 'function', path: 'app.ts', line: 1 });
  });

  it('finds definitions and references', () => {
    const dir = fixture();
    const defs = symbolDefinition({ cwd: dir, symbol: 'greet' });
    const refs = symbolReferences({ cwd: dir, symbol: 'greet' });
    expect(defs.definitions[0]).toMatchObject({ path: 'app.ts', line: 1, kind: 'function' });
    expect(refs.references.map(r => r.line)).toEqual([1, 5]);
  });

  it('renames identifiers across JS/TS files', () => {
    const dir = fixture();
    const r = renameSymbol({ cwd: dir, symbol: 'greet', newName: 'welcome' });
    expect(r.ok).toBe(true);
    expect(r.changed[0]).toMatchObject({ path: 'app.ts', replacements: 2 });
    expect(fs.readFileSync(path.join(dir, 'app.ts'), 'utf8')).toContain('function welcome');
    expect(fs.readFileSync(path.join(dir, 'app.ts'), 'utf8')).toContain('welcome("Ada")');
  });

  it('indexes symbols across languages and reuses cached files', () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'worker.py'), 'def process_document(value):\n    return value\n', 'utf8');
    const first = workspaceSymbols({ cwd: dir, query: 'process_document' });
    const second = workspaceSymbols({ cwd: dir, query: 'process_document' });
    expect(first.symbols[0]).toMatchObject({ name: 'process_document', kind: 'function', path: 'worker.py', line: 1 });
    expect(first.cache.hit).toBe(false);
    expect(second.cache.hit).toBe(true);
  });

  it('refreshes only changed files and ranks natural-language workspace results', () => {
    const dir = fixture();
    getWorkspaceIndex({ cwd: dir });
    fs.writeFileSync(path.join(dir, 'reader.ts'), 'export function parseScriptureReference() { return true; }\n', 'utf8');
    const refreshed = getWorkspaceIndex({ cwd: dir, force: true });
    expect(refreshed.cache.filesRead).toBe(1);
    expect(refreshed.cache.filesReused).toBe(1);
    const found = searchWorkspace({ cwd: dir, query: 'parse scripture reference' });
    expect(found.results[0]).toMatchObject({ path: 'reader.ts', line: 1 });
  });
});

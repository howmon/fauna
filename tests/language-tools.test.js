import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { workspaceSymbols, symbolDefinition, symbolReferences, renameSymbol } from '../lib/language-tools.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'fauna-lang-'));
  fs.writeFileSync(path.join(dir, 'app.ts'), [
    'export function greet(name) {',
    '  return helper(name);',
    '}',
    'const helper = (value) => value;',
    'greet("Ada");',
  ].join('\n'), 'utf8');
  return dir;
}

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
});

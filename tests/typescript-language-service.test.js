import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  disposeTypeScriptServices,
  semanticDefinition,
  semanticDiagnostics,
  semanticReferences,
  semanticRename,
  semanticWorkspaceSymbols,
} from '../lib/typescript-language-service.js';
import { clearWorkspaceIndexes } from '../lib/workspace-index.js';

const created = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-ts-service-'));
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'scopes.ts'), [
    'export function first() {',
    '  const value = 1;',
    '  return value + 1;',
    '}',
    'export function second() {',
    '  const value = 2;',
    '  return value + 2;',
    '}',
  ].join('\n'), 'utf8');
  return dir;
}

afterEach(() => {
  disposeTypeScriptServices();
  clearWorkspaceIndexes();
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
});

describe('TypeScript language service adapter', () => {
  it('resolves definitions and references within the anchored lexical scope', () => {
    const cwd = fixture();
    const anchor = { cwd, path: 'scopes.ts', line: 3, column: 10, symbol: 'value' };
    const definition = semanticDefinition(anchor);
    const references = semanticReferences(anchor);
    expect(definition.engine).toBe('typescript-language-service');
    expect(definition.definitions).toHaveLength(1);
    expect(definition.definitions[0]).toMatchObject({ path: 'scopes.ts', line: 2, column: 9 });
    expect(references.references.map(reference => reference.line).sort()).toEqual([2, 3]);
  });

  it('previews semantic rename and applies only the anchored scope', () => {
    const cwd = fixture();
    const args = { cwd, path: 'scopes.ts', line: 3, column: 10, symbol: 'value', newName: 'firstValue' };
    const before = fs.readFileSync(path.join(cwd, 'scopes.ts'), 'utf8');
    const preview = semanticRename(args);
    expect(preview).toMatchObject({ ok: true, preview: true, engine: 'typescript-language-service' });
    expect(preview.changed[0].replacements).toBe(2);
    expect(fs.readFileSync(path.join(cwd, 'scopes.ts'), 'utf8')).toBe(before);

    const applied = semanticRename({ ...args, apply: true });
    expect(applied.preview).toBe(false);
    const updated = fs.readFileSync(path.join(cwd, 'scopes.ts'), 'utf8');
    expect(updated.match(/firstValue/g)).toHaveLength(2);
    expect(updated.match(/\bvalue\b/g)).toHaveLength(2);
  });

  it('returns structured semantic diagnostics', () => {
    const cwd = fixture();
    fs.writeFileSync(path.join(cwd, 'broken.ts'), 'const count: number = "wrong";\n', 'utf8');
    clearWorkspaceIndexes();
    const result = semanticDiagnostics({ cwd, path: 'broken.ts' });
    expect(result.engine).toBe('typescript-language-service');
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 2322)).toBe(true);
    expect(result.diagnostics[0]).toMatchObject({ path: 'broken.ts', line: 1, severity: 'error', source: 'typescript' });
  });

  it('discovers methods through the TypeScript navigation tree', () => {
    const cwd = fixture();
    fs.writeFileSync(path.join(cwd, 'reader.ts'), 'export class Reader {\n  parseVerse() { return 1; }\n}\n', 'utf8');
    clearWorkspaceIndexes();
    const result = semanticWorkspaceSymbols({ cwd, query: 'parseVerse' });
    expect(result.symbols[0]).toMatchObject({ name: 'parseVerse', path: 'reader.ts', line: 2 });
  });
});
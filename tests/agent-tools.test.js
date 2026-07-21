import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { getBuiltInToolDefinitions, executeBuiltInTool } from '../agent-tools.js';

describe('agent built-in file tools', () => {
  it('exposes read-only repository search with file-read access', () => {
    const defs = getBuiltInToolDefinitions({ fileRead: ['/tmp'] });
    expect(defs.map(def => def.function.name)).toContain('agent_search_files');
  });

  it('searches only within allowed read paths', async () => {
    const dir = fs.mkdtempSync('/tmp/fauna-agent-search-');
    fs.writeFileSync(path.join(dir, 'one.js'), 'const targetValue = 1;\n', 'utf8');

    const result = JSON.parse(await executeBuiltInTool('agent_search_files', {
      path: dir,
      query: 'targetValue',
    }, { fileRead: [dir] }, 'test-agent'));

    expect(result.matchCount).toBe(1);
    expect(result.results[0]).toEqual(expect.objectContaining({ relativePath: 'one.js', line: 1 }));

    const blocked = await executeBuiltInTool('agent_search_files', {
      path: path.dirname(dir),
      query: 'targetValue',
    }, { fileRead: [dir] }, 'test-agent');
    expect(blocked).toMatch(/^BLOCKED:/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects regular expressions in bounded repository search', async () => {
    const result = await executeBuiltInTool('agent_search_files', {
      path: '/tmp',
      query: '(a+)+',
      regex: true,
    }, { fileRead: ['/tmp'] }, 'test-agent');
    expect(result).toContain('supports literal text only');
  });

  it('blocks writes through symlinks that escape the allowlist', async () => {
    const allowedDir = fs.mkdtempSync('/tmp/fauna-agent-allowed-');
    const outsideDir = fs.mkdtempSync('/tmp/fauna-agent-outside-');
    const outsideFile = path.join(outsideDir, 'note.txt');
    fs.writeFileSync(outsideFile, 'outside\n', 'utf8');
    fs.symlinkSync(outsideFile, path.join(allowedDir, 'linked.txt'));

    const result = await executeBuiltInTool('agent_write_file', {
      path: path.join(allowedDir, 'linked.txt'),
      content: 'changed\n',
    }, { fileWrite: [allowedDir] }, 'test-agent');

    expect(result).toMatch(/^BLOCKED:/);
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside\n');
    fs.rmSync(allowedDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('exposes agent_apply_patch when write access is granted', () => {
    const defs = getBuiltInToolDefinitions({ fileWrite: ['/tmp'] });
    const names = defs.map(def => def.function.name);

    expect(names).toContain('agent_apply_patch');
  });

  it('applies a patch through the same permissioned edit path as Fauna chat', async () => {
    const dir = fs.mkdtempSync('/tmp/fauna-agent-patch-');
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'one\n', 'utf8');

    const patch = [
      '*** Begin Patch',
      '*** Update File: note.txt',
      '@@',
      '-one',
      '+two',
      '*** End Patch',
    ].join('\n');

    const result = await executeBuiltInTool('agent_apply_patch', { patch, cwd: dir }, {
      fileWrite: [dir],
    }, 'test-agent');

    expect(result).toContain('Patch applied:');
    expect(fs.readFileSync(file, 'utf8')).toBe('two\n');
  });

  it('blocks patches outside the agent write allowlist', async () => {
    const dir = fs.mkdtempSync('/tmp/fauna-agent-patch-');
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'one\n', 'utf8');

    const patch = [
      '*** Begin Patch',
      '*** Update File: note.txt',
      '@@',
      '-one',
      '+two',
      '*** End Patch',
    ].join('\n');

    const result = await executeBuiltInTool('agent_apply_patch', { patch, cwd: dir }, {
      fileWrite: [path.join(dir, 'other')],
    }, 'test-agent');

    expect(result).toMatch(/^BLOCKED:/);
    expect(fs.readFileSync(file, 'utf8')).toBe('one\n');
  });
});
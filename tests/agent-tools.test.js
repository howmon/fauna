import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { getBuiltInToolDefinitions, executeBuiltInTool } from '../agent-tools.js';

describe('agent built-in file tools', () => {
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
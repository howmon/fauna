// Unit tests for the playbook store.
// Uses FAUNA_PLAYBOOK_FILE to point the store at a tmp file.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = path.join(os.tmpdir(), 'fauna-playbook-test-' + process.pid + '.json');
process.env.FAUNA_PLAYBOOK_FILE = TMP;

// Import after setting env so the module's _playbookFile() picks it up.
const {
  savePlaybookEntry, listPlaybookEntries, getPlaybookEntry,
  touchPlaybookEntry, deletePlaybookEntry, _resetForTests,
} = await import('../playbook-store.js');

function freshBundle() {
  return { html: '<div id="cube"></div>', css: '#cube{width:80px}', js: 'widget.on("rotate",()=>({ok:true}));' };
}

describe('playbook-store', () => {
  beforeEach(() => {
    try { fs.unlinkSync(TMP); } catch (_) {}
    _resetForTests();
  });

  afterAll(() => {
    try { fs.unlinkSync(TMP); } catch (_) {}
  });

  it('saves and retrieves an entry', () => {
    const result = savePlaybookEntry({
      name: '3D Viewer',
      description: 'rotating cube',
      tags: ['three', '3d'],
      bundle: freshBundle(),
      tools: [{ name: 'rotate', description: 'rotate the cube', parameters: { type: 'object' } }],
    });
    expect(result.ok).toBe(true);
    expect(result.replaced).toBe(false);

    const found = getPlaybookEntry('3D Viewer');
    expect(found).not.toBeNull();
    expect(found.name).toBe('3D Viewer');
    expect(found.tools).toHaveLength(1);
    expect(found.bundle.js).toContain('rotate');
  });

  it('lists entries with size info but without bundle bytes', () => {
    savePlaybookEntry({ name: 'A', bundle: freshBundle(), tools: [] });
    savePlaybookEntry({ name: 'B', bundle: freshBundle(), tools: [{ name: 'go' }] });

    const list = listPlaybookEntries();
    expect(list).toHaveLength(2);
    expect(list[0].bundle).toBeUndefined();
    expect(list[0].bundleSize).toBeGreaterThan(0);
    expect(list.find(e => e.name === 'B').toolNames).toEqual(['go']);
  });

  it('dedups by name on save (replace)', () => {
    savePlaybookEntry({ name: 'Dup', bundle: freshBundle(), tools: [] });
    const r2 = savePlaybookEntry({ name: 'Dup', description: 'updated', bundle: freshBundle(), tools: [] });
    expect(r2.replaced).toBe(true);
    expect(listPlaybookEntries()).toHaveLength(1);
    expect(getPlaybookEntry('Dup').description).toBe('updated');
  });

  it('touchPlaybookEntry increments useCount and updates lastUsedAt', () => {
    savePlaybookEntry({ name: 'T', bundle: freshBundle(), tools: [] });
    const beforeCount = getPlaybookEntry('T').useCount;
    const beforeUsed = getPlaybookEntry('T').lastUsedAt;
    const touched = touchPlaybookEntry('T');
    expect(touched.useCount).toBe(beforeCount + 1);
    expect(touched.lastUsedAt).toBeGreaterThanOrEqual(beforeUsed);
  });

  it('deletes by name', () => {
    savePlaybookEntry({ name: 'X', bundle: freshBundle(), tools: [] });
    const res = deletePlaybookEntry('X');
    expect(res.ok).toBe(true);
    expect(getPlaybookEntry('X')).toBeNull();
  });

  it('rejects oversized bundles', () => {
    const big = { html: 'a'.repeat(300 * 1024), js: 'b' };
    expect(() => savePlaybookEntry({ name: 'Big', bundle: big, tools: [] })).toThrow(/too large/i);
  });

  it('rejects invalid tool names', () => {
    expect(() => savePlaybookEntry({
      name: 'Bad', bundle: freshBundle(), tools: [{ name: '9starts-with-number' }],
    })).toThrow(/Invalid tool name/);
  });

  it('rejects duplicate tool names within one widget', () => {
    expect(() => savePlaybookEntry({
      name: 'Dup', bundle: freshBundle(), tools: [{ name: 'foo' }, { name: 'foo' }],
    })).toThrow(/Duplicate tool name/);
  });

  it('lookup is case-insensitive by name', () => {
    savePlaybookEntry({ name: 'CaseTest', bundle: freshBundle(), tools: [] });
    expect(getPlaybookEntry('casetest')).not.toBeNull();
    expect(getPlaybookEntry('CASETEST')).not.toBeNull();
  });
});

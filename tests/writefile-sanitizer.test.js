import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadStateHarness() {
  var statePath = path.join(process.cwd(), 'public/js/state.js');
  var source = fs.readFileSync(statePath, 'utf8');
  var storage = new Map();
  var warn = vi.fn();
  var context = {
    console: { log: vi.fn(), warn: warn },
    localStorage: {
      getItem: vi.fn(function(key) { return storage.has(key) ? storage.get(key) : null; }),
      setItem: vi.fn(function(key, value) { storage.set(key, String(value)); }),
      removeItem: vi.fn(function(key) { storage.delete(key); }),
    },
    JSON: JSON,
    Date: Date,
    Math: Math,
  };
  vm.runInNewContext(source + '\n;globalThis.__sanitizeWriteFileBlocks = sanitizeWriteFileBlocks; globalThis.__wfContentStore = _wfContentStore;', context);
  return {
    sanitize: context.__sanitizeWriteFileBlocks,
    store: context.__wfContentStore,
    warn: warn,
  };
}

describe('sanitizeWriteFileBlocks', () => {
  it('extracts complete write-file blocks into the side-channel store', () => {
    var harness = loadStateHarness();
    var result = harness.sanitize('before\n```write-file:/tmp/example.txt\nhello\n```\nafter');
    var ids = Object.keys(harness.store);

    expect(ids).toHaveLength(1);
    expect(harness.store[ids[0]]).toMatchObject({
      path: '/tmp/example.txt',
      content: 'hello\n',
      mode: 'write-file',
    });
    expect(result).toContain('```write-file-ready:' + ids[0] + ':/tmp/example.txt');
    expect(result).not.toContain('hello');
  });

  it('neutralizes unterminated write-file blocks instead of leaving runnable markdown', () => {
    var harness = loadStateHarness();
    var result = harness.sanitize('before\n```write-file:/tmp/partial.txt\npartial bytes');

    expect(Object.keys(harness.store)).toHaveLength(0);
    expect(result).toContain('```text\nCreating partial.txt was not rendered or run because the closing fence was missing.');
    expect(result).not.toContain('write-file-ready');
    expect(result).not.toContain('```write-file:/tmp/partial.txt');
    expect(result).not.toContain('partial bytes');
    expect(harness.warn).toHaveBeenCalledTimes(1);
  });

  it('warns only once for the same unterminated block rendered repeatedly', () => {
    var harness = loadStateHarness();
    var raw = '```append-file:/tmp/log.md\nunfinished';

    harness.sanitize(raw);
    harness.sanitize(raw);

    expect(harness.warn).toHaveBeenCalledTimes(1);
  });
});
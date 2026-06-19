// Tests for writeSourceFileBytes (drag-and-drop upload backing fn) and
// createSourceEntry. Mocks projects.json fs reads/writes for in-memory
// project state, but delegates source-root file ops to real fs so we can
// assert disk side-effects.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';

let _diskProjects = [];

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  function _isProjectsFile(p) { return typeof p === 'string' && p.endsWith('projects.json'); }
  const readFn = vi.fn((p, ...rest) => {
    if (_isProjectsFile(p)) return JSON.stringify(_diskProjects);
    return actual.readFileSync(p, ...rest);
  });
  const writeFn = vi.fn((p, body, ...rest) => {
    if (_isProjectsFile(p)) {
      try { _diskProjects = JSON.parse(body); } catch (_) {}
      return;
    }
    return actual.writeFileSync(p, body, ...rest);
  });
  return {
    ...actual,
    default: { ...actual, readFileSync: readFn, writeFileSync: writeFn },
    readFileSync: readFn,
    writeFileSync: writeFn,
  };
});

const pm = await import('../project-manager.js');
const {
  writeSourceFileBytes,
  createSourceEntry,
  listFiles,
  renameSourceEntry,
  deleteSourceEntry,
  getSourceEntryAbsolutePath,
} = pm;

// Anchor test files under HOME so the path-traversal sanity check (which
// stays internal to project-manager) doesn't trip on macOS's /var/folders
// tmpdir aliasing.
const _home = process.env.HOME || os.homedir();
let _tmpRoot;

beforeEach(() => {
  _diskProjects = [];
  _tmpRoot = fs.mkdtempSync(path.join(_home, '.fauna-upload-test-'));
  _diskProjects.push({
    id: 'p1', name: 'P', color: 'teal',
    rootPath: _tmpRoot,
    sources: [{ id: 'src1', name: 'Files', type: 'local', path: _tmpRoot }],
    contexts: [], connectors: [], conversationIds: [], taskIds: [],
    backlog: [],
  });
});
afterEach(() => {
  try { fs.rmSync(_tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

describe('writeSourceFileBytes', () => {
  it('writes a binary file at the source root', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const r = writeSourceFileBytes('p1', 'src1', 'logo.png', bytes);
    expect(r).toEqual({ path: 'logo.png', type: 'file', size: 4 });
    expect(fs.readFileSync(path.join(_tmpRoot, 'logo.png'))).toEqual(bytes);
  });

  it('creates missing parent directories', () => {
    const bytes = Buffer.from('hello');
    writeSourceFileBytes('p1', 'src1', 'a/b/c/note.txt', bytes);
    expect(fs.readFileSync(path.join(_tmpRoot, 'a/b/c/note.txt'), 'utf8')).toBe('hello');
  });

  it('refuses to overwrite by default', () => {
    writeSourceFileBytes('p1', 'src1', 'doc.txt', Buffer.from('v1'));
    expect(() => writeSourceFileBytes('p1', 'src1', 'doc.txt', Buffer.from('v2')))
      .toThrow(/already exists/i);
    expect(fs.readFileSync(path.join(_tmpRoot, 'doc.txt'), 'utf8')).toBe('v1');
  });

  it('overwrites when { overwrite: true }', () => {
    writeSourceFileBytes('p1', 'src1', 'doc.txt', Buffer.from('v1'));
    writeSourceFileBytes('p1', 'src1', 'doc.txt', Buffer.from('v2'), { overwrite: true });
    expect(fs.readFileSync(path.join(_tmpRoot, 'doc.txt'), 'utf8')).toBe('v2');
  });

  it('rejects path traversal via ..', () => {
    expect(() => writeSourceFileBytes('p1', 'src1', '../escape.txt', Buffer.from('x')))
      .toThrow(/traversal|invalid/i);
  });

  it('rejects null bytes in filenames', () => {
    expect(() => writeSourceFileBytes('p1', 'src1', 'bad\0name.txt', Buffer.from('x')))
      .toThrow(/invalid/i);
  });

  it('rejects non-Buffer payloads', () => {
    expect(() => writeSourceFileBytes('p1', 'src1', 'x.txt', 'string'))
      .toThrow(/Buffer/);
  });

  it('refuses to overwrite a directory with a file even with overwrite=true', () => {
    fs.mkdirSync(path.join(_tmpRoot, 'somedir'));
    expect(() => writeSourceFileBytes('p1', 'src1', 'somedir', Buffer.from('x'), { overwrite: true }))
      .toThrow(/directory/i);
  });

  it('writes to __rootpath__ when no explicit source is selected', () => {
    writeSourceFileBytes('p1', '__rootpath__', 'top.txt', Buffer.from('hi'));
    expect(fs.readFileSync(path.join(_tmpRoot, 'top.txt'), 'utf8')).toBe('hi');
  });

  it('newly written files show up in listFiles', () => {
    writeSourceFileBytes('p1', 'src1', 'sub/img.png', Buffer.from([1, 2, 3]));
    const entries = listFiles('p1', 'src1', 'sub');
    const names = entries.map(e => e.name);
    expect(names).toContain('img.png');
  });
});

describe('createSourceEntry (regression — used by the same route module)', () => {
  it('creates an empty file at the requested path', () => {
    const r = createSourceEntry('p1', 'src1', 'fresh.md', 'file');
    expect(r).toEqual({ path: 'fresh.md', type: 'file' });
    expect(fs.readFileSync(path.join(_tmpRoot, 'fresh.md'), 'utf8')).toBe('');
  });

  it('creates an empty directory', () => {
    createSourceEntry('p1', 'src1', 'newdir', 'dir');
    expect(fs.statSync(path.join(_tmpRoot, 'newdir')).isDirectory()).toBe(true);
  });
});

describe('renameSourceEntry', () => {
  it('renames a file inside the source root', () => {
    writeSourceFileBytes('p1', 'src1', 'old.txt', Buffer.from('x'), {});
    const out = renameSourceEntry('p1', 'src1', 'old.txt', 'new.txt');
    expect(out.oldPath).toBe('old.txt');
    expect(out.newPath).toBe('new.txt');
    expect(out.type).toBe('file');
    expect(fs.existsSync(path.join(_tmpRoot, 'old.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(_tmpRoot, 'new.txt'), 'utf8')).toBe('x');
  });

  it('moves a file into a nested directory (creating it if needed)', () => {
    writeSourceFileBytes('p1', 'src1', 'a.txt', Buffer.from('hi'), {});
    renameSourceEntry('p1', 'src1', 'a.txt', 'sub/b.txt');
    expect(fs.readFileSync(path.join(_tmpRoot, 'sub/b.txt'), 'utf8')).toBe('hi');
  });

  it('renames a directory recursively', () => {
    writeSourceFileBytes('p1', 'src1', 'folder/inner.txt', Buffer.from('z'), {});
    renameSourceEntry('p1', 'src1', 'folder', 'renamed');
    expect(fs.existsSync(path.join(_tmpRoot, 'folder'))).toBe(false);
    expect(fs.readFileSync(path.join(_tmpRoot, 'renamed/inner.txt'), 'utf8')).toBe('z');
  });

  it('refuses to overwrite an existing destination', () => {
    writeSourceFileBytes('p1', 'src1', 'a.txt', Buffer.from('a'), {});
    writeSourceFileBytes('p1', 'src1', 'b.txt', Buffer.from('b'), {});
    expect(() => renameSourceEntry('p1', 'src1', 'a.txt', 'b.txt')).toThrow(/exists/i);
    expect(fs.readFileSync(path.join(_tmpRoot, 'b.txt'), 'utf8')).toBe('b');
  });

  it('rejects path traversal in either argument', () => {
    writeSourceFileBytes('p1', 'src1', 'safe.txt', Buffer.from('s'), {});
    expect(() => renameSourceEntry('p1', 'src1', '../escape', 'x')).toThrow();
    expect(() => renameSourceEntry('p1', 'src1', 'safe.txt', '../escape')).toThrow();
  });

  it('throws when the source entry does not exist', () => {
    expect(() => renameSourceEntry('p1', 'src1', 'nope.txt', 'x.txt')).toThrow(/not found/i);
  });
});

describe('deleteSourceEntry', () => {
  it('deletes a file', () => {
    writeSourceFileBytes('p1', 'src1', 'gone.txt', Buffer.from('x'), {});
    const out = deleteSourceEntry('p1', 'src1', 'gone.txt');
    expect(out).toEqual({ path: 'gone.txt', type: 'file' });
    expect(fs.existsSync(path.join(_tmpRoot, 'gone.txt'))).toBe(false);
  });

  it('deletes a directory recursively', () => {
    writeSourceFileBytes('p1', 'src1', 'wipeme/a/b.txt', Buffer.from('1'), {});
    writeSourceFileBytes('p1', 'src1', 'wipeme/c.txt',   Buffer.from('2'), {});
    const out = deleteSourceEntry('p1', 'src1', 'wipeme');
    expect(out).toEqual({ path: 'wipeme', type: 'dir' });
    expect(fs.existsSync(path.join(_tmpRoot, 'wipeme'))).toBe(false);
  });

  it('rejects path traversal', () => {
    expect(() => deleteSourceEntry('p1', 'src1', '../escape')).toThrow();
  });

  it('throws when the path does not exist', () => {
    expect(() => deleteSourceEntry('p1', 'src1', 'nope')).toThrow(/not found/i);
  });
});

describe('getSourceEntryAbsolutePath', () => {
  it('returns the absolute path and type for a file', () => {
    writeSourceFileBytes('p1', 'src1', 'visible.txt', Buffer.from('v'), {});
    const out = getSourceEntryAbsolutePath('p1', 'src1', 'visible.txt');
    expect(out.type).toBe('file');
    expect(path.resolve(out.fullPath)).toBe(path.resolve(path.join(_tmpRoot, 'visible.txt')));
  });

  it('returns the absolute path and type for a directory', () => {
    createSourceEntry('p1', 'src1', 'dirname', 'dir');
    const out = getSourceEntryAbsolutePath('p1', 'src1', 'dirname');
    expect(out.type).toBe('dir');
    expect(path.resolve(out.fullPath)).toBe(path.resolve(path.join(_tmpRoot, 'dirname')));
  });

  it('rejects path traversal', () => {
    expect(() => getSourceEntryAbsolutePath('p1', 'src1', '../escape')).toThrow();
  });

  it('throws when the entry is missing', () => {
    expect(() => getSourceEntryAbsolutePath('p1', 'src1', 'missing.txt')).toThrow(/not found/i);
  });
});

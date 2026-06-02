import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';

globalThis.__memFs = globalThis.__memFs || new Map();
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const memFs = globalThis.__memFs;
  // tree: path -> { type: 'dir' | 'file', content?: string, size?: number }
  globalThis.__memTree = globalThis.__memTree || new Map();
  const tree = globalThis.__memTree;

  function dirent(name, isDir) {
    return { name, isDirectory: () => isDir, isFile: () => !isDir };
  }

  const api = {
    readFileSync: vi.fn((p, enc) => {
      if (tree.has(p)) {
        const node = tree.get(p);
        if (node.type === 'file') return node.content;
      }
      if (memFs.has(p)) return memFs.get(p);
      throw enoent();
    }),
    writeFileSync: vi.fn((p, d) => { memFs.set(p, d); }),
    mkdirSync: vi.fn(),
    existsSync: vi.fn((p) => tree.has(p) || memFs.has(p)),
    unlinkSync: vi.fn((p) => { memFs.delete(p); }),
    statSync: vi.fn((p) => {
      const node = tree.get(p);
      if (!node || node.type !== 'file') throw enoent();
      return { size: node.size ?? Buffer.byteLength(node.content || '', 'utf8'), isFile: () => true, isDirectory: () => false };
    }),
    readdirSync: vi.fn((p, opts) => {
      const prefix = p.endsWith('/') ? p : p + '/';
      const children = new Map();
      for (const key of tree.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        const seg = rest.split('/')[0];
        if (!seg) continue;
        const isDir = rest.includes('/') || tree.get(key).type === 'dir';
        children.set(seg, isDir);
      }
      const out = Array.from(children.entries()).map(([n, isDir]) => dirent(n, isDir));
      return opts && opts.withFileTypes ? out : out.map(d => d.name);
    }),
  };
  return { ...actual, default: { ...actual, ...api }, ...api };
});

const { _resetCache: resetCtx, listDocuments, getStats } = await import('../server/lib/context-store.js');
const { _resetCache: resetEmbed } = await import('../server/lib/embeddings.js');
const { syncGitHubRepo, syncLocalFolder, _internals } = await import('../server/lib/connectors.js');

const VOCAB = ['foo', 'bar', 'baz'];
const stubEmbed = (texts) => texts.map(t => VOCAB.map(v => String(t).toLowerCase().includes(v) ? 1 : 0));

beforeEach(() => {
  globalThis.__memFs.clear();
  globalThis.__memTree.clear();
  resetCtx();
  resetEmbed();
  vi.clearAllMocks();
});

describe('connectors._shouldInclude', () => {
  it('includes default doc + source extensions', () => {
    const { _shouldInclude, DEFAULT_INCLUDE, DEFAULT_EXCLUDE } = _internals;
    expect(_shouldInclude('README.md', DEFAULT_INCLUDE, DEFAULT_EXCLUDE)).toBe(true);
    expect(_shouldInclude('src/foo.ts', DEFAULT_INCLUDE, DEFAULT_EXCLUDE)).toBe(true);
  });

  it('excludes node_modules / .git / lock files', () => {
    const { _shouldInclude, DEFAULT_INCLUDE, DEFAULT_EXCLUDE } = _internals;
    expect(_shouldInclude('node_modules/foo/index.js', DEFAULT_INCLUDE, DEFAULT_EXCLUDE)).toBe(false);
    expect(_shouldInclude('.git/HEAD', DEFAULT_INCLUDE, DEFAULT_EXCLUDE)).toBe(false);
    expect(_shouldInclude('package-lock.json', DEFAULT_INCLUDE, DEFAULT_EXCLUDE)).toBe(false);
  });

  it('rejects unknown extensions', () => {
    const { _shouldInclude, DEFAULT_INCLUDE, DEFAULT_EXCLUDE } = _internals;
    expect(_shouldInclude('img/photo.png', DEFAULT_INCLUDE, DEFAULT_EXCLUDE)).toBe(false);
  });
});

describe('syncGitHubRepo', () => {
  it('rejects missing or malformed repo', async () => {
    expect((await syncGitHubRepo({})).ok).toBe(false);
    expect((await syncGitHubRepo({ repo: 'no-slash' })).ok).toBe(false);
  });

  it('ingests filtered tree entries via injected runner', async () => {
    const tree = {
      tree: [
        { path: 'README.md', type: 'blob', size: 200 },
        { path: 'src/index.js', type: 'blob', size: 150 },
        { path: 'node_modules/junk.js', type: 'blob', size: 100 }, // excluded
        { path: 'docs', type: 'tree', size: 0 },                    // not a blob
        { path: 'image.png', type: 'blob', size: 100 },             // not included
        { path: 'huge.md', type: 'blob', size: 9999999 },           // too big
      ],
    };
    const runner = vi.fn(async (args) => {
      if (args[1].includes('git/trees')) return JSON.stringify(tree);
      // raw fetch
      const m = args[1].match(/contents\/(.+)\?/);
      return `content of ${m[1]}`;
    });

    const r = await syncGitHubRepo({
      repo: 'acme/widgets', branch: 'main',
      runner, embedder: stubEmbed, containerTag: 'project:p',
    });
    expect(r.ok).toBe(true);
    expect(r.ingested).toBe(2);
    // skipped is computed against blobs only (the 'tree' entry is filtered
    // out before counting), so 5 blobs - 2 picked = 3.
    expect(r.skipped).toBe(3);
    const docs = listDocuments();
    expect(docs.map(d => d.sourcePath).sort()).toEqual(['README.md', 'src/index.js']);
    expect(docs.every(d => d.sourceType === 'github')).toBe(true);
  });

  it('returns error when tree fetch fails', async () => {
    const runner = vi.fn(async () => { throw new Error('gh exited 1'); });
    const r = await syncGitHubRepo({ repo: 'a/b', runner, embedder: stubEmbed });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tree fetch failed/);
  });

  it('captures per-file errors without aborting', async () => {
    const tree = { tree: [
      { path: 'a.md', type: 'blob', size: 10 },
      { path: 'b.md', type: 'blob', size: 10 },
    ]};
    let n = 0;
    const runner = vi.fn(async (args) => {
      if (args[1].includes('git/trees')) return JSON.stringify(tree);
      n++;
      if (n === 1) throw new Error('fetch a failed');
      return 'b body';
    });
    const r = await syncGitHubRepo({ repo: 'a/b', runner, embedder: stubEmbed });
    expect(r.ingested).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].path).toBe('a.md');
  });
});

describe('syncLocalFolder', () => {
  function seed(root, files) {
    const tree = globalThis.__memTree;
    tree.set(root, { type: 'dir' });
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      // Ensure each parent dir exists as a tree node so existsSync works.
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = path.join(root, parts.slice(0, i).join('/'));
        if (!tree.has(dir)) tree.set(dir, { type: 'dir' });
      }
      tree.set(abs, { type: 'file', content });
    }
  }

  it('rejects missing path', async () => {
    expect((await syncLocalFolder({ path: '/does/not/exist' })).ok).toBe(false);
  });

  it('walks folder and ingests matching files', async () => {
    const root = '/repo';
    seed(root, {
      'README.md': '# title',
      'src/foo.ts': 'export const foo = 1;',
      'src/index.js': 'console.log(1);',
      'node_modules/skip.js': 'no',
      'image.png': 'binary',
    });
    const r = await syncLocalFolder({ path: root, embedder: stubEmbed, containerTag: 'global' });
    expect(r.ok).toBe(true);
    expect(r.ingested).toBe(3);
    expect(listDocuments().every(d => d.sourceType === 'folder')).toBe(true);
  });

  it('respects maxFiles cap', async () => {
    const root = '/big';
    const files = {};
    for (let i = 0; i < 20; i++) files[`f${i}.md`] = `body ${i}`;
    seed(root, files);
    const r = await syncLocalFolder({ path: root, embedder: stubEmbed, maxFiles: 5 });
    expect(r.ingested).toBe(5);
  });

  it('re-running replaces prior chunks for unchanged files', async () => {
    const root = '/repo2';
    seed(root, { 'README.md': 'v1' });
    await syncLocalFolder({ path: root, embedder: stubEmbed });
    const docsBefore = listDocuments().length;
    // Replace content; sourceId stays the same -> docId stable -> ingest replaces.
    globalThis.__memTree.set(path.join(root, 'README.md'), { type: 'file', content: 'v2' });
    const r = await syncLocalFolder({ path: root, embedder: stubEmbed });
    expect(r.ingested).toBe(1);
    expect(listDocuments().length).toBe(docsBefore);
  });
});

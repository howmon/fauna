// ── Sync file adapter ────────────────────────────────────────────────────
//
// Covers the file-sync contract used by Phase 5 / "true folder sync":
//   • walkProject() skips ignore dirs & ignore files
//   • adapter.load() reads a file, returns base64 payload + sha1
//   • adapter.save() writes payload to the project's rootPath
//   • adapter.save() refuses path traversal (relPath = ../escape)
//   • adapter.save() skips the write when on-disk hash already matches
//   • adapter.delete() unlinks the file
//   • listAllIds() enumerates every eligible file in every project
//   • _scanOnce() enqueues only changed files; ignores the echo of a
//     just-applied sync write

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// Mirror the adapter's composite-id format so assertions stay readable
// without importing private helpers.
function _eid(projectId, relPath) {
  const b = Buffer.from(relPath, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${projectId}:b64:${b}`;
}

let tmpDir, syncDir, rootA, rootB, originalEnv;

beforeEach(async () => {
  tmpDir   = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-file-sync-'));
  syncDir  = path.join(tmpDir, 'sync');
  rootA    = path.join(tmpDir, 'projects', 'A');
  rootB    = path.join(tmpDir, 'projects', 'B');
  await fsp.mkdir(syncDir, { recursive: true });
  await fsp.mkdir(rootA,   { recursive: true });
  await fsp.mkdir(rootB,   { recursive: true });
  originalEnv = {
    FAUNA_SYNC_DIR: process.env.FAUNA_SYNC_DIR,
    FAUNA_SYNC_FILE_SCAN_MS: process.env.FAUNA_SYNC_FILE_SCAN_MS,
    FAUNA_SYNC_FILE_MODE: process.env.FAUNA_SYNC_FILE_MODE,
    FAUNA_SYNC_FILE_ACTIVE_TTL_MS: process.env.FAUNA_SYNC_FILE_ACTIVE_TTL_MS,
  };
  process.env.FAUNA_SYNC_DIR = syncDir;
  // Make the scan loop effectively dormant — tests call _scanOnce() directly.
  process.env.FAUNA_SYNC_FILE_SCAN_MS = '3600000';
  delete process.env.FAUNA_SYNC_FILE_MODE;
  delete process.env.FAUNA_SYNC_FILE_ACTIVE_TTL_MS;
  vi.resetModules();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    const { _resetForTests } = await import('../server/lib/sync-file-adapter.js');
    _resetForTests();
  } catch (_) {}
  try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// Minimal projectManager stub. Returns the two test projects from above.
function makePM(projects) {
  return {
    getProject(id) { return projects.find(p => p.id === id) || null; },
    getAllProjects() { return projects.slice(); },
    listProjects() { return projects.slice(); },
    updateProject(id, patch) {
      const p = projects.find(x => x.id === id);
      if (p) Object.assign(p, patch);
    },
  };
}

async function boot({ projects } = {}) {
  vi.doMock('../server/lib/agentstore-client.js', () => ({
    getSession: () => ({ loggedIn: true, baseUrl: 'https://x', user: { email: 'a@b' } }),
    getToken: () => 'tok',
    request:    vi.fn(async () => ({ changes: [], nextCursor: null })),
    requestRaw: vi.fn(async () => ({})),
  }));
  const engine  = await import('../server/lib/sync-engine.js');
  const adapter = await import('../server/lib/sync-file-adapter.js');
  // Stub out OTHER adapters so engine.start() and pulls don't blow up.
  for (const ns of ['project', 'conversation', 'checkpoint']) {
    engine.registerAdapter(ns, {
      async load() { return null; },
      async save() {},
      async delete() {},
      serialize: (o) => o,
      deserialize: (p) => p,
      getLastSeenVersion: () => null,
      setLastSeenVersion: () => {},
    });
  }
  const pm = makePM(projects);
  adapter.installFileAdapter({ projectManager: pm });
  await engine.start();
  return { engine, adapter, pm };
}

afterEach(async () => {
  vi.doUnmock('../server/lib/agentstore-client.js');
  try {
    const { stop, _resetForTests } = await import('../server/lib/sync-engine.js');
    try { await stop(); } catch (_) {}
    _resetForTests();
  } catch (_) {}
});

function _sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

describe('walkProject', () => {
  it('returns every eligible file as a POSIX relpath', async () => {
    await fsp.writeFile(path.join(rootA, 'a.txt'), 'A');
    await fsp.mkdir(path.join(rootA, 'src'), { recursive: true });
    await fsp.writeFile(path.join(rootA, 'src', 'index.ts'), 'export {}');
    const { walkProject } = await import('../server/lib/sync-file-adapter.js');
    const out = walkProject(rootA).sort();
    expect(out).toEqual(['a.txt', 'src/index.ts']);
  });

  it('skips the standard ignore dirs', async () => {
    await fsp.mkdir(path.join(rootA, 'node_modules', 'foo'), { recursive: true });
    await fsp.writeFile(path.join(rootA, 'node_modules', 'foo', 'pkg.json'), '{}');
    await fsp.mkdir(path.join(rootA, '.git', 'objects'), { recursive: true });
    await fsp.writeFile(path.join(rootA, '.git', 'objects', 'pack'), 'x');
    await fsp.mkdir(path.join(rootA, 'dist'), { recursive: true });
    await fsp.writeFile(path.join(rootA, 'dist', 'bundle.js'), 'x');
    await fsp.writeFile(path.join(rootA, 'keep.md'), 'k');
    const { walkProject } = await import('../server/lib/sync-file-adapter.js');
    expect(walkProject(rootA)).toEqual(['keep.md']);
  });

  it('skips .DS_Store, secrets, and symlinks', async () => {
    await fsp.writeFile(path.join(rootA, '.DS_Store'), 'x');
    await fsp.writeFile(path.join(rootA, '.env'), 'SECRET=1');
    await fsp.writeFile(path.join(rootA, 'real.txt'), 'r');
    try { await fsp.symlink(path.join(rootA, 'real.txt'), path.join(rootA, 'link.txt')); } catch (_) {}
    const { walkProject } = await import('../server/lib/sync-file-adapter.js');
    expect(walkProject(rootA)).toEqual(['real.txt']);
  });
});

describe('file adapter load/save/delete', () => {
  const projA = { id: 'proj_a', name: 'A', rootPath: '' };

  it('load() returns a base64 payload with sha1 hash', async () => {
    projA.rootPath = rootA;
    await fsp.writeFile(path.join(rootA, 'hello.txt'), 'hello world');
    const { engine } = await boot({ projects: [projA] });
    const a = engine.getAdapter('project_file');
    const payload = await a.load('proj_a:hello.txt');
    expect(payload).toBeTruthy();
    expect(payload.relPath).toBe('hello.txt');
    expect(payload.encoding).toBe('base64');
    expect(Buffer.from(payload.content, 'base64').toString('utf8')).toBe('hello world');
    expect(payload.hash).toBe(_sha1(Buffer.from('hello world')));
  });

  it('save() writes the file under the project rootPath', async () => {
    projA.rootPath = rootA;
    const { engine } = await boot({ projects: [projA] });
    const a = engine.getAdapter('project_file');
    const content = Buffer.from('synced content').toString('base64');
    await a.save('proj_a:notes/note.md', { projectId: 'proj_a', relPath: 'notes/note.md', encoding: 'base64', content });
    const onDisk = await fsp.readFile(path.join(rootA, 'notes', 'note.md'), 'utf8');
    expect(onDisk).toBe('synced content');
  });

  it('save() refuses path traversal via ../', async () => {
    projA.rootPath = rootA;
    const { engine } = await boot({ projects: [projA] });
    const a = engine.getAdapter('project_file');
    await a.save('proj_a:../escape.txt', { relPath: '../escape.txt', encoding: 'base64', content: Buffer.from('x').toString('base64') });
    const exists = fs.existsSync(path.join(path.dirname(rootA), 'escape.txt'));
    expect(exists).toBe(false);
  });

  it('save() is a no-op when the local hash already matches', async () => {
    projA.rootPath = rootA;
    await fsp.writeFile(path.join(rootA, 'same.txt'), 'identical');
    const before = (await fsp.stat(path.join(rootA, 'same.txt'))).mtimeMs;
    const { engine } = await boot({ projects: [projA] });
    const a = engine.getAdapter('project_file');
    const content = Buffer.from('identical').toString('base64');
    await new Promise(r => setTimeout(r, 25));
    await a.save('proj_a:same.txt', { relPath: 'same.txt', encoding: 'base64', content });
    const after = (await fsp.stat(path.join(rootA, 'same.txt'))).mtimeMs;
    expect(after).toBe(before);
  });

  it('delete() removes the file from disk', async () => {
    projA.rootPath = rootA;
    await fsp.writeFile(path.join(rootA, 'gone.txt'), 'x');
    const { engine } = await boot({ projects: [projA] });
    const a = engine.getAdapter('project_file');
    await a.delete('proj_a:gone.txt');
    expect(fs.existsSync(path.join(rootA, 'gone.txt'))).toBe(false);
  });

  it('load() gzips compressible payloads and tags encoding gzip+base64', async () => {
    projA.rootPath = rootA;
    // Repetitive text (~10 KB) — easily gzippable, so the heuristic
    // should win and switch to gzip+base64.
    const body = 'function helloWorld() { return "hello world"; }\n'.repeat(220);
    await fsp.writeFile(path.join(rootA, 'big.js'), body);
    const { engine } = await boot({ projects: [projA] });
    const a = engine.getAdapter('project_file');
    const payload = await a.load('proj_a:big.js');
    expect(payload.encoding).toBe('gzip+base64');
    // Inner content base64 must be smaller than the raw base64 form,
    // otherwise the heuristic shouldn't have adopted compression.
    const rawB64Len = Buffer.from(body, 'utf8').toString('base64').length;
    expect(payload.content.length).toBeLessThan(rawB64Len);
    // Hash is over the *raw* file bytes so the receiver can verify.
    expect(payload.hash).toBe(_sha1(Buffer.from(body, 'utf8')));
  });

  it('save() round-trips gzip+base64 back to the original bytes', async () => {
    projA.rootPath = rootA;
    const body = 'console.log("' + 'x'.repeat(500) + '");\n'.repeat(40);
    await fsp.writeFile(path.join(rootA, 'src.js'), body);
    const { engine } = await boot({ projects: [projA] });
    const a = engine.getAdapter('project_file');

    // Snapshot the compressed payload, then wipe the file and re-apply
    // it through save() — proves the gzip round-trip is byte-exact.
    const payload = await a.load('proj_a:src.js');
    expect(payload.encoding).toBe('gzip+base64');
    await fsp.unlink(path.join(rootA, 'src.js'));

    await a.save('proj_a:src.js', payload);
    const onDisk = await fsp.readFile(path.join(rootA, 'src.js'), 'utf8');
    expect(onDisk).toBe(body);
  });

  it('load() leaves tiny payloads as plain base64 (no inflation)', async () => {
    projA.rootPath = rootA;
    await fsp.writeFile(path.join(rootA, 'short.txt'), 'hi');
    const { engine } = await boot({ projects: [projA] });
    const a = engine.getAdapter('project_file');
    const payload = await a.load('proj_a:short.txt');
    // Below the 256-byte threshold → gzip not even attempted.
    expect(payload.encoding).toBe('base64');
  });
});

describe('listAllIds bootstrap', () => {
  it('skips dormant projects by default', async () => {
    await fsp.writeFile(path.join(rootA, 'a.txt'), '1');
    const projects = [
      { id: 'pa', name: 'A', rootPath: rootA },
    ];
    const { engine } = await boot({ projects });
    const a = engine.getAdapter('project_file');
    expect(await a.listAllIds()).toEqual([]);
  });

  it('returns every eligible file across every active project', async () => {
    await fsp.writeFile(path.join(rootA, 'a.txt'), '1');
    await fsp.writeFile(path.join(rootB, 'b.txt'), '2');
    await fsp.mkdir(path.join(rootB, 'src'), { recursive: true });
    await fsp.writeFile(path.join(rootB, 'src', 'x.ts'), '3');
    const projects = [
      { id: 'pa', name: 'A', rootPath: rootA },
      { id: 'pb', name: 'B', rootPath: rootB },
    ];
    const { engine, adapter } = await boot({ projects });
    adapter.activateProjectFileSync('pa');
    adapter.activateProjectFileSync('pb');
    const a = engine.getAdapter('project_file');
    const ids = (await a.listAllIds()).map(r => r.id).sort();
    // Composite ids are emitted in the base64url form so the URL segment
    // contains no '/' chars (Apache/nginx would otherwise decode %2F → /
    // before route matching and 404). Decode the relPath portion before
    // asserting so the test stays readable.
    const decoded = ids.map(function (id) {
      const m = id.match(/^([^:]+):b64:(.+)$/);
      if (!m) return id;
      let b = m[2].replace(/-/g, '+').replace(/_/g, '/');
      const pad = b.length % 4; if (pad) b += '='.repeat(4 - pad);
      return `${m[1]}:${Buffer.from(b, 'base64').toString('utf8')}`;
    });
    expect(decoded).toEqual(['pa:a.txt', 'pb:b.txt', 'pb:src/x.ts']);
  });
});

describe('_scanOnce anti-loop', () => {
  it('does not re-enqueue a file the adapter just wrote', async () => {
    const projA = { id: 'proj_a', name: 'A', rootPath: rootA };
    const { engine, adapter } = await boot({ projects: [projA] });
    adapter.activateProjectFileSync('proj_a');
    const a = engine.getAdapter('project_file');
    const enqueueSpy = vi.spyOn(engine, 'enqueueChange');
    const content = Buffer.from('payload from B').toString('base64');
    await a.save('proj_a:from-b.txt', { relPath: 'from-b.txt', encoding: 'base64', content });
    enqueueSpy.mockClear();
    await adapter._scanOnce();
    // Should NOT have re-enqueued the file we just wrote.
    const calls = enqueueSpy.mock.calls.filter(c => c[1] === 'proj_a:from-b.txt');
    expect(calls).toHaveLength(0);
  });

  it('enqueues a real local edit', async () => {
    const projA = { id: 'proj_a', name: 'A', rootPath: rootA };
    await fsp.writeFile(path.join(rootA, 'edit.txt'), 'v1');
    const { engine, adapter } = await boot({ projects: [projA] });
    adapter.activateProjectFileSync('proj_a');
    // First scan: seeds the hash cache (treats every existing file as new).
    const enqueueSpy = vi.spyOn(engine, 'enqueueChange');
    await adapter._scanOnce();
    enqueueSpy.mockClear();
    // Edit the file and ensure mtime advances on coarse-resolution filesystems.
    await new Promise(r => setTimeout(r, 25));
    await fsp.writeFile(path.join(rootA, 'edit.txt'), 'v2-changed');
    await adapter._scanOnce();
    const expectedId = _eid('proj_a', 'edit.txt');
    const calls = enqueueSpy.mock.calls.filter(c => c[1] === expectedId && c[2] === 'upsert');
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('enqueues a delete when a tracked file disappears', async () => {
    const projA = { id: 'proj_a', name: 'A', rootPath: rootA };
    await fsp.writeFile(path.join(rootA, 'doomed.txt'), 'x');
    const { engine, adapter } = await boot({ projects: [projA] });
    adapter.activateProjectFileSync('proj_a');
    await adapter._scanOnce(); // seed cache
    const enqueueSpy = vi.spyOn(engine, 'enqueueChange');
    await fsp.unlink(path.join(rootA, 'doomed.txt'));
    await adapter._scanOnce();
    const expectedId = _eid('proj_a', 'doomed.txt');
    const calls = enqueueSpy.mock.calls.filter(c => c[1] === expectedId && c[2] === 'delete');
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});

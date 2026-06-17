// ── Per-device sync preferences + engine integration ─────────────────────
//
// Covers:
//   • sync-prefs persistence + idempotent set/toggle
//   • sync-engine.enqueueChange skips writes belonging to excluded projects
//   • Journal.summary() groups pending by namespace AND by project
//   • _applyRemote skips pulls for excluded projects

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-prefs-'));
  process.env.FAUNA_SYNC_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.FAUNA_SYNC_DIR;
  try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('sync-prefs', () => {
  it('starts with an empty excluded list', async () => {
    const prefs = await import('../server/lib/sync-prefs.js');
    expect(prefs.getPrefs().excludedProjects).toEqual([]);
    expect(prefs.isProjectExcluded('any')).toBe(false);
  });

  it('persists setExcludedProjects across reloads', async () => {
    const prefs = await import('../server/lib/sync-prefs.js');
    await prefs.setExcludedProjects(['p1', 'p2']);
    expect(prefs.getPrefs().excludedProjects.sort()).toEqual(['p1', 'p2']);
    expect(prefs.isProjectExcluded('p1')).toBe(true);
    expect(prefs.isProjectExcluded('p3')).toBe(false);

    // Re-import with a fresh cache to simulate a process restart.
    vi.resetModules();
    const prefs2 = await import('../server/lib/sync-prefs.js');
    expect(prefs2.getPrefs().excludedProjects.sort()).toEqual(['p1', 'p2']);
    expect(prefs2.isProjectExcluded('p2')).toBe(true);
  });

  it('toggles a single project on/off', async () => {
    const prefs = await import('../server/lib/sync-prefs.js');
    await prefs.setProjectExcluded('p1', true);
    expect(prefs.isProjectExcluded('p1')).toBe(true);
    await prefs.setProjectExcluded('p1', false);
    expect(prefs.isProjectExcluded('p1')).toBe(false);
    expect(prefs.getPrefs().excludedProjects).toEqual([]);
  });

  it('deduplicates and stringifies ids', async () => {
    const prefs = await import('../server/lib/sync-prefs.js');
    await prefs.setExcludedProjects(['p1', 'p1', 1, '', null]);
    expect(prefs.getPrefs().excludedProjects.sort()).toEqual(['1', 'p1']);
  });
});

describe('sync-engine: per-project exclusion', () => {
  // Helper: spin up the engine with a fake adapter and a logged-in session.
  async function bootEngine({ excluded = [] } = {}) {
    // Mock agentstore-client so the engine thinks the user is signed in.
    vi.doMock('../server/lib/agentstore-client.js', () => ({
      getSession: () => ({ loggedIn: true, baseUrl: 'https://x', user: { email: 'a@b' } }),
      getToken: () => 'tok',
      request: vi.fn(async () => ({ changes: [], nextCursor: null })),
      requestRaw: vi.fn(async () => ({})),
    }));
    const engine  = await import('../server/lib/sync-engine.js');
    const prefs   = await import('../server/lib/sync-prefs.js');
    if (excluded.length) await prefs.setExcludedProjects(excluded);

    // Minimal adapter that records save/delete calls so we can assert
    // remote-apply behavior.
    const calls = { saved: [], deleted: [] };
    engine.registerAdapter('project', {
      async load(id) { return { id }; },
      async save(id, obj, opts) { calls.saved.push({ id, obj, opts }); },
      async delete(id, opts) { calls.deleted.push({ id, opts }); },
      serialize(o) { return o; },
      deserialize(p) { return p; },
      getLastSeenVersion() { return null; },
      setLastSeenVersion() {},
    });
    engine.registerAdapter('conversation', {
      async load(id) { return { id }; },
      async save(id, obj, opts) { calls.saved.push({ id, obj, opts }); },
      async delete(id, opts) { calls.deleted.push({ id, opts }); },
      serialize(o) { return o; },
      deserialize(p) { return p; },
      getLastSeenVersion() { return null; },
      setLastSeenVersion() {},
    });
    await engine.start();
    return { engine, prefs, calls };
  }

  afterEach(() => {
    vi.doUnmock('../server/lib/agentstore-client.js');
  });

  it('drops local edits of an excluded project', async () => {
    const { engine } = await bootEngine({ excluded: ['proj-A'] });
    engine.enqueueChange('project', 'proj-A', 'upsert');
    engine.enqueueChange('project', 'proj-B', 'upsert');
    const status = engine.getStatus();
    expect(status.pendingPush).toBe(1);
    expect(status.pendingByProject['proj-B']).toBe(1);
    expect(status.pendingByProject['proj-A']).toBeUndefined();
    expect(status.excludedProjects).toEqual(['proj-A']);
    await engine.stop();
  });

  it('drops conversation edits tagged with an excluded projectId', async () => {
    const { engine } = await bootEngine({ excluded: ['proj-A'] });
    engine.enqueueChange('conversation', 'c1', 'upsert', { projectId: 'proj-A' });
    engine.enqueueChange('conversation', 'c2', 'upsert', { projectId: 'proj-B' });
    engine.enqueueChange('conversation', 'c3', 'upsert'); // orphan — always kept
    const status = engine.getStatus();
    expect(status.pendingPush).toBe(2);
    expect(status.pendingByNamespace.conversation).toBe(2);
    expect(status.pendingByProject['proj-B']).toBe(1);
    expect(status.pendingByProject._unassigned).toBe(1);
    await engine.stop();
  });

  it('summary() groups pending changes by namespace and project', async () => {
    const { engine } = await bootEngine();
    engine.enqueueChange('project', 'proj-A', 'upsert');
    engine.enqueueChange('conversation', 'c1', 'upsert', { projectId: 'proj-A' });
    engine.enqueueChange('conversation', 'c2', 'upsert', { projectId: 'proj-A' });
    engine.enqueueChange('conversation', 'c3', 'delete', { projectId: 'proj-B' });
    const status = engine.getStatus();
    expect(status.pendingByNamespace).toEqual({ project: 1, conversation: 3 });
    expect(status.pendingByProject).toEqual({ 'proj-A': 3, 'proj-B': 1 });
    await engine.stop();
  });
});

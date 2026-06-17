// Tests for the sync engine. We stub the agentstore-client with vi.mock so
// no actual HTTP is performed; the focus is on:
//   * HLC monotonicity
//   * Journal append + dedupe by (ns, id)
//   * Adapter round-trip on push/pull
//   * Conflict (409) handling — merge + retry
//   * Tombstone propagation through delete + pull
//
// Each test resets the engine and uses a fresh tmpdir so the on-disk
// journal/cursors/hlc files don't leak across cases.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir;

// ── Mock agentstore-client BEFORE importing the engine ────────────────────
// vi.hoisted so the mock module ref is available inside vi.mock factories
// and our individual tests can reach into the mock to assert call history.
const mockClient = vi.hoisted(() => {
  const store = new Map(); // key=`${ns}:${id}` → {clientVersion, payload, deleted}
  const log = [];
  return {
    store,
    log,
    getSession() {
      return { loggedIn: true, user: { email: 'a@b.c' } };
    },
    async request(method, urlPath, body, opts = {}) {
      log.push({ method, urlPath, body, opts });
      // /api/sync/changes
      if (method === 'GET' && urlPath.startsWith('/api/sync/changes')) {
        const url = new URL('http://x' + urlPath);
        const ns = url.searchParams.get('ns');
        const since = url.searchParams.get('since');
        const changes = [];
        for (const [k, v] of store.entries()) {
          if (!k.startsWith(ns + ':')) continue;
          if (since && v.updatedAt && v.updatedAt <= since) continue;
          changes.push({
            namespace: ns,
            objectId: k.slice(ns.length + 1),
            clientVersion: v.clientVersion,
            updatedAt: v.updatedAt,
            deleted: !!v.deleted,
            payloadHash: v.hash || '',
            payload: v.deleted ? null : v.payload,
          });
        }
        const nextCursor = changes.length ? changes[changes.length - 1].updatedAt : since;
        return { changes, nextCursor, hasMore: false };
      }
      // DELETE /api/sync/objects/:ns/:id
      if (method === 'DELETE' && urlPath.startsWith('/api/sync/objects/')) {
        const parts = urlPath.split('/');
        const ns = parts[4], id = parts[5];
        const k = `${ns}:${id}`;
        const ts = new Date().toISOString();
        store.set(k, { clientVersion: Number(opts.headers?.['X-Client-Version'] || 0), payload: null, deleted: true, updatedAt: ts });
        return { ok: true };
      }
      throw new Error('Mock saw unexpected ' + method + ' ' + urlPath);
    },
    async requestRaw(method, urlPath, rawBody, opts = {}) {
      log.push({ method, urlPath, rawBody, opts });
      if (method === 'PUT' && urlPath.startsWith('/api/sync/objects/')) {
        const parts = urlPath.split('/');
        const ns = parts[4], id = parts[5];
        const k = `${ns}:${id}`;
        const cv = Number(opts.headers?.['X-Client-Version'] || 0);
        const ifMatch = opts.headers?.['If-Match'];
        const prev = store.get(k);
        if (ifMatch != null && prev && Number(ifMatch) !== Number(prev.clientVersion)) {
          const err = new Error('Version conflict');
          err.status = 409;
          err.body = {
            serverVersion: prev.clientVersion,
            serverPayload: prev.payload,
            serverDeleted: !!prev.deleted,
            serverUpdated: prev.updatedAt,
          };
          throw err;
        }
        const ts = new Date(Date.now()).toISOString();
        store.set(k, { clientVersion: cv, payload: JSON.parse(rawBody), deleted: false, updatedAt: ts });
        return { ok: true, namespace: ns, objectId: id, clientVersion: cv, updatedAt: ts };
      }
      throw new Error('Mock saw unexpected RAW ' + method + ' ' + urlPath);
    },
  };
});

vi.mock('../server/lib/agentstore-client.js', () => ({
  getSession: () => mockClient.getSession(),
  request: (...args) => mockClient.request(...args),
  requestRaw: (...args) => mockClient.requestRaw(...args),
  getToken: () => 'fake-token',
  getBaseUrl: () => 'http://test',
}));

// Now safe to import the engine.
let engine;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-sync-'));
  process.env.FAUNA_SYNC_DIR = tmpDir;
  mockClient.store.clear();
  mockClient.log.length = 0;
  // Fresh module each test so module-level state resets.
  vi.resetModules();
  engine = await import('../server/lib/sync-engine.js');
  engine._resetForTests();
});

afterEach(async () => {
  if (engine) await engine.stop();
  try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FAUNA_SYNC_DIR;
});

// ── HLC ────────────────────────────────────────────────────────────────────
describe('HLC', () => {
  it('is monotonically increasing across rapid ticks', () => {
    const ticks = Array.from({ length: 1000 }, () => engine.tick());
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
  });

  it('persists across module reload', async () => {
    const first = engine.tick();
    vi.resetModules();
    const engine2 = await import('../server/lib/sync-engine.js');
    const second = engine2.tick();
    expect(second).toBeGreaterThan(first);
  });
});

// ── Adapter / push + pull ─────────────────────────────────────────────────
function makeInMemoryAdapter() {
  const data = new Map();
  const versions = new Map();
  return {
    data,
    versions,
    async load(id) { return data.has(id) ? structuredClone(data.get(id)) : null; },
    async save(id, obj /*, opts */) { data.set(id, structuredClone(obj)); },
    async delete(id /*, opts */) { data.delete(id); },
    serialize(obj) { return obj; },
    deserialize(p) { return p; },
    getLastSeenVersion(id) { return versions.get(id) ?? null; },
    setLastSeenVersion(id, v) { versions.set(id, v); },
  };
}

describe('push', () => {
  it('uploads an enqueued upsert to the server', async () => {
    const a = makeInMemoryAdapter();
    a.data.set('c1', { id: 'c1', title: 'Hello' });
    engine.registerAdapter('conversation', a);
    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    engine.enqueueChange('conversation', 'c1', 'upsert');
    await engine.syncNow();

    expect(mockClient.store.has('conversation:c1')).toBe(true);
    expect(mockClient.store.get('conversation:c1').payload).toMatchObject({ id: 'c1', title: 'Hello' });
  });

  it('uploads a delete as a tombstone', async () => {
    const a = makeInMemoryAdapter();
    engine.registerAdapter('conversation', a);
    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    // Pre-populate the server so the delete has something to tombstone.
    mockClient.store.set('conversation:c2', { clientVersion: 1, payload: { id: 'c2' }, deleted: false, updatedAt: '2026-06-17T00:00:00.000Z' });
    engine.enqueueChange('conversation', 'c2', 'delete');
    await engine.syncNow();
    expect(mockClient.store.get('conversation:c2').deleted).toBe(true);
  });

  it('drains the journal after a successful push', async () => {
    const a = makeInMemoryAdapter();
    a.data.set('c3', { id: 'c3' });
    engine.registerAdapter('conversation', a);
    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    engine.enqueueChange('conversation', 'c3', 'upsert');
    expect(engine.getStatus().pendingPush).toBe(1);
    await engine.syncNow();
    expect(engine.getStatus().pendingPush).toBe(0);
  });
});

describe('pull', () => {
  it('applies a remote upsert into the adapter', async () => {
    const a = makeInMemoryAdapter();
    engine.registerAdapter('conversation', a);
    mockClient.store.set('conversation:c4', {
      clientVersion: 42,
      payload: { id: 'c4', title: 'From server' },
      deleted: false,
      updatedAt: '2026-06-17T01:00:00.000Z',
    });
    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    await engine.syncNow();
    expect(a.data.get('c4')).toMatchObject({ title: 'From server' });
    expect(a.getLastSeenVersion('c4')).toBe(42);
  });

  it('applies a tombstone (delete) from the server', async () => {
    const a = makeInMemoryAdapter();
    a.data.set('c5', { id: 'c5' });
    engine.registerAdapter('conversation', a);
    mockClient.store.set('conversation:c5', {
      clientVersion: 99, payload: null, deleted: true, updatedAt: '2026-06-17T02:00:00.000Z',
    });
    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    await engine.syncNow();
    expect(a.data.has('c5')).toBe(false);
  });
});

describe('conflict (409)', () => {
  it('merges and retries when If-Match is stale', async () => {
    const a = makeInMemoryAdapter();
    a.merge = (local, remote) => ({ ...remote, ...local, mergedFlag: true });
    a.data.set('c6', { id: 'c6', mine: true });
    a.setLastSeenVersion('c6', 1);
    engine.registerAdapter('conversation', a);

    // Server already moved on — its version is 2, but client thinks 1.
    mockClient.store.set('conversation:c6', {
      clientVersion: 2, payload: { id: 'c6', theirs: true }, deleted: false, updatedAt: '2026-06-17T03:00:00.000Z',
    });

    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    engine.enqueueChange('conversation', 'c6', 'upsert');
    await engine.syncNow();

    // Merged + retried: server now has our combined payload.
    const serverRow = mockClient.store.get('conversation:c6');
    expect(serverRow.payload).toMatchObject({ mine: true, theirs: true, mergedFlag: true });
  });
});

describe('status snapshot', () => {
  it('reports pending push count and registered namespaces', async () => {
    const a = makeInMemoryAdapter();
    engine.registerAdapter('conversation', a);
    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    engine.enqueueChange('conversation', 'x1', 'upsert');
    const status = engine.getStatus();
    expect(status.running).toBe(true);
    expect(status.namespaces).toContain('conversation');
    expect(status.pendingPush).toBeGreaterThanOrEqual(1);
  });
});

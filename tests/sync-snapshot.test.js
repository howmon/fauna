// Tests for the snapshot-bundle bootstrap path:
//   * `requestNdjson` is invoked exactly once on a fresh device
//   * each streamed row goes through `_applyRemote` (i.e. lands in the adapter)
//   * cursors are seeded from the max updatedAt per namespace so the
//     subsequent delta-pull doesn't re-fetch the same rows
//   * a device that already has a cursor SKIPS the snapshot entirely
//   * a failing snapshot does not break the engine — delta-pull continues
//
// We isolate by stubbing both `request` (delta-pull) and `requestNdjson`
// (snapshot) so no network is touched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir;

const mockClient = vi.hoisted(() => {
  const log = [];
  let ndjsonRows = [];
  let ndjsonError = null;
  let ndjsonCallCount = 0;
  const deltaResponses = []; // queue of {changes, nextCursor, hasMore}
  return {
    log,
    setNdjsonRows(rows) { ndjsonRows = rows; ndjsonError = null; },
    setNdjsonError(err) { ndjsonError = err; ndjsonRows = []; },
    getNdjsonCallCount() { return ndjsonCallCount; },
    resetNdjsonCallCount() { ndjsonCallCount = 0; },
    pushDeltaResponse(r) { deltaResponses.push(r); },
    getSession() { return { loggedIn: true, user: { email: 'a@b.c' } }; },
    async request(method, urlPath /*, body, opts */) {
      log.push({ method, urlPath });
      if (method === 'GET' && urlPath.startsWith('/api/sync/changes')) {
        // Pop next queued delta response (or an empty one).
        return deltaResponses.shift() || { changes: [], nextCursor: null, hasMore: false };
      }
      throw new Error('Mock saw unexpected ' + method + ' ' + urlPath);
    },
    async requestRaw() { throw new Error('No raw requests expected in snapshot tests'); },
    async *requestNdjson(method, urlPath /*, opts */) {
      ndjsonCallCount++;
      log.push({ method, urlPath, kind: 'ndjson' });
      if (ndjsonError) throw ndjsonError;
      for (const row of ndjsonRows) yield row;
    },
  };
});

vi.mock('../server/lib/agentstore-client.js', () => ({
  getSession: () => mockClient.getSession(),
  request: (...a) => mockClient.request(...a),
  requestRaw: (...a) => mockClient.requestRaw(...a),
  requestNdjson: (...a) => mockClient.requestNdjson(...a),
  getToken: () => 'fake-token',
  getBaseUrl: () => 'http://test',
}));

let engine;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-sync-snap-'));
  process.env.FAUNA_SYNC_DIR = tmpDir;
  process.env.FAUNA_SYNC_E2E = 'off';
  mockClient.log.length = 0;
  mockClient.resetNdjsonCallCount();
  mockClient.setNdjsonRows([]);
  vi.resetModules();
  engine = await import('../server/lib/sync-engine.js');
  engine._resetForTests();
});

afterEach(async () => {
  if (engine) await engine.stop();
  try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FAUNA_SYNC_DIR;
  delete process.env.FAUNA_SYNC_E2E;
});

function makeInMemoryAdapter() {
  const data = new Map();
  const versions = new Map();
  return {
    data,
    versions,
    async load(id) { return data.has(id) ? structuredClone(data.get(id)) : null; },
    async save(id, obj) { data.set(id, structuredClone(obj)); },
    async delete(id) { data.delete(id); },
    serialize(obj) { return obj; },
    deserialize(p) { return p; },
    getLastSeenVersion(id) { return versions.get(id) ?? null; },
    setLastSeenVersion(id, v) { versions.set(id, v); },
  };
}

// Wait for one of the named events on engine.events with a hard timeout
// so a test never hangs forever if a code path drops the event.
function waitFor(event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      engine.events.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    const onEvent = (payload) => {
      clearTimeout(t);
      resolve(payload);
    };
    engine.events.once(event, onEvent);
  });
}

describe('snapshot bootstrap', () => {
  it('streams rows and applies each one through the adapter on a fresh device', async () => {
    const a = makeInMemoryAdapter();
    engine.registerAdapter('conversation', a);
    mockClient.setNdjsonRows([
      { ns: 'conversation', objectId: 'c1', clientVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z', payloadHash: 'h1', payload: { id: 'c1', title: 'A' } },
      { ns: 'conversation', objectId: 'c2', clientVersion: 1, updatedAt: '2026-01-02T00:00:00.000Z', payloadHash: 'h2', payload: { id: 'c2', title: 'B' } },
      { ns: 'conversation', objectId: 'c3', clientVersion: 1, updatedAt: '2026-01-03T00:00:00.000Z', payloadHash: 'h3', payload: { id: 'c3', title: 'C' } },
    ]);

    const done = waitFor('snapshot:end');
    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    const summary = await done;

    expect(summary.applied).toBe(3);
    expect(mockClient.getNdjsonCallCount()).toBe(1);
    expect(a.data.get('c1')).toMatchObject({ id: 'c1', title: 'A' });
    expect(a.data.get('c2')).toMatchObject({ id: 'c2', title: 'B' });
    expect(a.data.get('c3')).toMatchObject({ id: 'c3', title: 'C' });
  });

  it('seeds cursors to the max updatedAt per namespace so delta-pull resumes cleanly', async () => {
    const a = makeInMemoryAdapter();
    engine.registerAdapter('conversation', a);
    mockClient.setNdjsonRows([
      { ns: 'conversation', objectId: 'c1', clientVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z', payloadHash: 'h1', payload: { id: 'c1' } },
      { ns: 'conversation', objectId: 'c2', clientVersion: 1, updatedAt: '2026-01-05T12:34:56.000Z', payloadHash: 'h2', payload: { id: 'c2' } },
      { ns: 'conversation', objectId: 'c3', clientVersion: 1, updatedAt: '2026-01-03T00:00:00.000Z', payloadHash: 'h3', payload: { id: 'c3' } },
    ]);

    const pullDone = waitFor('pull:end');
    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    await pullDone;

    // The delta-pull immediately after the snapshot should carry the
    // computed max as its `since` query param — proves cursors were
    // persisted from the snapshot rows.
    const deltaCall = mockClient.log.find(
      e => e.kind !== 'ndjson' && e.urlPath?.startsWith('/api/sync/changes') && e.urlPath.includes('conversation')
    );
    expect(deltaCall).toBeTruthy();
    expect(deltaCall.urlPath).toContain('since=' + encodeURIComponent('2026-01-05T12:34:56.000Z'));
  });

  it('does NOT call the snapshot endpoint when cursors already exist', async () => {
    const a = makeInMemoryAdapter();
    engine.registerAdapter('conversation', a);
    // Simulate a prior delta-pull cursor by seeding cursors.json on disk
    // before start(). The engine reads this in _loadCursors().
    const cursorsPath = path.join(tmpDir, 'cursors.json');
    await fsp.writeFile(cursorsPath, JSON.stringify({ conversation: '2026-06-01T00:00:00.000Z' }));

    mockClient.setNdjsonRows([
      { ns: 'conversation', objectId: 'c1', clientVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z', payloadHash: 'h', payload: { id: 'c1' } },
    ]);

    // Snapshot is skipped on this device — wait for the regular delta-pull instead.
    const pullDone = waitFor('pull:end');
    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    await pullDone;

    expect(mockClient.getNdjsonCallCount()).toBe(0);
    // And the adapter was NOT populated by the snapshot path.
    expect(a.data.has('c1')).toBe(false);
  });

  it('falls through to delta-pull when the snapshot endpoint fails', async () => {
    const a = makeInMemoryAdapter();
    engine.registerAdapter('conversation', a);
    const e = new Error('Endpoint missing');
    e.status = 404;
    mockClient.setNdjsonError(e);

    // Pre-queue a delta-pull response so we can verify delta still runs.
    mockClient.pushDeltaResponse({
      changes: [{
        namespace: 'conversation', objectId: 'c-delta', clientVersion: 1,
        updatedAt: '2026-02-01T00:00:00.000Z', deleted: false,
        payloadHash: 'h', payload: { id: 'c-delta', from: 'delta' },
      }],
      nextCursor: '2026-02-01T00:00:00.000Z',
      hasMore: false,
    });

    const snapErr = waitFor('snapshot:error');
    const pullDone = waitFor('pull:end');
    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    await snapErr;
    await pullDone;

    expect(mockClient.getNdjsonCallCount()).toBe(1);
    // Delta path still ran and populated the adapter.
    expect(a.data.get('c-delta')).toMatchObject({ id: 'c-delta', from: 'delta' });
  });

  it('skips rows with unregistered namespaces without aborting the stream', async () => {
    const a = makeInMemoryAdapter();
    engine.registerAdapter('conversation', a);
    mockClient.setNdjsonRows([
      { ns: 'unknown-ns', objectId: 'x1', clientVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z', payloadHash: 'h', payload: { id: 'x1' } },
      { ns: 'conversation', objectId: 'c1', clientVersion: 1, updatedAt: '2026-01-02T00:00:00.000Z', payloadHash: 'h', payload: { id: 'c1' } },
    ]);

    const done = waitFor('snapshot:end');
    await engine.start({ pushDebounceMs: 1, pullIntervalMs: 60_000 });
    const summary = await done;

    // Stream did not error out — second row was applied; unknown skipped.
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(a.data.get('c1')).toMatchObject({ id: 'c1' });
  });
});

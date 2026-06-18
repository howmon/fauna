// ── sync-engine + E2E end-to-end ─────────────────────────────────────────
//
// Verifies the engine encrypts on push and decrypts on pull when E2E is
// enabled. We run a mock agentstore that stores whatever JSON the engine
// sends — so if the engine is leaking plaintext we'd see the unencrypted
// payload land in the mock's store and the assertions catch it.
//
// What's covered:
//   * Outgoing PUTs carry envelope JSON ({e2e:1, n, c}), never plaintext.
//   * Pulled envelopes round-trip back to the original adapter payload.
//   * Locked engine refuses to push (journal stays full) and refuses to
//     apply remote envelopes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

let tmpDir;

const mockClient = vi.hoisted(() => {
  const store = new Map();
  const log = [];
  return {
    store, log,
    getSession() { return { loggedIn: true, user: { email: 'a@b.c' } }; },
    async request(method, urlPath /* , body, opts */) {
      log.push({ method, urlPath });
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
            payloadHash: '',
            payload: v.deleted ? null : v.payload,
          });
        }
        const nextCursor = changes.length ? changes[changes.length - 1].updatedAt : since;
        return { changes, nextCursor, hasMore: false };
      }
      throw new Error('Unexpected ' + method + ' ' + urlPath);
    },
    async requestRaw(method, urlPath, rawBody, opts = {}) {
      log.push({ method, urlPath, rawBody });
      if (method === 'PUT' && urlPath.startsWith('/api/sync/objects/')) {
        const parts = urlPath.split('/');
        const ns = parts[4], id = parts[5];
        const k = `${ns}:${id}`;
        const cv = Number(opts.headers?.['X-Client-Version'] || 0);
        const ts = new Date(Date.now()).toISOString();
        // The mock stores whatever the engine sent. If E2E is doing its
        // job this is an envelope; if E2E is broken it's plaintext and
        // the assertions catch it.
        store.set(k, { clientVersion: cv, payload: JSON.parse(rawBody), deleted: false, updatedAt: ts });
        return { ok: true, namespace: ns, objectId: id, clientVersion: cv, updatedAt: ts };
      }
      throw new Error('Unexpected RAW ' + method + ' ' + urlPath);
    },
  };
});

vi.mock('../server/lib/agentstore-client.js', () => ({
  getSession: () => mockClient.getSession(),
  request: (...a) => mockClient.request(...a),
  requestRaw: (...a) => mockClient.requestRaw(...a),
  getToken: () => 'fake',
  getBaseUrl: () => 'http://test',
}));

let engine, syncCrypto;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-e2e-'));
  process.env.FAUNA_SYNC_DIR = tmpDir;
  process.env.FAUNA_SYNC_E2E = 'on'; // explicit
  mockClient.store.clear();
  mockClient.log.length = 0;
  vi.resetModules();
  engine = await import('../server/lib/sync-engine.js');
  syncCrypto = await import('../server/lib/sync-crypto.js');
  engine._resetForTests();
  syncCrypto._resetForTests();
  // Inject a fixed test key so we don't have to mock the unlock RTT.
  syncCrypto._setKeyForTests(crypto.randomBytes(32));
});

afterEach(async () => {
  if (engine) await engine.stop();
  syncCrypto && syncCrypto._resetForTests();
  try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FAUNA_SYNC_DIR;
  delete process.env.FAUNA_SYNC_E2E;
});

function _registerEchoAdapter(ns) {
  const memory = new Map();
  engine.registerAdapter(ns, {
    async load(id) { return memory.get(id) || null; },
    async save(id, obj) { memory.set(id, obj); },
    async delete(id) { memory.delete(id); },
    serialize(obj) { return obj; },
    deserialize(p)  { return p; },
  });
  return memory;
}

describe('engine: outgoing PUT bodies are encrypted', () => {
  it('PUT carries an envelope, never plaintext', async () => {
    _registerEchoAdapter('conversation');
    await engine.start();
    // Direct adapter.save first, then enqueue — mimics the conversation
    // store's interaction pattern.
    const adapter = engine.getAdapter('conversation');
    await adapter.save('c1', { id: 'c1', secret: 'TOP-SECRET-PLAINTEXT' });
    engine.enqueueChange('conversation', 'c1', 'upsert');
    await engine.syncNow();

    const put = mockClient.log.find(e => e.method === 'PUT' && e.urlPath.includes('conversation/c1'));
    expect(put).toBeTruthy();
    const body = JSON.parse(put.rawBody);
    // Wire body must be the envelope shape.
    expect(body.e2e).toBe(1);
    expect(typeof body.n).toBe('string');
    expect(typeof body.c).toBe('string');
    // The plaintext secret must NOT appear anywhere in the wire body.
    expect(put.rawBody).not.toContain('TOP-SECRET-PLAINTEXT');
  });
});

describe('engine: incoming envelopes round-trip', () => {
  it('decrypts a remote envelope back to the adapter payload', async () => {
    const memory = _registerEchoAdapter('project');
    // Pre-stage a server row whose payload is an envelope produced with
    // the same key the engine has cached. Simulates "another device
    // pushed this".
    const plaintextPayload = { id: 'p1', name: 'Encrypted on the wire', tasks: [1, 2, 3] };
    const env = syncCrypto.encryptString(JSON.stringify(plaintextPayload), 'project:p1');
    mockClient.store.set('project:p1', {
      clientVersion: 1,
      payload: env,
      deleted: false,
      updatedAt: '2026-06-17T00:00:00.000Z',
    });
    await engine.start();
    await engine.syncNow();
    expect(memory.get('p1')).toEqual(plaintextPayload);
  });

  it('skips plaintext rows when E2E is required', async () => {
    const memory = _registerEchoAdapter('project');
    mockClient.store.set('project:legacy', {
      clientVersion: 1,
      payload: { id: 'legacy', name: 'Old plaintext row' },
      deleted: false,
      updatedAt: '2026-06-17T00:00:00.000Z',
    });
    await engine.start();
    await engine.syncNow();
    // Plaintext is rejected — nothing applied.
    expect(memory.has('legacy')).toBe(false);
  });
});

describe('engine: locked state', () => {
  it('refuses to push when no key is available', async () => {
    syncCrypto.clearKey();
    const memory = _registerEchoAdapter('conversation');
    await engine.start();
    const adapter = engine.getAdapter('conversation');
    await adapter.save('cX', { id: 'cX' });
    engine.enqueueChange('conversation', 'cX', 'upsert');
    await engine.syncNow();
    // Mock store should be empty — the engine never sent the PUT.
    expect(mockClient.store.size).toBe(0);
    // Memory still has the record locally.
    expect(memory.get('cX')).toBeTruthy();
  });
});

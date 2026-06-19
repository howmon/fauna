// Tests for server/routes/genui-share.js
//
// Spins up an ephemeral express server with the route handlers attached
// and exercises the public HTTP surface end-to-end. Snapshot persistence
// is rooted under a fresh tmpdir per test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { registerGenUiShareRoutes } from '../server/routes/genui-share.js';

const _home = process.env.HOME || os.homedir();
let _tmpCfg;
let _server;
let _baseUrl;
let _handles;

function _spec(extra) {
  return Object.assign({
    root: 'r',
    elements: { r: { type: 'Heading', props: { text: 'hi' } } },
  }, extra || {});
}

async function _post(url, body) {
  const r = await fetch(_baseUrl + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function _put(url, body) {
  const r = await fetch(_baseUrl + url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function _get(url) {
  const r = await fetch(_baseUrl + url);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function _del(url) {
  const r = await fetch(_baseUrl + url, { method: 'DELETE' });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

beforeEach(async () => {
  _tmpCfg = fs.mkdtempSync(path.join(_home, '.fauna-genui-share-test-'));
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  _handles = registerGenUiShareRoutes(app, { faunaConfigDir: _tmpCfg, port: 0 });
  await new Promise(resolve => {
    _server = app.listen(0, '127.0.0.1', () => {
      const { port } = _server.address();
      _baseUrl = 'http://127.0.0.1:' + port;
      resolve();
    });
  });
});

afterEach(async () => {
  if (_server) await new Promise(r => _server.close(r));
  try { fs.rmSync(_tmpCfg, { recursive: true, force: true }); } catch (_) {}
});

describe('POST /api/genui/share', () => {
  it('creates a new share with an auto id and returns a URL', async () => {
    const r = await _post('/api/genui/share', { spec: _spec(), title: 'Hello' });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^[a-f0-9]{8}$/);
    expect(r.body.title).toBe('Hello');
    expect(r.body.created).toBe(true);
    expect(r.body.url).toMatch(/\/genui\/[a-f0-9]{8}$/);
  });

  it('falls back to default title when none supplied', async () => {
    const r = await _post('/api/genui/share', { spec: _spec() });
    expect(r.status).toBe(201);
    expect(r.body.title).toBe('Shared UI');
  });

  it('upserts an existing id and reports created:false', async () => {
    const a = await _post('/api/genui/share', { spec: _spec(), title: 'v1' });
    const b = await _post('/api/genui/share', { id: a.body.id, spec: _spec(), title: 'v2' });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.created).toBe(false);
    expect(b.body.title).toBe('v2');
  });

  it('accepts the bare-component shorthand spec', async () => {
    const r = await _post('/api/genui/share', { spec: { type: 'Heading', props: { text: 'x' } } });
    expect(r.status).toBe(201);
  });

  it('rejects missing or invalid spec', async () => {
    const a = await _post('/api/genui/share', { spec: null });
    expect(a.status).toBe(400);
    const b = await _post('/api/genui/share', { spec: 'not an object' });
    expect(b.status).toBe(400);
    const c = await _post('/api/genui/share', { spec: { root: 'x' } }); // no elements, no type
    expect(c.status).toBe(400);
  });

  it('rejects ids with disallowed characters', async () => {
    const r = await _post('/api/genui/share', { id: '../../escape', spec: _spec() });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/genui/shared', () => {
  it('returns 404 for unknown id', async () => {
    const r = await _get('/api/genui/shared/missing');
    expect(r.status).toBe(404);
  });

  it('returns the spec and increments hits for known id', async () => {
    const created = await _post('/api/genui/share', { spec: _spec(), title: 'T' });
    const a = await _get('/api/genui/shared/' + created.body.id);
    expect(a.status).toBe(200);
    expect(a.body.spec.elements.r.type).toBe('Heading');
    expect(a.body.title).toBe('T');
    // hits visible via list endpoint
    const list = await _get('/api/genui/shared');
    const entry = list.body.shares.find(s => s.id === created.body.id);
    expect(entry.hits).toBe(1);
  });

  it('lists shares ordered by updatedAt desc', async () => {
    const a = await _post('/api/genui/share', { spec: _spec(), title: 'A' });
    // Force temporal separation; updatedAt has ms resolution but call order
    // alone could collide on fast machines.
    await new Promise(r => setTimeout(r, 5));
    const b = await _post('/api/genui/share', { spec: _spec(), title: 'B' });
    const list = await _get('/api/genui/shared');
    expect(list.body.shares[0].id).toBe(b.body.id);
    expect(list.body.shares[1].id).toBe(a.body.id);
  });
});

describe('PUT /api/genui/shared/:id', () => {
  it('updates spec + title and bumps updatedAt', async () => {
    const created = await _post('/api/genui/share', { spec: _spec(), title: 'old' });
    await new Promise(r => setTimeout(r, 5));
    const r = await _put('/api/genui/shared/' + created.body.id, {
      spec: _spec({ root: 'r2', elements: { r2: { type: 'Text', props: { text: 'new' } } } }),
      title: 'new',
    });
    expect(r.status).toBe(200);
    expect(r.body.updatedAt).toBeGreaterThan(created.body.updatedAt);
    const fetched = await _get('/api/genui/shared/' + created.body.id);
    expect(fetched.body.title).toBe('new');
    expect(fetched.body.spec.root).toBe('r2');
  });

  it('returns 404 when updating unknown id', async () => {
    const r = await _put('/api/genui/shared/nope', { spec: _spec() });
    expect(r.status).toBe(404);
  });

  it('rejects invalid spec on update', async () => {
    const created = await _post('/api/genui/share', { spec: _spec() });
    const r = await _put('/api/genui/shared/' + created.body.id, { spec: {} });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /api/genui/shared/:id', () => {
  it('removes the share and a subsequent GET 404s', async () => {
    const created = await _post('/api/genui/share', { spec: _spec() });
    const del = await _del('/api/genui/shared/' + created.body.id);
    expect(del.body.deleted).toBe(true);
    const g = await _get('/api/genui/shared/' + created.body.id);
    expect(g.status).toBe(404);
  });

  it('reports deleted:false for unknown id but still 200s', async () => {
    const r = await _del('/api/genui/shared/missing');
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(false);
  });
});

describe('GET /genui/:id', () => {
  it('404s when the share id is unknown', async () => {
    const r = await fetch(_baseUrl + '/genui/missing');
    expect(r.status).toBe(404);
  });

  // Note: we don't assert the success path here because that depends on
  // public/genui-share.html resolving from the appDir — covered by the
  // higher-level integration check in the smoke test.
});

describe('snapshot persistence', () => {
  it('rehydrates shares from the snapshot on next register', async () => {
    const created = await _post('/api/genui/share', { spec: _spec(), title: 'persist-me' });
    // Wait past the debounce window so the snapshot lands on disk.
    await new Promise(r => setTimeout(r, 500));
    expect(fs.existsSync(path.join(_tmpCfg, 'genui-shares.json'))).toBe(true);

    // Tear down + re-register against the same config dir.
    await new Promise(r => _server.close(r));
    const app2 = express();
    app2.use(express.json({ limit: '5mb' }));
    registerGenUiShareRoutes(app2, { faunaConfigDir: _tmpCfg });
    await new Promise(resolve => {
      _server = app2.listen(0, '127.0.0.1', () => {
        _baseUrl = 'http://127.0.0.1:' + _server.address().port;
        resolve();
      });
    });

    const list = await _get('/api/genui/shared');
    const entry = list.body.shares.find(s => s.id === created.body.id);
    expect(entry).toBeTruthy();
    expect(entry.title).toBe('persist-me');
  });
});

describe('SSE broadcast', () => {
  it('notifies subscribers when an existing share is updated', async () => {
    const created = await _post('/api/genui/share', { spec: _spec(), title: 'initial' });

    // Open a raw fetch on the SSE stream and collect events.
    const events = [];
    const ctrl = new AbortController();
    const streamPromise = fetch(_baseUrl + '/api/genui/stream/' + created.body.id, { signal: ctrl.signal })
      .then(async r => {
        expect(r.ok).toBe(true);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 2);
            const lines = frame.split('\n');
            for (const ln of lines) {
              if (ln.startsWith('data: ')) {
                try { events.push(JSON.parse(ln.slice(6))); } catch (_) {}
              }
            }
          }
        }
      })
      .catch(() => { /* abort = expected */ });

    // Give the subscriber time to register.
    await new Promise(r => setTimeout(r, 50));
    await _put('/api/genui/shared/' + created.body.id, { spec: _spec(), title: 'pushed' });
    // Let the event flush.
    await new Promise(r => setTimeout(r, 80));
    ctrl.abort();
    await streamPromise;

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].kind).toBe('update');
    expect(events[events.length - 1].title).toBe('pushed');
  });
});

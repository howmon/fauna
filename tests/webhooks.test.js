// Tests for inbound webhook triggers:
//  - task-manager webhook helpers (enable/disable/rotate/lookup)
//  - the /api/hooks/:token route wiring (registerWebhookRoutes)
// We mock fs so the in-memory tasks array is what we control.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs BEFORE importing task-manager (same approach as task-manager.test.js).
let _diskTasks = [];
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  const readFn = vi.fn(() => JSON.stringify(_diskTasks));
  const writeFn = vi.fn((_p, body) => {
    try { _diskTasks = JSON.parse(body); } catch (_) { /* ignore */ }
  });
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: readFn,
      writeFileSync: writeFn,
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => true),
      copyFileSync: vi.fn(),
    },
    readFileSync: readFn,
    writeFileSync: writeFn,
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    copyFileSync: vi.fn(),
  };
});

const tm = await import('../task-manager.js');
const { createTask, enableWebhook, disableWebhook, rotateWebhookToken, getTaskByWebhookToken, markWebhookFired } = tm;
const { registerWebhookRoutes } = await import('../server/routes/webhooks.js');

beforeEach(() => {
  _diskTasks = [];
  vi.clearAllMocks();
});

// ── task-manager webhook helpers ─────────────────────────────────────────
describe('webhook helpers (task-manager)', () => {
  it('enableWebhook generates a strong token and marks enabled', () => {
    const t = createTask({ title: 'Hook me', kind: 'pipeline' });
    expect(t.webhook).toBeNull();
    const updated = enableWebhook(t.id);
    expect(updated.webhook.enabled).toBe(true);
    expect(typeof updated.webhook.token).toBe('string');
    expect(updated.webhook.token.length).toBeGreaterThanOrEqual(40); // 24 bytes hex = 48 chars
  });

  it('getTaskByWebhookToken resolves an enabled task', () => {
    const t = createTask({ title: 'Resolve me' });
    const { webhook } = enableWebhook(t.id);
    const found = getTaskByWebhookToken(webhook.token);
    expect(found).toBeTruthy();
    expect(found.id).toBe(t.id);
  });

  it('getTaskByWebhookToken returns null for unknown/empty tokens', () => {
    createTask({ title: 'Nope' });
    expect(getTaskByWebhookToken('does-not-exist')).toBeNull();
    expect(getTaskByWebhookToken('')).toBeNull();
    expect(getTaskByWebhookToken(null)).toBeNull();
  });

  it('disableWebhook makes the token non-resolvable but preserves it', () => {
    const t = createTask({ title: 'Disable me' });
    const { webhook } = enableWebhook(t.id);
    const token = webhook.token;
    disableWebhook(t.id);
    expect(getTaskByWebhookToken(token)).toBeNull();
    // Re-enabling keeps the same token (URL stays stable)
    const re = enableWebhook(t.id);
    expect(re.webhook.token).toBe(token);
    expect(getTaskByWebhookToken(token)).toBeTruthy();
  });

  it('rotateWebhookToken issues a new token and invalidates the old', () => {
    const t = createTask({ title: 'Rotate me' });
    const old = enableWebhook(t.id).webhook.token;
    const next = rotateWebhookToken(t.id).webhook.token;
    expect(next).not.toBe(old);
    expect(getTaskByWebhookToken(old)).toBeNull();
    expect(getTaskByWebhookToken(next)).toBeTruthy();
  });

  it('markWebhookFired records a lastFiredAt timestamp', () => {
    const t = createTask({ title: 'Fire me' });
    const { webhook } = enableWebhook(t.id);
    expect(webhook.lastFiredAt).toBeNull();
    markWebhookFired(t.id);
    const found = getTaskByWebhookToken(webhook.token);
    expect(typeof found.webhook.lastFiredAt).toBe('number');
  });

  it('helpers return null for unknown task ids', () => {
    expect(enableWebhook('nope')).toBeNull();
    expect(disableWebhook('nope')).toBeNull();
    expect(rotateWebhookToken('nope')).toBeNull();
  });
});

// ── /api/hooks/:token route ──────────────────────────────────────────────
function makeApp() {
  const routes = { post: {}, get: {} };
  const app = {
    post: (path, h) => { routes.post[path] = h; },
    get:  (path, h) => { routes.get[path] = h; },
  };
  return { app, routes };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

describe('registerWebhookRoutes (/api/hooks/:token)', () => {
  it('runs the task with the request body as triggerPayload', async () => {
    const t = createTask({ title: 'Run me', kind: 'pipeline' });
    const token = enableWebhook(t.id).webhook.token;

    const runTask = vi.fn(() => Promise.resolve());
    const { app, routes } = makeApp();
    registerWebhookRoutes(app, {
      getTaskByWebhookToken,
      markWebhookFired,
      runTask,
      isTaskRunning: () => false,
    });

    const req = { method: 'POST', params: { token }, body: { hello: 'world' } };
    const res = makeRes();
    routes.post['/api/hooks/:token'](req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.taskId).toBe(t.id);
    expect(runTask).toHaveBeenCalledOnce();
    const [calledId, opts] = runTask.mock.calls[0];
    expect(calledId).toBe(t.id);
    expect(opts.trigger).toBe('webhook');
    expect(opts.triggerPayload).toContain('world');
  });

  it('returns 404 for an unknown token without running', () => {
    const runTask = vi.fn(() => Promise.resolve());
    const { app, routes } = makeApp();
    registerWebhookRoutes(app, {
      getTaskByWebhookToken,
      markWebhookFired,
      runTask,
      isTaskRunning: () => false,
    });
    const res = makeRes();
    routes.post['/api/hooks/:token']({ method: 'POST', params: { token: 'bogus' }, body: {} }, res);
    expect(res.statusCode).toBe(404);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('returns 409 when the task is already running', () => {
    const t = createTask({ title: 'Busy' });
    const token = enableWebhook(t.id).webhook.token;
    const runTask = vi.fn(() => Promise.resolve());
    const { app, routes } = makeApp();
    registerWebhookRoutes(app, {
      getTaskByWebhookToken,
      markWebhookFired,
      runTask,
      isTaskRunning: () => true,
    });
    const res = makeRes();
    routes.post['/api/hooks/:token']({ method: 'POST', params: { token }, body: {} }, res);
    expect(res.statusCode).toBe(409);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('serializes GET query params into the payload', () => {
    const t = createTask({ title: 'Query me' });
    const token = enableWebhook(t.id).webhook.token;
    const runTask = vi.fn(() => Promise.resolve());
    const { app, routes } = makeApp();
    registerWebhookRoutes(app, {
      getTaskByWebhookToken,
      markWebhookFired,
      runTask,
      isTaskRunning: () => false,
    });
    const res = makeRes();
    routes.get['/api/hooks/:token']({ method: 'GET', params: { token }, query: { foo: 'bar' } }, res);
    expect(res.statusCode).toBe(202);
    expect(runTask.mock.calls[0][1].triggerPayload).toContain('bar');
  });
});

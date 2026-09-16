import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunStore } from '../server/lib/run-store.js';
import { registerAgentRunRoutes } from '../server/routes/agent-runs.js';

const dirs = [];

function setup() {
  const routes = new Map();
  const app = {
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-agent-routes-'));
  dirs.push(configDir);
  const runStore = createRunStore({ configDir });
  registerAgentRunRoutes(app, { runStore });
  return { routes, runStore };
}

function response() {
  return {
    statusCode: 200, body: null, output: '', headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    flushHeaders() {},
    write(chunk) { this.output += chunk; },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('agent run routes', () => {
  it('replays only events newer than the requested cursor', () => {
    const { routes, runStore } = setup();
    runStore.create({ id: 'run-1' });
    runStore.append('run-1', 'content', { content: 'hello' });
    const req = { params: { id: 'run-1' }, query: { after: '1' }, headers: {}, on() {} };
    const res = response();
    routes.get('GET /api/agent-runs/:id/events')(req, res);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].data.content).toBe('hello');
  });

  it('queues controls and resolves persisted pauses', () => {
    const { routes, runStore } = setup();
    runStore.create({ id: 'run-2' });
    const pause = runStore.pause('run-2', { prompt: 'Proceed?' });

    const controlRes = response();
    routes.get('POST /api/agent-runs/:id/controls')(
      { params: { id: 'run-2' }, body: { action: 'steer', payload: { text: 'Use tests' } } }, controlRes
    );
    expect(controlRes.statusCode).toBe(202);

    const pauseRes = response();
    routes.get('POST /api/agent-runs/:id/pauses/:pauseId/resolve')(
      { params: { id: 'run-2', pauseId: pause.id }, body: { decision: 'allow', finalize: true } }, pauseRes
    );
    expect(pauseRes.body.pause.resolution.decision).toBe('allow');
    expect(runStore.get('run-2').status).toBe('completed');
  });

  it('aggregates run analytics', () => {
    const { routes, runStore } = setup();
    runStore.create({ id: 'run-3', projectId: 'p1' });
    runStore.append('run-3', 'model.response', { promptTokens: 7, completionTokens: 3 });
    runStore.setStatus('run-3', 'completed');
    const res = response();
    routes.get('GET /api/agent-runs/analytics')({ query: { projectId: 'p1' } }, res);
    expect(res.body).toMatchObject({ runs: 1, completed: 1, promptTokens: 7, completionTokens: 3 });
  });

  it('exports a run as OTLP JSON', () => {
    const { routes, runStore } = setup();
    runStore.create({ id: 'run-export', kind: 'chat' });
    runStore.append('run-export', 'content', { content: 'hello' });
    runStore.setStatus('run-export', 'completed');
    const res = response();
    routes.get('GET /api/agent-runs/:id/export')({ params: { id: 'run-export' }, query: { format: 'otlp' } }, res);
    const span = res.body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe('chat run');
    expect(span.events.map(event => event.name)).toContain('content');
    expect(res.headers['Content-Disposition']).toContain('run-export.otlp.json');
  });
});

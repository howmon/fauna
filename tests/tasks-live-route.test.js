// Tests for GET /api/tasks/:id/live — live-task snapshot endpoint surfaced
// to the board UI so users can see the model, current step, and chain of
// reasoning of an in-flight kanban autopilot run.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerTaskRoutes } from '../server/routes/tasks.js';

// Tiny stub mimicking the subset of express we need: capture handlers per
// (method, path) and let tests invoke them with fake req/res.
function makeFakeApp() {
  const routes = new Map();
  const key = (m, p) => m.toUpperCase() + ' ' + p;
  return {
    get(path, handler) { routes.set(key('GET', path), handler); },
    post(path, handler) { routes.set(key('POST', path), handler); },
    put(path, handler) { routes.set(key('PUT', path), handler); },
    patch(path, handler) { routes.set(key('PATCH', path), handler); },
    delete(path, handler) { routes.set(key('DELETE', path), handler); },
    invoke(method, path, req) {
      const handler = routes.get(key(method, path));
      if (!handler) throw new Error('No route ' + key(method, path));
      const res = makeFakeRes();
      handler(req, res);
      return res;
    },
  };
}

function makeFakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() {},
    flushHeaders() {},
    write() {},
    on() {},
  };
  return res;
}

function makeDeps(overrides = {}) {
  return {
    createTask: vi.fn(),
    getTask: vi.fn(),
    getAllTasks: vi.fn(() => []),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    runTask: vi.fn(),
    pauseTask: vi.fn(),
    stopTask: vi.fn(),
    steerTask: vi.fn(),
    isTaskRunning: vi.fn(() => false),
    subscribe: vi.fn(() => () => {}),
    enableWebhook: vi.fn(),
    disableWebhook: vi.fn(),
    rotateWebhookToken: vi.fn(),
    getRunningTaskInfo: vi.fn(() => null),
    ...overrides,
  };
}

describe('GET /api/tasks/:id/live', () => {
  let app;
  let deps;

  beforeEach(() => {
    app = makeFakeApp();
    deps = makeDeps();
    registerTaskRoutes(app, deps);
  });

  it('returns 404 when the task does not exist', () => {
    deps.getTask.mockReturnValue(undefined);
    const res = app.invoke('GET', '/api/tasks/:id/live', { params: { id: 'missing' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Task not found' });
  });

  it('returns the live snapshot for a running task', () => {
    deps.getTask.mockReturnValue({
      id: 'task-1', title: 'Build widget', model: 'gpt-5', status: 'running',
      agents: ['ProductManager'],
    });
    deps.isTaskRunning.mockReturnValue(true);
    const reasoning = [
      { step: 1, intent: 'Plan the work', actions: [{ type: 'tool', action: 'fauna_workitem_claim', ok: true }], outcome: 'claimed' },
      { step: 2, intent: 'Implement change', actions: [{ type: 'tool', action: 'edit_file', ok: true }], outcome: 'edited' },
    ];
    deps.getRunningTaskInfo.mockReturnValue({
      step: 2,
      startedAt: 1000,
      elapsed: 5000,
      reasoning,
      current: reasoning[1],
      stats: { actionsTotal: 4, actionsOk: 3, actionsFailed: 1 },
    });

    const res = app.invoke('GET', '/api/tasks/:id/live', { params: { id: 'task-1' } });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.running).toBe(true);
    expect(res.body.model).toBe('gpt-5');
    expect(res.body.agents).toEqual(['ProductManager']);
    expect(res.body.step).toBe(2);
    expect(res.body.elapsedMs).toBe(5000);
    expect(res.body.stats).toEqual({ actionsTotal: 4, actionsOk: 3, actionsFailed: 1 });
    expect(res.body.reasoning).toHaveLength(2);
    expect(res.body.current.step).toBe(2);
  });

  it('returns the runner fallback when the task has no model set', () => {
    deps.getTask.mockReturnValue({ id: 't', title: 'x', model: null, status: 'running' });
    deps.isTaskRunning.mockReturnValue(true);
    deps.getRunningTaskInfo.mockReturnValue({
      step: 0, startedAt: 0, elapsed: 0, reasoning: [], current: null, stats: null,
    });

    const res = app.invoke('GET', '/api/tasks/:id/live', { params: { id: 't' } });

    expect(res.body.model).toBe('claude-sonnet-4.6');
  });

  it('prefers _resolvedModel over the raw task.model (autopilot tasks)', () => {
    // Older autopilot tasks may still have model:null; once the runner writes
    // back _resolvedModel, the UI should prefer what actually ran.
    deps.getTask.mockReturnValue({
      id: 't', title: 'x', model: null, status: 'running',
      _resolvedModel: 'claude-sonnet-4.6',
    });
    deps.isTaskRunning.mockReturnValue(true);
    deps.getRunningTaskInfo.mockReturnValue({
      step: 1, startedAt: 0, elapsed: 0, reasoning: [], current: null, stats: null,
    });

    const res = app.invoke('GET', '/api/tasks/:id/live', { params: { id: 't' } });

    expect(res.body.model).toBe('claude-sonnet-4.6');
  });

  it('returns persisted reasoning when the task has already finished', () => {
    deps.getTask.mockReturnValue({
      id: 't', title: 'x', model: 'gpt-5', status: 'completed',
      result: {
        totalSteps: 5,
        stats: { actionsTotal: 9, actionsOk: 9, actionsFailed: 0 },
        reasoning: [
          { step: 1, intent: 'a', actions: [], outcome: 'done' },
          { step: 2, intent: 'b', actions: [], outcome: 'done' },
        ],
      },
    });
    deps.isTaskRunning.mockReturnValue(false);

    const res = app.invoke('GET', '/api/tasks/:id/live', { params: { id: 't' } });

    expect(res.body.running).toBe(false);
    expect(res.body.step).toBe(5);
    expect(res.body.stats.actionsOk).toBe(9);
    expect(res.body.reasoning).toHaveLength(2);
    // No live snapshot fetch happens when the task is not running.
    expect(deps.getRunningTaskInfo).not.toHaveBeenCalled();
  });

  it('gracefully handles a task with no result and no live state', () => {
    deps.getTask.mockReturnValue({ id: 't', title: 'x', model: null, status: 'idle' });
    deps.isTaskRunning.mockReturnValue(false);

    const res = app.invoke('GET', '/api/tasks/:id/live', { params: { id: 't' } });

    expect(res.statusCode).toBe(200);
    expect(res.body.reasoning).toEqual([]);
    expect(res.body.step).toBe(0);
    expect(res.body.stats).toBeNull();
    expect(res.body.current).toBeNull();
  });

  it('exposes _partialReasoning for a task interrupted mid-run by sleep/crash', () => {
    deps.getTask.mockReturnValue({
      id: 't', title: 'x', model: 'gpt-5', status: 'running',
      _partialReasoning: [
        { step: 1, intent: 'a', actions: [], outcome: 'done' },
        { step: 2, intent: 'b', actions: [], outcome: 'done' },
      ],
      _partialStats: { actionsTotal: 3, actionsOk: 3, actionsFailed: 0 },
      _partialStep: 2,
      _partialUpdatedAt: 1700000000000,
    });
    deps.isTaskRunning.mockReturnValue(false);

    const res = app.invoke('GET', '/api/tasks/:id/live', { params: { id: 't' } });

    expect(res.body.running).toBe(false);
    expect(res.body.interrupted).toBe(true);
    expect(res.body.interruptedAt).toBe(1700000000000);
    expect(res.body.step).toBe(2);
    expect(res.body.stats.actionsOk).toBe(3);
    expect(res.body.reasoning).toHaveLength(2);
  });
});

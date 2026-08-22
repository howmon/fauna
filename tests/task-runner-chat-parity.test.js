import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = new Map();
const events = [];
const settleRoutingOutcomes = vi.fn();

vi.mock('../task-manager.js', () => ({
  getTask: vi.fn((id) => store.get(id) || null),
  updateTask: vi.fn((id, patch) => {
    const task = store.get(id);
    if (task) store.set(id, { ...task, ...patch });
    return store.get(id) || null;
  }),
  completeTask: vi.fn((id, result) => {
    const task = store.get(id);
    if (task) store.set(id, { ...task, status: 'completed', result });
    return store.get(id) || null;
  }),
  failTask: vi.fn((id, error) => {
    const task = store.get(id);
    if (task) store.set(id, { ...task, status: 'failed', error });
    return store.get(id) || null;
  }),
}));

vi.mock('../lib/routing-evidence.js', () => ({
  recordRoutingOutcomesForRun: settleRoutingOutcomes,
}));

const runner = await import('../task-runner.js');

function sse(eventsList) {
  return eventsList.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('');
}

let originalFetch;

beforeEach(() => {
  store.clear();
  events.length = 0;
  settleRoutingOutcomes.mockClear();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('task-runner chat parity', () => {
  it('passes project autonomous context into loopback chat calls and accepts DONE', async () => {
    let body = null;
    store.set('t1', {
      id: 't1', title: 'Card work', kind: 'cron', projectId: 'proj-1',
      permissions: { shell: { cwd: '/tmp/proj' } }, maxSteps: 3, timeout: 30000,
    });
    globalThis.fetch = vi.fn(async (_url, opts) => {
      body = JSON.parse(opts.body);
      return new Response(sse([{ type: 'content', content: 'DONE: shipped and verified' }]));
    });

    await runner.runTask('t1');

    expect(body).toMatchObject({
      projectId: 'proj-1',
      runId: 't1',
      autonomousMode: true,
      headlessTask: true,
    });
    expect(settleRoutingOutcomes).toHaveBeenCalledWith('t1', expect.objectContaining({
      projectId: 'proj-1',
      verified: undefined,
      verifier: 'autonomous-task-completion',
    }));
    expect(store.get('t1').status).toBe('completed');
    expect(store.get('t1').result.summary).toBe('shipped and verified');
  });

  it('does not fold tool_output into assistant completion text', async () => {
    store.set('t2', {
      id: 't2', title: 'Card work', kind: 'cron', projectId: 'proj-1',
      permissions: { shell: true }, maxSteps: 3, timeout: 30000,
    });
    globalThis.fetch = vi.fn(async () => new Response(sse([
      { type: 'tool_output', output: 'stdout that should stay observational\n' },
      { type: 'content', content: 'DONE: final summary only' },
    ])));

    await runner.runTask('t2');

    expect(store.get('t2').status).toBe('completed');
    expect(store.get('t2').result.summary).toBe('final summary only');
  });

  it('settles routed decisions as failed when the autonomous task fails', async () => {
    store.set('t3', {
      id: 't3', title: 'Failing work', kind: 'cron', projectId: 'proj-2',
      permissions: { shell: true }, maxSteps: 3, timeout: 30000,
    });
    globalThis.fetch = vi.fn(async () => new Response(sse([
      { type: 'content', content: 'TASK_FAILED: verifier rejected the result' },
    ])));

    await runner.runTask('t3');

    expect(store.get('t3').status).toBe('failed');
    expect(settleRoutingOutcomes).toHaveBeenCalledWith('t3', expect.objectContaining({
      projectId: 'proj-2',
      verified: false,
      verifier: 'autonomous-task-failure',
    }));
  });
});

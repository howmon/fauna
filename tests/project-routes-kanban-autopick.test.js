import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerProjectRoutes } from '../server/routes/projects.js';
import { pokeNow } from '../kanban-worker.js';

vi.mock('../kanban-worker.js', () => ({
  pokeNow: vi.fn(),
}));

function makeApp() {
  const routes = new Map();
  const add = (method) => (path, ...handlers) => routes.set(method + ' ' + path, handlers.at(-1));
  return {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    invoke(method, path, { params = {}, body = {}, headers = {} } = {}) {
      const handler = routes.get(method + ' ' + path);
      if (!handler) throw new Error('missing route ' + method + ' ' + path);
      const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
      };
      const req = {
        params,
        body,
        query: {},
        get(name) { return headers[String(name).toLowerCase()] || headers[name] || ''; },
      };
      handler(req, res);
      return res;
    },
  };
}

function makeDeps(overrides = {}) {
  return {
    fs: {},
    createProject: vi.fn(),
    getProject: vi.fn(() => null),
    getAllProjects: vi.fn(() => []),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    touchProject: vi.fn(),
    linkConversation: vi.fn(),
    linkTask: vi.fn(),
    addSource: vi.fn(),
    removeSource: vi.fn(),
    syncSource: vi.fn(),
    listFiles: vi.fn(),
    readSourceFile: vi.fn(),
    resolveSourceFilePath: vi.fn(),
    createSourceEntry: vi.fn(),
    writeSourceFileBytes: vi.fn(),
    deleteSourceEntry: vi.fn(),
    renameSourceEntry: vi.fn(),
    getSourceEntryAbsolutePath: vi.fn(),
    requireElectron: vi.fn(),
    addContext: vi.fn(),
    updateContext: vi.fn(),
    removeContext: vi.fn(),
    contextFromArtifact: vi.fn(),
    buildProjectProfile: vi.fn(),
    addBacklogItem: vi.fn(),
    updateBacklogItem: vi.fn(),
    moveWorkItem: vi.fn(),
    deleteWorkItem: vi.fn(),
    emptyArchivedWorkItems: vi.fn(),
    addWorkItemComment: vi.fn(),
    setWorkItemLock: vi.fn(),
    listAllWorkItems: vi.fn(() => []),
    getProjectBoard: vi.fn(),
    prioritizeBacklog: vi.fn(),
    getInternalAICaller: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

async function flushDynamicImport() {
  for (let i = 0; i < 3; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('project routes Kanban autopick wake-up', () => {
  it('creates Todo cards as AI-assigned when project autopilot is on', async () => {
    const deps = makeDeps({
      getProject: vi.fn(() => ({ id: 'p1', kanban: { autopilot: true } })),
      addBacklogItem: vi.fn((_pid, body) => ({ id: 'w1', title: body.title, column: body.column, assignee: body.assignee, claimedBy: null })),
    });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const res = app.invoke('POST', '/api/projects/:id/workitems', {
      params: { id: 'p1' },
      body: { title: 'ship it', column: 'todo' },
    });
    await flushDynamicImport();

    expect(res.statusCode).toBe(201);
    expect(deps.addBacklogItem.mock.calls[0][1]).toMatchObject({ column: 'todo', assignee: 'ai' });
    expect(pokeNow).toHaveBeenCalledTimes(1);
  });

  it('clears stale claims when humans drag AI cards into In Progress', async () => {
    const stale = { id: 'w1', column: 'in_progress', assignee: 'ai', claimedBy: 'ai:old', runs: [] };
    const rearmed = { ...stale, claimedBy: null };
    const deps = makeDeps({
      getProject: vi.fn(() => ({ id: 'p1', kanban: { autopilot: true } })),
      moveWorkItem: vi.fn()
        .mockReturnValueOnce({ ok: true, item: stale })
        .mockReturnValueOnce({ ok: true, item: rearmed }),
    });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const res = app.invoke('POST', '/api/projects/:id/workitems/:itemId/move', {
      params: { id: 'p1', itemId: 'w1' },
      body: { column: 'in_progress' },
      headers: { 'x-fauna-actor': 'human' },
    });
    await flushDynamicImport();

    expect(res.body.claimedBy).toBeNull();
    expect(deps.moveWorkItem.mock.calls[1][2]).toEqual({ assignee: 'ai', claimedBy: null });
    expect(pokeNow).toHaveBeenCalledTimes(1);
  });

  it('summarizes Kanban cards linked to a conversation', () => {
    const deps = makeDeps({
      listAllWorkItems: vi.fn(() => [
        { id: 'w1', title: 'Build', column: 'in_progress', originConvId: 'c1', projectId: 'p1' },
        { id: 'w2', title: 'Other', column: 'done', originConvId: 'c2', projectId: 'p1' },
      ]),
    });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const res = app.invoke('GET', '/api/conversations/:convId/kanban', { params: { convId: 'c1' } });

    expect(res.body.ok).toBe(true);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.percent).toBe(55);
    expect(res.body.activeItem.id).toBe('w1');
  });

  it('mirrors human Kanban comments back into the origin conversation', async () => {
    const existing = { id: 'c1', messages: [] };
    const conversationStore = {
      get: vi.fn(async () => existing),
      put: vi.fn(async (_id, conv) => conv),
    };
    const item = { id: 'w1', title: 'Build widget', column: 'in_progress', originConvId: 'c1' };
    const comment = { id: 'cm1', author: 'human', body: 'Please use the safer option.' };
    const deps = makeDeps({
      addWorkItemComment: vi.fn(() => comment),
      getProjectBoard: vi.fn(() => ({ columns: { in_progress: [item] } })),
      conversationStore,
    });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const res = app.invoke('POST', '/api/projects/:id/workitems/:itemId/comments', {
      params: { id: 'p1', itemId: 'w1' },
      body: { author: 'human', body: comment.body },
    });
    await flushDynamicImport();

    expect(res.statusCode).toBe(201);
    expect(conversationStore.put).toHaveBeenCalledOnce();
    expect(conversationStore.put.mock.calls[0][1].messages[0]).toMatchObject({
      role: 'user',
      _isKanbanFeedback: true,
      _kanbanFeedbackId: 'cm1',
      _kanbanItemId: 'w1',
    });
    expect(conversationStore.put.mock.calls[0][1].messages[0].content).toContain('Please use the safer option.');
  });
});

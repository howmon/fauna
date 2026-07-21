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
    searchSourceFiles: vi.fn(),
    replaceSourceMatches: vi.fn(),
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

describe('project routes find and replace', () => {
  it('passes search options to the scoped source search engine', () => {
    const searchResult = { files: [], matchCount: 0, fileCount: 0 };
    const deps = makeDeps({ searchSourceFiles: vi.fn(() => searchResult) });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const body = { query: 'needle', caseSensitive: true, include: '**/*.js' };
    const res = app.invoke('POST', '/api/projects/:id/sources/:srcId/search', {
      params: { id: 'p1', srcId: 'src1' }, body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(searchResult);
    expect(deps.searchSourceFiles).toHaveBeenCalledWith('p1', 'src1', body);
  });

  it('returns 403 when the replacement engine reports editing is disabled', () => {
    const deps = makeDeps({
      replaceSourceMatches: vi.fn(() => { throw new Error('File editing is disabled for this project'); }),
    });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const res = app.invoke('POST', '/api/projects/:id/sources/:srcId/replace', {
      params: { id: 'p1', srcId: 'src1' }, body: { query: 'a', replacement: 'b' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/editing is disabled/i);
  });

  it('blocks ordinary file saves when editing is disabled', () => {
    const deps = makeDeps({ getProject: vi.fn(() => ({ id: 'p1', allowFileEditing: false })) });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const res = app.invoke('PUT', '/api/projects/:id/sources/:srcId/file', {
      params: { id: 'p1', srcId: 'src1' }, body: { content: 'changed' },
    });

    expect(res.statusCode).toBe(403);
    expect(deps.resolveSourceFilePath).not.toHaveBeenCalled();
  });

  it('blocks create, upload, rename, and delete when editing is disabled', () => {
    const deps = makeDeps({ getProject: vi.fn(() => ({ id: 'p1', allowFileEditing: false })) });
    const app = makeApp();
    registerProjectRoutes(app, deps);
    const params = { id: 'p1', srcId: 'src1' };

    const responses = [
      app.invoke('POST', '/api/projects/:id/sources/:srcId/entry', { params, body: { path: 'new.txt', type: 'file' } }),
      app.invoke('POST', '/api/projects/:id/sources/:srcId/upload', { params, body: Buffer.from('data') }),
      app.invoke('PATCH', '/api/projects/:id/sources/:srcId/entry', { params, body: { oldPath: 'a', newPath: 'b' } }),
      app.invoke('DELETE', '/api/projects/:id/sources/:srcId/entry', { params }),
    ];

    expect(responses.map(response => response.statusCode)).toEqual([403, 403, 403, 403]);
    expect(deps.createSourceEntry).not.toHaveBeenCalled();
    expect(deps.writeSourceFileBytes).not.toHaveBeenCalled();
    expect(deps.renameSourceEntry).not.toHaveBeenCalled();
    expect(deps.deleteSourceEntry).not.toHaveBeenCalled();
  });
});

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

  it('treats blank Todo assignee as AI when autopilot is on', async () => {
    const deps = makeDeps({
      getProject: vi.fn(() => ({ id: 'p1', kanban: { autopilot: true } })),
      addBacklogItem: vi.fn((_pid, body) => ({ id: 'w1', title: body.title, column: body.column, assignee: body.assignee, claimedBy: null })),
    });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const res = app.invoke('POST', '/api/projects/:id/workitems', {
      params: { id: 'p1' },
      body: { title: 'ship it', column: 'todo', assignee: null },
    });
    await flushDynamicImport();

    expect(res.statusCode).toBe(201);
    expect(deps.addBacklogItem.mock.calls[0][1]).toMatchObject({ column: 'todo', assignee: 'ai' });
    expect(pokeNow).toHaveBeenCalledTimes(1);
  });

  it('wakes autopilot when a Backlog card is explicitly assigned to AI', async () => {
    const deps = makeDeps({
      getProject: vi.fn(() => ({ id: 'p1', kanban: { autopilot: true } })),
      addBacklogItem: vi.fn((_pid, body) => ({ id: 'w1', title: body.title, column: body.column, assignee: body.assignee, claimedBy: null })),
    });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const res = app.invoke('POST', '/api/projects/:id/workitems', {
      params: { id: 'p1' },
      body: { title: 'ship it', column: 'backlog', assignee: 'ai' },
    });
    await flushDynamicImport();

    expect(res.statusCode).toBe(201);
    expect(deps.addBacklogItem.mock.calls[0][1]).toMatchObject({ column: 'backlog', assignee: 'ai' });
    expect(pokeNow).toHaveBeenCalledTimes(1);
  });

  it('auto-enables project autopilot when a pickable Todo card is created', async () => {
    const deps = makeDeps({
      getProject: vi.fn(() => ({ id: 'p1', kanban: { autopilot: false, concurrency: 3 } })),
      updateProject: vi.fn((_id, patch) => ({ id: 'p1', kanban: patch.kanban })),
      addBacklogItem: vi.fn((_pid, body) => ({ id: 'w1', title: body.title, column: body.column, assignee: body.assignee, claimedBy: null })),
    });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const res = app.invoke('POST', '/api/projects/:id/workitems', {
      params: { id: 'p1' },
      body: { title: 'ship it', column: 'todo', assignee: null },
    });
    await flushDynamicImport();

    expect(res.statusCode).toBe(201);
    expect(deps.updateProject).toHaveBeenCalledWith('p1', { kanban: { autopilot: true, concurrency: 3 } });
    expect(pokeNow).toHaveBeenCalledTimes(1);
  });

  it('re-arms blank-assignee Todo edits when autopilot is on', async () => {
    const deps = makeDeps({
      getProject: vi.fn(() => ({ id: 'p1', kanban: { autopilot: true } })),
      updateBacklogItem: vi.fn((_pid, _id, body) => ({ id: 'w1', title: body.title, column: body.column, assignee: body.assignee, claimedBy: body.claimedBy || null })),
    });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const res = app.invoke('PATCH', '/api/projects/:id/workitems/:itemId', {
      params: { id: 'p1', itemId: 'w1' },
      body: { title: 'ship it', column: 'todo', assignee: null },
    });
    await flushDynamicImport();

    expect(res.statusCode).toBe(200);
    expect(deps.updateBacklogItem.mock.calls[0][2]).toMatchObject({ column: 'todo', assignee: 'ai', claimedBy: null });
    expect(pokeNow).toHaveBeenCalledTimes(1);
  });

  it('auto-enables project autopilot when a pickable Todo card is edited', async () => {
    const deps = makeDeps({
      getProject: vi.fn(() => ({ id: 'p1', kanban: { autopilot: false, concurrency: 3 } })),
      updateProject: vi.fn((_id, patch) => ({ id: 'p1', kanban: patch.kanban })),
      updateBacklogItem: vi.fn((_pid, _id, body) => ({ id: 'w1', title: body.title, column: body.column, assignee: body.assignee, claimedBy: body.claimedBy || null })),
    });
    const app = makeApp();
    registerProjectRoutes(app, deps);

    const res = app.invoke('PATCH', '/api/projects/:id/workitems/:itemId', {
      params: { id: 'p1', itemId: 'w1' },
      body: { title: 'ship it', column: 'todo', assignee: null },
    });
    await flushDynamicImport();

    expect(res.statusCode).toBe(200);
    expect(deps.updateProject).toHaveBeenCalledWith('p1', { kanban: { autopilot: true, concurrency: 3 } });
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
    expect(res.body).toMatchObject({ comment, item });
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

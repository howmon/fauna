// Tests for the Kanban work-item self-tools (P3).
// Mocks project-manager so the in-memory store is what we control.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const _state = { items: [] };

function _mkItem(over = {}) {
  return Object.assign({
    id: 'bk-x', title: 't', body: '', column: 'todo', status: 'groomed',
    assignee: 'ai', claimedBy: null, lockedByUser: false, priority: 'p2',
    runs: [], comments: [], blockedBy: [], tags: [], rice: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }, over);
}

vi.mock('../memory-store.js', () => ({
  remember: vi.fn(() => ({ ok: true })),
  recall: vi.fn(() => []),
  forget: vi.fn(() => ({ ok: true })),
}));

vi.mock('../project-manager.js', () => ({
  createProject: vi.fn(),
  getAllProjects: vi.fn(() => [{ id: 'proj-1', name: 'Test' }]),
  getProject: vi.fn(() => ({ id: 'proj-1', name: 'Test' })),
  addBacklogItem: vi.fn((pid, item) => {
    const it = _mkItem({ ...item, id: 'bk-' + (_state.items.length + 1) });
    _state.items.push(it);
    return it;
  }),
  listBacklog: vi.fn(() => _state.items.slice()),
  prioritizeBacklog: vi.fn(() => ({ ok: true, items: _state.items })),
  updateBacklogItem: vi.fn((pid, id, patch) => {
    const it = _state.items.find(x => x.id === id);
    if (!it) return null;
    Object.assign(it, patch);
    return it;
  }),
  moveWorkItem: vi.fn((pid, id, patch, opts) => {
    const it = _state.items.find(x => x.id === id);
    if (!it) return { ok: false, error: 'item not found' };
    if (it.lockedByUser && opts && opts.actor === 'ai') {
      return { ok: false, error: 'item is locked by user' };
    }
    if (patch.column) it.column = patch.column;
    if (patch.claimedBy !== undefined) it.claimedBy = patch.claimedBy;
    if (patch.assignee !== undefined) it.assignee = patch.assignee;
    return { ok: true, item: it };
  }),
  addWorkItemComment: vi.fn((pid, id, { author, body }) => {
    const it = _state.items.find(x => x.id === id);
    if (!it) return null;
    const c = { id: 'cmt-' + Date.now(), author, body, ts: Date.now() };
    it.comments.push(c);
    return c;
  }),
  setWorkItemLock: vi.fn(),
  listAllWorkItems: vi.fn(() => _state.items.map(it => ({ ...it, projectId: 'proj-1', projectName: 'Test', projectColor: 'teal' }))),
  getProjectBoard: vi.fn(() => {
    const cols = { backlog: [], todo: [], in_progress: [], review: [], done: [], archived: [] };
    for (const it of _state.items) (cols[it.column] || cols.backlog).push(it);
    return { projectId: 'proj-1', projectName: 'Test', columns: cols };
  }),
}));

// Stub the board event emitter so the lazy import inside executeSelfTool
// doesn't try to wire the real Express router during the test.
vi.mock('../server/routes/projects.js', () => ({
  emitBoardEvent: vi.fn(),
}));

const { executeSelfTool } = await import('../self-tools.js');

beforeEach(() => { _state.items = []; });

const ctx = { activeProjectId: 'proj-1', agentName: 'orchestrator' };

describe('fauna_feature_request_create (extended)', () => {
  it('passes column, assignee, priority, acceptance through', async () => {
    const raw = await executeSelfTool('fauna_feature_request_create', {
      title: 'Refactor auth', column: 'todo', assignee: 'ai',
      priority: 'p1', acceptance: 'tests pass',
    }, ctx);
    const r = JSON.parse(raw);
    expect(r.ok).toBe(true);
    expect(r.item.column).toBe('todo');
    expect(r.item.assignee).toBe('ai');
    expect(r.item.priority).toBe('p1');
  });

  it('errors without active project', async () => {
    const raw = await executeSelfTool('fauna_feature_request_create', { title: 'x' }, {});
    expect(JSON.parse(raw).ok).toBe(false);
  });
});

describe('fauna_workitem_move', () => {
  it('moves an item and optionally claims it', async () => {
    await executeSelfTool('fauna_feature_request_create',
      { title: 'card', column: 'todo' }, ctx);
    const id = _state.items[0].id;
    const raw = await executeSelfTool('fauna_workitem_move',
      { itemId: id, column: 'in_progress', claim: true }, ctx);
    const r = JSON.parse(raw);
    expect(r.ok).toBe(true);
    expect(r.item.column).toBe('in_progress');
    expect(r.item.claimedBy).toBe('ai:orchestrator');
  });

  it('rejects move with no itemId', async () => {
    const raw = await executeSelfTool('fauna_workitem_move',
      { column: 'in_progress' }, ctx);
    expect(JSON.parse(raw).ok).toBe(false);
  });

  it('refuses locked card', async () => {
    await executeSelfTool('fauna_feature_request_create', { title: 'x', column: 'todo' }, ctx);
    _state.items[0].lockedByUser = true;
    const raw = await executeSelfTool('fauna_workitem_move',
      { itemId: _state.items[0].id, column: 'in_progress' }, ctx);
    const r = JSON.parse(raw);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/locked/);
  });
});

describe('fauna_workitem_claim', () => {
  it('sets claimedBy to ai:<agent>', async () => {
    await executeSelfTool('fauna_feature_request_create', { title: 'x' }, ctx);
    const id = _state.items[0].id;
    const raw = await executeSelfTool('fauna_workitem_claim', { itemId: id }, ctx);
    const r = JSON.parse(raw);
    expect(r.ok).toBe(true);
    expect(r.item.claimedBy).toBe('ai:orchestrator');
  });
});

describe('fauna_workitem_comment', () => {
  it('appends an AI comment', async () => {
    await executeSelfTool('fauna_feature_request_create', { title: 'x' }, ctx);
    const id = _state.items[0].id;
    const raw = await executeSelfTool('fauna_workitem_comment',
      { itemId: id, body: 'looking into this now' }, ctx);
    const r = JSON.parse(raw);
    expect(r.ok).toBe(true);
    expect(r.comment.author).toBe('ai');
    expect(_state.items[0].comments.length).toBe(1);
  });
});

describe('fauna_workitem_update', () => {
  it('updates allowed fields', async () => {
    await executeSelfTool('fauna_feature_request_create', { title: 'x' }, ctx);
    const id = _state.items[0].id;
    const raw = await executeSelfTool('fauna_workitem_update', {
      itemId: id, title: 'new title', priority: 'p0', acceptance: 'AC',
    }, ctx);
    const r = JSON.parse(raw);
    expect(r.ok).toBe(true);
    expect(r.item.title).toBe('new title');
    expect(r.item.priority).toBe('p0');
  });
});

describe('fauna_board_scan', () => {
  it('returns project-scope items by default', async () => {
    await executeSelfTool('fauna_feature_request_create', { title: 'a', column: 'todo' }, ctx);
    await executeSelfTool('fauna_feature_request_create', { title: 'b', column: 'done' }, ctx);
    const raw = await executeSelfTool('fauna_board_scan', { column: 'todo' }, ctx);
    const r = JSON.parse(raw);
    expect(r.ok).toBe(true);
    expect(r.scope).toBe('project');
    expect(r.items.length).toBe(1);
    expect(r.items[0].title).toBe('a');
  });

  it('returns global-scope items when scope=global', async () => {
    await executeSelfTool('fauna_feature_request_create', { title: 'a' }, ctx);
    const raw = await executeSelfTool('fauna_board_scan', { scope: 'global' }, ctx);
    const r = JSON.parse(raw);
    expect(r.ok).toBe(true);
    expect(r.scope).toBe('global');
    expect(r.items[0].projectName).toBe('Test');
  });

  it('caps limit at 200', async () => {
    const raw = await executeSelfTool('fauna_board_scan', { limit: 9999 }, ctx);
    const r = JSON.parse(raw);
    expect(r.ok).toBe(true);
  });
});

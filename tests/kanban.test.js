// Tests for the Kanban / work-item layer added on top of project-manager.
// We mock fs so the projects array is purely in-memory per test.

import { describe, it, expect, beforeEach, vi } from 'vitest';

let _diskProjects = [];

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  const readFn = vi.fn((p) => {
    if (typeof p === 'string' && p.endsWith('projects.json')) {
      return JSON.stringify(_diskProjects);
    }
    return actual.readFileSync(p);
  });
  const writeFn = vi.fn((p, body) => {
    if (typeof p === 'string' && p.endsWith('projects.json')) {
      try { _diskProjects = JSON.parse(body); } catch (_) { /* ignore */ }
      return;
    }
  });
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: readFn,
      writeFileSync: writeFn,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => true),
      appendFileSync: vi.fn(),
    },
    readFileSync: readFn,
    writeFileSync: writeFn,
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    appendFileSync: vi.fn(),
  };
});

const pm = await import('../project-manager.js');
const {
  createProject, updateProject,
  addBacklogItem, updateBacklogItem, listBacklog, prioritizeBacklog,
  moveWorkItem, addWorkItemComment, setWorkItemLock,
  listAllWorkItems, getProjectBoard, WORK_ITEM_COLUMNS,
} = pm;

function seedProject(id, extra = {}) {
  _diskProjects.push({
    id, name: 'Test ' + id, color: 'teal',
    sources: [], contexts: [], connectors: [], conversationIds: [], taskIds: [],
    backlog: [], ...extra,
  });
}

beforeEach(() => { _diskProjects = []; });

describe('addBacklogItem (P1 extended shape)', () => {
  it('defaults a new item to backlog column with priority p2', () => {
    seedProject('proj-1');
    const item = addBacklogItem('proj-1', { title: 'Hello' });
    expect(item).toBeTruthy();
    expect(item.column).toBe('backlog');
    expect(item.status).toBe('new');
    expect(item.priority).toBe('p2');
    expect(item.assignee).toBeNull();
    expect(item.lockedByUser).toBe(false);
    expect(Array.isArray(item.runs)).toBe(true);
    expect(Array.isArray(item.comments)).toBe(true);
    expect(Array.isArray(item.blockedBy)).toBe(true);
    expect(item.movedAt).toBeTruthy();
  });

  it('honours explicit column / assignee / priority', () => {
    seedProject('proj-1');
    const item = addBacklogItem('proj-1', {
      title: 'AI task', column: 'todo', assignee: 'ai', priority: 'p0',
      acceptance: 'must pass tests',
    });
    expect(item.column).toBe('todo');
    expect(item.status).toBe('groomed');
    expect(item.assignee).toBe('ai');
    expect(item.priority).toBe('p0');
    expect(item.acceptance).toBe('must pass tests');
  });

  it('coerces invalid priority back to p2', () => {
    seedProject('proj-1');
    const item = addBacklogItem('proj-1', { title: 'x', priority: 'urgent' });
    expect(item.priority).toBe('p2');
  });

  it('returns null when project does not exist', () => {
    expect(addBacklogItem('missing', { title: 'x' })).toBeNull();
  });
});

describe('migration of legacy items', () => {
  it('lazily fills column from legacy status on read', () => {
    seedProject('proj-1', {
      backlog: [{
        id: 'bk-legacy', title: 'old', body: '', status: 'in-progress',
        score: null, rice: {}, tags: [], source: 'agent',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
    });
    const items = listBacklog('proj-1');
    expect(items[0].column).toBe('in_progress');
    expect(items[0].assignee).toBeNull();
    expect(items[0].lockedByUser).toBe(false);
    expect(Array.isArray(items[0].runs)).toBe(true);
  });

  it('maps dropped → archived', () => {
    seedProject('proj-1', {
      backlog: [{ id: 'b', title: 't', status: 'dropped' }],
    });
    expect(listBacklog('proj-1')[0].column).toBe('archived');
  });
});

describe('moveWorkItem', () => {
  beforeEach(() => {
    seedProject('proj-1');
    addBacklogItem('proj-1', { title: 'card', column: 'todo', assignee: 'ai' });
  });

  it('allows strict AI promotion from backlog to todo', () => {
    const backlogCard = addBacklogItem('proj-1', { title: 'backlog card', column: 'backlog', assignee: 'ai' });
    const r = moveWorkItem('proj-1', backlogCard.id, { column: 'todo', assignee: 'ai', claimedBy: null }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(true);
    expect(r.item.column).toBe('todo');
  });

  it('moves a card forward and keeps status mirrored', () => {
    const id = listBacklog('proj-1')[0].id;
    const r = moveWorkItem('proj-1', id, { column: 'in_progress' }, { actor: 'human' });
    expect(r.ok).toBe(true);
    expect(r.item.column).toBe('in_progress');
    expect(r.item.status).toBe('in-progress');
    expect(r.item.movedAt).toBeTruthy();
  });

  it('rejects an invalid column', () => {
    const id = listBacklog('proj-1')[0].id;
    const r = moveWorkItem('proj-1', id, { column: 'banana' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid column/);
  });

  it('blocks AI moves on a user-locked card', () => {
    const id = listBacklog('proj-1')[0].id;
    setWorkItemLock('proj-1', id, true);
    const r = moveWorkItem('proj-1', id, { column: 'in_progress' }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/locked/);
  });

  it('strict mode rejects backwards AI moves', () => {
    const id = listBacklog('proj-1')[0].id;
    moveWorkItem('proj-1', id, { column: 'review' }, { actor: 'human' });
    const r = moveWorkItem('proj-1', id, { column: 'todo' }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot move/);
  });

  it('humans can move backwards freely', () => {
    const id = listBacklog('proj-1')[0].id;
    moveWorkItem('proj-1', id, { column: 'review' }, { actor: 'human' });
    const r = moveWorkItem('proj-1', id, { column: 'todo' }, { actor: 'human' });
    expect(r.ok).toBe(true);
    expect(r.item.column).toBe('todo');
  });

  it('appends runEntry into runs[]', () => {
    const id = listBacklog('proj-1')[0].id;
    const r = moveWorkItem('proj-1', id, {
      column: 'in_progress',
      runEntry: { taskId: 'task-1', startedAt: 123 },
    }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(true);
    expect(r.item.runs.length).toBe(1);
    expect(r.item.runs[0].taskId).toBe('task-1');
  });

  it('rejects AI claim of a user-claimed card', () => {
    const id = listBacklog('proj-1')[0].id;
    moveWorkItem('proj-1', id, { claimedBy: 'user:alice' }, { actor: 'human' });
    const r = moveWorkItem('proj-1', id, { column: 'in_progress' }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/claimed by a human/);
  });
});

describe('addWorkItemComment', () => {
  it('appends comment with author normalised', () => {
    seedProject('proj-1');
    const item = addBacklogItem('proj-1', { title: 'x' });
    const c1 = addWorkItemComment('proj-1', item.id, { author: 'ai', body: 'hi' });
    const c2 = addWorkItemComment('proj-1', item.id, { author: 'gibberish', body: 'human reply' });
    expect(c1.author).toBe('ai');
    expect(c2.author).toBe('human');
    const reread = listBacklog('proj-1')[0];
    expect(reread.comments.length).toBe(2);
  });
});

describe('prioritizeBacklog (RICE)', () => {
  it('scores items and promotes new → groomed/todo', () => {
    seedProject('proj-1');
    addBacklogItem('proj-1', { title: 'a', rice: { reach: 10, impact: 3, confidence: 0.8, effort: 2 } });
    addBacklogItem('proj-1', { title: 'b', rice: { reach: 1,  impact: 1, confidence: 1,   effort: 1 } });
    const r = prioritizeBacklog('proj-1', { method: 'rice' });
    expect(r.ok).toBe(true);
    expect(r.items[0].title).toBe('a');
    expect(r.items[0].column).toBe('todo');
    expect(r.items[0].status).toBe('groomed');
    expect(r.items[0].score).toBeGreaterThan(r.items[1].score);
  });

  it('does not demote items already past todo', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'inprog', column: 'in_progress' });
    prioritizeBacklog('proj-1');
    const re = listBacklog('proj-1').find(x => x.id === it.id);
    expect(re.column).toBe('in_progress');
  });
});

describe('getProjectBoard', () => {
  it('groups items by column with every column present', () => {
    seedProject('proj-1');
    addBacklogItem('proj-1', { title: 'a', column: 'todo' });
    addBacklogItem('proj-1', { title: 'b', column: 'todo' });
    addBacklogItem('proj-1', { title: 'c', column: 'done' });
    const board = getProjectBoard('proj-1');
    for (const col of WORK_ITEM_COLUMNS) {
      expect(board.columns[col]).toBeDefined();
    }
    expect(board.columns.todo.length).toBe(2);
    expect(board.columns.done.length).toBe(1);
  });

  it('exposes kanban config (so the UI can render the autopilot toggle)', () => {
    seedProject('proj-1', { kanban: { autopilot: true, concurrency: 2 } });
    const board = getProjectBoard('proj-1');
    expect(board.kanban).toBeDefined();
    expect(board.kanban.autopilot).toBe(true);
    expect(board.kanban.concurrency).toBe(2);
  });

  it('defaults new projects to autopilot on', () => {
    const project = createProject({ name: 'Autopilot Project' });
    expect(project.kanban.autopilot).toBe(true);
    expect(project.kanban.autopilotDefaultOnV1).toBe(true);
  });

  it('migrates old default-off projects to autopilot on once', () => {
    seedProject('proj-1', { kanban: { autopilot: false, concurrency: 2 } });
    const board = getProjectBoard('proj-1');
    expect(board.kanban.autopilot).toBe(true);
    expect(board.kanban.autopilotDefaultOnV1).toBe(true);
  });

  it('preserves explicit autopilot opt-out after default-on migration', () => {
    seedProject('proj-1', { kanban: { autopilot: false, autopilotDefaultOnV1: true, concurrency: 2 } });
    const board = getProjectBoard('proj-1');
    expect(board.kanban.autopilot).toBe(false);
  });

  it('preserves explicit opt-out when kanban is patched partially', () => {
    seedProject('proj-1', { kanban: { autopilot: true, autopilotDefaultOnV1: true, concurrency: 3 } });
    const updated = updateProject('proj-1', { kanban: { autopilot: false } });
    expect(updated.kanban.autopilot).toBe(false);
    expect(updated.kanban.autopilotDefaultOnV1).toBe(true);
    expect(updated.kanban.concurrency).toBe(3);
    expect(getProjectBoard('proj-1').kanban.autopilot).toBe(false);
  });
});

describe('listAllWorkItems (global board)', () => {
  it('aggregates across projects with project metadata attached', () => {
    seedProject('proj-1', { color: 'teal' });
    seedProject('proj-2', { color: 'purple' });
    addBacklogItem('proj-1', { title: 'a', column: 'todo', assignee: 'ai' });
    addBacklogItem('proj-2', { title: 'b', column: 'todo', assignee: 'ai' });
    addBacklogItem('proj-2', { title: 'c', column: 'done' });
    const all = listAllWorkItems({ column: 'todo', assignee: 'ai' });
    expect(all.length).toBe(2);
    expect(all.map(i => i.projectId).sort()).toEqual(['proj-1', 'proj-2']);
    expect(all[0].projectName).toBeTruthy();
  });

  it('respects limit', () => {
    seedProject('proj-1');
    for (let i = 0; i < 5; i++) addBacklogItem('proj-1', { title: 'i' + i });
    const all = listAllWorkItems({ limit: 3 });
    expect(all.length).toBe(3);
  });
});

describe('updateBacklogItem (extended fields)', () => {
  it('updates assignee, priority, acceptance', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x' });
    const updated = updateBacklogItem('proj-1', it.id, {
      assignee: 'ai', priority: 'p1', acceptance: 'AC', tags: ['t'],
    });
    expect(updated.assignee).toBe('ai');
    expect(updated.priority).toBe('p1');
    expect(updated.acceptance).toBe('AC');
  });

  it('keeps column/status mirrored when column is patched', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x' });
    const updated = updateBacklogItem('proj-1', it.id, { column: 'in_progress' });
    expect(updated.column).toBe('in_progress');
    expect(updated.status).toBe('in-progress');
  });
});

// ── P7: verification gate on moveWorkItem ────────────────────────────────
describe('moveWorkItem verification gate (P7)', () => {
  const { setWorkItemVerification } = pm;

  it('defaults new items to verifyCommand=null and verified=null', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x' });
    expect(it.verifyCommand).toBeNull();
    expect(it.verified).toBeNull();
  });

  it('updateBacklogItem accepts verifyCommand', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x' });
    const u = updateBacklogItem('proj-1', it.id, { verifyCommand: 'npm test' });
    expect(u.verifyCommand).toBe('npm test');
  });

  it('allows AI to move in_progress → done when NO verifier configured', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x', column: 'in_progress' });
    const r = moveWorkItem('proj-1', it.id, { column: 'done' }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(true);
    expect(r.item.column).toBe('done');
  });

  it('BLOCKS AI move to done when card has verifyCommand and no passing verification', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x', column: 'in_progress' });
    updateBacklogItem('proj-1', it.id, { verifyCommand: 'npm test' });
    const r = moveWorkItem('proj-1', it.id, { column: 'done' }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/verification/i);
  });

  it('BLOCKS AI move to done when project has qa.command and no passing verification', () => {
    seedProject('proj-1', { qa: { command: 'npm test' } });
    const it = addBacklogItem('proj-1', { title: 'x', column: 'in_progress' });
    const r = moveWorkItem('proj-1', it.id, { column: 'done' }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/verification/i);
  });

  it('ALLOWS AI move to done after setWorkItemVerification({ok:true})', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x', column: 'in_progress' });
    updateBacklogItem('proj-1', it.id, { verifyCommand: 'npm test' });
    setWorkItemVerification('proj-1', it.id, { ok: true, exitCode: 0, output: 'all good' });
    const r = moveWorkItem('proj-1', it.id, { column: 'done' }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(true);
    expect(r.item.column).toBe('done');
  });

  it('BLOCKS AI move to done after setWorkItemVerification({ok:false})', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x', column: 'in_progress' });
    updateBacklogItem('proj-1', it.id, { verifyCommand: 'npm test' });
    setWorkItemVerification('proj-1', it.id, { ok: false, exitCode: 1, output: 'fail' });
    const r = moveWorkItem('proj-1', it.id, { column: 'done' }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(false);
  });

  it('lets HUMAN move to done even with failing verification (override)', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x', column: 'in_progress' });
    updateBacklogItem('proj-1', it.id, { verifyCommand: 'npm test' });
    setWorkItemVerification('proj-1', it.id, { ok: false, exitCode: 1, output: 'fail' });
    const r = moveWorkItem('proj-1', it.id, { column: 'done' }, { actor: 'human' });
    expect(r.ok).toBe(true);
  });

  it('rejects STALE verification tied to an old run', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x', column: 'in_progress' });
    updateBacklogItem('proj-1', it.id, { verifyCommand: 'npm test' });
    // Push a run entry then a verification tied to a DIFFERENT taskId.
    moveWorkItem('proj-1', it.id, { runEntry: { taskId: 'task-current' } }, { actor: 'ai' });
    setWorkItemVerification('proj-1', it.id, { ok: true, exitCode: 0, output: 'old', runId: 'task-old' });
    const r = moveWorkItem('proj-1', it.id, { column: 'done' }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stale/i);
  });

  it('accepts verification with matching runId', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x', column: 'in_progress' });
    updateBacklogItem('proj-1', it.id, { verifyCommand: 'npm test' });
    moveWorkItem('proj-1', it.id, { runEntry: { taskId: 'task-current' } }, { actor: 'ai' });
    setWorkItemVerification('proj-1', it.id, { ok: true, exitCode: 0, output: 'fresh', runId: 'task-current' });
    const r = moveWorkItem('proj-1', it.id, { column: 'done' }, { actor: 'ai', strict: true });
    expect(r.ok).toBe(true);
  });

  it('clears verified when moving back from in_progress → todo', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x', column: 'in_progress' });
    setWorkItemVerification('proj-1', it.id, { ok: true, exitCode: 0, output: 'stale-soon' });
    moveWorkItem('proj-1', it.id, { column: 'todo' }, { actor: 'human' });
    const after = listBacklog('proj-1').find(x => x.id === it.id);
    expect(after.verified).toBeNull();
  });
});

// ── P7: setWorkItemVerification ──────────────────────────────────────────
describe('setWorkItemVerification', () => {
  const { setWorkItemVerification } = pm;

  it('stores a verification record with sane defaults', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x' });
    const r = setWorkItemVerification('proj-1', it.id, {
      ok: true, exitCode: 0, output: 'yay', runId: 't1', command: 'true', source: 'shell',
    });
    expect(r.verified.ok).toBe(true);
    expect(r.verified.exitCode).toBe(0);
    expect(r.verified.command).toBe('true');
    expect(r.verified.runId).toBe('t1');
    expect(r.verified.source).toBe('shell');
    expect(typeof r.verified.ts).toBe('number');
  });

  it('null clears the verification', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x' });
    setWorkItemVerification('proj-1', it.id, { ok: true, exitCode: 0, output: '' });
    setWorkItemVerification('proj-1', it.id, null);
    const after = listBacklog('proj-1').find(x => x.id === it.id);
    expect(after.verified).toBeNull();
  });

  it('truncates long output', () => {
    seedProject('proj-1');
    const it = addBacklogItem('proj-1', { title: 'x' });
    const huge = 'x'.repeat(20_000);
    const r = setWorkItemVerification('proj-1', it.id, { ok: true, exitCode: 0, output: huge });
    expect(r.verified.output.length).toBeLessThanOrEqual(8_000);
  });
});

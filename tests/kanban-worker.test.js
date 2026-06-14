// Tests for kanban-worker.js (P4 autopilot).
//
// We mock every heavy dependency (project-manager, task-manager, task-runner,
// server/routes/projects.js, and fs for the quota file) so the worker's
// pure logic can be exercised in isolation without touching disk or
// spinning up an Express server.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory simulated DB the project-manager mock reads/writes.
const _db = {
  projects: [],
  items: [],     // each item has projectId mirror for listAllWorkItems
};

function _mkItem(over = {}) {
  return Object.assign({
    id: 'c1', title: 't', body: '', acceptance: '',
    column: 'todo', status: 'groomed', assignee: 'ai',
    claimedBy: null, lockedByUser: false, priority: 'p2',
    runs: [], comments: [], blockedBy: [], tags: [],
    createdAt: new Date('2024-01-01').toISOString(),
    updatedAt: new Date('2024-01-01').toISOString(),
    movedAt: new Date('2024-01-01').toISOString(),
  }, over);
}

function _boardOf(projectId) {
  const cols = { backlog: [], todo: [], in_progress: [], review: [], done: [], archived: [] };
  for (const it of _db.items) if (it.projectId === projectId) (cols[it.column] || cols.backlog).push(it);
  const p = _db.projects.find(x => x.id === projectId);
  return p ? { projectId, projectName: p.name, columns: cols } : null;
}

vi.mock('../project-manager.js', () => ({
  getAllProjects: vi.fn(() => _db.projects.slice()),
  getProject: vi.fn(id => _db.projects.find(p => p.id === id) || null),
  getProjectBoard: vi.fn(id => _boardOf(id)),
  moveWorkItem: vi.fn((pid, id, patch, opts) => {
    const it = _db.items.find(x => x.id === id && x.projectId === pid);
    if (!it) return { ok: false, error: 'item not found' };
    if (it.lockedByUser && opts && opts.actor === 'ai' && (patch.column || patch.assignee)) {
      return { ok: false, error: 'locked' };
    }
    if (patch.column)             { it.column = patch.column; it.movedAt = new Date().toISOString(); }
    if (patch.assignee !== undefined) it.assignee = patch.assignee;
    if (patch.claimedBy !== undefined) it.claimedBy = patch.claimedBy;
    if (patch.runEntry)           it.runs.push(patch.runEntry);
    return { ok: true, item: it };
  }),
  addWorkItemComment: vi.fn((pid, id, { author, body }) => {
    const it = _db.items.find(x => x.id === id && x.projectId === pid);
    if (!it) return null;
    const c = { id: 'cmt-' + Math.random().toString(36).slice(2, 8), author, body, ts: Date.now() };
    it.comments.push(c);
    return c;
  }),
  updateBacklogItem: vi.fn((pid, id, patch) => {
    const it = _db.items.find(x => x.id === id && x.projectId === pid);
    if (it) Object.assign(it, patch);
    return it;
  }),
  listAllWorkItems: vi.fn(({ column } = {}) => {
    return _db.items
      .filter(it => !column || it.column === column)
      .map(it => ({ ...it, projectName: 'P', projectColor: 'teal' }));
  }),
  appendAutonomousRunLog: vi.fn(),
}));

const _createdTasks = [];
vi.mock('../task-manager.js', () => ({
  createTask: vi.fn(opts => {
    const t = { id: 'task-' + (_createdTasks.length + 1), ...opts, status: 'pending' };
    _createdTasks.push(t);
    return t;
  }),
  getTask: vi.fn(id => _createdTasks.find(t => t.id === id) || null),
}));

const _subs = new Map(); // taskId → callback (only one needed per test)
const _runCalls = [];
vi.mock('../task-runner.js', () => ({
  runTask: vi.fn(id => { _runCalls.push(id); return Promise.resolve({ ok: true }); }),
  subscribe: vi.fn((id, cb) => { _subs.set(id, cb); return () => _subs.delete(id); }),
}));

vi.mock('../server/routes/projects.js', () => ({
  emitBoardEvent: vi.fn(),
}));

// ── P7: stub the work-item-verifier so tests don't actually spawn /bin/sh ─
const _verify = { nextResult: { ok: true, skipped: true } };
vi.mock('../lib/work-item-verifier.js', () => ({
  verifyWorkItem: vi.fn(async () => _verify.nextResult),
}));

// Tiny helper to let the worker's fire-and-forget verifier chain settle.
async function flushAsync(turns = 5) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
  // One macrotask in case timers are involved.
  await new Promise(r => setTimeout(r, 0));
}


// Stub fs so the quota file doesn't touch ~/.config/fauna/.
let _quotaStore = {};
vi.mock('fs', async () => {
  const real = await vi.importActual('fs');
  const overrides = {
    readFileSync: vi.fn((p, enc) => {
      if (typeof p === 'string' && p.includes('board-quota.json')) {
        return JSON.stringify(_quotaStore);
      }
      return real.readFileSync(p, enc);
    }),
    writeFileSync: vi.fn((p, data) => {
      if (typeof p === 'string' && p.includes('board-quota.json')) {
        _quotaStore = JSON.parse(data); return;
      }
      return real.writeFileSync(p, data);
    }),
    mkdirSync: vi.fn((p, opts) => {
      if (typeof p === 'string' && p.includes('autonomous-runs')) return;
      return real.mkdirSync(p, opts);
    }),
  };
  // Cover both `import fs from 'fs'` (default) and named-import call sites.
  return { ...real, ...overrides, default: { ...real, ...overrides } };
});

const worker = await import('../kanban-worker.js');
const { __test } = worker;

beforeEach(() => {
  _db.projects = [];
  _db.items = [];
  _createdTasks.length = 0;
  _runCalls.length = 0;
  _subs.clear();
  _quotaStore = {};
  __test.inFlight.clear();
  _verify.nextResult = { ok: true, skipped: true };
});

// ── _comparePickability ──────────────────────────────────────────────────
describe('_comparePickability', () => {
  it('sorts p0 before p1 before p2', () => {
    const arr = [
      { priority: 'p2', score: 0, createdAt: '2024-01-01' },
      { priority: 'p0', score: 0, createdAt: '2024-01-02' },
      { priority: 'p1', score: 0, createdAt: '2024-01-03' },
    ];
    arr.sort(__test.comparePickability);
    expect(arr.map(x => x.priority)).toEqual(['p0', 'p1', 'p2']);
  });
  it('uses score as tie-breaker (higher first)', () => {
    const arr = [
      { priority: 'p1', score: 1, createdAt: '2024-01-01' },
      { priority: 'p1', score: 5, createdAt: '2024-01-01' },
    ];
    arr.sort(__test.comparePickability);
    expect(arr[0].score).toBe(5);
  });
});

// ── _isBlocked ───────────────────────────────────────────────────────────
describe('_isBlocked', () => {
  it('returns false with no blockers', () => {
    expect(__test.isBlocked({}, { columns: {} })).toBe(false);
  });
  it('returns true if a blocker is not done', () => {
    const board = { columns: { todo: [{ id: 'd1', column: 'todo' }] } };
    expect(__test.isBlocked({ blockedBy: ['d1'] }, board)).toBe(true);
  });
  it('returns false if all blockers are done', () => {
    const board = { columns: { done: [{ id: 'd1', column: 'done' }] } };
    expect(__test.isBlocked({ blockedBy: ['d1'] }, board)).toBe(false);
  });
});

// ── _hasUnansweredHumanComment ───────────────────────────────────────────
describe('_hasUnansweredHumanComment', () => {
  it('false when last comment is from ai', () => {
    expect(__test.hasUnansweredHumanComment({ comments: [
      { author: 'human', body: '?' }, { author: 'ai', body: '!' },
    ]})).toBe(false);
  });
  it('true when last comment is from human', () => {
    expect(__test.hasUnansweredHumanComment({ comments: [
      { author: 'ai', body: '!' }, { author: 'human', body: '?' },
    ]})).toBe(true);
  });
  it('false on empty comments', () => {
    expect(__test.hasUnansweredHumanComment({ comments: [] })).toBe(false);
  });
});

// ── _pickNext ────────────────────────────────────────────────────────────
describe('_pickNext', () => {
  it('returns null when no ai cards in todo', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 1 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'todo', assignee: 'human' }));
    expect(__test.pickNext(_db.projects[0])).toBe(null);
  });
  it('skips locked cards', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 1 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'todo', assignee: 'ai', lockedByUser: true }));
    expect(__test.pickNext(_db.projects[0])).toBe(null);
  });
  it('skips claimed cards', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 1 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'todo', assignee: 'ai', claimedBy: 'ai:other' }));
    expect(__test.pickNext(_db.projects[0])).toBe(null);
  });
  it('respects concurrency cap', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 1 } });
    _db.items.push(_mkItem({ id: 'busy', projectId: 'p1', column: 'in_progress', claimedBy: 'ai:x' }));
    _db.items.push(_mkItem({ id: 'c1',   projectId: 'p1', column: 'todo' }));
    expect(__test.pickNext(_db.projects[0])).toBe(null);
  });
  it('respects daily quota', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 5, dailyAiQuota: 2 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'todo' }));
    const today = new Date().toISOString().slice(0, 10);
    _quotaStore = { ['p1:' + today]: 2 };
    expect(__test.pickNext(_db.projects[0])).toBe(null);
  });
  it('picks p0 before p2', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 1 } });
    _db.items.push(_mkItem({ id: 'p2card', projectId: 'p1', column: 'todo', priority: 'p2' }));
    _db.items.push(_mkItem({ id: 'p0card', projectId: 'p1', column: 'todo', priority: 'p0' }));
    expect(__test.pickNext(_db.projects[0]).id).toBe('p0card');
  });
  it('skips blocked cards', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 1 } });
    _db.items.push(_mkItem({ id: 'blocker', projectId: 'p1', column: 'in_progress' }));
    _db.items.push(_mkItem({ id: 'blocked', projectId: 'p1', column: 'todo', blockedBy: ['blocker'] }));
    expect(__test.pickNext(_db.projects[0])).toBe(null);
  });
});

// ── _archiveSweep ────────────────────────────────────────────────────────
describe('_archiveSweep', () => {
  const oldTs = new Date(Date.now() - 60 * 60_000).toISOString(); // 60 min ago
  it('archives a stale done card', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, archiveDelayMin: 10 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'done', movedAt: oldTs }));
    __test.archiveSweep();
    expect(_db.items[0].column).toBe('archived');
  });
  it('skips locked done cards', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, archiveDelayMin: 10 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'done', movedAt: oldTs, lockedByUser: true }));
    __test.archiveSweep();
    expect(_db.items[0].column).toBe('done');
  });
  it('skips done cards with unanswered human comments', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, archiveDelayMin: 10 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'done', movedAt: oldTs,
      comments: [{ author: 'ai', body: 'ok' }, { author: 'human', body: 'wait' }],
    }));
    __test.archiveSweep();
    expect(_db.items[0].column).toBe('done');
  });
  it('skips young done cards', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, archiveDelayMin: 10 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'done', movedAt: new Date().toISOString() }));
    __test.archiveSweep();
    expect(_db.items[0].column).toBe('done');
  });
});

// ── finalizeRunSuccess ───────────────────────────────────────────────────
describe('_finalizeRunSuccess', () => {
  it('moves in_progress card to done when verifier reports skipped (no QA)', async () => {
    _verify.nextResult = { ok: true, skipped: true };
    _db.projects.push({ id: 'p1', name: 'P', kanban: {} });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress', claimedBy: 'ai:o' }));
    __test.inFlight.set('c1', { taskId: 'task-1', projectId: 'p1', unsubscribe: () => {} });
    __test.finalizeRunSuccess('p1', 'c1', { event: 'completed', summary: 'done!' });
    await flushAsync();
    expect(_db.items[0].column).toBe('done');
    expect(_db.items[0].comments.length).toBeGreaterThanOrEqual(1);
  });

  it('moves to done when verifier passes', async () => {
    _verify.nextResult = { ok: true, skipped: false, command: 'npm test' };
    _db.projects.push({ id: 'p1', name: 'P', kanban: {}, qa: { command: 'npm test' } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress', claimedBy: 'ai:o' }));
    __test.inFlight.set('c1', { taskId: 'task-1', projectId: 'p1', unsubscribe: () => {} });
    __test.finalizeRunSuccess('p1', 'c1', { event: 'completed' });
    await flushAsync();
    expect(_db.items[0].column).toBe('done');
    const lastRun = _db.items[0].runs.at(-1);
    expect(lastRun.verified).toBe(true);
  });

  it('moves to REVIEW when verifier fails', async () => {
    _verify.nextResult = { ok: false, skipped: false, exitCode: 1 };
    _db.projects.push({ id: 'p1', name: 'P', kanban: {}, qa: { command: 'npm test' } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress', claimedBy: 'ai:o' }));
    __test.inFlight.set('c1', { taskId: 'task-1', projectId: 'p1', unsubscribe: () => {} });
    __test.finalizeRunSuccess('p1', 'c1', { event: 'completed' });
    await flushAsync();
    expect(_db.items[0].column).toBe('review');
    const lastRun = _db.items[0].runs.at(-1);
    expect(lastRun.verified).toBe(false);
  });

  it('respects an AI move to review/done that already happened', async () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: {} });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'review', claimedBy: 'ai:o' }));
    __test.inFlight.set('c1', { taskId: 'task-1', projectId: 'p1', unsubscribe: () => {} });
    __test.finalizeRunSuccess('p1', 'c1', { event: 'completed' });
    await flushAsync();
    expect(_db.items[0].column).toBe('review');
  });
});

// ── finalizeRunFailure ───────────────────────────────────────────────────
describe('_finalizeRunFailure', () => {
  it('bounces card back to todo on first failure (retries left)', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { maxAiRetries: 2 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress', claimedBy: 'ai:o', assignee: 'ai' }));
    __test.inFlight.set('c1', { taskId: 'task-1', projectId: 'p1', unsubscribe: () => {} });
    __test.finalizeRunFailure('p1', 'c1', { event: 'failed', error: 'boom' });
    expect(_db.items[0].column).toBe('todo');
    expect(_db.items[0].assignee).toBe('ai');
    expect(_db.items[0].claimedBy).toBe(null);
  });
  it('hands to human after max retries', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { maxAiRetries: 2 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress', claimedBy: 'ai:o',
      assignee: 'ai',
      runs: [{ ok: false }, /* one prior failure */],
    }));
    __test.inFlight.set('c1', { taskId: 'task-2', projectId: 'p1', unsubscribe: () => {} });
    __test.finalizeRunFailure('p1', 'c1', { event: 'failed', error: 'boom' });
    expect(_db.items[0].column).toBe('todo');
    expect(_db.items[0].assignee).toBe('human');
    expect(_db.items[0].claimedBy).toBe(null);
  });
});

// ── Quota helpers ────────────────────────────────────────────────────────
describe('quota', () => {
  it('increments and reads back today\'s count', () => {
    expect(__test.quota.used('p1')).toBe(0);
    __test.quota.increment('p1');
    __test.quota.increment('p1');
    expect(__test.quota.used('p1')).toBe(2);
  });
});

// ── Orphan recovery ──────────────────────────────────────────────────────
describe('_recoverOrphans', () => {
  const STALE_MIN = 16; // > 15 min threshold

  function staleAt(min) { return new Date(Date.now() - min * 60_000).toISOString(); }

  beforeEach(() => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: {} });
  });

  it('bounces a stale AI-claimed in_progress card back to todo', () => {
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o', movedAt: staleAt(STALE_MIN) }));
    __test.recoverOrphans();
    expect(_db.items[0].column).toBe('todo');
    expect(_db.items[0].claimedBy).toBe(null);
    // Recovery comment was posted
    expect(_db.items[0].comments.length).toBeGreaterThanOrEqual(1);
    expect(_db.items[0].comments[0].body).toMatch(/recovered/i);
  });

  it('leaves a FRESH in_progress card alone', () => {
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o', movedAt: staleAt(2) }));
    __test.recoverOrphans();
    expect(_db.items[0].column).toBe('in_progress');
  });

  it('leaves cards we are still tracking (in _inFlight) alone', () => {
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o', movedAt: staleAt(STALE_MIN) }));
    __test.inFlight.set('c1', { taskId: 't1', projectId: 'p1', unsubscribe: () => {} });
    __test.recoverOrphans();
    expect(_db.items[0].column).toBe('in_progress');
    __test.inFlight.clear();
  });

  it('skips human-claimed cards (only AI-claimed are recovered)', () => {
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'human', claimedBy: 'user:abey', movedAt: staleAt(STALE_MIN) }));
    __test.recoverOrphans();
    expect(_db.items[0].column).toBe('in_progress');
  });

  it('skips lockedByUser cards', () => {
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o', lockedByUser: true,
      movedAt: staleAt(STALE_MIN) }));
    __test.recoverOrphans();
    expect(_db.items[0].column).toBe('in_progress');
  });

  it('recovers even when autopilot is off (so the card is no longer orphaned)', () => {
    // No autopilot on the project — recovery should still happen because the
    // user will want the AI badge cleared even if they turn autopilot back on later.
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o', movedAt: staleAt(STALE_MIN) }));
    __test.recoverOrphans();
    expect(_db.items[0].column).toBe('todo');
  });
});

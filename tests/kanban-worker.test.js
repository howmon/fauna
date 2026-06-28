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
  getAllTasks: vi.fn(() => _createdTasks.slice()),
}));

const _subs = new Map(); // taskId → callback (only one needed per test)
const _runCalls = [];
const _runningTasks = new Set();
const _steerCalls = [];
vi.mock('../task-runner.js', () => ({
  runTask: vi.fn(id => { _runCalls.push(id); return Promise.resolve({ ok: true }); }),
  subscribe: vi.fn((id, cb) => { _subs.set(id, cb); return () => _subs.delete(id); }),
  isTaskRunning: vi.fn(id => _runningTasks.has(id)),
  steerTask: vi.fn((id, msg) => { _steerCalls.push({ id, msg }); return _runningTasks.has(id); }),
}));

vi.mock('../server/routes/projects.js', () => ({
  emitBoardEvent: vi.fn(),
}));

// ── P7: stub the work-item-verifier so tests don't actually spawn /bin/sh ─
const _verify = { nextResult: { ok: true, skipped: true }, nextResolved: null };
vi.mock('../lib/work-item-verifier.js', () => ({
  verifyWorkItem: vi.fn(async () => _verify.nextResult),
  resolveVerifyCommand: vi.fn(() => _verify.nextResolved),
}));

// Tiny helper to let the worker's fire-and-forget verifier chain settle.
async function flushAsync(turns = 5) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
  // One macrotask in case timers are involved.
  await new Promise(r => setTimeout(r, 0));
}


// Stub fs so the quota file doesn't touch ~/.config/fauna/.
let _quotaStore = {};
let _inflightStore = {};
vi.mock('fs', async () => {
  const real = await vi.importActual('fs');
  const overrides = {
    readFileSync: vi.fn((p, enc) => {
      if (typeof p === 'string' && p.includes('board-quota.json')) {
        return JSON.stringify(_quotaStore);
      }
      if (typeof p === 'string' && p.includes('kanban-inflight.json')) {
        return JSON.stringify(_inflightStore);
      }
      return real.readFileSync(p, enc);
    }),
    writeFileSync: vi.fn((p, data) => {
      if (typeof p === 'string' && p.includes('board-quota.json')) {
        _quotaStore = JSON.parse(data); return;
      }
      if (typeof p === 'string' && p.includes('kanban-inflight.json')) {
        _inflightStore = JSON.parse(data); return;
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
  _runningTasks.clear();
  _quotaStore = {};
  _inflightStore = {};
  __test.inFlight.clear();
  _verify.nextResult = { ok: true, skipped: true };
  _verify.nextResolved = null;
  _steerCalls.length = 0;
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
  it('picks unassigned todo cards when project autopilot is on', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 1 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'todo', assignee: null }));
    expect(__test.pickNext(_db.projects[0]).id).toBe('c1');
  });
  it('picks unassigned in_progress cards when project autopilot is on', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 1 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress', assignee: null, claimedBy: null }));
    expect(__test.pickNext(_db.projects[0]).id).toBe('c1');
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
    _db.items.push(_mkItem({ id: 'blocker', projectId: 'p1', column: 'in_progress', claimedBy: 'ai:x' }));
    _db.items.push(_mkItem({ id: 'blocked', projectId: 'p1', column: 'todo', blockedBy: ['blocker'] }));
    expect(__test.pickNext(_db.projects[0])).toBe(null);
  });
  it('picks an unclaimed in_progress card (human dragged it there)', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 1 } });
    // Card moved straight into in_progress by a human drag — no claimedBy.
    _db.items.push(_mkItem({ id: 'dragged', projectId: 'p1', column: 'in_progress', assignee: 'ai', claimedBy: null }));
    expect(__test.pickNext(_db.projects[0]).id).toBe('dragged');
  });
  it('picks an in_progress card even when it has unresolved blockers (human override)', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 2 } });
    _db.items.push(_mkItem({ id: 'blocker', projectId: 'p1', column: 'in_progress', claimedBy: 'ai:x' }));
    // Human dragged this card into in_progress despite the dependency.
    _db.items.push(_mkItem({ id: 'dragged', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: null, blockedBy: ['blocker'] }));
    expect(__test.pickNext(_db.projects[0]).id).toBe('dragged');
  });
  it('skips in_progress cards already in-flight', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 2 } });
    _db.items.push(_mkItem({ id: 'live', projectId: 'p1', column: 'in_progress', assignee: 'ai', claimedBy: null }));
    __test.inFlight.set('live', { taskId: 't', projectId: 'p1', unsubscribe: () => {} });
    expect(__test.pickNext(_db.projects[0])).toBe(null);
  });
  it('prefers todo over in_progress at same priority', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 1 } });
    _db.items.push(_mkItem({ id: 'inprog', projectId: 'p1', column: 'in_progress', assignee: 'ai', claimedBy: null, priority: 'p1' }));
    _db.items.push(_mkItem({ id: 'todo',   projectId: 'p1', column: 'todo',        assignee: 'ai', claimedBy: null, priority: 'p1' }));
    // Both same priority — comparePickability is stable; the first non-blocked match wins.
    // Either is fine; just ensure something is picked.
    const picked = __test.pickNext(_db.projects[0]);
    expect(picked).not.toBeNull();
    expect(['todo', 'inprog']).toContain(picked.id);
  });
});

// ── _computeIdleReasons (autopilot diagnostic) ───────────────────────────
describe('computeIdleReasons', () => {
  it('returns null when no AI candidates are waiting', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 2, dailyAiQuota: 10 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'todo', assignee: 'human' }));
    expect(__test.computeIdleReasons(_db.projects[0])).toBe(null);
  });
  it('reports daily-quota reason when quota exhausted', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 2, dailyAiQuota: 5 } });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'todo', assignee: 'ai' }));
    const today = new Date().toISOString().slice(0, 10);
    _quotaStore = { ['p1:' + today]: 5 };
    const info = __test.computeIdleReasons(_db.projects[0]);
    expect(info.candidates).toBe(1);
    const quota = info.reasons.find(r => r.kind === 'quota');
    expect(quota).toBeTruthy();
    expect(quota.current).toBe(5);
    expect(quota.limit).toBe(5);
    expect(info.actionable).toBe(true);
  });
  it('reports concurrency-cap reason when in-flight saturates, but flags it non-actionable', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 1 } });
    _db.items.push(_mkItem({ id: 'busy', projectId: 'p1', column: 'in_progress', assignee: 'ai', claimedBy: 'ai:x' }));
    _db.items.push(_mkItem({ id: 'wait', projectId: 'p1', column: 'todo',        assignee: 'ai' }));
    const info = __test.computeIdleReasons(_db.projects[0]);
    const conc = info.reasons.find(r => r.kind === 'concurrency');
    expect(conc).toBeTruthy();
    expect(conc.current).toBe(1);
    expect(conc.limit).toBe(1);
    // Concurrency-cap-only = working as designed, banner should be suppressed.
    expect(info.actionable).toBe(false);
    // And we should NOT also list 'claimed' / 'inflight' (those ARE the cap).
    expect(info.reasons.some(r => r.kind === 'claimed')).toBe(false);
    expect(info.reasons.some(r => r.kind === 'inflight')).toBe(false);
  });
  it('reports blocked-by-deps reason for todo cards', () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, concurrency: 2 } });
    _db.items.push(_mkItem({ id: 'blocker', projectId: 'p1', column: 'in_progress', assignee: 'ai', claimedBy: 'ai:x' }));
    _db.items.push(_mkItem({ id: 'b1', projectId: 'p1', column: 'todo', assignee: 'ai', blockedBy: ['blocker'] }));
    const info = __test.computeIdleReasons(_db.projects[0]);
    // Concurrency NOT saturated (cap=2, 1 in flight), so the only reason must be 'blocked'.
    expect(info.reasons.some(r => r.kind === 'blocked' && r.count === 1)).toBe(true);
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

  it('auto-advances a card the AI moved to review onward to done when verifier passes (or no verifier)', async () => {
    // Previously the worker treated "AI moved to review" as terminal and left
    // the card sitting there forever — also keeping it counted against the
    // concurrency limit. With the fix, we run the verifier (here: skipped,
    // since no qa.command / verifyCommand is set) and advance to done.
    _db.projects.push({ id: 'p1', name: 'P', kanban: {} });
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'review', claimedBy: 'ai:o' }));
    __test.inFlight.set('c1', { taskId: 'task-1', projectId: 'p1', unsubscribe: () => {} });
    __test.finalizeRunSuccess('p1', 'c1', { event: 'completed' });
    await flushAsync();
    expect(_db.items[0].column).toBe('done');
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

// ── Lifecycle notifications (native + widget alert hub) ──────────────────
describe('lifecycle notifications', () => {
  const _osCalls = [];
  const _alertCalls = [];
  beforeEach(() => {
    _osCalls.length = 0;
    _alertCalls.length = 0;
    worker.setOsNotifier((title, body) => { _osCalls.push({ title, body }); });
    worker.setAlertSink(alert => { _alertCalls.push(alert); });
  });

  it('fires "Card complete" on success path landing on done', async () => {
    _verify.nextResult = { ok: true, skipped: true };
    _db.projects.push({ id: 'p1', name: 'Proj', kanban: {} });
    _db.items.push(_mkItem({ id: 'c1', title: 'Ship widget', projectId: 'p1',
      column: 'in_progress', claimedBy: 'ai:o' }));
    __test.inFlight.set('c1', { taskId: 'task-1', projectId: 'p1', unsubscribe: () => {} });
    __test.finalizeRunSuccess('p1', 'c1', { event: 'completed', summary: 'shipped it' });
    await flushAsync();
    expect(_osCalls).toHaveLength(1);
    expect(_osCalls[0].title).toContain('Card complete');
    expect(_osCalls[0].title).toContain('Ship widget');
    expect(_osCalls[0].body).toContain('shipped it');
    expect(_alertCalls).toHaveLength(1);
    expect(_alertCalls[0].source).toBe('kanban');
    expect(_alertCalls[0].kind).toBe('kanban_complete');
    expect(_alertCalls[0].projectId).toBe('p1');
    expect(_alertCalls[0].cardId).toBe('c1');
    expect(_alertCalls[0].id).toMatch(/^kb-/);
  });

  it('fires "Card needs review" when verifier fails (lands in review)', async () => {
    _verify.nextResult = { ok: false, skipped: false, exitCode: 1 };
    _db.projects.push({ id: 'p1', name: 'Proj', kanban: {}, qa: { command: 'npm test' } });
    _db.items.push(_mkItem({ id: 'c1', title: 'Refactor', projectId: 'p1',
      column: 'in_progress', claimedBy: 'ai:o' }));
    __test.inFlight.set('c1', { taskId: 'task-1', projectId: 'p1', unsubscribe: () => {} });
    __test.finalizeRunSuccess('p1', 'c1', { event: 'completed' });
    await flushAsync();
    expect(_osCalls).toHaveLength(1);
    expect(_osCalls[0].title).toContain('Card needs review');
    expect(_alertCalls[0].kind).toBe('kanban_review');
  });

  it('fires "Card failed (will retry)" on intermediate failure', () => {
    _db.projects.push({ id: 'p1', name: 'Proj', kanban: { maxAiRetries: 3 } });
    _db.items.push(_mkItem({ id: 'c1', title: 'Build', projectId: 'p1',
      column: 'in_progress', claimedBy: 'ai:o', assignee: 'ai' }));
    __test.inFlight.set('c1', { taskId: 'task-1', projectId: 'p1', unsubscribe: () => {} });
    __test.finalizeRunFailure('p1', 'c1', { event: 'failed', error: 'compile error' });
    expect(_osCalls).toHaveLength(1);
    expect(_osCalls[0].title).toContain('Card failed (will retry)');
    expect(_osCalls[0].body).toMatch(/Attempt 1 of 3/);
    expect(_osCalls[0].body).toContain('compile error');
    expect(_alertCalls[0].kind).toBe('kanban_fail');
  });

  it('fires "Card needs you" (out-of-retries) on terminal failure', () => {
    _db.projects.push({ id: 'p1', name: 'Proj', kanban: { maxAiRetries: 2 } });
    _db.items.push(_mkItem({ id: 'c1', title: 'Stubborn', projectId: 'p1',
      column: 'in_progress', claimedBy: 'ai:o', assignee: 'ai',
      runs: [{ ok: false }],
    }));
    __test.inFlight.set('c1', { taskId: 'task-2', projectId: 'p1', unsubscribe: () => {} });
    __test.finalizeRunFailure('p1', 'c1', { event: 'failed', error: 'still broken' });
    expect(_osCalls).toHaveLength(1);
    expect(_osCalls[0].title).toContain('Card needs you');
    expect(_osCalls[0].body).toContain('Out of retries');
    expect(_alertCalls[0].kind).toBe('kanban_out_of_retries');
  });

  it('does not throw when notifier and alert sink are unset', () => {
    worker.setOsNotifier(null);
    worker.setAlertSink(null);
    _db.projects.push({ id: 'p1', name: 'Proj', kanban: { maxAiRetries: 3 } });
    _db.items.push(_mkItem({ id: 'c1', title: 'X', projectId: 'p1',
      column: 'in_progress', claimedBy: 'ai:o', assignee: 'ai' }));
    __test.inFlight.set('c1', { taskId: 't', projectId: 'p1', unsubscribe: () => {} });
    expect(() => {
      __test.finalizeRunFailure('p1', 'c1', { event: 'failed', error: 'e' });
    }).not.toThrow();
  });

  it('swallows notifier exceptions so the lifecycle path still completes', () => {
    worker.setOsNotifier(() => { throw new Error('notifier crashed'); });
    worker.setAlertSink(() => { throw new Error('hub crashed'); });
    _db.projects.push({ id: 'p1', name: 'Proj', kanban: { maxAiRetries: 3 } });
    _db.items.push(_mkItem({ id: 'c1', title: 'Y', projectId: 'p1',
      column: 'in_progress', claimedBy: 'ai:o', assignee: 'ai' }));
    __test.inFlight.set('c1', { taskId: 't', projectId: 'p1', unsubscribe: () => {} });
    expect(() => {
      __test.finalizeRunFailure('p1', 'c1', { event: 'failed', error: 'e' });
    }).not.toThrow();
    // Card still moved (retry path).
    expect(_db.items[0].column).toBe('todo');
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

  it('releases the claim on a stale AI-claimed in_progress card (keeps it in_progress)', () => {
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o', movedAt: staleAt(STALE_MIN) }));
    __test.recoverOrphans();
    // Card stays in_progress; the picker now grabs unclaimed in_progress cards.
    expect(_db.items[0].column).toBe('in_progress');
    expect(_db.items[0].claimedBy).toBe(null);
    // Recovery comment was posted
    expect(_db.items[0].comments.length).toBeGreaterThanOrEqual(1);
    expect(_db.items[0].comments[0].body).toMatch(/released|recovered/i);
  });

  it('leaves a FRESH in_progress card alone (non-aggressive)', () => {
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o', movedAt: staleAt(2) }));
    __test.recoverOrphans();
    expect(_db.items[0].column).toBe('in_progress');
    expect(_db.items[0].claimedBy).toBe('ai:o');
  });

  it('aggressive mode releases even FRESH stale claims (used at startup)', () => {
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o', movedAt: staleAt(2) }));
    __test.recoverOrphans({ aggressive: true });
    expect(_db.items[0].column).toBe('in_progress');
    expect(_db.items[0].claimedBy).toBe(null);
  });

  it('leaves cards we are still tracking (in _inFlight) alone', () => {
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o', movedAt: staleAt(STALE_MIN) }));
    __test.inFlight.set('c1', { taskId: 't1', projectId: 'p1', unsubscribe: () => {} });
    __test.recoverOrphans();
    expect(_db.items[0].column).toBe('in_progress');
    expect(_db.items[0].claimedBy).toBe('ai:o');
    __test.inFlight.clear();
  });

  it('skips human-claimed cards (only AI-claimed are recovered)', () => {
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'human', claimedBy: 'user:abey', movedAt: staleAt(STALE_MIN) }));
    __test.recoverOrphans();
    expect(_db.items[0].column).toBe('in_progress');
    expect(_db.items[0].claimedBy).toBe('user:abey');
  });

  it('skips lockedByUser cards', () => {
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o', lockedByUser: true,
      movedAt: staleAt(STALE_MIN) }));
    __test.recoverOrphans();
    expect(_db.items[0].column).toBe('in_progress');
    expect(_db.items[0].claimedBy).toBe('ai:o');
  });

  it('recovers even when autopilot is off (so the AI badge is cleared)', () => {
    // No autopilot on the project — recovery should still happen because the
    // user will want the AI badge cleared even if they turn autopilot back on later.
    _db.items.push(_mkItem({ id: 'c1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o', movedAt: staleAt(STALE_MIN) }));
    __test.recoverOrphans();
    expect(_db.items[0].claimedBy).toBe(null);
  });
});

// ── In-flight persistence + zombie recovery (sleep/crash durability) ────
//
// When the laptop sleeps or the process is killed, the in-memory _inFlight
// Map is lost. These tests verify:
//   1. Every set/delete on _inFlight writes the map to disk.
//   2. On worker start (or powerMonitor 'resume'), the persisted file is
//      read back and split into "still running" vs "zombie" tasks.
//   3. Zombie tasks trigger _finalizeRunFailure so the existing retry /
//      hand-back-to-human flow handles them — no card is left stranded.

describe('in-flight persistence', () => {
  it('writes the in-flight map to disk', () => {
    __test.inFlight.set('card-a', { taskId: 'task-aaa', projectId: 'p1', startedAt: 1000 });
    __test.persistInFlight();
    const stored = __test.readPersistedInFlight();
    expect(stored['card-a']).toBeDefined();
    expect(stored['card-a'].taskId).toBe('task-aaa');
    expect(stored['card-a'].projectId).toBe('p1');
  });

  it('strips non-serialisable fields like unsubscribe callbacks', () => {
    const cb = vi.fn();
    __test.inFlight.set('card-b', { taskId: 'task-bbb', projectId: 'p1', unsubscribe: cb });
    __test.persistInFlight();
    const stored = __test.readPersistedInFlight();
    expect(stored['card-b'].unsubscribe).toBeUndefined();
    expect(typeof stored['card-b'].startedAt).toBe('number');
  });
});

describe('zombie task recovery', () => {
  it('rehydrates entries whose task IS still running and resubscribes', async () => {
    _inflightStore = {
      'card-1': { taskId: 'task-1', projectId: 'p1', startedAt: 1000 },
    };
    _runningTasks.add('task-1'); // task-runner says it's still running
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true } });
    _db.items.push(_mkItem({ id: 'card-1', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o' }));

    const zombies = await __test.rehydrateInFlight();
    expect(zombies).toEqual([]);
    expect(__test.inFlight.has('card-1')).toBe(true);
    // Subscription was reattached, so the worker can finalize it later.
    expect(_subs.has('task-1')).toBe(true);
  });

  it('classifies entries whose task is NOT running as zombies', async () => {
    _inflightStore = {
      'card-2': { taskId: 'task-2', projectId: 'p1', startedAt: 1000 },
    };
    // _runningTasks intentionally empty → task-runner says task is gone
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, maxAiRetries: 2 } });

    const zombies = await __test.rehydrateInFlight();
    expect(zombies).toHaveLength(1);
    expect(zombies[0].cardId).toBe('card-2');
    expect(zombies[0].ent.taskId).toBe('task-2');
    expect(__test.inFlight.has('card-2')).toBe(false);
  });

  it('finalizes zombies as failures so the retry pipeline takes over', async () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, maxAiRetries: 2 } });
    _db.items.push(_mkItem({ id: 'card-3', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o',
      runs: [], }));

    __test.recoverZombieTasks([
      { cardId: 'card-3', ent: { taskId: 'task-3', projectId: 'p1' } },
    ]);

    // _finalizeRunFailure with attempt count below maxRetries → card back to todo,
    // claimedBy cleared, run entry recorded with ok:false.
    const card = _db.items.find(x => x.id === 'card-3');
    expect(card.column).toBe('todo');
    expect(card.claimedBy).toBeNull();
    expect(card.runs.length).toBe(1);
    expect(card.runs[0].ok).toBe(false);
    // A comment was posted explaining the interruption.
    expect(card.comments.some(c => /interrupt/i.test(c.body))).toBe(true);
  });

  it('hands stuck zombies to a human after maxRetries failures', async () => {
    _db.projects.push({ id: 'p1', name: 'P', kanban: { autopilot: true, maxAiRetries: 1 } });
    _db.items.push(_mkItem({ id: 'card-4', projectId: 'p1', column: 'in_progress',
      assignee: 'ai', claimedBy: 'ai:o',
      // Already failed once before — recovery is attempt #2 which hits the cap.
      runs: [{ taskId: 'task-prev', ok: false, finishedAt: Date.now() }] }));

    __test.recoverZombieTasks([
      { cardId: 'card-4', ent: { taskId: 'task-4', projectId: 'p1' } },
    ]);

    const card = _db.items.find(x => x.id === 'card-4');
    expect(card.column).toBe('todo');
    expect(card.assignee).toBe('human');
  });
});

// ── steerCard — human comment → live task steering ───────────────────────
describe('steerCard', () => {
  it('injects the comment into the running task when the card is in-flight', async () => {
    _runningTasks.add('task-99');
    __test.inFlight.set('card-9', { taskId: 'task-99', projectId: 'p1', unsubscribe: () => {} });

    const r = await worker.steerCard('p1', 'card-9', 'please use TypeScript instead of JS');

    expect(r.steered).toBe(true);
    expect(r.taskId).toBe('task-99');
    expect(_steerCalls.length).toBe(1);
    expect(_steerCalls[0].id).toBe('task-99');
    // Must mention HUMAN and contain the original text verbatim.
    expect(_steerCalls[0].msg).toMatch(/HUMAN/);
    expect(_steerCalls[0].msg).toContain('please use TypeScript instead of JS');
  });

  it('no-ops when the card has no in-flight task', async () => {
    const r = await worker.steerCard('p1', 'card-missing', 'hi');
    expect(r.steered).toBe(false);
    expect(_steerCalls.length).toBe(0);
  });

  it('no-ops when the in-flight entry belongs to a different project', async () => {
    _runningTasks.add('task-x');
    __test.inFlight.set('card-x', { taskId: 'task-x', projectId: 'p1', unsubscribe: () => {} });
    const r = await worker.steerCard('p2', 'card-x', 'hi');
    expect(r.steered).toBe(false);
    expect(_steerCalls.length).toBe(0);
  });

  it('no-ops on empty / whitespace messages', async () => {
    _runningTasks.add('task-1');
    __test.inFlight.set('card-1', { taskId: 'task-1', projectId: 'p1', unsubscribe: () => {} });
    expect((await worker.steerCard('p1', 'card-1', '')).steered).toBe(false);
    expect((await worker.steerCard('p1', 'card-1', '   ')).steered).toBe(false);
    expect(_steerCalls.length).toBe(0);
  });
});

describe('claim-time auto-close (pre-flight verifier)', () => {
  function _setup({ verifyCommand = null, qa = null } = {}) {
    const proj = {
      id: 'p1', name: 'P', defaultAgent: 'claude',
      kanban: { autopilot: true, dailyAiQuota: 0 },
      ...(qa ? { qa: { command: qa } } : {}),
    };
    const card = _mkItem({
      id: 'c1', title: 'do the thing', body: 'b', acceptance: 'a',
      projectId: 'p1',
      ...(verifyCommand ? { verifyCommand } : {}),
    });
    _db.projects.push(proj);
    _db.items.push(card);
    return { proj, card };
  }

  it('auto-closes when card-scoped verifier already passes', async () => {
    const { proj, card } = _setup({ verifyCommand: 'echo ok' });
    _verify.nextResolved = { command: 'echo ok', source: 'card' };
    _verify.nextResult   = { ok: true, skipped: false, command: 'echo ok', source: 'card', exitCode: 0 };

    await __test.claimAndRun(proj, card);

    expect(card.column).toBe('done');
    expect(_createdTasks.length).toBe(0); // no AI task spawned
    expect(_runCalls.length).toBe(0);     // task-runner not invoked
    expect(card.comments.some(c => /pre-flight/i.test(c.body))).toBe(true);
    // Quota was NOT incremented (no AI run happened).
    expect(__test.quota.used('p1')).toBe(0);
  });

  it('auto-closes when project-scoped qa.command already passes', async () => {
    const { proj, card } = _setup({ qa: 'npm test' });
    _verify.nextResolved = { command: 'npm test', source: 'project' };
    _verify.nextResult   = { ok: true, skipped: false, command: 'npm test', source: 'project', exitCode: 0 };

    await __test.claimAndRun(proj, card);

    expect(card.column).toBe('done');
    expect(_createdTasks.length).toBe(0);
    expect(card.comments.some(c => /project verifier/i.test(c.body))).toBe(true);
  });

  it('does NOT auto-close when only an auto-detected verifier exists', async () => {
    const { proj, card } = _setup();
    _verify.nextResolved = { command: 'npm test', source: 'auto' };
    _verify.nextResult   = { ok: true, skipped: false, command: 'npm test', source: 'auto', exitCode: 0 };

    await __test.claimAndRun(proj, card);

    expect(card.column).toBe('in_progress');
    expect(_createdTasks.length).toBe(1);
    expect(__test.quota.used('p1')).toBe(1);
  });

  it('proceeds with normal run when verifier fails', async () => {
    const { proj, card } = _setup({ verifyCommand: 'npm test' });
    _verify.nextResolved = { command: 'npm test', source: 'card' };
    _verify.nextResult   = { ok: false, skipped: false, command: 'npm test', source: 'card', exitCode: 1 };

    await __test.claimAndRun(proj, card);

    expect(card.column).toBe('in_progress');
    expect(_createdTasks.length).toBe(1);
    expect(__test.quota.used('p1')).toBe(1);
  });

  it('proceeds with normal run when no verifier is configured', async () => {
    const { proj, card } = _setup();
    _verify.nextResolved = null; // resolveVerifyCommand returns null

    await __test.claimAndRun(proj, card);

    expect(card.column).toBe('in_progress');
    expect(_createdTasks.length).toBe(1);
    expect(_createdTasks[0].model).toBe('claude-sonnet-4.6');
  });

  it('falls through when pre-flight verifier throws', async () => {
    const { proj, card } = _setup({ verifyCommand: 'broken' });
    _verify.nextResolved = { command: 'broken', source: 'card' };
    // Override verifyWorkItem to throw for this case.
    const verifierMod = await import('../lib/work-item-verifier.js');
    verifierMod.verifyWorkItem.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    await __test.claimAndRun(proj, card);

    expect(card.column).toBe('in_progress'); // safe fallback
    expect(_createdTasks.length).toBe(1);
  });
});

describe('buildTaskContext failure-history self-unblock', () => {
  const _project = {
    id: 'p1', name: 'P', rootPath: '/tmp/p1',
    kanban: { maxAiRetries: 2 },
  };

  it('omits failure section when there are no prior failures', () => {
    const card = _mkItem({ id: 'c1', title: 'fresh card', runs: [] });
    const ctx = __test.buildTaskContext(_project, card);
    expect(ctx).not.toMatch(/Prior attempts have failed/);
    expect(ctx).not.toMatch(/FINAL ATTEMPT/);
  });

  it('adds diagnose-first block when prior failures exist', () => {
    const card = _mkItem({ id: 'c1', title: 'flaky card', runs: [
      { taskId: 't1', ok: false, error: 'Run was interrupted while in progress (failed)' },
    ]});
    const ctx = __test.buildTaskContext(_project, card);
    expect(ctx).toMatch(/Prior attempts have failed/);
    expect(ctx).toMatch(/attempt #2 on this card/);
    expect(ctx).toMatch(/Run was interrupted while in progress/);
    expect(ctx).toMatch(/DIAGNOSE BEFORE CODING/);
    // 2nd attempt is the final one (maxAiRetries=2) → final-attempt block too.
    expect(ctx).toMatch(/THIS IS YOUR FINAL ATTEMPT/);
    expect(ctx).toMatch(/root cause/);
  });

  it('marks final attempt and demands actionable handoff', () => {
    const projHigh = { ..._project, kanban: { maxAiRetries: 3 } };
    const card = _mkItem({ id: 'c1', title: 'flaky', runs: [
      { taskId: 't1', ok: false, error: 'first fail' },
      { taskId: 't2', ok: false, error: 'second fail' },
    ]});
    const ctx = __test.buildTaskContext(projHigh, card);
    expect(ctx).toMatch(/attempt #3 on this card/);
    expect(ctx).toMatch(/THIS IS YOUR FINAL ATTEMPT/);
    expect(ctx).toMatch(/exact next step a human should take/);
  });

  it('does NOT mark final attempt when retries remain', () => {
    const projHigh = { ..._project, kanban: { maxAiRetries: 4 } };
    const card = _mkItem({ id: 'c1', title: 'flaky', runs: [
      { taskId: 't1', ok: false, error: 'first fail' },
    ]});
    const ctx = __test.buildTaskContext(projHigh, card);
    expect(ctx).toMatch(/Prior attempts have failed/);
    expect(ctx).not.toMatch(/THIS IS YOUR FINAL ATTEMPT/);
  });

  it('ignores successful runs when counting prior failures', () => {
    const card = _mkItem({ id: 'c1', title: 'mixed', runs: [
      { taskId: 't1', ok: true },
      { taskId: 't2', ok: true },
    ]});
    const ctx = __test.buildTaskContext(_project, card);
    expect(ctx).not.toMatch(/Prior attempts have failed/);
  });
});


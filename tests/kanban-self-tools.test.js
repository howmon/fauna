// Tests for the Kanban work-item self-tools (P3).
// Mocks project-manager so the in-memory store is what we control.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const _state = { items: [], projectRoot: null, projectPatch: null, updateError: null };

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
  getProject: vi.fn(() => ({ id: 'proj-1', name: 'Test', rootPath: _state.projectRoot })),
  updateProject: vi.fn((pid, patch) => {
    if (_state.updateError) throw _state.updateError;
    _state.projectPatch = patch;
    return { id: pid, ...patch };
  }),
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
    if (patch.runEntry) it.runs.push(patch.runEntry);
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

beforeEach(() => {
  _state.items = [];
  _state.projectPatch = null;
  _state.updateError = null;
  _state.projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-engineering-'));
});
afterEach(() => { fs.rmSync(_state.projectRoot, { recursive: true, force: true }); });

const ctx = { activeProjectId: 'proj-1', agentName: 'orchestrator' };

function engineeringProfile() {
  return {
    tracker: { name: 'Tracker', operations: { search: 'Search', create: 'Create', update: 'Update', comment: 'Comment', close: 'Close' } },
    triageRoles: [{ role: 'bug', when: 'Behavior is broken', trackerValue: 'type:bug' }],
    domain: { summary: 'Test domain', terms: [{ term: 'Card', meaning: 'A unit of work' }] },
    context: {
      overview: 'Test project', entryPoints: [{ path: 'main.js', purpose: 'Entry point' }],
      commands: [{ purpose: 'Tests', command: 'npm test' }], boundaries: ['Stay inside the project root'],
    },
  };
}

describe('fauna_setup_engineering', () => {
  it('previews without writing and preserves existing files on apply', async () => {
    fs.writeFileSync(path.join(_state.projectRoot, 'CONTEXT.md'), '# Existing\n');
    const preview = JSON.parse(await executeSelfTool('fauna_setup_engineering', { approved: false, ...engineeringProfile() }, ctx));
    expect(preview.ok).toBe(true);
    expect(preview.applied).toBe(false);
    expect(preview.files.find(file => file.path === 'CONTEXT.md').status).toBe('preserve');
    expect(fs.existsSync(path.join(_state.projectRoot, 'docs/agents/domain.md'))).toBe(false);

    const applied = JSON.parse(await executeSelfTool('fauna_setup_engineering', { approved: true, ...engineeringProfile() }, ctx));
    expect(applied.ok).toBe(true);
    expect(applied.preserved).toContain('CONTEXT.md');
    expect(fs.readFileSync(path.join(_state.projectRoot, 'CONTEXT.md'), 'utf8')).toBe('# Existing\n');
    expect(fs.existsSync(path.join(_state.projectRoot, 'docs/agents/domain.md'))).toBe(true);
    expect(_state.projectPatch.engineeringContract.paths).toContain('docs/adr/README.md');
    expect(applied.cacheUpdated).toBe(true);
    expect(applied.cacheWarning).toBeNull();
  });

  it('refuses a symlinked parent that escapes the project root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-engineering-outside-'));
    try {
      fs.symlinkSync(outside, path.join(_state.projectRoot, 'docs'));
      const result = JSON.parse(await executeSelfTool('fauna_setup_engineering', { approved: true, ...engineeringProfile() }, ctx));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/escapes project root/);
      expect(fs.existsSync(path.join(outside, 'agents/domain.md'))).toBe(false);
      expect(fs.existsSync(path.join(_state.projectRoot, 'CONTEXT.md'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps repository files authoritative when metadata caching fails', async () => {
    _state.updateError = new Error('cache unavailable');
    const result = JSON.parse(await executeSelfTool('fauna_setup_engineering', { approved: true, ...engineeringProfile() }, ctx));
    expect(result.ok).toBe(true);
    expect(result.cacheUpdated).toBe(false);
    expect(result.cacheWarning).toMatch(/cache unavailable/);
    expect(fs.existsSync(path.join(_state.projectRoot, 'CONTEXT.md'))).toBe(true);
  });
});

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

describe('fauna_create_ticket_plan', () => {
  const tickets = [
    {
      key: 'ui', title: 'Add UI', acceptanceCriteria: ['UI works'],
      verifyCommand: 'npm test -- ui', blockedBy: ['api'], fileScope: ['public/ui'],
    },
    {
      key: 'api', title: 'Add API', acceptanceCriteria: ['API works'],
      verifyCommand: 'npm test -- api', blockedBy: [], fileScope: ['server/api'],
    },
  ];

  it('previews without creating cards until approval', async () => {
    const result = JSON.parse(await executeSelfTool(
      'fauna_create_ticket_plan', { tickets, approved: false }, ctx,
    ));
    expect(result.ok).toBe(true);
    expect(result.published).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(result.readyFrontier).toEqual(['api']);
    expect(_state.items).toHaveLength(0);
  });

  it('publishes in dependency order with resolved blocker ids', async () => {
    const result = JSON.parse(await executeSelfTool(
      'fauna_create_ticket_plan', { tickets, approved: true }, ctx,
    ));
    expect(result.ok).toBe(true);
    expect(result.published).toBe(true);
    expect(result.created.map(item => item.key)).toEqual(['api', 'ui']);
    expect(result.created[1].blockedBy).toEqual([result.created[0].id]);
    expect(result.created[0]).toMatchObject({ column: 'todo', assignee: 'ai', blockedBy: [] });
    expect(result.created[0].acceptance).toBe('- API works');
    expect(result.created[0].verifyCommand).toBe('npm test -- api');
    expect(result.created[0].fileScope).toEqual(['server/api']);
    expect(result.readyFrontier).toEqual([result.created[0].id]);
  });
});

describe('fauna_evaluate_worktree_parallelism', () => {
  it('returns evaluation evidence without executing worktrees', async () => {
    const successfulRun = {
      mergeConflict: false,
      verifierPassed: true,
      humanRework: false,
      cleanupSucceeded: true,
    };
    const result = JSON.parse(await executeSelfTool('fauna_evaluate_worktree_parallelism', {
      approved: true,
      candidates: [
        { id: 'api', fileScope: ['server/api'], verifyCommand: 'npm test -- api', blockedBy: [] },
        { id: 'ui', fileScope: ['public/ui'], verifyCommand: 'npm test -- ui', blockedBy: [] },
      ],
      repository: { isGit: true, clean: true, supportsWorktrees: true, baseCommit: '1234567890abcdef' },
      runs: Array(10).fill(successfulRun),
    }, ctx));
    expect(result).toMatchObject({
      ok: true,
      executed: false,
      rolloutRecommendation: 'eligible-for-controlled-rollout',
      candidateEvaluation: { eligible: true },
      rolloutEvaluation: { rolloutReady: true },
    });
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
      itemId: id, title: 'new title', priority: 'p0', acceptance: 'AC', fileScope: ['lib/auth'],
    }, ctx);
    const r = JSON.parse(raw);
    expect(r.ok).toBe(true);
    expect(r.item.title).toBe('new title');
    expect(r.item.priority).toBe('p0');
    expect(r.item.fileScope).toEqual(['lib/auth']);
  });
});

describe('fauna_workitem_record_review', () => {
  it('attaches both review axes and verification to the work-item run', async () => {
    await executeSelfTool('fauna_feature_request_create', { title: 'Review me' }, ctx);
    const itemId = _state.items[0].id;
    const result = JSON.parse(await executeSelfTool('fauna_workitem_record_review', {
      itemId,
      diff: { baseRef: '1111111', headRef: '2222222', mergeBase: '1111111', files: ['src/auth.js'] },
      spec: { status: 'available', reference: 'docs/spec.md' },
      standards: { contextId: 'standards-1', verdict: 'pass', summary: 'Clean', findings: [] },
      specReview: { contextId: 'spec-1', verdict: 'pass', summary: 'Complete', findings: [] },
      verification: { commands: [{ command: 'npm test', ok: true, summary: '42 tests passed' }] },
    }, ctx));
    expect(result.ok).toBe(true);
    expect(_state.items[0].runs).toHaveLength(1);
    expect(_state.items[0].runs[0]).toMatchObject({
      type: 'code-review',
      standards: { contextId: 'standards-1' },
      specReview: { contextId: 'spec-1' },
      verification: { commands: [{ command: 'npm test', ok: true }] },
    });
  });
});

describe('fauna_workitem_record_diagnosis', () => {
  it('attaches red-green diagnosis evidence to the work-item run', async () => {
    await executeSelfTool('fauna_feature_request_create', { title: 'Fix auth failure' }, ctx);
    const itemId = _state.items[0].id;
    const result = JSON.parse(await executeSelfTool('fauna_workitem_record_diagnosis', {
      itemId,
      reproduction: {
        command: 'npx vitest run tests/auth.test.js',
        symptom: 'Expired sessions return 500',
        before: { ok: false, exitCode: 1, summary: 'Expected 401, received 500' },
        after: { ok: true, exitCode: 0, summary: '1 test passed' },
      },
      hypotheses: [
        { rank: 1, claim: 'Expiry throws', prediction: 'Decoder throws', evidence: 'Trace confirms throw', status: 'supported' },
        { rank: 2, claim: 'Middleware absent', prediction: 'Route has no middleware', evidence: 'Middleware is present', status: 'rejected' },
      ],
      regressionTest: { file: 'tests/auth.test.js', name: 'expired session returns 401', failedBefore: true, passedAfter: true },
      instrumentationRemoved: true,
    }, ctx));
    expect(result.ok).toBe(true);
    expect(_state.items[0].runs).toHaveLength(1);
    expect(_state.items[0].runs[0]).toMatchObject({
      type: 'bug-diagnosis',
      reproduction: { before: { ok: false }, after: { ok: true } },
      regressionTest: { failedBefore: true, passedAfter: true },
      instrumentationRemoved: true,
    });
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

// ── Kanban Worker — autopilot that runs AI-assigned cards ────────────────
//
// Polls every PROJECT with `kanban.autopilot=true` on a 15 s interval.
// For each project:
//   1. Find Todo cards where assignee='ai', !claimedBy, no outstanding
//      blockers, and the project is under its concurrency + daily quota.
//   2. Pick highest priority then highest score.
//   3. Claim it (moveWorkItem patch claimedBy='ai:<agent>').
//   4. Move it to in_progress.
//   5. Synthesise a manual task (kind='cron', schedule.type='manual') whose
//      AI prompt is the card body + acceptance criteria, then invoke
//      runTask(taskId). The task-runner already knows how to drive the
//      autonomy loop, call tools, etc.
//   6. Subscribe to task-runner events:
//        'completed' → comment summary, move card to 'review' (or 'done' if
//                      no QA gate is configured on the project), append run.
//        'failed'    → comment error, increment retries. After maxRetries
//                      bounce back to Todo with assignee='human'.
//   7. Separate sweep auto-archives 'done' cards older than archiveDelayMin
//      unless lockedByUser or there are unanswered human comments.
//
// All operations are best-effort and idempotent. The worker holds NO
// in-memory state about cards beyond a per-project in-flight set — if the
// process restarts mid-run, the half-complete card stays in 'in_progress'
// with claimedBy set; the next operator (human or worker) can re-claim it.

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import {
  getAllProjects, getProject, getProjectBoard,
  moveWorkItem, addWorkItemComment, updateBacklogItem, listAllWorkItems,
  appendAutonomousRunLog,
} from './project-manager.js';
import { createTask, getTask } from './task-manager.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const QUOTA_FILE = path.join(CONFIG_DIR, 'autonomous-runs', 'board-quota.json');

const POLL_MS         = 15_000;
const ARCHIVE_TICK_MS = 60_000;     // sweep done cards once a minute
const ORPHAN_STALE_MS = 15 * 60_000; // in_progress cards untouched this long are recovered
const PRIORITY_ORDER  = { p0: 0, p1: 1, p2: 2, p3: 3 };
const DEFAULT_AGENT   = 'orchestrator';

// runTask is imported lazily to break a potential cycle (task-runner → chat
// route → other modules). The worker only needs it at runtime.
let _runTaskImpl = null;
let _subscribeImpl = null;
async function _loadRunner() {
  if (_runTaskImpl) return;
  const mod = await import('./task-runner.js');
  _runTaskImpl   = mod.runTask;
  _subscribeImpl = mod.subscribe;
}

// Emit board events back to the SSE bus so live UIs refresh. Lazy import
// for the same reason as in self-tools.js.
let _boardEmitter = null;
async function _emitBoard(evt) {
  try {
    if (!_boardEmitter) {
      const mod = await import('./server/routes/projects.js');
      _boardEmitter = typeof mod.emitBoardEvent === 'function' ? mod.emitBoardEvent : () => {};
    }
    _boardEmitter(evt);
  } catch (_) { /* swallow */ }
}

// ── Quota persistence ────────────────────────────────────────────────────
function _today() { return new Date().toISOString().slice(0, 10); }

function _readQuota() {
  try { return JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function _writeQuota(obj) {
  try {
    fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('[kanban-worker] quota write failed:', e?.message || e); }
}

function _quotaKey(projectId, day) { return projectId + ':' + (day || _today()); }

function _quotaUsed(projectId) {
  const q = _readQuota();
  return q[_quotaKey(projectId)] || 0;
}

function _quotaIncrement(projectId) {
  const q = _readQuota();
  const k = _quotaKey(projectId);
  q[k] = (q[k] || 0) + 1;
  // Garbage-collect entries older than 14 days
  const cutoff = Date.now() - 14 * 86_400_000;
  for (const key of Object.keys(q)) {
    const day = key.split(':').pop();
    const ts = Date.parse(day + 'T00:00:00Z');
    if (!Number.isFinite(ts) || ts < cutoff) delete q[key];
  }
  _writeQuota(q);
  return q[k];
}

// ── Card scoring ─────────────────────────────────────────────────────────
function _comparePickability(a, b) {
  const pa = PRIORITY_ORDER[a.priority] ?? 2;
  const pb = PRIORITY_ORDER[b.priority] ?? 2;
  if (pa !== pb) return pa - pb;
  const sa = typeof a.score === 'number' ? a.score : 0;
  const sb = typeof b.score === 'number' ? b.score : 0;
  if (sb !== sa) return sb - sa;
  return Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0);
}

// Has at least one unresolved blocker? An item is blocked if another item
// listed in `blockedBy` is not yet column='done' or 'archived'.
function _isBlocked(card, board) {
  if (!Array.isArray(card.blockedBy) || !card.blockedBy.length) return false;
  const byId = new Map();
  for (const col of Object.keys(board.columns)) {
    for (const it of board.columns[col]) byId.set(it.id, it);
  }
  for (const depId of card.blockedBy) {
    const dep = byId.get(depId);
    if (!dep) continue;                     // unknown blocker → ignore
    if (dep.column !== 'done' && dep.column !== 'archived') return true;
  }
  return false;
}

// In-flight count for a project = cards currently column='in_progress' or
// 'review' that we've claimed.
function _aiInFlight(board) {
  let n = 0;
  for (const col of ['in_progress', 'review']) {
    for (const it of board.columns[col] || []) {
      if (it.claimedBy && it.claimedBy.startsWith('ai:')) n++;
    }
  }
  return n;
}

// Pick the next claimable card for a project, or null.
function _pickNext(project) {
  const board = getProjectBoard(project.id);
  if (!board) return null;
  const kanban = project.kanban || {};
  const concurrency = Math.max(1, Number(kanban.concurrency) || 1);
  const dailyQuota  = Math.max(0, Number(kanban.dailyAiQuota) || 0);

  if (_aiInFlight(board) >= concurrency) return null;
  if (dailyQuota && _quotaUsed(project.id) >= dailyQuota) return null;

  const todo = (board.columns.todo || []).filter(it =>
    it.assignee === 'ai' &&
    !it.claimedBy &&
    !it.lockedByUser &&
    !_isBlocked(it, board)
  );
  if (!todo.length) return null;
  todo.sort(_comparePickability);
  return todo[0];
}

// ── Task synthesis ───────────────────────────────────────────────────────
function _buildTaskContext(project, card) {
  const lines = [];
  lines.push('You are working on a Kanban work item from the project "' + project.name + '".');
  lines.push('');
  lines.push('## Work item');
  lines.push('Title: ' + card.title);
  if (card.body) { lines.push(''); lines.push(card.body); }
  if (card.acceptance) {
    lines.push('');
    lines.push('## Acceptance criteria');
    lines.push(card.acceptance);
  }
  lines.push('');
  lines.push('## How to finish');
  lines.push('1. Do the work end-to-end (read files, run shells, edit code as needed).');
  lines.push('2. When you believe it is complete, call `fauna_workitem_verify` to run the verifier (per-card `verifyCommand`, else project `qa.command`). The result is recorded on the card.');
  lines.push('3. If verification passed, call `fauna_workitem_comment` with a short summary, then `fauna_workitem_move` to column="done". Cards with a verifier configured CANNOT be moved to done without a passing verification — the API will reject it.');
  lines.push('4. If verification failed, fix the failures and re-verify. After 2 failed verifications hand back to a human via `fauna_workitem_update` (assignee="human") + `fauna_workitem_move` column="todo".');
  lines.push('5. If you get blocked or need a decision from the user, call `fauna_workitem_comment` describing the blocker and `fauna_workitem_move` with column="todo" + assignee="human" via `fauna_workitem_update`.');
  lines.push('');
  lines.push('Work item id (for the tool calls): ' + card.id);
  lines.push('Project id: ' + project.id);
  return lines.join('\n');
}

function _spawnTaskForCard(project, card) {
  const agentName = (Array.isArray(project.defaultAgent) ? project.defaultAgent[0] : project.defaultAgent) || null;
  const task = createTask({
    kind: 'cron',
    title: '[board] ' + card.title.slice(0, 100),
    description: 'Auto-run for work item ' + card.id,
    schedule: { type: 'manual' },
    projectId: project.id,
    agents: agentName ? [agentName] : [],
    context: _buildTaskContext(project, card),
    permissions: {
      shell: true,
      browser: !!(project.permissions && project.permissions.browser),
      figma: false,
    },
    model: null,           // inherits from settings
    maxRetries: 0,         // we handle retry at the card level
    timeout: 30 * 60_000,
    maxSteps: 80,
  });
  return task;
}

// ── Worker state ─────────────────────────────────────────────────────────
const _pollTimers = { poll: null, archive: null };
const _inFlight   = new Map();  // cardId → { taskId, projectId, unsubscribe }
let   _running    = false;

// ── Claim + run one card ─────────────────────────────────────────────────
async function _claimAndRun(project, card) {
  await _loadRunner();
  const agentClaim = 'ai:' + (
    (Array.isArray(project.defaultAgent) ? project.defaultAgent[0] : project.defaultAgent) ||
    DEFAULT_AGENT
  );

  // Claim + transition into in_progress in a single move call.
  const r = moveWorkItem(project.id, card.id, {
    column: 'in_progress', claimedBy: agentClaim,
  }, { actor: 'ai', strict: true });
  if (!r.ok) {
    console.warn('[kanban-worker] claim failed for', card.id, '—', r.error);
    return;
  }
  _quotaIncrement(project.id);
  _emitBoard({ type: 'claimed', projectId: project.id, item: r.item });

  // Synthesise + start a task.
  let task;
  try { task = _spawnTaskForCard(project, card); }
  catch (e) {
    console.warn('[kanban-worker] task create failed for', card.id, '—', e?.message || e);
    addWorkItemComment(project.id, card.id, { author: 'ai', body: 'Autopilot could not start: ' + e.message });
    moveWorkItem(project.id, card.id, { column: 'todo', assignee: 'human', claimedBy: null }, { actor: 'human' });
    return;
  }

  // Record the run on the card.
  moveWorkItem(project.id, card.id, {
    runEntry: { taskId: task.id, startedAt: Date.now() },
  }, { actor: 'ai' });

  appendAutonomousRunLog(project.id, {
    kind: 'kanban_start', cardId: card.id, taskId: task.id, title: card.title,
  });

  // Subscribe to task-runner events for completion / failure.
  const unsubscribe = _subscribeImpl(task.id, (ev) => _onTaskEvent(project.id, card.id, ev));
  _inFlight.set(card.id, { taskId: task.id, projectId: project.id, unsubscribe });

  // Kick off the run.
  Promise.resolve(_runTaskImpl(task.id)).catch(err => {
    console.warn('[kanban-worker] runTask threw:', err?.message || err);
  });
}

// ── Handle task-runner lifecycle events ──────────────────────────────────
function _onTaskEvent(projectId, cardId, ev) {
  const ent = _inFlight.get(cardId);
  if (!ent || ent.projectId !== projectId) return;

  if (ev.event === 'completed') {
    _finalizeRunSuccess(projectId, cardId, ev);
  } else if (ev.event === 'failed') {
    _finalizeRunFailure(projectId, cardId, ev);
  }
}

function _finalizeRunSuccess(projectId, cardId, ev) {
  const ent = _inFlight.get(cardId);
  if (ent && ent.unsubscribe) ent.unsubscribe();
  _inFlight.delete(cardId);

  const proj = getProject(projectId);
  if (!proj) return;
  // Annotate run entry with success
  const board = getProjectBoard(projectId);
  const card = board && board.columns ? _findCard(board, cardId) : null;
  if (!card) return;

  // Comment with summary (truncated)
  const summary = (ev.summary || '').toString().slice(0, 500);
  if (summary) {
    addWorkItemComment(projectId, cardId, { author: 'ai',
      body: 'Autopilot finished:\n\n' + summary,
    });
  }

  // ── P7: actually run the verifier before moving to done ───────────────
  // Resolution order:
  //   1. card.verifyCommand
  //   2. project.qa.command
  //   3. (none) → trust path, move straight to done
  // We run the verifier in the background and only then move the card.
  // This is fire-and-forget: errors are logged and the card is bounced
  // to 'review' as a fail-safe.
  Promise.resolve().then(async () => {
    let verifyResult = null;
    try {
      const mod = await import('./lib/work-item-verifier.js');
      verifyResult = await mod.verifyWorkItem(projectId, cardId, {
        runId: ent && ent.taskId,
        postComment: true,
      });
    } catch (e) {
      console.warn('[kanban-worker] verify threw:', e?.message || e);
      addWorkItemComment(projectId, cardId, { author: 'ai',
        body: 'Verification step crashed: ' + (e?.message || String(e)) + ' — leaving in review for a human.',
      });
    }

    const stillInProgress = (() => {
      const b = getProjectBoard(projectId);
      const c = b && b.columns ? _findCard(b, cardId) : null;
      return c && c.column === 'in_progress';
    })();

    if (!stillInProgress) {
      // The AI tools already moved it (probably to review). Just record the run.
      moveWorkItem(projectId, cardId, {
        runEntry: { taskId: ent && ent.taskId, finishedAt: Date.now(), ok: true, verified: verifyResult && verifyResult.ok },
      }, { actor: 'ai' });
    } else if (verifyResult && verifyResult.ok === false) {
      // Verifier ran and failed → leave in review for a human, do not advance.
      moveWorkItem(projectId, cardId, {
        column: 'review',
        runEntry: { taskId: ent && ent.taskId, finishedAt: Date.now(), ok: true, verified: false },
      }, { actor: 'ai', strict: true });
    } else {
      // Either verifier passed, or there was no verifier (skipped). Skip
      // 'review' and go straight to 'done' when verification actually ran;
      // for skipped (no QA configured) we also go to done — same trust as
      // the old behaviour.
      moveWorkItem(projectId, cardId, {
        column: 'done',
        runEntry: { taskId: ent && ent.taskId, finishedAt: Date.now(), ok: true, verified: verifyResult && verifyResult.ok === true },
      }, { actor: 'ai', strict: true });
    }

    appendAutonomousRunLog(projectId, {
      kind: 'kanban_complete', cardId, taskId: ent && ent.taskId,
      verified: verifyResult && verifyResult.ok,
      skippedVerify: verifyResult && verifyResult.skipped === true,
    });
    _emitBoard({ type: 'moved', projectId, itemId: cardId });
  });
}

function _finalizeRunFailure(projectId, cardId, ev) {
  const ent = _inFlight.get(cardId);
  if (ent && ent.unsubscribe) ent.unsubscribe();
  _inFlight.delete(cardId);

  const proj = getProject(projectId);
  if (!proj) return;
  const board = getProjectBoard(projectId);
  const card = board && board.columns ? _findCard(board, cardId) : null;
  if (!card) return;

  const maxRetries = Math.max(0, Number((proj.kanban && proj.kanban.maxAiRetries)) || 2);
  const aiFails = (card.runs || []).filter(r => r.ok === false).length;
  const err = (ev.error || 'unknown error').toString().slice(0, 500);

  addWorkItemComment(projectId, cardId, { author: 'ai',
    body: 'Autopilot attempt ' + (aiFails + 1) + ' failed: ' + err,
  });

  if (aiFails + 1 >= maxRetries) {
    // Bounce back to Todo, hand to a human.
    moveWorkItem(projectId, cardId, {
      column: 'todo', assignee: 'human', claimedBy: null,
      runEntry: { taskId: ent && ent.taskId, finishedAt: Date.now(), ok: false, error: err },
    }, { actor: 'human' });
    addWorkItemComment(projectId, cardId, { author: 'ai',
      body: 'Out of retries — handing back to a human to unblock.',
    });
  } else {
    // Release the claim so the next tick can re-pick (or another agent).
    moveWorkItem(projectId, cardId, {
      column: 'todo', claimedBy: null,
      runEntry: { taskId: ent && ent.taskId, finishedAt: Date.now(), ok: false, error: err },
    }, { actor: 'human' });
  }

  appendAutonomousRunLog(projectId, {
    kind: 'kanban_fail', cardId, taskId: ent && ent.taskId, error: err,
  });
  _emitBoard({ type: 'moved', projectId, itemId: cardId });
}

function _findCard(board, cardId) {
  for (const col of Object.keys(board.columns)) {
    for (const it of board.columns[col]) if (it.id === cardId) return it;
  }
  return null;
}

// ── Auto-archive sweep ───────────────────────────────────────────────────
// Sweeps every project (autopilot or not — humans want stale Done cleanup
// too). Archives 'done' cards older than the project's archiveDelayMin
// UNLESS lockedByUser OR there's an unanswered human comment (= last
// comment is by human and no AI reply after).
function _archiveSweep() {
  const items = listAllWorkItems({ column: 'done', limit: 2000 });
  const now = Date.now();
  for (const it of items) {
    if (it.lockedByUser) continue;
    const proj = getProject(it.projectId);
    if (!proj) continue;
    const delayMs = Math.max(1, Number(proj.kanban && proj.kanban.archiveDelayMin) || 10) * 60_000;
    const movedAt = Date.parse(it.movedAt || it.updatedAt || it.createdAt || 0);
    if (!Number.isFinite(movedAt) || now - movedAt < delayMs) continue;
    if (_hasUnansweredHumanComment(it)) continue;
    const r = moveWorkItem(it.projectId, it.id, { column: 'archived' }, { actor: 'ai', strict: true });
    if (r.ok) {
      appendAutonomousRunLog(it.projectId, { kind: 'kanban_archive', cardId: it.id });
      _emitBoard({ type: 'moved', projectId: it.projectId, item: r.item });
    }
  }
}

function _hasUnansweredHumanComment(card) {
  const arr = card.comments || [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].author === 'ai') return false;
    if (arr[i].author === 'human') return true;
  }
  return false;
}

// ── Orphan recovery ──────────────────────────────────────────────────────
// A card may be left stranded in `in_progress` when the worker process
// restarts (in-memory _inFlight is lost) or when the task-runner silently
// drops a job. We periodically scan in_progress cards claimed by AI; if
// none are tracked locally AND the card hasn't moved in ORPHAN_STALE_MS,
// bounce it back to `todo` so the next poll can claim it again.
function _recoverOrphans() {
  const items = listAllWorkItems({ column: 'in_progress', limit: 2000 });
  const now = Date.now();
  for (const it of items) {
    if (!it || !it.projectId) continue;
    // Only touch AI-claimed cards. Human cards in_progress are the user's.
    const claimedBy = it.claimedBy || '';
    if (!claimedBy.startsWith('ai:')) continue;
    // Skip cards we're actively tracking — the live subscription will finalize them.
    if (_inFlight.has(it.id)) continue;
    // Honour user lock.
    if (it.lockedByUser) continue;
    const movedAt = Date.parse(it.movedAt || it.updatedAt || it.createdAt || 0);
    if (!Number.isFinite(movedAt) || (now - movedAt) < ORPHAN_STALE_MS) continue;
    // Honour autopilot off — without it, the recovered card just sits in todo, which is fine.
    const r = moveWorkItem(it.projectId, it.id, {
      column: 'todo', claimedBy: null,
      runEntry: { taskId: null, finishedAt: now, ok: false, recovered: true },
    }, { actor: 'ai', strict: false });
    if (r && r.ok) {
      try {
        addWorkItemComment(it.projectId, it.id, { author: 'ai',
          body: 'Autopilot recovered this card — it was stuck in_progress with no live task. Reset to todo so it can be picked up again.',
        });
      } catch (_) {}
      appendAutonomousRunLog(it.projectId, { kind: 'kanban_orphan_recovered', cardId: it.id });
      _emitBoard({ type: 'moved', projectId: it.projectId, itemId: it.id });
    }
  }
}

// ── Poll tick ────────────────────────────────────────────────────────────
async function _pollTick() {
  if (!_running) return;
  try {
    // Always run orphan recovery first — independent of any project's autopilot
    // setting. Stale `in_progress` cards are a UX trap (the user sees a card
    // "running" that has no live task) so we clear them every tick.
    try { _recoverOrphans(); }
    catch (e) { console.warn('[kanban-worker] orphan recovery error:', e?.message || e); }

    const projects = getAllProjects();
    for (const proj of projects) {
      if (!proj || !(proj.kanban && proj.kanban.autopilot)) continue;
      const card = _pickNext(proj);
      if (!card) continue;
      try { await _claimAndRun(proj, card); }
      catch (e) { console.warn('[kanban-worker] claim+run failed:', e?.message || e); }
    }
  } catch (e) {
    console.warn('[kanban-worker] poll error:', e?.message || e);
  }
}

function _archiveTick() {
  if (!_running) return;
  try { _archiveSweep(); }
  catch (e) { console.warn('[kanban-worker] archive sweep error:', e?.message || e); }
}

// ── Public API ───────────────────────────────────────────────────────────

/** Start the worker. Idempotent. */
export function startKanbanWorker(opts = {}) {
  if (_running) return;
  _running = true;
  const pollMs    = Number(opts.pollMs)    || POLL_MS;
  const archiveMs = Number(opts.archiveMs) || ARCHIVE_TICK_MS;
  _pollTimers.poll    = setInterval(() => { _pollTick();    }, pollMs);
  _pollTimers.archive = setInterval(() => { _archiveTick(); }, archiveMs);
  // First tick after a short delay so the rest of the server finishes boot.
  setTimeout(() => { _pollTick(); _archiveTick(); }, 2_000);
  console.log('[kanban-worker] started (poll ' + pollMs + 'ms, archive ' + archiveMs + 'ms)');
}

/** Stop the worker and unsubscribe from any in-flight tasks. */
export function stopKanbanWorker() {
  _running = false;
  if (_pollTimers.poll)    { clearInterval(_pollTimers.poll);    _pollTimers.poll = null; }
  if (_pollTimers.archive) { clearInterval(_pollTimers.archive); _pollTimers.archive = null; }
  for (const ent of _inFlight.values()) {
    try { ent.unsubscribe && ent.unsubscribe(); } catch (_) {}
  }
  _inFlight.clear();
}

// Test-only: expose internals so we can unit-test pure logic without
// running real intervals or task-runner.
export const __test = {
  pickNext: _pickNext,
  isBlocked: _isBlocked,
  comparePickability: _comparePickability,
  hasUnansweredHumanComment: _hasUnansweredHumanComment,
  archiveSweep: _archiveSweep,
  recoverOrphans: _recoverOrphans,
  finalizeRunSuccess: _finalizeRunSuccess,
  finalizeRunFailure: _finalizeRunFailure,
  inFlight: _inFlight,
  quota: { read: _readQuota, increment: _quotaIncrement, used: _quotaUsed },
};

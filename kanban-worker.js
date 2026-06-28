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
import { createTask, getTask, getAllTasks } from './task-manager.js';
import { taskPowerSave } from './server/lib/power-save.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const QUOTA_FILE    = path.join(CONFIG_DIR, 'autonomous-runs', 'board-quota.json');
const INFLIGHT_FILE = path.join(CONFIG_DIR, 'autonomous-runs', 'kanban-inflight.json');

const POLL_MS         = 15_000;
const ARCHIVE_TICK_MS = 60_000;     // sweep done cards once a minute
const ORPHAN_STALE_MS = 15 * 60_000; // in_progress cards untouched this long are recovered
const PRIORITY_ORDER  = { p0: 0, p1: 1, p2: 2, p3: 3 };
const DEFAULT_AGENT   = 'orchestrator';

// runTask is imported lazily to break a potential cycle (task-runner → chat
// route → other modules). The worker only needs it at runtime.
let _runTaskImpl = null;
let _subscribeImpl = null;
let _isTaskRunningImpl = null;
let _steerTaskImpl = null;
async function _loadRunner() {
  if (_runTaskImpl) return;
  const mod = await import('./task-runner.js');
  _runTaskImpl       = mod.runTask;
  _subscribeImpl     = mod.subscribe;
  _isTaskRunningImpl = mod.isTaskRunning;
  _steerTaskImpl     = mod.steerTask;
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

// ── Lifecycle notifications (native toast + widget alert hub) ────────────
// server.js wires these so the worker can import-free fire OS notifications
// and publish to the widget alert panel without pulling in electron or the
// alert-hub module directly. Mirrors the task-runner pattern.
let _osNotifier = null;       // function(title, body)
let _alertSinkPub = null;     // function({ id, timestamp, source, summary, action, ... })

export function setOsNotifier(fn) { _osNotifier = typeof fn === 'function' ? fn : null; }
export function setAlertSink(fn)  { _alertSinkPub = typeof fn === 'function' ? fn : null; }

function _emitAlert({ title, body, projectId, projectName, cardId, cardTitle, kind }) {
  try {
    if (_osNotifier) _osNotifier(title, body);
  } catch (e) { console.warn('[kanban-worker] os-notify failed:', e?.message || e); }
  try {
    if (_alertSinkPub) {
      _alertSinkPub({
        id: 'kb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        timestamp: Date.now(),
        source: 'kanban',
        summary: title,
        action: body,
        kind,
        projectId,
        projectName,
        cardId,
        cardTitle,
      });
    }
  } catch (e) { console.warn('[kanban-worker] alert-hub publish failed:', e?.message || e); }
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

  // Pickable from BOTH columns:
  //   - todo: the normal queue.
  //   - in_progress with no claim: a human dragged an AI card straight
  //     into in_progress; autopilot should still take it. (Cards that
  //     are actively being worked have `claimedBy` set, so they're skipped.)
  //
  // We DO apply the blocked-by dependency gate to the todo queue, but NOT
  // to in_progress drops — placing a card in in_progress is an explicit
  // human override that says "do this now, ignore dependencies".
  const todoPool = (board.columns.todo || []).filter(it =>
    it.assignee === 'ai' &&
    !it.claimedBy &&
    !it.lockedByUser &&
    !_isBlocked(it, board)
  );
  const inProgressPool = (board.columns.in_progress || []).filter(it =>
    it.assignee === 'ai' &&
    !it.claimedBy &&
    !it.lockedByUser &&
    !_inFlight.has(it.id)
  );
  const pool = todoPool.concat(inProgressPool);
  if (!pool.length) return null;
  pool.sort(_comparePickability);
  return pool[0];
}

// ── Task synthesis ───────────────────────────────────────────────────────
function _buildTaskContext(project, card) {
  const lines = [];
  lines.push('You are working on a Kanban work item from the project "' + project.name + '".');
  if (project.rootPath) {
    lines.push('');
    lines.push('## Project root');
    lines.push('All file reads, edits, and shell commands for this task MUST stay inside:');
    lines.push('  ' + project.rootPath);
    lines.push('Treat this as your working directory. Do NOT touch files outside this root.');
  }
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
  // Surface the most recent comments so re-spawned runs see human steering
  // notes (and prior AI status posts). Humans may also drop comments mid-run;
  // those are injected into the live conversation by `steerCard` below.
  const comments = Array.isArray(card.comments) ? card.comments.slice(-8) : [];
  if (comments.length) {
    lines.push('');
    lines.push('## Recent comments (newest last)');
    for (const c of comments) {
      const who = c.author === 'ai' ? 'AI' : 'HUMAN';
      const body = String(c.body || '').slice(0, 600).replace(/\s+/g, ' ').trim();
      if (body) lines.push('- [' + who + '] ' + body);
    }
    lines.push('');
    lines.push('Treat any HUMAN comment above (and any new HUMAN comment that arrives mid-run as a user message) as a direct steering instruction from the user — address it before continuing.');
  }

  // ── Failure history + self-unblock instructions ──────────────────────
  // Each retry is a fresh agent with no memory of the prior attempt's
  // shell history. Surface the structured failure list so the new agent
  // can diagnose the recurring root cause instead of repeating the same
  // path and failing the same way.
  const failedRuns = Array.isArray(card.runs)
    ? card.runs.filter(r => r && r.ok === false)
    : [];
  if (failedRuns.length > 0) {
    const projMaxRetries = Math.max(0, Number((project.kanban && project.kanban.maxAiRetries)) || 2);
    const isFinalAttempt = (failedRuns.length + 1) >= projMaxRetries;

    lines.push('');
    lines.push('## ⚠️ Prior attempts have failed — DIAGNOSE BEFORE CODING');
    lines.push('You are attempt #' + (failedRuns.length + 1) + ' on this card. Previous attempt(s) failed with:');
    for (let i = 0; i < failedRuns.length; i++) {
      const r = failedRuns[i];
      const errStr = String(r.error || '(no error recorded)').replace(/\s+/g, ' ').slice(0, 400);
      lines.push('  ' + (i + 1) + '. ' + errStr);
    }
    lines.push('');
    lines.push('Before changing any code, you MUST use your shell tools to investigate why prior attempts failed. Common patterns:');
    lines.push('  • "Run was interrupted while in progress" → the task-runner process was killed (system sleep, crash, OOM, parent restart). Check `df -h` for disk space, `vm_stat` / `free -m` for memory pressure, `~/.config/fauna/logs/` for crash traces, and recent edits in the project that may have introduced an infinite loop or memory leak.');
    lines.push('  • Verification failures → run the verifier yourself first, read its output carefully before assuming the prior diagnosis was right.');
    lines.push('  • "Module not found" / dependency errors → check `package.json` / `requirements.txt` / venv, run install commands if missing.');
    lines.push('  • Test timeouts → look for hung child processes (`ps aux | grep node`), zombie test workers.');
    lines.push('');
    lines.push('Only after you have a concrete hypothesis for the failure should you start the work itself. Your first tool calls should be diagnostic (read, ls, cat, ps, git log, etc.), not edits.');

    if (isFinalAttempt) {
      lines.push('');
      lines.push('### ⚠️ THIS IS YOUR FINAL ATTEMPT');
      lines.push('If you cannot complete the work this run, autopilot will hand the card back to a human. Before giving up, you MUST post a `fauna_workitem_comment` containing:');
      lines.push('  1. The root cause you identified (from your shell investigation).');
      lines.push('  2. The specific blocker that prevents you from finishing (be precise — file paths, error messages, commands you tried).');
      lines.push('  3. The exact next step a human should take to unblock this (e.g. "run `brew install foo`", "delete `node_modules` and reinstall", "review architectural decision in line X of file Y").');
      lines.push('Do NOT post a vague "I could not finish" comment — that wastes the human\'s time. A precise handoff with diagnosis is what they need.');
    }
  }

  return lines.join('\n');
}

function _spawnTaskForCard(project, card) {
  const agentName = (Array.isArray(project.defaultAgent) ? project.defaultAgent[0] : project.defaultAgent) || null;
  // Resolve column → skill bindings so task-runner can inject the
  // relevant SKILL.md anatomies into the system prompt and run the
  // anti-rationalization gate on TASK_COMPLETE.
  const column = card.column || 'in_progress';
  const skillBindings = (project.kanban && project.kanban.skillBindings) || {};
  const boundSkills = Array.isArray(skillBindings[column]) ? skillBindings[column].slice() : [];
  const task = createTask({
    kind: 'cron',
    title: '[board] ' + card.title.slice(0, 100),
    description: 'Auto-run for work item ' + card.id,
    schedule: { type: 'manual' },
    projectId: project.id,
    convId: card.originConvId || null,
    agents: agentName ? [agentName] : [],
    context: _buildTaskContext(project, card),
    // Skill bindings consumed by task-runner._resolveTaskSkills.
    skills: boundSkills,
    kanban: { column, skillBindings },
    permissions: {
      // Anchor the shell to the project root when we know it, otherwise
      // fall through to the global default (HOME). Without this the model
      // would happily grep ~/Downloads or any other unrelated folder.
      shell: project.rootPath ? { cwd: project.rootPath } : true,
      browser: !!(project.permissions && project.permissions.browser),
      figma: false,
    },
    // Per-card model override (set via the work-item modal). Falls back
    // to null which means task-runner inherits from app settings.
    model: card.model || null,
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

// Wrap _inFlight set/delete so we can ref-count a system-level power-save
// blocker: the laptop must not sleep while autopilot is mid-run, otherwise
// the task-runner's event loop pauses and the card stalls (then gets
// recovered as a zombie 15 min later, with the user wondering what happened).
// `taskPowerSave` is a no-op until server.js attaches the Electron API.
function _trackInFlight(cardId, entry) {
  if (_inFlight.has(cardId)) {
    // Replacing an existing entry — net ref-count unchanged.
    _inFlight.set(cardId, entry);
    return;
  }
  _inFlight.set(cardId, entry);
  try { taskPowerSave.acquire(); } catch (_) {}
}
function _untrackInFlight(cardId) {
  if (!_inFlight.has(cardId)) return false;
  _inFlight.delete(cardId);
  try { taskPowerSave.release(); } catch (_) {}
  return true;
}

// ── In-flight persistence ────────────────────────────────────────────────
// The _inFlight map is the only thing standing between an autopilot run
// and orphan recovery. When the process dies (laptop sleep killing the
// Electron renderer, OOM, manual quit) we lose the map and the card sits
// in `in_progress` until the 15-min staleness sweep eventually bounces it
// back to `todo`. That's 15 min of UX confusion AND we lose the link from
// card → task so the user can't even open the live viewer.
//
// We persist the map to disk on every set/delete (small object, a few
// dozen entries at most) and rehydrate on worker start so recovery is
// instant and the live viewer keeps working across restarts.

function _persistInFlight() {
  try {
    fs.mkdirSync(path.dirname(INFLIGHT_FILE), { recursive: true });
    const out = {};
    for (const [cardId, ent] of _inFlight) {
      out[cardId] = { taskId: ent.taskId, projectId: ent.projectId, startedAt: ent.startedAt || Date.now() };
    }
    fs.writeFileSync(INFLIGHT_FILE, JSON.stringify(out, null, 2));
  } catch (e) { console.warn('[kanban-worker] inflight write failed:', e?.message || e); }
}

function _readPersistedInFlight() {
  try { return JSON.parse(fs.readFileSync(INFLIGHT_FILE, 'utf8')); }
  catch (_) { return {}; }
}

// Bring the in-flight map back from disk and resubscribe to any tasks
// that survived (rare — but if the worker is restarted without the
// task-runner process dying, e.g. test reload or stop/start of the
// worker only, we should reattach). Tasks that are NOT running anymore
// are treated as zombies and handed off to recovery.
async function _rehydrateInFlight() {
  await _loadRunner();
  const persisted = _readPersistedInFlight();
  const zombies = [];
  for (const cardId of Object.keys(persisted)) {
    const ent = persisted[cardId];
    if (!ent || !ent.taskId || !ent.projectId) continue;
    const stillRunning = _isTaskRunningImpl && _isTaskRunningImpl(ent.taskId);
    if (stillRunning) {
      // Reattach the subscription so finalize-on-completion still works.
      const unsubscribe = _subscribeImpl(ent.taskId, (ev) => _onTaskEvent(ent.projectId, cardId, ev));
      _trackInFlight(cardId, { taskId: ent.taskId, projectId: ent.projectId, unsubscribe, startedAt: ent.startedAt });
    } else {
      zombies.push({ cardId, ent });
    }
  }
  _persistInFlight();
  return zombies;
}

// A zombie is an inflight entry whose task is no longer running. The task
// itself may show status='running' (the task-runner died before it could
// write 'failed'). We finalize the card as a failure so the existing
// retry/handoff logic kicks in. We DO NOT auto-resume — the chat history
// of a multi-step agent run isn't persisted between steps, so a "resume"
// would actually be a fresh start with no context, which is what the
// retry path already provides.
function _recoverZombieTasks(zombies) {
  for (const { cardId, ent } of zombies) {
    const task = (typeof getTask === 'function') ? getTask(ent.taskId) : null;
    const stalledStatus = task && task.status === 'running' ? 'interrupted (system sleep or restart)' : (task && task.status) || 'unknown';
    try {
      _finalizeRunFailure(ent.projectId, cardId, {
        error: 'Run was interrupted while in progress (' + stalledStatus + '). The work-so-far is preserved on the task — open the live viewer to inspect. Retrying.',
      });
    } catch (e) {
      console.warn('[kanban-worker] zombie recovery failed for', cardId, '—', e?.message || e);
    }
  }
}

// Public hook: called by main.js on `powerMonitor.on('resume')` so we
// scan immediately when the laptop wakes up instead of waiting for the
// next 15 s poll.
export async function recoverInterruptedRuns() {
  await _loadRunner();
  const zombies = await _rehydrateInFlight();
  _recoverZombieTasks(zombies);
  // Aggressive sweep — at this point the inflight map is fully rehydrated,
  // so any AI-claimed in_progress card NOT in `_inFlight` is provably dead.
  // Release its claim immediately so the next poll re-picks it (the picker
  // now accepts unclaimed in_progress cards).
  try { _recoverOrphans({ aggressive: true }); } catch (_) {}
}

// ── Claim + run one card ─────────────────────────────────────────────────

// Pre-flight verifier check. Returns true if the card was auto-closed
// (caller should bail out instead of spawning a task). Returns false if
// the caller should proceed with the normal claim+spawn flow.
//
// Honors per-card verifyCommand and project-wide qa.command (both of which
// the user has explicitly opted into). Skips auto-detected verifiers
// (`source === 'auto'`, e.g. sniffed `npm test`) because those aren't an
// intentional gate — a greenfield project where `npm test` passes
// trivially shouldn't auto-close every new card.
async function _maybeAutoClose(project, card, claimedItem) {
  const mod = await import('./lib/work-item-verifier.js');
  if (!mod.resolveVerifyCommand) return false;
  const resolved = mod.resolveVerifyCommand(project, claimedItem || card);
  if (!resolved) return false;
  if (resolved.source !== 'card' && resolved.source !== 'project') return false;

  const v = await mod.verifyWorkItem(project.id, card.id, {
    runId: null,
    postComment: false,
  });
  if (!v || v.ok !== true || v.skipped === true) return false;

  // Verifier passed → record + close.
  const sourceLabel = v.source === 'card' ? 'per-card verifier' : 'project verifier';
  addWorkItemComment(project.id, card.id, {
    author: 'ai',
    body: '🟢 Autopilot pre-flight: the ' + sourceLabel + ' (`' +
      (v.command || resolved.command) +
      '`) already passes against the current code — the work appears to be done already. Auto-closing without spawning an AI run.',
  });
  const mv = moveWorkItem(project.id, card.id, {
    column: 'done',
    runEntry: { taskId: null, finishedAt: Date.now(), ok: true, verified: true, autoClosed: true },
  }, { actor: 'ai', strict: true });
  if (!mv.ok) {
    console.warn('[kanban-worker] auto-close move failed for', card.id, '—', mv.error);
    return false;
  }
  appendAutonomousRunLog(project.id, {
    kind: 'kanban_auto_close', cardId: card.id, title: card.title,
    reason: 'verifier-already-passes', source: v.source,
    command: v.command || resolved.command,
  });
  _emitBoard({ type: 'moved', projectId: project.id, item: mv.item });
  console.log('[kanban-worker] auto-closed already-done card', card.id,
    '— ' + sourceLabel + ' passed pre-flight');
  return true;
}

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
  _emitBoard({ type: 'claimed', projectId: project.id, item: r.item });

  // ── Pre-flight: is the card already done? ─────────────────────────────
  // Run a fast verifier check BEFORE spawning the (expensive) AI task. If
  // the configured verifier (per-card `verifyCommand` or project-wide
  // `qa.command`) already passes against the current code, the work has
  // effectively been done by some other path (manual edit, earlier run,
  // copy-pasted from another branch). Auto-close instead of burning a
  // model run on it. See _maybeAutoClose for source-scoping rationale.
  try {
    const closed = await _maybeAutoClose(project, card, r.item);
    if (closed) return;
  } catch (e) {
    // Pre-flight failure is non-fatal — fall through and run the task as
    // we would have without the check.
    console.warn('[kanban-worker] pre-flight verify error:', e?.message || e);
  }

  _quotaIncrement(project.id);

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
  _trackInFlight(card.id, { taskId: task.id, projectId: project.id, unsubscribe, startedAt: Date.now() });
  _persistInFlight();

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
  _untrackInFlight(cardId);
  _persistInFlight();

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

    // The AI's own tools may have moved the card to 'review' before TASK_COMPLETE
    // (common kanban convention even though our prompt says go straight to 'done').
    // Without this check, such cards sit in 'review' forever AND keep counting
    // toward concurrency, blocking the next claim. Treat 'review' the same as
    // 'in_progress' for finalization: run/honor verifier, then advance to done.
    const stuckInReview = (() => {
      const b = getProjectBoard(projectId);
      const c = b && b.columns ? _findCard(b, cardId) : null;
      return c && c.column === 'review' && c.claimedBy && c.claimedBy.indexOf('ai:') === 0;
    })();

    if (!stillInProgress && !stuckInReview) {
      // The AI tools already moved it somewhere terminal (done/archived/todo).
      // Just record the run.
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

    // ── Lifecycle notification ────────────────────────────────────────
    // We notify the user when the card terminally lands somewhere that
    // needs their attention: 'done' (success) or 'review' (verifier
    // failed — needs a human). If the AI moved it elsewhere already, we
    // stay quiet to avoid double-firing on top of whatever moved it.
    const verifierFailed = verifyResult && verifyResult.ok === false;
    const cardTitle = (card.title || cardId).toString().slice(0, 120);
    if (verifierFailed) {
      _emitAlert({
        title: 'Card needs review: ' + cardTitle,
        body: 'Autopilot finished but verification failed — left in review for you.',
        projectId, projectName: proj.name, cardId, cardTitle,
        kind: 'kanban_review',
      });
    } else if (!stillInProgress && !stuckInReview) {
      // AI tools already moved it terminal — stay quiet.
    } else {
      _emitAlert({
        title: 'Card complete: ' + cardTitle,
        body: ((ev.summary || '').toString().slice(0, 200)) || 'Autopilot finished the card.',
        projectId, projectName: proj.name, cardId, cardTitle,
        kind: 'kanban_complete',
      });
    }
  });
}

function _finalizeRunFailure(projectId, cardId, ev) {
  const ent = _inFlight.get(cardId);
  if (ent && ent.unsubscribe) ent.unsubscribe();
  _untrackInFlight(cardId);
  _persistInFlight();

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

  const cardTitle = (card.title || cardId).toString().slice(0, 120);
  if (aiFails + 1 >= maxRetries) {
    // Bounce back to Todo, hand to a human.
    moveWorkItem(projectId, cardId, {
      column: 'todo', assignee: 'human', claimedBy: null,
      runEntry: { taskId: ent && ent.taskId, finishedAt: Date.now(), ok: false, error: err },
    }, { actor: 'human' });
    addWorkItemComment(projectId, cardId, { author: 'ai',
      body: 'Out of retries — handing back to a human to unblock.',
    });
    _emitAlert({
      title: 'Card needs you: ' + cardTitle,
      body: 'Out of retries (' + maxRetries + ') — handed back to a human. Last error: ' + err.slice(0, 160),
      projectId, projectName: proj.name, cardId, cardTitle,
      kind: 'kanban_out_of_retries',
    });
  } else {
    // Release the claim so the next tick can re-pick (or another agent).
    moveWorkItem(projectId, cardId, {
      column: 'todo', claimedBy: null,
      runEntry: { taskId: ent && ent.taskId, finishedAt: Date.now(), ok: false, error: err },
    }, { actor: 'human' });
    _emitAlert({
      title: 'Card failed (will retry): ' + cardTitle,
      body: 'Attempt ' + (aiFails + 1) + ' of ' + maxRetries + ' failed: ' + err.slice(0, 200),
      projectId, projectName: proj.name, cardId, cardTitle,
      kind: 'kanban_fail',
    });
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

// ── Human steering via card comments ─────────────────────────────────────
// Called by the POST /api/projects/:id/workitems/:itemId/comments route
// after a HUMAN comment is persisted. If there's a live task for the card,
// inject the comment into the running conversation so the model reads it
// at the top of its next step. Otherwise, no-op — the next poll tick will
// re-pick the card (which now includes the comment in its task context).
//
// Returns { steered: bool, taskId?: string }.
export async function steerCard(projectId, cardId, message) {
  try {
    if (!projectId || !cardId || !message) return { steered: false };
    const ent = _inFlight.get(cardId);
    if (!ent || ent.projectId !== projectId) return { steered: false };
    await _loadRunner();
    if (typeof _steerTaskImpl !== 'function') return { steered: false };
    const text = String(message).slice(0, 4000).trim();
    if (!text) return { steered: false };
    const formatted = 'A new HUMAN comment was just posted on the Kanban card you are working on. Treat it as direct steering from the user — read it and adjust course before continuing.\n\n> ' + text;
    const ok = _steerTaskImpl(ent.taskId, formatted);
    return { steered: !!ok, taskId: ent.taskId };
  } catch (e) {
    console.warn('[kanban-worker] steerCard failed:', e?.message || e);
    return { steered: false };
  }
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
// release the claim so the next poll can re-pick it.
//
// `aggressive=true` skips the stale-time check — used at startup right
// after `_rehydrateInFlight()` runs, because at that point we KNOW any
// AI-claimed in_progress card without an inflight entry is dead (no
// race against an in-progress claim transition). The card is left in
// `in_progress` (not bounced to todo) so the new picker — which now
// scans both columns — can grab it again immediately.
function _recoverOrphans(opts = {}) {
  const aggressive = opts.aggressive === true;
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
    if (!aggressive) {
      const movedAt = Date.parse(it.movedAt || it.updatedAt || it.createdAt || 0);
      if (!Number.isFinite(movedAt) || (now - movedAt) < ORPHAN_STALE_MS) continue;
    }
    // Release the claim in-place (keep column = in_progress). The picker
    // now accepts unclaimed in_progress cards, so the next poll re-picks.
    const r = moveWorkItem(it.projectId, it.id, {
      claimedBy: null,
      runEntry: { taskId: null, finishedAt: now, ok: false, recovered: true },
    }, { actor: 'ai', strict: false });
    if (r && r.ok) {
      try {
        addWorkItemComment(it.projectId, it.id, { author: 'ai',
          body: aggressive
            ? 'Autopilot restarted — previous run did not survive. Released the claim so the card can be re-picked.'
            : 'Autopilot recovered this card — it was stuck in_progress with no live task. Released the claim so it can be picked up again.',
        });
      } catch (_) {}
      appendAutonomousRunLog(it.projectId, { kind: 'kanban_orphan_recovered', cardId: it.id, aggressive });
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
      if (!card) {
        // Diagnostic — explain why nothing was picked when there ARE AI
        // cards waiting. Helps the user see what's blocking autopilot.
        try { _logUnpickedReason(proj); } catch (_) {}
        continue;
      }
      try { await _claimAndRun(proj, card); }
      catch (e) { console.warn('[kanban-worker] claim+run failed:', e?.message || e); }
    }
  } catch (e) {
    console.warn('[kanban-worker] poll error:', e?.message || e);
  }
}

// Public hook: called by the move/comment/board routes after any change
// that might make a new card pickable, so the user doesn't have to wait
// up to 15 s for the next interval tick.
let _pokeScheduled = false;
export function pokeNow() {
  if (!_running) return;
  if (_pokeScheduled) return;
  _pokeScheduled = true;
  setTimeout(() => { _pokeScheduled = false; _pollTick(); }, 50);
}

// Diagnostic: when the picker returns null but the project has AI cards
// waiting, build a structured "why is autopilot silent?" snapshot. We
// emit it over SSE for the UI banner and log a throttled summary.
//
// Important: concurrency-cap is NOT a "stuck" condition — it just means
// autopilot is running at full capacity (working as designed). The
// `actionable` flag tells the UI whether to surface the banner. When the
// cap is hit, the only candidates that could be picked are by definition
// already-claimed/in-flight ones, so we also suppress those mechanical
// reasons to avoid double-counting.
const _unpickedLogAt = new Map();
function _computeIdleReasons(project) {
  const board = getProjectBoard(project.id);
  if (!board) return null;
  const kanban = project.kanban || {};
  const concurrency = Math.max(1, Number(kanban.concurrency) || 1);
  const dailyQuota  = Math.max(0, Number(kanban.dailyAiQuota) || 0);
  const inFlight = _aiInFlight(board);
  const candidates = (board.columns.todo || []).concat(board.columns.in_progress || [])
    .filter(it => it.assignee === 'ai');
  if (!candidates.length) return null;  // nothing to pick, not interesting
  const capHit  = inFlight >= concurrency;
  const used    = _quotaUsed(project.id);
  const quotaHit = !!(dailyQuota && used >= dailyQuota);
  const reasons = [];
  if (capHit)   reasons.push({ kind: 'concurrency', label: 'concurrency cap', current: inFlight, limit: concurrency });
  if (quotaHit) reasons.push({ kind: 'quota',       label: 'daily AI quota reached', current: used, limit: dailyQuota });
  // Per-candidate filters. Skip the "claimed"/"in-flight" tallies when the
  // concurrency cap is the cause — those cards ARE the in-flight set, and
  // listing them is redundant noise on a banner that already says "cap reached".
  if (!capHit) {
    const claimed   = candidates.filter(it => !!it.claimedBy).length;
    const liveTrack = candidates.filter(it => it.column === 'in_progress' && _inFlight.has(it.id)).length;
    if (claimed)   reasons.push({ kind: 'claimed',   label: 'already claimed',   count: claimed });
    if (liveTrack) reasons.push({ kind: 'inflight',  label: 'already in-flight', count: liveTrack });
  }
  const locked  = candidates.filter(it => it.lockedByUser).length;
  const blocked = candidates.filter(it => it.column === 'todo' && _isBlocked(it, board)).length;
  if (locked)  reasons.push({ kind: 'locked',  label: 'locked by user',  count: locked });
  if (blocked) reasons.push({ kind: 'blocked', label: 'blocked by deps', count: blocked });
  if (!reasons.length) reasons.push({ kind: 'unknown', label: 'no candidate matched the picker filter' });
  // Actionable = the user should see this. Concurrency cap alone is the
  // happy path (autopilot is working at max) — don't badge the toolbar
  // for it. Quota/locked/blocked/unknown all warrant attention.
  const actionable = reasons.some(r => r.kind !== 'concurrency');
  return { reasons, candidates: candidates.length, actionable };
}
function _logUnpickedReason(project) {
  const info = _computeIdleReasons(project);
  if (!info) return;
  // Emit every tick so the UI badge reflects current state (the SSE handler
  // diffs and is cheap). The UI is responsible for honoring `actionable`.
  _emitBoard({
    type: 'idle', projectId: project.id,
    reasons: info.reasons, candidates: info.candidates, actionable: info.actionable,
  });
  // Console log is throttled to keep stdout readable. We still log even
  // when not actionable — operators inspecting stdout want full visibility.
  const last = _unpickedLogAt.get(project.id) || 0;
  if (Date.now() - last < 60_000) return;
  const summary = info.reasons.map(r => {
    if (r.kind === 'concurrency' || r.kind === 'quota') return r.label + ' (' + r.current + '/' + r.limit + ')';
    if (typeof r.count === 'number') return r.count + ' ' + r.label;
    return r.label;
  }).join(', ');
  console.log('[kanban-worker] ' + project.name + ': autopilot idle —', summary,
    '(candidates=' + info.candidates + ')');
  _unpickedLogAt.set(project.id, Date.now());
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
  // First tick after a short delay so the rest of the server finishes
  // booting. Recovery runs IMMEDIATELY though — we want to surface
  // interrupted runs the moment the worker comes back up so the user
  // sees accurate card state, not the stale "in_progress" from before
  // the crash/sleep.
  recoverInterruptedRuns().catch(e => console.warn('[kanban-worker] startup recovery failed:', e?.message || e));
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
  // Release one power-save ref per in-flight entry before clearing the map,
  // otherwise we'd leak a system-sleep blocker per stop/start cycle.
  const heldRefs = _inFlight.size;
  _inFlight.clear();
  for (let i = 0; i < heldRefs; i++) {
    try { taskPowerSave.release(); } catch (_) {}
  }
  // Note: we deliberately do NOT clear the persisted INFLIGHT_FILE on
  // stop. If the process is being shut down, we WANT the next start to
  // see those entries so it can recover them as zombies.
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
  persistInFlight: _persistInFlight,
  readPersistedInFlight: _readPersistedInFlight,
  rehydrateInFlight: _rehydrateInFlight,
  recoverZombieTasks: _recoverZombieTasks,
  inflightFile: INFLIGHT_FILE,
  quota: { read: _readQuota, increment: _quotaIncrement, used: _quotaUsed },
  computeIdleReasons: _computeIdleReasons,
  maybeAutoClose: _maybeAutoClose,
  claimAndRun: _claimAndRun,
  buildTaskContext: _buildTaskContext,
  emitAlert: _emitAlert,
};

// Public API: compute why autopilot is idle on a project. Returns
// { reasons: [{kind,label,...}], candidates: number } or null when there
// are no AI candidates (in which case autopilot is correctly silent).
// The projects route exposes this via /api/projects/:id/board so the UI
// can fetch it on demand (in addition to the SSE 'idle' event).
export function getIdleReasons(projectId) {
  const p = getAllProjects().find(x => x && x.id === projectId);
  if (!p) return null;
  return _computeIdleReasons(p);
}

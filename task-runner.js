// ── Task Runner — Autonomous Execution Engine ────────────────────────────
// Runs a task by driving the AI in a headless conversation loop.
// Uses the /api/chat endpoint internally (HTTP loopback) so all existing
// infrastructure (browser actions, shell exec, agents, tools) works.

import { getTask, updateTask, completeTask, failTask } from './task-manager.js';
import { buildContext as _buildExprContext, interpolate as _exprInterpolate, hasExpression as _hasExpression } from './server/lib/expr-engine.js';
import { getActionNode } from './server/lib/action-nodes.js';
import { resolveCredential as _resolveCredential } from './credentials-store.js';
import { toItems as _toItems, toItem as _toItem, isItemArray as _isItemArray, brandItems as _brandItems, displayOutput as _displayOutput } from './server/lib/items.js';
import { findSection as _skillFindSection, parseFrontmatter as _skillParseFrontmatter } from './lib/skill-anatomy.js';
import { buildCatalog as _buildSkillCatalog, routeSkill as _routeSkill } from './lib/skill-catalog.js';
import { EVENT_TYPES as _LEDGER, appendEvent as _ledgerAppend } from './lib/run-ledger.js';
import { unstuck as _unstuckPersonas } from './lib/personas.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 3737;
const _runningTasks = new Map(); // taskId → { abortController, step, startedAt }

// Optional hooks injected by server.js so pipeline nodes can fire native OS
// notifications and push to the widget alert hub without importing electron
// or alert-hub directly from the runner.
let _osNotifier = null;       // function(title, body)
let _alertSinkPub = null;     // function({ id, timestamp, source, summary, action })

export function setOsNotifier(fn) { _osNotifier = typeof fn === 'function' ? fn : null; }
export function setAlertSink(fn)  { _alertSinkPub = typeof fn === 'function' ? fn : null; }
// Per-pipeline expression context, keyed by the run's nodeOutputs object so
// concurrent pipelines never collide. Updated synchronously at each node.
const _exprCtxByOutputs = new WeakMap();

function _abortError() {
  const err = new Error('Stopped by user');
  err.name = 'AbortError';
  return err;
}

function _throwIfAborted(signal) {
  if (signal?.aborted) throw _abortError();
}

function _abortableDelay(ms, signal) {
  _throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(_abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── Main entry point — called when scheduler fires or user hits "Run Now" ──

async function runTask(taskId, opts = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found: ' + taskId);

  if (_runningTasks.has(taskId)) {
    console.log('[task-runner] Task already running:', task.title);
    // Reject (rather than silently return undefined) so callers don't
    // hang awaiting a promise that never settles. Use a sentinel code
    // so callers can detect the duplicate-run case cleanly.
    const err = new Error('Task already running: ' + task.title);
    err.code = 'TASK_ALREADY_RUNNING';
    throw err;
  }

  const ac = new AbortController();
  const state = {
    abortController: ac, step: 0, startedAt: Date.now(), log: [], steerQueue: [],
    reasoning: [],   // chain-of-reasoning entries: { step, intent, actions[], outcome }
    stats: { actionsTotal: 0, actionsOk: 0, actionsFailed: 0 },
    nodeResults: [], // pipeline per-node results: { id, label, type, status, output, error }
    triggerPayload: opts.triggerPayload != null ? opts.triggerPayload : null, // inbound webhook body
  };
  _runningTasks.set(taskId, state);

  // Ensure task is marked running — clear previous result on re-run.
  // Also persist the *resolved* model so the live viewer can show
  // "claude-sonnet-4.6" instead of "default" when the task was created
  // with model:null (e.g. autopilot tasks inherit from settings).
  const resolvedModel = task.model || 'claude-sonnet-4.6';
  updateTask(taskId, {
    status: 'running',
    result: null,
    _historyEvent: 'started',
    _historyDetail: opts.trigger || 'manual',
    _resolvedModel: resolvedModel,
    // Clear any stale partial state from a previous interrupted run.
    _partialReasoning: [],
    _partialStats: null,
    _partialStep: 0,
    _partialUpdatedAt: null,
  });

  // Notify listeners (for SSE streaming to widget/panel)
  _emit(taskId, 'started', { title: task.title });

  try {
    if (task.kind === 'pipeline') {
      await _runPipeline(task, state);
    } else {
      await _autonomyLoop(task, state);
    }
  } catch (err) {
    if (err.name === 'AbortError' || state.abortController.signal.aborted) {
      const current = getTask(taskId);
      if (current && current.status === 'running') {
        failTask(taskId, 'Stopped by user');
        _emit(taskId, 'failed', { error: 'Stopped by user' });
      }
      return;
    }
    console.error('[task-runner] Task failed:', task.title, err.message);
    failTask(taskId, err.message);
    _emit(taskId, 'failed', { error: err.message });
  } finally {
    // Save reasoning and stats to task result
    const t = getTask(taskId);
    if (t) {
      const statsData = state.stats;
      const reasoning = state.reasoning;
      updateTask(taskId, {
        result: {
          ...(t.result || {}),
          stats: statsData,
          reasoning: reasoning,
          duration: Date.now() - state.startedAt,
          totalSteps: state.step,
          nodes: state.nodeResults.length ? state.nodeResults : undefined,
        },
      });
    }
    _runningTasks.delete(taskId);
  }
}

// ── Autonomy Loop ────────────────────────────────────────────────────────

async function _autonomyLoop(task, state) {
  const maxSteps = task.maxSteps || 50;
  const timeoutMs = task.timeout || 300000;
  const deadline = state.startedAt + timeoutMs;

  // Build conversation messages
  const messages = [];

  // First user message — task description
  let userPrompt = task.title;
  if (task.description) userPrompt += '\n\n' + task.description;
  if (task.context) userPrompt += '\n\nContext:\n' + task.context;

  // Inject browser tab context if specified
  const perms = task.permissions || {};
  if (perms.browser && typeof perms.browser === 'object' && perms.browser.tabs && perms.browser.tabs.length) {
    userPrompt += '\n\nBrowser tabs to work with:\n' + perms.browser.tabs.map(t => '- ' + t).join('\n');
  }

  if (task.actions && task.actions.length) {
    userPrompt += '\n\nPlanned steps:\n' + task.actions.map((a, i) => `${i + 1}. ${a.type || a.action}: ${JSON.stringify(a)}`).join('\n');
  }
  if (state.triggerPayload != null && state.triggerPayload !== '') {
    userPrompt += '\n\nWebhook payload:\n' + String(state.triggerPayload).slice(0, 8000);
  }
  userPrompt += '\n\nExecute this task autonomously. When done, say "TASK_COMPLETE" followed by a brief summary. If you cannot complete the task, say "TASK_FAILED" followed by the reason.';

  messages.push({ role: 'user', content: userPrompt });

  // System prompt for autonomous mode — scope tools based on permissions
  const toolGuidance = [];
  if (perms.shell !== false) {
    const cwdNote = (perms.shell && typeof perms.shell === 'object' && perms.shell.cwd)
      ? ' (working directory: ' + perms.shell.cwd + ')'
      : '';
    toolGuidance.push('You CAN use shell-exec blocks to run terminal commands' + cwdNote + '.');
  } else {
    toolGuidance.push('You CANNOT use shell commands for this task — shell access is disabled.');
  }
  if (perms.browser) {
    toolGuidance.push('You CAN use ```browser-ext-action blocks to interact with web pages via the browser extension. ALWAYS use ```browser-ext-action (not ```browser-action). Prefer existing/shared tabs first: start with tab:list or extract when the user refers to an open page. Open a new tab only when no relevant shared tab exists or the task gives a new URL. Put ONE action per block. After navigate, use ```browser-ext-action\n{"action":"wait","ms":2000}\n``` before taking a snapshot.');
  } else {
    toolGuidance.push('You CANNOT use browser actions — browser access is disabled for this task.');
  }
  if (perms.figma) {
    toolGuidance.push('You CAN use Figma MCP tools (get_design_context, figma_execute) for design work.');
  } else {
    toolGuidance.push('You CANNOT use Figma tools — Figma access is disabled for this task.');
  }

  const systemPrompt = [
    'You are executing an autonomous task. Work step by step.',
    ..._coreOperatingBehaviors(),
    ..._skillSystemPromptLines(task),
    ...toolGuidance,
    'FORMATTING RULES for action blocks:',
    '- Put EXACTLY ONE action per code block.',
    '- Put the JSON on its OWN line after the opening fence:',
    '  ```browser-ext-action',
    '  {"action":"navigate","url":"https://example.com"}',
    '  ```',
    '- Do NOT put multiple actions in a single block.',
    '- After navigate, always use a wait block before snapshot.',
    'You have full autonomy — do not ask questions, just execute.',
    'After completing the task, respond with TASK_COMPLETE: <summary>.',
    'If the task cannot be completed, respond with TASK_FAILED: <reason>.',
    'Do not explain what you are about to do — just do it.',
  ].join('\n');

  // Track consecutive tool failures (empty/not-found results) to bail early
  let consecutiveNotFoundCount = 0;
  const MAX_CONSECUTIVE_NOT_FOUND = 3;
  const NOT_FOUND_RE = /no such file|not found|no results|0 results|directory is empty|zero files|no files found|no matches|does not exist|cannot find/i;

  // Consecutive stalls (text-only responses with neither actions nor a
  // completion marker). After a couple of these the loop is spinning, so we
  // inject lateral-thinking personas (Feature B5 "unstuck") to break the rut.
  let consecutiveStallCount = 0;
  const MAX_STALL_BEFORE_UNSTUCK = 2;

  // Replayable run ledger (Feature B5). Best-effort — never blocks the run.
  const ledger = _ledgerPath(task.id);
  _ledgerAppend(ledger, { type: _LEDGER.RUN_START, runId: task.id, seedId: task.seedId || null });

  // Surface the semantically-routed skill (Feature A) when one was adopted.
  const autoSkill = _autoRouteSkill(task);
  if (autoSkill && !(Array.isArray(task.skills) && task.skills.length)) {
    _emit(task.id, 'reasoning', { entry: { step: 0, intent: `Auto-routed skill: ${autoSkill}`, actions: [], outcome: 'skill-routed' } });
  }

  for (let step = 0; step < maxSteps; step++) {
    state.step = step + 1;
    _emit(task.id, 'step', { step: state.step });

    // Check timeout
    if (Date.now() > deadline) {
      failTask(task.id, 'Timeout after ' + Math.round(timeoutMs / 1000) + 's');
      _emit(task.id, 'failed', { error: 'timeout' });
      return;
    }

    // Check abort
    if (state.abortController.signal.aborted) {
      updateTask(task.id, { status: 'paused', _historyEvent: 'paused', _historyDetail: 'user abort' });
      _emit(task.id, 'paused', {});
      return;
    }

    // Drain steer queue — inject user messages from external steering
    while (state.steerQueue.length) {
      const steerMsg = state.steerQueue.shift();
      messages.push({ role: 'user', content: steerMsg });
      updateTask(task.id, { _historyEvent: 'steered', _historyDetail: steerMsg.slice(0, 120) });
      _emit(task.id, 'steered', { message: steerMsg.slice(0, 200) });
    }

    // Call AI via loopback
    const aiResponse = await _callChat({
      messages,
      model: task.model || 'claude-sonnet-4.6',
      systemPrompt,
      agentName: _pickAgent(task, state.step),
      projectId: task.projectId || null,
      conversationId: task.convId || task.targetConvId || null,
      autonomousMode: true,
      acceptanceCriteria: task.acceptanceCriteria || '',
      qa: task.qa || null,
      thinkingBudget: 'medium',
      maxContextTurns: 100,
      // Headless run — tells /api/chat to use the relaxed tool-guard caps
      // and auto-allow shell permission prompts (no UI to confirm against).
      headlessTask: true,
    }, state.abortController.signal, (partial) => {
      // Throttled inside _callChat; surface only the tail so we don't ship
      // megabytes of growing strings through SSE every 500ms.
      _emit(task.id, 'partial', {
        step: state.step,
        content: partial.slice(-1500),
        length: partial.length,
      });
    });

    _throwIfAborted(state.abortController.signal);
    if (!aiResponse) {
      failTask(task.id, 'No response from AI');
      _emit(task.id, 'failed', { error: 'no response' });
      return;
    }

    // Add AI response to conversation
    messages.push({ role: 'assistant', content: aiResponse });
    state.log.push({ step: state.step, response: aiResponse.slice(0, 500) });

    // Extract reasoning intent — what the AI said it would do (non-code-block text)
    const intent = aiResponse.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const reasoningEntry = { step: state.step, intent, actions: [], outcome: null };

    // Update task with step progress
    updateTask(task.id, {
      _historyEvent: 'step',
      _historyDetail: 'Step ' + state.step + ': ' + aiResponse.replace(/```[\s\S]*?```/g, '[…]').replace(/\s+/g, ' ').trim().slice(0, 150),
    });

    // FIRST: execute any action blocks in the response (before checking completion markers)
    // The AI often emits action blocks alongside TASK_FAILED guesses — we must run
    // the actions first and feed results back so the AI can make an informed decision.
    const actionResults = await _executeResponseActions(aiResponse, task, state.abortController.signal);

    if (actionResults && actionResults.length) {
      consecutiveStallCount = 0;
      _ledgerAppend(ledger, { type: _LEDGER.ACTION, step: state.step, count: actionResults.length });
      // Track stats and reasoning
      for (const r of actionResults) {
        state.stats.actionsTotal++;
        const ok = !r.output.includes('→ error') && !r.output.includes('→ failed');
        if (ok) state.stats.actionsOk++; else state.stats.actionsFailed++;
        reasoningEntry.actions.push({ type: r.type, action: r.output.split('\n')[0].slice(0, 100), ok });
      }
      reasoningEntry.outcome = 'executed ' + actionResults.length + ' action(s)';
      state.reasoning.push(reasoningEntry);
      _emit(task.id, 'reasoning', { entry: reasoningEntry });
      _persistPartial(task.id, state);

      // Feed action results back — the AI decides next step based on real results
      const feedback = actionResults.map((r, i) =>
        `[Action ${i + 1}] ${r.type}: ${r.output.slice(0, 2000)}`
      ).join('\n\n');

      // Detect consecutive not-found / empty results to bail early
      const allNotFound = actionResults.every(r => NOT_FOUND_RE.test(r.output));
      if (allNotFound) {
        consecutiveNotFoundCount++;
        if (consecutiveNotFoundCount >= MAX_CONSECUTIVE_NOT_FOUND) {
          failTask(task.id, 'Stopped after ' + consecutiveNotFoundCount + ' consecutive not-found results. The requested files or resources do not exist at the searched locations. Please clarify the correct path or provide the missing files.');
          _emit(task.id, 'failed', { error: 'consecutive not-found: resources do not exist' });
          return;
        }
      } else {
        consecutiveNotFoundCount = 0;
      }

      messages.push({ role: 'user', content: feedback + '\n\nContinue the task based on these results. Say TASK_COMPLETE: <summary> when done, or TASK_FAILED: <reason> if you cannot proceed.' });
    } else {
      // No action blocks — this is a pure text response, check for completion markers
      reasoningEntry.outcome = 'text-only response';
      state.reasoning.push(reasoningEntry);
      _emit(task.id, 'reasoning', { entry: reasoningEntry });
      _persistPartial(task.id, state);

      const completionMatch = aiResponse.match(/(?:TASK_COMPLETE|DONE)\s*:?\s*([\s\S]*)/i);
      if (completionMatch) {
        const summary = (completionMatch[1] || '').trim() || 'Task completed successfully';
        // Anti-rationalization gate: if the task has bound skills, force
        // the model to cite evidence against each skill's Verification
        // checklist before accepting TASK_COMPLETE. This is the single
        // most leverage-y guardrail from the addyosmani skill pack —
        // "seems right" is never sufficient; require evidence.
        const verified = await _verifyAgainstSkills({
          task, state, messages, summary,
          systemPrompt,
          signal: state.abortController.signal,
        });
        if (verified.ok) {
          _ledgerAppend(ledger, { type: _LEDGER.STAGE, stage: 'skill-verification', ok: true });
          _ledgerAppend(ledger, { type: _LEDGER.RUN_END, status: 'completed' });
          completeTask(task.id, { summary: summary.slice(0, 500), verification: verified.evidence });
          _emit(task.id, 'completed', { summary: summary.slice(0, 500), verification: verified.evidence });
          return;
        }
        // Rejected — push the gate's rebuttal back into the conversation
        // and continue looping. The verifier already added the assistant
        // turn (the evidence response) and a user follow-up.
        _ledgerAppend(ledger, { type: _LEDGER.STAGE, stage: 'skill-verification', ok: false });
        continue;
      }

      const failedMatch = aiResponse.match(/(?:TASK_FAILED|BLOCKED|NEEDS-INPUT)\s*:?\s*([\s\S]*)/i);
      if (failedMatch) {
        const reason = (failedMatch[1] || '').trim() || 'Task failed (no reason given)';
        _ledgerAppend(ledger, { type: _LEDGER.RUN_END, status: 'failed', reason: reason.slice(0, 200) });
        failTask(task.id, reason.slice(0, 500));
        _emit(task.id, 'failed', { error: reason.slice(0, 500) });
        return;
      }

      // No actions and no completion marker — the AI might be explaining or
      // stuck. After repeated stalls, inject lateral-thinking personas to break
      // the rut instead of the same generic nudge (Feature B5 "unstuck").
      consecutiveStallCount++;
      if (consecutiveStallCount >= MAX_STALL_BEFORE_UNSTUCK) {
        consecutiveStallCount = 0;
        _ledgerAppend(ledger, { type: _LEDGER.UNSTUCK, step: state.step });
        const u = _unstuckPersonas(intent || task.title, { count: 3 });
        const personaLines = u.personas.map((p) => `- ${p.role}: ${p.prompt}`).join('\n');
        messages.push({ role: 'user', content: `You appear stuck — repeating without taking action. ${u.instruction}\n\n${personaLines}\n\nPick the most promising angle, then emit a concrete action block (shell-exec / browser-ext-action). Say TASK_COMPLETE when done.` });
        _emit(task.id, 'reasoning', { entry: { step: state.step, intent: 'unstuck: lateral personas injected', actions: [], outcome: 'unstuck' } });
      } else {
        messages.push({ role: 'user', content: 'Continue executing. Use ```browser-ext-action blocks (one action per block) to take action. Say TASK_COMPLETE when done.' });
      }
    }
  }

  // Max steps exceeded
  failTask(task.id, 'Max steps (' + maxSteps + ') exceeded');
  _emit(task.id, 'failed', { error: 'max steps exceeded' });
}

// ── Agent selection — skill-aware with round-robin fallback ──────────────
//
// When a task has bound skills (via task.skills or kanban skillBindings) and
// 2+ agents to pick from, score each agent by how many of the active skills
// it declares in its agent.json `skills: []` array. Highest score wins;
// ties fall back to round-robin so the existing rotation behaviour holds
// when nobody is a clear specialist.

function _readAgentSkills(agentName) {
  const safe = String(agentName || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return [];
  const home = os.homedir();
  const candidates = [
    path.join(home, '.config', 'fauna', 'agents', safe, 'agent.json'),
    path.join(process.cwd(), 'agents', safe, 'agent.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(manifest.skills) ? manifest.skills : [];
    } catch (_) {}
  }
  return [];
}

function _pickAgent(task, step) {
  const agents = task.agents || [];
  if (agents.length === 0) return null;          // use default
  if (agents.length === 1) return agents[0];

  const active = _resolveTaskSkills(task);
  if (active.length) {
    const activeSet = new Set(active);
    const scored = agents.map((name) => {
      const skills = _readAgentSkills(name);
      let score = 0;
      for (const s of skills) if (activeSet.has(s)) score++;
      return { name, score };
    });
    const top = scored.reduce((a, b) => (b.score > a.score ? b : a), scored[0]);
    if (top.score > 0) {
      // Tie-break among top scorers via round-robin so we still distribute.
      const tied = scored.filter((s) => s.score === top.score).map((s) => s.name);
      return tied[(step - 1) % tied.length];
    }
  }
  return agents[(step - 1) % agents.length];     // round-robin fallback
}

// ── Call /api/chat via loopback ──────────────────────────────────────────

// Streams the chat SSE response and invokes onDelta(partialContent) at most
// once every ~500ms while the model is producing tokens. Returns the full
// assembled assistant text once the stream ends.
async function _callChat(params, signal, onDelta) {
  try {
    const resp = await fetch(`http://localhost:${PORT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });

    if (!resp.ok) throw new Error('Chat API error: ' + resp.status);

    // Fall back to buffered text() if the response body is not a stream
    // (e.g. mocked in tests). This keeps test fixtures working.
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      const text = await resp.text();
      return _parseSseToContent(text);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let lastEmit = 0;
    const DELTA_INTERVAL_MS = 500;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        const next = _accumulateSseLine(line, content);
        if (next !== content) {
          content = next;
          if (typeof onDelta === 'function') {
            const now = Date.now();
            if (now - lastEmit >= DELTA_INTERVAL_MS) {
              lastEmit = now;
              try { onDelta(content); } catch (_) {}
            }
          }
        }
      }
    }
    // Flush any trailing partial line.
    if (buffer) {
      content = _accumulateSseLine(buffer, content);
    }
    // Final flush so the consumer sees the tail even if it falls inside
    // the throttle window.
    if (typeof onDelta === 'function' && content) {
      try { onDelta(content); } catch (_) {}
    }
    return content || null;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    console.error('[task-runner] Chat call failed:', err.message);
    return null;
  }
}

// Pure helper — takes one SSE-formatted line and the accumulated content,
// returns the new accumulated content. Exported via _testables for unit tests.
function _accumulateSseLine(line, content) {
  if (!line.startsWith('data: ')) return content;
  try {
    const evt = JSON.parse(line.slice(6));
    if (evt.type === 'content' && evt.content) return content + evt.content;
    if (evt.type === 'error') {
      console.error('[task-runner] API error in stream:', evt.error);
    }
  } catch (_) {}
  return content;
}

// Buffered fallback parser for when the response body is not streamable.
function _parseSseToContent(text) {
  let content = '';
  for (const line of String(text || '').split('\n')) {
    content = _accumulateSseLine(line, content);
  }
  return content || null;
}

// ── Anti-rationalization gate ────────────────────────────────────────────

// Returns the list of skill slugs this task should verify against. Reads
// from task.skills (preferred), then kanban column bindings (via
// task.kanban.skillBindings[task.kanban.column]) so a card moving through
// the in_progress column gets that column's skills automatically.
function _resolveTaskSkills(task) {
  const out = [];
  const seen = new Set();
  const add = (slug) => {
    const s = String(slug || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(task && task.skills)) task.skills.forEach(add);
  const k = task && task.kanban;
  if (k && k.skillBindings && k.column) {
    const bound = k.skillBindings[k.column];
    if (Array.isArray(bound)) bound.forEach(add);
  }
  return out;
}

// The roots we scan for installed SKILL.md files (same set as
// _locateSkillFile). Returns [{ name, path, description, body }].
function _scanSkillFiles() {
  const home = os.homedir();
  const cwd = process.cwd();
  const roots = [
    path.join(cwd, 'skills'),
    path.join(home, '.config', 'fauna', 'skills'),
    path.join(home, '.config', 'fauna', 'agents', '_skills'),
    path.join(cwd, 'agentstore', '_skills'),
  ];
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      let file = null;
      let name = ent.name;
      if (ent.isDirectory()) {
        const cand = path.join(root, ent.name, 'SKILL.md');
        if (fs.existsSync(cand)) file = cand;
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        file = path.join(root, ent.name);
        name = ent.name.replace(/\.md$/i, '');
      }
      if (!file || seen.has(name)) continue;
      seen.add(name);
      let body = '';
      try { body = fs.readFileSync(file, 'utf8'); } catch (_) {}
      let description = '';
      try { description = (_skillParseFrontmatter(body).frontmatter.description || ''); } catch (_) {}
      out.push({ name, path: file, description, body });
    }
  }
  return out;
}

// Semantically route a task with no bound skills to the best-matching skill.
// Returns a slug (when confident) or null. Computed once per task and cached.
// Uses the deterministic lexical router (no embeddings) so the loop stays fast.
function _autoRouteSkill(task) {
  if (!task) return null;
  if (task.__autoRoutedSkill !== undefined) return task.__autoRoutedSkill;
  let slug = null;
  try {
    const query = [task.title, task.description, task.context].filter(Boolean).join('\n');
    const skills = _scanSkillFiles();
    if (query.trim() && skills.length) {
      const routed = _routeSkill(query, _buildSkillCatalog(skills));
      // Only adopt a routed skill when the router is reasonably confident, so
      // an off-topic task doesn't get a spurious skill forced on it.
      if (routed && routed.ok && routed.top && routed.confidence >= 0.45) {
        slug = routed.top;
      }
    }
  } catch (_) { slug = null; }
  try { Object.defineProperty(task, '__autoRoutedSkill', { value: slug, enumerable: false, configurable: true }); } catch (_) { task.__autoRoutedSkill = slug; }
  return slug;
}

// Append-only run ledger path for a task (Feature B5 — replayable EventStore).
function _ledgerPath(taskId) {
  return path.join(os.homedir(), '.config', 'fauna', 'autonomous-runs', String(taskId).replace(/[^a-zA-Z0-9_.-]/g, '') + '.ledger.jsonl');
}


// Locate a SKILL.md across the same search roots as self-tools._findSkill.
// Kept inline to avoid pulling self-tools into the runner.
function _locateSkillFile(skillName) {
  const safe = String(skillName || '').replace(/[^a-zA-Z0-9_./-]/g, '').replace(/\.\.+/g, '');
  if (!safe) return null;
  const home = os.homedir();
  const cwd = process.cwd();
  const roots = [
    path.join(cwd, 'skills'),
    path.join(home, '.config', 'fauna', 'skills'),
    path.join(home, '.config', 'fauna', 'agents', '_skills'),
    path.join(cwd, 'agentstore', '_skills'),
  ];
  for (const root of roots) {
    const candidates = [
      path.join(root, safe, 'SKILL.md'),
      path.join(root, safe + '.md'),
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
  }
  return null;
}

// Build the Core Operating Behaviors block (compressed from
// addyosmani/using-agent-skills). Kept under 600 chars to stay cheap.
function _coreOperatingBehaviors() {
  return [
    'CORE OPERATING BEHAVIORS (non-negotiable):',
    '1. Surface assumptions before acting on ambiguous requirements.',
    '2. Stop and name confusion rather than guessing through it.',
    '3. Push back when an approach has clear problems; do not be sycophantic.',
    '4. Enforce simplicity — if 100 lines suffice, do not write 1000.',
    '5. Scope discipline — touch only what you were asked to touch.',
    '6. Verify, do not assume. "Seems right" is never sufficient; cite evidence (test output, build result, file contents).',
  ];
}

// Returns prompt lines describing the active skills for this task, with a
// terse description so the model knows which skill bodies to load with
// fauna_get_skill if it needs the full workflow.
function _skillSystemPromptLines(task) {
  const slugs = _resolveTaskSkills(task);
  // When no skills are explicitly bound, semantically route to the best match
  // (Feature A) and surface it as advisory guidance. Auto-routed skills guide
  // the model but are NOT enforced by the evidence gate (which stays opt-in via
  // explicit binding), so a routed skill never blocks TASK_COMPLETE.
  const auto = slugs.length ? null : _autoRouteSkill(task);
  const explicit = slugs.length > 0;
  const effective = slugs.length ? slugs : (auto ? [auto] : []);
  if (!effective.length) return [];
  const summaries = [];
  for (const slug of effective) {
    const file = _locateSkillFile(slug);
    if (!file) { summaries.push(`- ${slug} (not installed)`); continue; }
    try {
      const body = fs.readFileSync(file, 'utf8');
      const { frontmatter } = _skillParseFrontmatter(body);
      const desc = (frontmatter.description || '').slice(0, 200);
      summaries.push(`- ${slug}: ${desc}`);
    } catch (_) { summaries.push(`- ${slug}`); }
  }
  const header = explicit
    ? 'ACTIVE SKILLS for this task (call fauna_get_skill(name) to load the full workflow, or fauna_get_skill(name, "Verification") for just the exit criteria):'
    : 'SUGGESTED SKILL for this task (auto-matched — call fauna_get_skill(name) to load the full workflow if it fits):';
  const footer = explicit
    ? 'You MUST follow each skill\'s Process and pass its Verification before claiming TASK_COMPLETE.'
    : 'Follow this skill\'s Process where it applies before claiming TASK_COMPLETE.';
  return [header, ...summaries, footer];
}

// When the model emits TASK_COMPLETE, require it to cite evidence against
// each active skill\'s Verification checklist. One additional LLM hop —
// cheap insurance against "declared victory at step 3 of 10" failures.
async function _verifyAgainstSkills({ task, state, messages, summary, systemPrompt, signal }) {
  const slugs = _resolveTaskSkills(task);
  if (!slugs.length) return { ok: true, evidence: null };

  // Gather Verification + Common Rationalizations sections for the prompt.
  const sections = [];
  for (const slug of slugs) {
    const file = _locateSkillFile(slug);
    if (!file) continue;
    let body = '';
    try { body = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const verification = _skillFindSection(body, ['Verification', 'Verify', 'Evidence', 'Exit criteria']) || '';
    const rationalizations = _skillFindSection(body, ['Common Rationalizations', 'Rationalizations']) || '';
    sections.push({ slug, verification, rationalizations });
  }
  if (!sections.length) return { ok: true, evidence: null };

  const gatePrompt = [
    'GATE: You announced TASK_COMPLETE. Before this is accepted, you must verify against each active skill.',
    'For EACH skill below, walk its Verification checklist item-by-item and cite concrete evidence (file path + line, command run + output, screenshot, test name + result). Do not paraphrase — quote real output.',
    'If any item is unverified, do NOT claim TASK_COMPLETE again — instead, run the missing verification step now (use shell-exec / browser-ext-action blocks) and report what you ran.',
    'If every item passes with evidence, end your response with the literal token: GATE_PASS',
    'If you discover the task is not actually complete, end your response with: GATE_RETRY <one-line reason>',
    '',
    ...sections.flatMap(s => {
      const out = [`### Skill: ${s.slug}`];
      if (s.rationalizations) {
        out.push('Common Rationalizations (do not use any of these as an excuse to skip verification):');
        out.push(s.rationalizations.slice(0, 2000));
      }
      if (s.verification) {
        out.push('Verification checklist:');
        out.push(s.verification.slice(0, 2000));
      }
      out.push('');
      return out;
    }),
    `Your claimed summary: ${summary.slice(0, 300)}`,
  ].join('\n');

  _emit(task.id, 'partial', { step: state.step, content: '[verification gate] running…', length: 0 });

  messages.push({ role: 'user', content: gatePrompt });

  const verifyResponse = await _callChat({
    messages,
    model: task.model || 'claude-sonnet-4.6',
    systemPrompt,
    agentName: _pickAgent(task, state.step),
    thinkingBudget: 'low',
    maxContextTurns: 100,
    headlessTask: true,
  }, signal, (partial) => {
    _emit(task.id, 'partial', {
      step: state.step,
      content: '[verification gate] ' + partial.slice(-1200),
      length: partial.length,
    });
  });

  if (!verifyResponse) {
    // Treat a missing verifier response as a hard fail — do not silently
    // accept the original TASK_COMPLETE.
    messages.push({ role: 'assistant', content: '(no verifier response)' });
    messages.push({ role: 'user', content: 'Verifier returned no response. Re-run your verification steps with real commands and try again.' });
    return { ok: false, evidence: null };
  }

  messages.push({ role: 'assistant', content: verifyResponse });

  if (/GATE_PASS\b/.test(verifyResponse)) {
    return { ok: true, evidence: verifyResponse.slice(0, 4000) };
  }
  // Either GATE_RETRY or no token — push back into the loop.
  const reason = (verifyResponse.match(/GATE_RETRY\s*(.+)/) || [])[1] || 'verification incomplete';
  messages.push({ role: 'user', content: 'Verification not yet satisfied (' + reason.slice(0, 200) + '). Run the missing verification steps now. Do not say TASK_COMPLETE again until every checklist item has cited evidence.' });
  return { ok: false, evidence: null };
}

// ── Extract and execute action blocks from AI response ───────────────────

async function _executeResponseActions(response, task, signal) {
  const results = [];
  const perms = task.permissions || {};
  _throwIfAborted(signal);

  // Extract ```shell-exec blocks (handle both newline and space/inline after block name)
  const shellBlocks = [];
  const shellRe = /```shell-exec[\s]([\s\S]*?)```/g;
  let m;
  while ((m = shellRe.exec(response))) shellBlocks.push(m[1].trim());

  for (const cmd of shellBlocks) {
    _throwIfAborted(signal);
    // Gate: skip if shell permission is disabled
    if (perms.shell === false) {
      results.push({ type: 'shell-exec', output: 'Shell access is disabled for this task. Skipped.' });
      continue;
    }
    const cwd = (perms.shell && typeof perms.shell === 'object' && perms.shell.cwd) ? perms.shell.cwd : null;
    // Autonomous tasks run headless — no UI to approve per-command permission
    // prompts. The task-level grant (perms.shell !== false) IS the permission.
    // Without bypass, `isCommandSafe` would return permissionRequired:true,
    // the model would see empty output, and fabricate a "tool limit" excuse.
    const bypassPermissions = perms.shell !== false;
    try {
      const r = await fetch(`http://localhost:${PORT}/api/shell-exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, cwd, bypassPermissions }),
        signal,
      });
      const data = await r.json().catch(() => null);
      let output = '';
      if (!data) {
        output = 'Error: shell-exec returned no JSON';
      } else if (data.permissionRequired) {
        // Should never trigger now that bypassPermissions is true, but keep
        // a clear message so a misconfigured task doesn't silently no-op.
        output = `[blocked by permission guard] ${data.command || cmd}` +
          (data.explanation ? `\n${data.explanation}` : '');
      } else {
        const stdout = String(data.stdout || '');
        const stderr = String(data.stderr || '');
        const code = data.exitCode == null ? '?' : data.exitCode;
        output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '') + `\n[exit code: ${code}]`;
      }
      results.push({ type: 'shell-exec', output: output.slice(0, 8000) });
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) throw _abortError();
      results.push({ type: 'shell-exec', output: 'Error: ' + err.message });
    }
  }

  // Extract ```browser-ext-action and ```browser-action blocks — AI uses both forms
  // Allow space or newline after block name (AI sometimes puts JSON on the same line)
  const browserRe = /```browser(?:-ext)?-action[\s]([\s\S]*?)```/g;
  while ((m = browserRe.exec(response))) {
    if (!perms.browser) {
      results.push({ type: 'browser-ext-action', output: 'Browser access is disabled for this task. Skipped.' });
      continue;
    }
    const blockText = m[1].trim();
    // Each block may contain one or more JSON action objects (one per line or a single object)
    const actions = [];
    try {
      // Try parsing as a single JSON object first
      actions.push(JSON.parse(blockText));
    } catch (_) {
      // Try line-by-line (multiple actions in one block)
      for (const line of blockText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try { actions.push(JSON.parse(trimmed)); } catch (_) {}
      }
    }

    for (const act of actions) {
      _throwIfAborted(signal);
      if (!act.action) { results.push({ type: 'browser-ext-action', output: 'Invalid action (no action field): ' + JSON.stringify(act).slice(0, 200) }); continue; }
      try {
        // Determine target tabId — if task has specific tabs, try to resolve
        let tabId = act.tabId || null;

        const r = await fetch(`http://localhost:${PORT}/api/ext/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: act.action,
            params: act,
            tabId,
            timeout: act.timeout || 15000,
          }),
          signal,
        });
        const result = await r.json();
        if (result.ok) {
          // Smart summarize — strip images, cap text, keep useful info
          const summary = _summarizeActionResult(act.action, result);
          results.push({ type: 'browser-ext-action', output: summary });
        } else {
          results.push({ type: 'browser-ext-action', output: act.action + ' → error: ' + (result.error || 'unknown') });
        }
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) throw _abortError();
        results.push({ type: 'browser-ext-action', output: act.action + ' → failed: ' + err.message });
      }
    }
  }

  return results;
}

// ── Smart summarize browser action results ───────────────────────────────
// Strip base64 images, cap extracted text, keep only useful info for the AI

function _summarizeActionResult(action, result) {
  switch (action) {
    case 'snapshot':
    case 'snapshot-full':
      return action + ' → ok (screenshot captured, ' +
        (result.width ? result.width + 'x' + result.height : 'image available') + ')';
    case 'navigate':
      return 'navigate → ok' + (result.url ? ' — now at: ' + result.url : '');
    case 'click':
      return 'click → ok' + (result.clicked ? ' — clicked: ' + String(result.clicked).slice(0, 100) : '');
    case 'fill':
    case 'type':
      return action + ' → ok (filled form field)';
    case 'wait':
      return 'wait → ok';
    case 'hover':
      return 'hover → ok';
    case 'select':
      return 'select → ok';
    case 'keyboard':
      return 'keyboard → ok';
    case 'scroll':
      return 'scroll → ok';
    case 'eval': {
      const val = result.result !== undefined ? String(result.result) : '';
      return 'eval → ok\n' + val.slice(0, 3000);
    }
    case 'extract': {
      const text = result.text || result.content || JSON.stringify(result).slice(0, 3000);
      return 'extract → ok\n' + String(text).slice(0, 3000);
    }
    case 'extract-forms': {
      const forms = result.forms || result.fields || result;
      const txt = typeof forms === 'string' ? forms : JSON.stringify(forms, null, 0);
      return 'extract-forms → ok\n' + txt.slice(0, 3000);
    }
    case 'tab:list': {
      const tabs = result.tabs || [];
      return 'tab:list → ok (' + tabs.length + ' tabs)\n' +
        tabs.map(t => '- ' + (t.title || t.url || t.id)).join('\n').slice(0, 1000);
    }
    case 'tab:info':
      return 'tab:info → ok\n' + JSON.stringify({ id: result.id, title: result.title, url: result.url }).slice(0, 500);
    case 'console-logs': {
      const logs = result.logs || result;
      const txt = typeof logs === 'string' ? logs : JSON.stringify(logs, null, 0);
      return 'console-logs → ok\n' + txt.slice(0, 2000);
    }
    default: {
      // Generic: strip any image/base64 fields, cap to 2000
      const clean = { ...result };
      delete clean.image; delete clean.screenshot; delete clean.base64; delete clean.ok;
      const txt = JSON.stringify(clean, null, 0);
      return action + ' → ok\n' + txt.slice(0, 2000);
    }
  }
}

// ── SSE Event Emitter for live monitoring ────────────────────────────────

const _listeners = new Map(); // taskId → Set<callback>

// Flush the in-memory chain-of-reasoning + stats to the persisted task on
// every reasoning step. Without this, a process killed mid-run (laptop
// sleep, crash, OOM) loses everything the model already produced and the
// /api/tasks/:id/live endpoint has nothing to show after recovery.
// We cap at the most recent 50 entries to keep tasks.json small.
function _persistPartial(taskId, state) {
  try {
    const reasoning = Array.isArray(state.reasoning) ? state.reasoning.slice(-50) : [];
    updateTask(taskId, {
      _partialReasoning: reasoning,
      _partialStats: state.stats ? { ...state.stats } : null,
      _partialStep: state.step,
      _partialUpdatedAt: Date.now(),
    });
  } catch (_) { /* best-effort */ }
}

function _emit(taskId, event, data) {
  const cbs = _listeners.get(taskId);
  if (cbs) cbs.forEach(cb => { try { cb({ taskId, event, ...data }); } catch (_) {} });
  // Also emit to 'all' listeners (for the task panel)
  const allCbs = _listeners.get('*');
  if (allCbs) allCbs.forEach(cb => { try { cb({ taskId, event, ...data }); } catch (_) {} });
}

function subscribe(taskId, callback) {
  if (!_listeners.has(taskId)) _listeners.set(taskId, new Set());
  _listeners.get(taskId).add(callback);
  return () => {
    const cbs = _listeners.get(taskId);
    if (cbs) { cbs.delete(callback); if (cbs.size === 0) _listeners.delete(taskId); }
  };
}

// ── Control ──────────────────────────────────────────────────────────────

function pauseTask(taskId) {
  const state = _runningTasks.get(taskId);
  if (state) state.abortController.abort();
}

function stopTask(taskId) {
  const state = _runningTasks.get(taskId);
  if (state) {
    state.abortController.abort();
    failTask(taskId, 'Stopped by user');
    _emit(taskId, 'failed', { error: 'Stopped by user' });
  }
}

function steerTask(taskId, message) {
  const state = _runningTasks.get(taskId);
  if (!state) return false;
  state.steerQueue.push(message);
  return true;
}

function isTaskRunning(taskId) {
  return _runningTasks.has(taskId);
}

function getRunningTaskInfo(taskId) {
  const state = _runningTasks.get(taskId);
  if (!state) return null;
  // Clone reasoning so callers can't mutate the live array.
  const reasoning = Array.isArray(state.reasoning) ? state.reasoning.slice() : [];
  // Last entry is the freshest "what the model is doing right now" line.
  const current = reasoning.length ? reasoning[reasoning.length - 1] : null;
  return {
    step: state.step,
    startedAt: state.startedAt,
    elapsed: Date.now() - state.startedAt,
    reasoning,
    current,
    stats: state.stats ? { ...state.stats } : null,
  };
}

function getRunningTasks() {
  const result = [];
  for (const [id, state] of _runningTasks) {
    result.push({ id, step: state.step, startedAt: state.startedAt, elapsed: Date.now() - state.startedAt });
  }
  return result;
}

// ── Pipeline executor ────────────────────────────────────────────────────
// Runs a pipeline kind task by executing its node graph.

async function _runPipeline(task, state) {
  const pipeline = task.pipeline;
  if (!pipeline || !pipeline.nodes || !pipeline.nodes.length) {
    throw new Error('Pipeline has no nodes');
  }

  const nodes = pipeline.nodes;
  const edges = pipeline.edges || [];

  // nodeId -> label map for $node["Label"] expression access
  const _nodeLabels = {};
  nodes.forEach(n => { if (n.label) _nodeLabels[n.id] = n.label; });

  // Topological sort (Kahn's algorithm)
  const inDeg = {};
  const adj   = {};    // nodeId → [{ to, fromPort, toPort }]
  nodes.forEach(n => { inDeg[n.id] = 0; adj[n.id] = []; });
  edges.forEach(e => {
    if (inDeg[e.to] !== undefined) inDeg[e.to]++;
    if (adj[e.from]) adj[e.from].push({ to: e.to, fromPort: e.fromPort, toPort: e.toPort });
  });

  const queue    = nodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
  const order    = [];
  const skipped  = new Set();   // nodes on non-taken condition branches

  while (queue.length) {
    const nid = queue.shift();
    order.push(nid);
    (adj[nid] || []).forEach(e => {
      if (--inDeg[e.to] === 0) queue.push(e.to);
    });
  }

  // Accumulate outputs per node
  const nodeOutputs = {};

  for (const nid of order) {
    _throwIfAborted(state.abortController.signal);
    if (skipped.has(nid)) {
      nodeOutputs[nid] = null;
      const skippedNode = nodes.find(n => n.id === nid);
      if (skippedNode) state.nodeResults.push({ id: nid, label: skippedNode.label, type: skippedNode.type, status: 'skipped' });
      continue;
    }

    const node = nodes.find(n => n.id === nid);
    if (!node) continue;

    // Resolve inputs. `inputs` holds every upstream branch's output (for the
    // merge node); `input` is the first non-skipped upstream value (legacy
    // single-input behaviour for every other node).
    const inEdges = edges.filter(e => e.to === nid);
    const liveEdges = inEdges.filter(e => !skipped.has(e.from));
    const inputs = liveEdges.map(e => nodeOutputs[e.from] ?? null);
    const input  = inputs.length ? inputs[0] : null;

    state.step++;
    _emit(task.id, 'step', { step: state.step, nodeId: nid, nodeType: node.type });
    updateTask(task.id, { _historyEvent: 'step', _historyDetail: 'Pipeline step: ' + node.label + ' (' + node.type + ')' });

    let output;
    const cfg = node.config || {};
    // Publish this node's expression context (input + items + label map) for
    // _interpolate. `items` powers $items/$item/$binary in expressions.
    _exprCtxByOutputs.set(nodeOutputs, { input, items: _toItems(input), labels: _nodeLabels, creds: {} });
    try {
      _throwIfAborted(state.abortController.signal);
      switch (node.type) {

        case 'trigger':
          // Inbound webhook payload (if any) becomes the trigger output so
          // downstream nodes can consume the request body.
          output = (input != null ? input : (state.triggerPayload != null ? state.triggerPayload : '')) ?? '';
          break;

        case 'prompt':
        case 'agent': {
          // Run a prompt against the AI — disable tools so the model processes
          // the piped data instead of searching the web
          const promptText = _interpolate(cfg.prompt || node.label, nodeOutputs);
          const aiResp = await _callChat({
            messages: [{ role: 'user', content: promptText }],
            model:    task.model || 'claude-sonnet-4.6',
            agentName: cfg.agentName || _pickAgent(task, state.step),
            noTools: node.type === 'prompt',
          }, state.abortController.signal);
          _throwIfAborted(state.abortController.signal);
          output = aiResp || '';
          break;
        }

        case 'shell': {
          // Run shell command
          const cmd = _interpolate(cfg.command || '', nodeOutputs);
          const shellResult = await _callChat({
            messages: [{ role: 'user', content: '```shell-exec\n' + cmd + '\n```\nReturn only the command output, no explanation.' }],
            model: task.model || 'claude-sonnet-4.6',
            systemPrompt: 'Execute shell commands. Return only the output.',
          }, state.abortController.signal);
          _throwIfAborted(state.abortController.signal);
          output = shellResult || '';
          break;
        }

        case 'browser': {
          const url  = _interpolate(cfg.url || '', nodeOutputs);
          const inst = _interpolate(cfg.instruction || 'Summarize this page', nodeOutputs);
          const browserResp = await _callChat({
            messages: [{ role: 'user', content: 'Navigate to ' + url + ' and ' + inst }],
            model: task.model || 'claude-sonnet-4.6',
            systemPrompt: 'You can use browser-ext-action blocks. Navigate and return results.',
          }, state.abortController.signal);
          _throwIfAborted(state.abortController.signal);
          output = browserResp || '';
          break;
        }

        case 'figma': {
          const inst = _interpolate(cfg.instruction || 'Describe the current Figma selection', nodeOutputs);
          const figmaResp = await _callChat({
            messages: [{ role: 'user', content: inst }],
            model: task.model || 'claude-sonnet-4.6',
            systemPrompt: 'You have access to Figma MCP tools.',
          }, state.abortController.signal);
          _throwIfAborted(state.abortController.signal);
          output = figmaResp || '';
          break;
        }

        case 'condition': {
          // Evaluate JS expression
          const expr = _interpolate(cfg.expression || 'false', nodeOutputs);
          let result = false;
          try {
            // eslint-disable-next-line no-new-func
            result = !!(new Function('input', 'return (' + expr + ')'))(input);
          } catch (_) { result = false; }
          output = result;
          // Skip nodes on the non-taken port
          const takenPort  = result ? 'true' : 'false';
          const skippedPort = result ? 'false' : 'true';
          edges.filter(e => e.from === nid && e.fromPort === skippedPort).forEach(e => {
            // BFS to mark all downstream of skipped port
            const toSkip = [e.to];
            while (toSkip.length) {
              const sid = toSkip.shift();
              skipped.add(sid);
              edges.filter(e2 => e2.from === sid).forEach(e2 => toSkip.push(e2.to));
            }
          });
          break;
        }

        case 'loop': {
          const maxIter = parseInt(cfg.maxIterations || '10', 10);
          const condExpr = _interpolate(cfg.condition || 'false', nodeOutputs);
          let loopInput = input;
          let iteration = 0;
          // Execute body nodes repeatedly (simplified: just run condition check)
          while (iteration < maxIter) {
            let stop = false;
            try {
              // eslint-disable-next-line no-new-func
              stop = !!(new Function('input', 'iteration', 'return (' + condExpr + ')')(loopInput, iteration));
            } catch (_) { stop = true; }
            if (stop) break;
            iteration++;
          }
          output = loopInput;
          break;
        }

        case 'parse-urgent': {
          // Inspect the upstream output for HEARTBEAT_URGENT|source|summary|action
          // or HEARTBEAT_OK markers and emit a structured object downstream:
          //   { status: 'urgent'|'ok', source, summary, action, raw }
          // Mirrors the parser in heartbeat.js so a pipeline can replace the
          // standalone heartbeat module. Always emits an object — downstream
          // nodes (e.g. condition) can switch on $json.status.
          const raw = String(input == null ? '' : input);
          const um = raw.match(/^[\s>*-]*HEARTBEAT_URGENT\|([^|\n]*)\|([^|\n]+)(?:\|([^\n]+))?/im);
          if (um) {
            output = {
              status: 'urgent',
              source: um[1].trim(),
              summary: um[2].trim(),
              action: (um[3] || '').trim(),
              raw,
            };
          } else {
            output = { status: 'ok', source: '', summary: '', action: '', raw };
          }
          break;
        }

        case 'os-notify': {
          // Fire a native OS notification AND publish to the widget alert
          // hub (subject to per-call toggles). Accepts either a plain string
          // input or a parse-urgent-shaped object.
          let title = _interpolate(cfg.title || '', nodeOutputs);
          let body  = _interpolate(cfg.body  || '', nodeOutputs);
          let source = '';
          let action = '';
          let isUrgent = true;
          if (input && typeof input === 'object' && 'status' in input) {
            isUrgent = input.status === 'urgent';
            if (!title) title = isUrgent ? '🫀 Heartbeat Alert' : 'Heartbeat OK';
            if (!body)  body  = input.summary + (input.source ? ` (${input.source})` : '') +
                                (input.action ? `\nSuggested: ${input.action}` : '');
            source = input.source || '';
            action = input.action || '';
          } else {
            if (!title) title = task.title || 'Automation';
            if (!body)  body  = String(input == null ? '' : input).slice(0, 500);
          }
          // Respect node config toggles — onlyUrgent skips the OK case.
          if (cfg.onlyUrgent === 'true' || cfg.onlyUrgent === true) {
            if (!isUrgent) { output = input; break; }
          }
          if (cfg.os !== 'false' && cfg.os !== false && _osNotifier) {
            try { _osNotifier(title, body); } catch (e) { console.warn('[task-runner] os-notify failed:', e?.message || e); }
          }
          if (cfg.widget !== 'false' && cfg.widget !== false && _alertSinkPub) {
            try {
              _alertSinkPub({
                id: 'pl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
                timestamp: Date.now(),
                source: source || (task.title || 'pipeline'),
                summary: title,
                action: action || body,
              });
            } catch (e) { console.warn('[task-runner] alert sink failed:', e?.message || e); }
          }
          output = input;
          break;
        }

        case 'notify': {
          // Post the pipeline output to a new conversation in the app.
          // Conversations live in renderer localStorage, so we emit a SSE 'notify'
          // event that the front-end handles to inject a new conversation directly.
          const convId = 'conv-task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
          const convTitle = _interpolate(cfg.title || '', nodeOutputs) || task.title + ' — result';
          const msgText = String(input);
          // Emit to renderer — it will create the conversation in localStorage
          _emit(task.id, 'notify', { convId, title: convTitle, content: msgText });
          // Also persist server-side as a fallback
          await fetch(`http://localhost:${PORT}/api/conversations/${convId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: convId, title: convTitle,
              createdAt: new Date().toISOString(),
              messages: [{ role: 'assistant', content: msgText, timestamp: new Date().toISOString() }],
            }),
            signal: state.abortController.signal,
          }).catch(() => {});
          output = convId;
          break;
        }

        case 'webhook': {
          const url = _interpolate(cfg.url || '', nodeOutputs);
          if (!url) { output = 'Node error: No URL configured'; break; }
          const method = cfg.method || 'POST';
          const body   = cfg.body ? _interpolate(cfg.body, nodeOutputs) : undefined;
          const fetchOpts = { method, headers: { 'Content-Type': 'application/json' }, signal: state.abortController.signal };
          if (body && method !== 'GET') fetchOpts.body = body;
          const resp   = await fetch(url, fetchOpts);
          _throwIfAborted(state.abortController.signal);
          output = await resp.text();
          break;
        }

        case 'delay': {
          const ms = parseInt(cfg.ms || '1000', 10);
          await _abortableDelay(Math.min(ms, 30000), state.abortController.signal);
          output = input;
          break;
        }

        case 'code': {
          const code = _interpolate(cfg.code || 'return input;', nodeOutputs);
          try {
            // eslint-disable-next-line no-new-func
            output = (new Function('input', code))(input);
          } catch (e) {
            output = 'Code error: ' + e.message;
          }
          break;
        }

        case 'split': {
          // Split Out — expand an array (or a field of the input) into a
          // multi-item array so downstream nodes fan out, one run per item.
          let src = input;
          if (cfg.field) {
            const obj = _maybeParse(input);
            src = obj && typeof obj === 'object' ? obj[cfg.field] : undefined;
          } else {
            src = _maybeParse(input);
          }
          output = Array.isArray(src)
            ? _brandItems(src.map(v => ({ json: v })))
            : _toItems(input);
          break;
        }

        case 'merge': {
          // Merge — recombine multiple upstream branches into one item array.
          //   append (default): concatenate all branches' items
          //   combine / byIndex: shallow-merge json by position
          const mode = cfg.mode || 'append';
          const branches = inputs.map(v => _toItems(v));
          if (mode === 'combine' || mode === 'byIndex') {
            const maxLen = branches.reduce((m, a) => Math.max(m, a.length), 0);
            const merged = [];
            for (let i = 0; i < maxLen; i++) {
              const json = {};
              const binary = {};
              branches.forEach(a => {
                if (!a[i]) return;
                const j = _maybeParse(a[i].json);
                if (j && typeof j === 'object' && !Array.isArray(j)) Object.assign(json, j);
                else json['value' + (Object.keys(json).length)] = j;
                if (a[i].binary) Object.assign(binary, a[i].binary);
              });
              const item = { json };
              if (Object.keys(binary).length) item.binary = binary;
              merged.push(item);
            }
            output = _brandItems(merged);
          } else {
            output = _brandItems([].concat(...branches));
          }
          break;
        }

        default: {
          // Pluggable connector nodes (HTTP, Slack, …) from the action-node
          // registry. Falls through to pass-through for unknown types.
          const actionDef = getActionNode(node.type);
          if (actionDef && typeof actionDef.run === 'function') {
            const resolveCred = (id) => { try { return _resolveCredential(id); } catch (_) { return null; } };
            // Per-item fan-out: when the input is a multi-item array, run the
            // connector once per item (n8n semantics) and collect an item array.
            if (_isItemArray(input) && input.length > 1) {
              const collected = [];
              let failed = null;
              for (const it of input) {
                _throwIfAborted(state.abortController.signal);
                const r = await actionDef.run({
                  input: it.json,
                  item: it,
                  cfg,
                  interp: (s) => _interpolate(s, nodeOutputs, it),
                  resolveCred,
                  signal: state.abortController.signal,
                });
                if (typeof r === 'string' && r.startsWith('Node error')) { failed = r; break; }
                collected.push(_toItem(r));
              }
              output = failed != null ? failed : _brandItems(collected);
            } else {
              const single = _isItemArray(input) ? (input[0] || { json: null }) : null;
              output = await actionDef.run({
                input: single ? single.json : input,
                item: single,
                cfg,
                interp: (s) => _interpolate(s, nodeOutputs, single),
                resolveCred,
                signal: state.abortController.signal,
              });
            }
            _throwIfAborted(state.abortController.signal);
          } else {
            output = input;
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError' || state.abortController.signal.aborted) throw _abortError();
      output = 'Node error: ' + e.message;
    }

    // Treat undefined/null output as a node failure (e.g. code node that never returns)
    if (output === undefined || output === null) {
      output = 'Node error: Step produced no output (returned ' + output + ')';
    }
    nodeOutputs[nid] = output;
    state.stats.actionsTotal++;
    const _outStr = _displayOutput(output);
    const _isError = typeof output === 'string' && (
                     _outStr.startsWith('Node error') ||
                     _outStr.startsWith('Code error') ||
                     _outStr.startsWith('BLOCKED:') ||
                     _outStr.startsWith('Condition error'));
    const ok = !_isError;
    if (ok) state.stats.actionsOk++; else state.stats.actionsFailed++;
    state.nodeResults.push({
      id: nid,
      label: node.label,
      type: node.type,
      status: ok ? 'ok' : 'failed',
      output: ok ? _outStr.slice(0, 300) : null,
      error: ok ? null : _outStr.replace(/^Node error: |^Code error: |^BLOCKED: |^Condition error: /, ''),
    });
    state.reasoning.push({ step: state.step, intent: node.label, actions: [{ type: node.type, action: node.label, ok }], outcome: _displayOutput(output).slice(0, 200) });
  }

  // Final output = last node's output
  const lastId = order[order.length - 1];
  const summary = (_displayOutput(nodeOutputs[lastId]) || 'Pipeline completed').slice(0, 500);

  // If any node failed, mark the whole pipeline as failed
  if (state.stats.actionsFailed > 0) {
    const failedNodes = state.nodeResults.filter(n => n.status === 'failed').map(n => n.label).join(', ');
    const errMsg = `Pipeline failed: ${state.stats.actionsFailed} step(s) errored — ${failedNodes}`;
    failTask(task.id, errMsg);
    _emit(task.id, 'failed', { error: errMsg, nodes: state.nodeResults });
    return;
  }

  completeTask(task.id, { summary });
  _emit(task.id, 'completed', { summary });
}

// Best-effort JSON parse for the split/merge field helpers.
function _maybeParse(val) {
  if (typeof val !== 'string') return val;
  const t = val.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return val;
  try { return JSON.parse(t); } catch (_) { return val; }
}

// Variable interpolation: legacy {{nodeId}} / {{nodeId.output}} substitution,
// plus n8n-style {{ $json.x }} expressions via the sandboxed expr-engine.
// `currentItem` (optional) scopes $json/$item/$binary to one item on fan-out.
function _interpolate(str, nodeOutputs, currentItem) {
  if (!str) return str;
  // Legacy: bare node-id references (word chars only — never matches $-exprs).
  let s = String(str).replace(/\{\{\s*(\w+)(?:\.output)?\s*\}\}/g, (_m, id) => {
    const v = nodeOutputs[id];
    return v !== undefined && v !== null ? _displayOutput(v) : '';
  });
  // New: $-namespaced expressions ({{ $json.x }}, {{ $node["L"].output }}, …).
  if (_hasExpression(s)) {
    const meta = _exprCtxByOutputs.get(nodeOutputs) || {};
    const ctx = _buildExprContext({
      input: currentItem ? currentItem.json : meta.input,
      items: meta.items,
      item: currentItem || undefined,
      nodeOutputs,
      labels: meta.labels,
      creds: meta.creds,
    });
    const out = _exprInterpolate(s, ctx);
    s = typeof out === 'object' ? JSON.stringify(out) : String(out);
  }
  return s;
}

export {
  runTask, pauseTask, stopTask, steerTask,
  isTaskRunning, getRunningTaskInfo, getRunningTasks,
  subscribe,
};

// Internal helpers exposed for unit testing only.
export const _testables = {
  scanSkillFiles: _scanSkillFiles,
  autoRouteSkill: _autoRouteSkill,
  resolveTaskSkills: _resolveTaskSkills,
  skillSystemPromptLines: _skillSystemPromptLines,
  ledgerPath: _ledgerPath,
};

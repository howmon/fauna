// ── Task Runner — Autonomous Execution Engine ────────────────────────────
// Runs a task by driving the AI in a headless conversation loop.
// Uses the /api/chat endpoint internally (HTTP loopback) so all existing
// infrastructure (browser actions, shell exec, agents, tools) works.

import { getTask, updateTask, completeTask, failTask } from './task-manager.js';
import { buildContext as _buildExprContext, interpolate as _exprInterpolate, hasExpression as _hasExpression } from './server/lib/expr-engine.js';
import { getActionNode } from './server/lib/action-nodes.js';
import { resolveCredential as _resolveCredential } from './credentials-store.js';
import { toItems as _toItems, toItem as _toItem, isItemArray as _isItemArray, brandItems as _brandItems, displayOutput as _displayOutput } from './server/lib/items.js';

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
      thinkingBudget: 'medium',
      maxContextTurns: 100,
    }, state.abortController.signal);

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

      if (/TASK_COMPLETE/i.test(aiResponse)) {
        const summary = aiResponse.replace(/[\s\S]*TASK_COMPLETE:?\s*/i, '').trim() || 'Task completed successfully';
        completeTask(task.id, { summary: summary.slice(0, 500) });
        _emit(task.id, 'completed', { summary: summary.slice(0, 500) });
        return;
      }

      if (/TASK_FAILED/i.test(aiResponse)) {
        const reason = aiResponse.replace(/[\s\S]*TASK_FAILED:?\s*/i, '').trim() || 'Task failed (no reason given)';
        failTask(task.id, reason.slice(0, 500));
        _emit(task.id, 'failed', { error: reason.slice(0, 500) });
        return;
      }

      // No actions and no completion marker — the AI might be explaining or stuck
      // Give it one more nudge
      messages.push({ role: 'user', content: 'Continue executing. Use ```browser-ext-action blocks (one action per block) to take action. Say TASK_COMPLETE when done.' });
    }
  }

  // Max steps exceeded
  failTask(task.id, 'Max steps (' + maxSteps + ') exceeded');
  _emit(task.id, 'failed', { error: 'max steps exceeded' });
}

// ── Agent selection — round-robin across assigned agents ─────────────────

function _pickAgent(task, step) {
  const agents = task.agents || [];
  if (agents.length === 0) return null;          // use default
  if (agents.length === 1) return agents[0];
  return agents[(step - 1) % agents.length];     // round-robin
}

// ── Call /api/chat via loopback ──────────────────────────────────────────

async function _callChat(params, signal) {
  try {
    const resp = await fetch(`http://localhost:${PORT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });

    if (!resp.ok) throw new Error('Chat API error: ' + resp.status);

    // Parse SSE stream to collect the full assistant response
    const text = await resp.text();
    let content = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === 'content' && evt.content) content += evt.content;
        if (evt.type === 'tool_output' && evt.output) content += evt.output;
        if (evt.type === 'error') {
          console.error('[task-runner] API error in stream:', evt.error);
        }
      } catch (_) {}
    }
    return content || null;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    console.error('[task-runner] Chat call failed:', err.message);
    return null;
  }
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
    try {
      const r = await fetch(`http://localhost:${PORT}/api/shell-exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, cwd }),
        signal,
      });
      // SSE stream — collect output
      const text = await r.text();
      let output = '';
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'output') output += evt.data;
          if (evt.type === 'exit') output += '\n[exit code: ' + evt.code + ']';
        } catch (_) {}
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

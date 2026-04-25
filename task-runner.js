// ── Task Runner — Autonomous Execution Engine ────────────────────────────
// Runs a task by driving the AI in a headless conversation loop.
// Uses the /api/chat endpoint internally (HTTP loopback) so all existing
// infrastructure (browser actions, shell exec, agents, tools) works.

import { getTask, updateTask, completeTask, failTask } from './task-manager.js';

const PORT = 3737;
const _runningTasks = new Map(); // taskId → { abortController, step, startedAt }

// ── Main entry point — called when scheduler fires or user hits "Run Now" ──

async function runTask(taskId, opts = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found: ' + taskId);

  if (_runningTasks.has(taskId)) {
    console.log('[task-runner] Task already running:', task.title);
    return;
  }

  const ac = new AbortController();
  const state = {
    abortController: ac, step: 0, startedAt: Date.now(), log: [], steerQueue: [],
    reasoning: [],   // chain-of-reasoning entries: { step, intent, actions[], outcome }
    stats: { actionsTotal: 0, actionsOk: 0, actionsFailed: 0 },
  };
  _runningTasks.set(taskId, state);

  // Ensure task is marked running — clear previous result on re-run
  updateTask(taskId, { status: 'running', result: null, _historyEvent: 'started', _historyDetail: opts.trigger || 'manual' });

  // Notify listeners (for SSE streaming to widget/panel)
  _emit(taskId, 'started', { title: task.title });

  try {
    await _autonomyLoop(task, state);
  } catch (err) {
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
    toolGuidance.push('You CAN use ```browser-ext-action blocks to interact with web pages via the browser extension. ALWAYS use ```browser-ext-action (not ```browser-action). Put ONE action per block. After navigate, use ```browser-ext-action\n{"action":"wait","ms":2000}\n``` before taking a snapshot.');
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
    const actionResults = await _executeResponseActions(aiResponse, task);

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

      // Feed action results back — the AI decides next step based on real results
      const feedback = actionResults.map((r, i) =>
        `[Action ${i + 1}] ${r.type}: ${r.output.slice(0, 2000)}`
      ).join('\n\n');
      messages.push({ role: 'user', content: feedback + '\n\nContinue the task based on these results. Say TASK_COMPLETE: <summary> when done, or TASK_FAILED: <reason> if you cannot proceed.' });
    } else {
      // No action blocks — this is a pure text response, check for completion markers
      reasoningEntry.outcome = 'text-only response';
      state.reasoning.push(reasoningEntry);
      _emit(task.id, 'reasoning', { entry: reasoningEntry });

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

async function _executeResponseActions(response, task) {
  const results = [];
  const perms = task.permissions || {};

  // Extract ```shell-exec blocks (handle both newline and space/inline after block name)
  const shellBlocks = [];
  const shellRe = /```shell-exec[\s]([\s\S]*?)```/g;
  let m;
  while ((m = shellRe.exec(response))) shellBlocks.push(m[1].trim());

  for (const cmd of shellBlocks) {
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
  return { step: state.step, startedAt: state.startedAt, elapsed: Date.now() - state.startedAt };
}

function getRunningTasks() {
  const result = [];
  for (const [id, state] of _runningTasks) {
    result.push({ id, step: state.step, startedAt: state.startedAt, elapsed: Date.now() - state.startedAt });
  }
  return result;
}

export {
  runTask, pauseTask, stopTask, steerTask,
  isTaskRunning, getRunningTaskInfo, getRunningTasks,
  subscribe,
};

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
  const state = { abortController: ac, step: 0, startedAt: Date.now(), log: [], steerQueue: [] };
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

    // Update task with step progress
    updateTask(task.id, {
      _historyEvent: 'step',
      _historyDetail: 'Step ' + state.step + ': ' + aiResponse.slice(0, 120),
    });

    // Check for completion markers
    if (/TASK_COMPLETE/i.test(aiResponse)) {
      const summary = aiResponse.replace(/.*TASK_COMPLETE:?\s*/i, '').trim() || 'Task completed successfully';
      completeTask(task.id, { summary });
      _emit(task.id, 'completed', { summary });
      return;
    }

    if (/TASK_FAILED/i.test(aiResponse)) {
      const reason = aiResponse.replace(/.*TASK_FAILED:?\s*/i, '').trim() || 'Task failed (no reason given)';
      failTask(task.id, reason);
      _emit(task.id, 'failed', { error: reason });
      return;
    }

    // Check if the AI produced actionable blocks (shell-exec, browser-ext-action, etc.)
    // The /api/chat endpoint handles tool calls server-side, but code blocks in the
    // response text need the client to execute them. For autonomous mode, we extract
    // and auto-execute them, then feed results back.
    const actionResults = await _executeResponseActions(aiResponse, task);

    if (actionResults && actionResults.length) {
      // Feed action results back as user message for next iteration
      const feedback = actionResults.map((r, i) =>
        `[Action ${i + 1}] ${r.type}: ${r.output.slice(0, 2000)}`
      ).join('\n\n');
      messages.push({ role: 'user', content: feedback + '\n\nContinue the task based on these results. Say TASK_COMPLETE when done or TASK_FAILED if stuck.' });
    } else {
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
          // Summarize result — extract useful fields, cap size
          const summary = JSON.stringify(result, null, 0).slice(0, 4000);
          results.push({ type: 'browser-ext-action', output: act.action + ' → ok\n' + summary });
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
  runTask, pauseTask, steerTask,
  isTaskRunning, getRunningTaskInfo, getRunningTasks,
  subscribe,
};

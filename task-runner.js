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
  const state = { abortController: ac, step: 0, startedAt: Date.now(), log: [] };
  _runningTasks.set(taskId, state);

  // Ensure task is marked running
  updateTask(taskId, { status: 'running', _historyEvent: 'started', _historyDetail: opts.trigger || 'manual' });

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
  const maxSteps = task.maxSteps || 20;
  const timeoutMs = task.timeout || 300000;
  const deadline = state.startedAt + timeoutMs;

  // Build conversation messages
  const messages = [];

  // First user message — task description
  let userPrompt = task.title;
  if (task.description) userPrompt += '\n\n' + task.description;
  if (task.context) userPrompt += '\n\nContext:\n' + task.context;
  if (task.actions && task.actions.length) {
    userPrompt += '\n\nPlanned steps:\n' + task.actions.map((a, i) => `${i + 1}. ${a.type || a.action}: ${JSON.stringify(a)}`).join('\n');
  }
  userPrompt += '\n\nExecute this task autonomously. When done, say "TASK_COMPLETE" followed by a brief summary. If you cannot complete the task, say "TASK_FAILED" followed by the reason.';

  messages.push({ role: 'user', content: userPrompt });

  // System prompt for autonomous mode
  const systemPrompt = [
    'You are executing an autonomous task. Work step by step, using shell-exec, browser-ext-action, and other tools as needed.',
    'You have full autonomy — do not ask questions, just execute.',
    'After completing the task, respond with TASK_COMPLETE: <summary>.',
    'If the task cannot be completed, respond with TASK_FAILED: <reason>.',
    'Do not explain what you are about to do — just do it.',
  ].join('\n');

  for (let step = 0; step < maxSteps; step++) {
    state.step = step + 1;
    _emit(task.id, 'step', { step: state.step, maxSteps });

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

    // Call AI via loopback
    const aiResponse = await _callChat({
      messages,
      model: task.model || 'claude-sonnet-4.6',
      systemPrompt,
      agentName: task.agent || null,
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
      const feedback = actionResults.map(r => r.type + ' result:\n' + r.output).join('\n\n');
      messages.push({ role: 'user', content: feedback + '\n\nContinue the task. Say TASK_COMPLETE when done or TASK_FAILED if stuck.' });
    } else {
      // No actions and no completion marker — the AI might be explaining or stuck
      // Give it one more nudge
      messages.push({ role: 'user', content: 'Continue executing. Use shell-exec or browser-ext-action blocks to take action. Say TASK_COMPLETE when done.' });
    }
  }

  // Max steps exceeded
  failTask(task.id, 'Max steps (' + maxSteps + ') exceeded');
  _emit(task.id, 'failed', { error: 'max steps exceeded' });
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
        if (evt.type === 'token' && evt.token) content += evt.token;
        if (evt.type === 'tool_output' && evt.output) content += evt.output;
      } catch (_) {}
    }
    return content;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    console.error('[task-runner] Chat call failed:', err.message);
    return null;
  }
}

// ── Extract and execute action blocks from AI response ───────────────────

async function _executeResponseActions(response, task) {
  const results = [];

  // Extract ```shell-exec blocks
  const shellBlocks = [];
  const shellRe = /```shell-exec\n([\s\S]*?)```/g;
  let m;
  while ((m = shellRe.exec(response))) shellBlocks.push(m[1].trim());

  for (const cmd of shellBlocks) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/shell-exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, cwd: null }),
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

  // Extract ```browser-ext-action blocks (these need the client-side executeExtAction)
  // For autonomous mode, we call the extension relay directly via WebSocket
  // But for now, we note them as needing browser — the AI handles tool calls internally
  const browserRe = /```browser-ext-action\n([\s\S]*?)```/g;
  while ((m = browserRe.exec(response))) {
    results.push({ type: 'browser-ext-action', output: 'Browser action block detected — executed via tool call loop.' });
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
  runTask, pauseTask,
  isTaskRunning, getRunningTaskInfo, getRunningTasks,
  subscribe,
};

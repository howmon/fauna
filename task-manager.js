// ── Task Manager — CRUD, Persistence, Scheduler ─────────────────────────
// Manages tasks stored in ~/.config/fauna/tasks.json
// Provides scheduling loop that fires tasks at their scheduled time.

import fs   from 'fs';
import path from 'path';
import os   from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const TASKS_FILE = path.join(CONFIG_DIR, 'tasks.json');

// ── Persistence ──────────────────────────────────────────────────────────

function readTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); }
  catch (_) { return []; }
}

function writeTasks(tasks) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

// ── CRUD ─────────────────────────────────────────────────────────────────

function createTask(opts) {
  const tasks = readTasks();
  const task = {
    id:          'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    title:       opts.title || 'Untitled task',
    description: opts.description || '',
    status:      'pending',  // pending | scheduled | running | completed | failed | paused
    schedule: {
      type:     opts.schedule?.type || 'manual',     // manual | once | recurring
      at:       opts.schedule?.at || null,            // ISO string for once
      cron:     opts.schedule?.cron || null,           // cron expression for recurring
      timezone: opts.schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    agents:      _normalizeAgents(opts.agents || opts.agent),  // array of agent names (empty = default)
    actions:     opts.actions || [],                    // pre-planned action steps
    context:     opts.context || '',                    // extra context for the AI
    model:       opts.model || null,                    // override model or null = use default
    maxRetries:  opts.maxRetries ?? 2,
    timeout:     opts.timeout ?? 300000,                // 5 min default
    maxSteps:    opts.maxSteps ?? 20,                   // max autonomy iterations
    result:      null,
    history:     [{ timestamp: Date.now(), event: 'created', detail: null }],
    convId:      null,                                  // linked conversation (set at run time)
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };

  // If schedule.type === 'once' and schedule.at is set, mark as scheduled
  if (task.schedule.type === 'once' && task.schedule.at) {
    task.status = 'scheduled';
    task.history.push({ timestamp: Date.now(), event: 'scheduled', detail: task.schedule.at });
  }
  if (task.schedule.type === 'recurring' && task.schedule.cron) {
    task.status = 'scheduled';
    task.history.push({ timestamp: Date.now(), event: 'scheduled', detail: 'cron: ' + task.schedule.cron });
  }

  tasks.push(task);
  writeTasks(tasks);
  return task;
}

// Normalize agent input: string, array, null → always an array
function _normalizeAgents(val) {
  if (!val) return [];
  if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
  if (Array.isArray(val)) return val.flatMap(v => typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : []).filter(Boolean);
  return [];
}

function getTask(id) {
  const t = readTasks().find(t => t.id === id) || null;
  // Backward compat: migrate old single `agent` field to `agents` array
  if (t && !t.agents && t.agent !== undefined) {
    t.agents = _normalizeAgents(t.agent);
    delete t.agent;
  }
  return t;
}

function getAllTasks() {
  return readTasks().map(t => {
    // Backward compat: migrate old single `agent` field to `agents` array
    if (!t.agents && t.agent !== undefined) {
      t.agents = _normalizeAgents(t.agent);
      delete t.agent;
    }
    return t;
  });
}

function updateTask(id, updates) {
  const tasks = readTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;

  const allowed = ['title', 'description', 'status', 'schedule', 'agent', 'actions',
                   'context', 'model', 'maxRetries', 'timeout', 'maxSteps', 'result', 'convId'];
  for (const key of allowed) {
    if (key in updates) tasks[idx][key] = updates[key];
  }
  tasks[idx].updatedAt = new Date().toISOString();

  if (updates._historyEvent) {
    tasks[idx].history.push({
      timestamp: Date.now(),
      event: updates._historyEvent,
      detail: updates._historyDetail || null
    });
  }

  writeTasks(tasks);
  return tasks[idx];
}

function deleteTask(id) {
  const tasks = readTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  writeTasks(tasks);
  return true;
}

// ── Cron Parsing (minimal — supports "min hour dom month dow") ───────────

function cronMatchesNow(cronExpr) {
  if (!cronExpr) return false;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const now = new Date();
  const fields = [
    now.getMinutes(),      // 0
    now.getHours(),        // 1
    now.getDate(),         // 2
    now.getMonth() + 1,    // 3
    now.getDay(),          // 4
  ];
  for (let i = 0; i < 5; i++) {
    if (parts[i] === '*') continue;
    // Handle */N step values
    if (parts[i].startsWith('*/')) {
      const step = parseInt(parts[i].slice(2), 10);
      if (step && fields[i] % step !== 0) return false;
      continue;
    }
    // Handle comma-separated values
    const vals = parts[i].split(',').map(v => parseInt(v, 10));
    if (!vals.includes(fields[i])) return false;
  }
  return true;
}

function nextCronOccurrence(cronExpr) {
  // Simple: scan forward up to 7 days to find next match
  if (!cronExpr) return null;
  const now = new Date();
  for (let m = 1; m <= 10080; m++) { // up to 7 days in minutes
    const candidate = new Date(now.getTime() + m * 60000);
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5) return null;
    const fields = [candidate.getMinutes(), candidate.getHours(), candidate.getDate(), candidate.getMonth() + 1, candidate.getDay()];
    let match = true;
    for (let i = 0; i < 5; i++) {
      if (parts[i] === '*') continue;
      if (parts[i].startsWith('*/')) {
        const step = parseInt(parts[i].slice(2), 10);
        if (step && fields[i] % step !== 0) { match = false; break; }
        continue;
      }
      const vals = parts[i].split(',').map(v => parseInt(v, 10));
      if (!vals.includes(fields[i])) { match = false; break; }
    }
    if (match) return candidate.toISOString();
  }
  return null;
}

// ── Scheduler Loop ───────────────────────────────────────────────────────

let _schedulerTimer = null;
let _onTaskDue = null;  // callback: (task) => void — set by server.js

function startScheduler(onTaskDue) {
  _onTaskDue = onTaskDue;
  if (_schedulerTimer) clearInterval(_schedulerTimer);
  _schedulerTimer = setInterval(() => _tick(), 30000); // every 30s
  console.log('[task-mgr] Scheduler started (30s interval)');
}

function stopScheduler() {
  if (_schedulerTimer) { clearInterval(_schedulerTimer); _schedulerTimer = null; }
  console.log('[task-mgr] Scheduler stopped');
}

function _tick() {
  const tasks = readTasks();
  const now = Date.now();

  for (const task of tasks) {
    if (task.status !== 'scheduled') continue;

    // One-time tasks
    if (task.schedule.type === 'once' && task.schedule.at) {
      const at = new Date(task.schedule.at).getTime();
      if (at <= now) {
        console.log('[task-mgr] Task due:', task.title);
        updateTask(task.id, { status: 'running', _historyEvent: 'started', _historyDetail: 'scheduler' });
        if (_onTaskDue) _onTaskDue(task);
      }
    }

    // Recurring tasks
    if (task.schedule.type === 'recurring' && task.schedule.cron) {
      if (cronMatchesNow(task.schedule.cron)) {
        // Prevent double-fire: check last run wasn't in the same minute
        const lastRun = task.history.filter(h => h.event === 'started').pop();
        if (lastRun) {
          const lastRunTime = new Date(lastRun.timestamp);
          const nowDate = new Date();
          if (lastRunTime.getFullYear() === nowDate.getFullYear() &&
              lastRunTime.getMonth() === nowDate.getMonth() &&
              lastRunTime.getDate() === nowDate.getDate() &&
              lastRunTime.getHours() === nowDate.getHours() &&
              lastRunTime.getMinutes() === nowDate.getMinutes()) {
            continue; // already fired this minute
          }
        }
        console.log('[task-mgr] Recurring task due:', task.title);
        updateTask(task.id, { status: 'running', _historyEvent: 'started', _historyDetail: 'scheduler (recurring)' });
        if (_onTaskDue) _onTaskDue(task);
      }
    }
  }
}

// ── Mark task complete / failed (called by task-runner) ──────────────────

function completeTask(id, result) {
  const updates = {
    status: 'completed',
    result: { ok: true, summary: result?.summary || '', completedAt: new Date().toISOString() },
    _historyEvent: 'completed',
    _historyDetail: result?.summary || null,
  };
  const task = updateTask(id, updates);

  // For recurring tasks, re-schedule
  if (task && task.schedule.type === 'recurring' && task.schedule.cron) {
    const next = nextCronOccurrence(task.schedule.cron);
    updateTask(id, {
      status: 'scheduled',
      result: task.result, // keep last result
      _historyEvent: 'rescheduled',
      _historyDetail: next,
    });
  }
  return task;
}

function failTask(id, error) {
  const task = getTask(id);
  if (!task) return null;

  const retries = task.history.filter(h => h.event === 'retry').length;
  if (retries < task.maxRetries) {
    // Retry
    updateTask(id, {
      status: 'scheduled',
      schedule: { ...task.schedule, at: new Date(Date.now() + 60000).toISOString() }, // retry in 1 min
      _historyEvent: 'retry',
      _historyDetail: error,
    });
    return getTask(id);
  }

  // Max retries exceeded — mark failed
  const updates = {
    status: 'failed',
    result: { ok: false, error: error, completedAt: new Date().toISOString() },
    _historyEvent: 'failed',
    _historyDetail: error,
  };
  const updated = updateTask(id, updates);

  // For recurring tasks, still re-schedule next occurrence
  if (updated && updated.schedule.type === 'recurring' && updated.schedule.cron) {
    const next = nextCronOccurrence(updated.schedule.cron);
    updateTask(id, {
      status: 'scheduled',
      _historyEvent: 'rescheduled',
      _historyDetail: next,
    });
  }
  return updated;
}

export {
  readTasks, writeTasks,
  createTask, getTask, getAllTasks, updateTask, deleteTask,
  startScheduler, stopScheduler,
  completeTask, failTask,
  cronMatchesNow, nextCronOccurrence,
};

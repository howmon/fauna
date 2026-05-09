// ── Task Manager — CRUD, Persistence, Scheduler ─────────────────────────
// Manages tasks/automations stored in ~/.config/fauna/tasks.json
// Supports cron (RRULE), heartbeat (thread-watching), and pipeline (node graph) kinds.

import fs   from 'fs';
import path from 'path';
import os   from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const TASKS_FILE = path.join(CONFIG_DIR, 'tasks.json');
const TASKS_BACKUP_FILE = path.join(CONFIG_DIR, 'backups', 'tasks.json');

// ── RRULE Engine ─────────────────────────────────────────────────────────
// Supports: FREQ, INTERVAL, BYHOUR, BYMINUTE, BYDAY, BYMONTHDAY, COUNT, UNTIL

const WEEKDAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseRrule(rruleStr) {
  if (!rruleStr) return null;
  const out = {};
  for (const part of rruleStr.split(';')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    const key = k.trim().toUpperCase();
    const val = v.trim();
    switch (key) {
      case 'FREQ':       out.freq = val; break;
      case 'INTERVAL':   out.interval = parseInt(val, 10) || 1; break;
      case 'BYHOUR':     out.byHour = val.split(',').map(Number); break;
      case 'BYMINUTE':   out.byMinute = val.split(',').map(Number); break;
      case 'BYDAY':      out.byDay = val.split(','); break;
      case 'BYMONTHDAY': out.byMonthDay = val.split(',').map(Number); break;
      case 'COUNT':      out.count = parseInt(val, 10); break;
      case 'UNTIL':      out.until = _parseRruleDt(val); break;
    }
  }
  if (!out.interval) out.interval = 1;
  return out;
}

function _parseRruleDt(s) {
  // UNTIL=20260601T090000Z or 20260601
  if (!s) return null;
  const clean = s.replace(/[TZ]/g, '');
  if (clean.length >= 8) {
    return new Date(
      parseInt(clean.slice(0, 4)), parseInt(clean.slice(4, 6)) - 1, parseInt(clean.slice(6, 8)),
      clean.length >= 12 ? parseInt(clean.slice(8, 10)) : 0,
      clean.length >= 12 ? parseInt(clean.slice(10, 12)) : 0, 0
    );
  }
  return null;
}

function rruleMatchesNow(rrule, lastRunAt) {
  if (!rrule) return false;
  const r = typeof rrule === 'string' ? parseRrule(rrule) : rrule;
  if (!r || !r.freq) return false;

  const now = new Date();

  // UNTIL guard
  if (r.until && now > r.until) return false;

  // Must be the right minute — BYHOUR/BYMINUTE must both match if set
  const h = now.getHours(), m = now.getMinutes();
  if (r.byHour && !r.byHour.includes(h)) return false;
  if (r.byMinute && !r.byMinute.includes(m)) return false;
  // If BYHOUR set but BYMINUTE not, only fire at :00
  if (r.byHour && !r.byMinute && m !== 0) return false;

  // Prevent double-fire within the same minute
  if (lastRunAt) {
    const last = new Date(lastRunAt);
    if (last.getFullYear() === now.getFullYear() &&
        last.getMonth() === now.getMonth() &&
        last.getDate() === now.getDate() &&
        last.getHours() === now.getHours() &&
        last.getMinutes() === now.getMinutes()) return false;
  }

  switch (r.freq) {
    case 'MINUTELY': return true;
    case 'HOURLY':   return (!r.byMinute || r.byMinute.includes(m));
    case 'DAILY':    return true;
    case 'WEEKLY': {
      if (!r.byDay) return true;
      const dayCode = WEEKDAY_NAMES[now.getDay()];
      return r.byDay.some(d => d.endsWith(dayCode));
    }
    case 'MONTHLY': {
      if (r.byMonthDay) return r.byMonthDay.includes(now.getDate());
      return true;
    }
    case 'YEARLY':
      return true;
    default:
      return false;
  }
}

function nextRruleOccurrence(rruleStr) {
  if (!rruleStr) return null;
  const r = parseRrule(rruleStr);
  if (!r || !r.freq) return null;

  const now = new Date();
  const targetH = (r.byHour   && r.byHour.length   > 0) ? r.byHour[0]   : 0;
  const targetM = (r.byMinute && r.byMinute.length > 0) ? r.byMinute[0] : 0;
  const maxMins = 366 * 24 * 60;

  for (let delta = 1; delta <= maxMins; delta++) {
    const candidate = new Date(now.getTime() + delta * 60000);

    if (r.until && candidate > r.until) return null;

    const ch = candidate.getHours(), cm = candidate.getMinutes();

    // Must hit the right hour:minute
    if (r.byHour && !r.byHour.includes(ch)) continue;
    if (r.byMinute && !r.byMinute.includes(cm)) continue;
    if (r.byHour && !r.byMinute && cm !== 0) continue;

    switch (r.freq) {
      case 'MINUTELY':
        return candidate.toISOString();
      case 'HOURLY':
        if (cm === targetM) return candidate.toISOString();
        continue;
      case 'DAILY':
        if (ch === targetH && cm === targetM) return candidate.toISOString();
        continue;
      case 'WEEKLY': {
        if (ch !== targetH || cm !== targetM) continue;
        if (!r.byDay) return candidate.toISOString();
        const dayCode = WEEKDAY_NAMES[candidate.getDay()];
        if (r.byDay.some(d => d.endsWith(dayCode))) return candidate.toISOString();
        continue;
      }
      case 'MONTHLY': {
        if (ch !== targetH || cm !== targetM) continue;
        if (!r.byMonthDay) return candidate.toISOString();
        if (r.byMonthDay.includes(candidate.getDate())) return candidate.toISOString();
        continue;
      }
      case 'YEARLY': {
        if (ch === targetH && cm === targetM) return candidate.toISOString();
        continue;
      }
    }
  }
  return null;
}

function humanizeRrule(rruleStr) {
  if (!rruleStr) return 'Manual';
  const r = parseRrule(rruleStr);
  if (!r || !r.freq) return rruleStr;

  const h = (r.byHour   && r.byHour.length)   ? r.byHour[0]   : null;
  const m = (r.byMinute && r.byMinute.length) ? r.byMinute[0] : 0;
  const timeStr = h !== null ? _fmtTime(h, m) : null;

  const interval = r.interval || 1;
  const intervalStr = interval > 1 ? ' ' + interval : '';

  switch (r.freq) {
    case 'MINUTELY':
      return interval === 1 ? 'Every minute' : 'Every ' + interval + ' minutes';
    case 'HOURLY':
      return interval === 1 ? 'Every hour' : 'Every ' + interval + ' hours';
    case 'DAILY':
      return (interval === 1 ? 'Every day' : 'Every ' + interval + ' days') +
             (timeStr ? ' at ' + timeStr : '');
    case 'WEEKLY': {
      const dayLabels = r.byDay
        ? r.byDay.map(d => {
            const idx = WEEKDAY_NAMES.indexOf(d.replace(/^[+-]?\d*/, ''));
            return idx >= 0 ? WEEKDAY_LABELS[idx] : d;
          })
        : [];
      const dayPart = dayLabels.length ? ' on ' + dayLabels.join(', ') : '';
      return (interval === 1 ? 'Every week' : 'Every ' + interval + ' weeks') +
             dayPart + (timeStr ? ' at ' + timeStr : '');
    }
    case 'MONTHLY': {
      const dayPart = r.byMonthDay && r.byMonthDay.length
        ? ' on the ' + _ordinal(r.byMonthDay[0])
        : '';
      return (interval === 1 ? 'Every month' : 'Every ' + interval + ' months') +
             dayPart + (timeStr ? ' at ' + timeStr : '');
    }
    case 'YEARLY':
      return 'Every year' + (timeStr ? ' at ' + timeStr : '');
    default:
      return rruleStr;
  }
}

function _fmtTime(h, m) {
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 || 12;
  const mm = String(m).padStart(2, '0');
  return hh + (m ? ':' + mm : '') + ' ' + period;
}

function _ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── Persistence ──────────────────────────────────────────────────────────

function _readTaskArray(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(data) ? data : [];
}

function readTasks() {
  try { return _readTaskArray(TASKS_FILE); }
  catch (_) {
    try {
      const backup = _readTaskArray(TASKS_BACKUP_FILE);
      if (backup.length) writeTasks(backup);
      return backup;
    } catch (_) { return []; }
  }
}

function writeTasks(tasks) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(TASKS_BACKUP_FILE), { recursive: true });
  const body = JSON.stringify(Array.isArray(tasks) ? tasks : [], null, 2);
  const tmp = TASKS_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, TASKS_FILE);
  fs.writeFileSync(TASKS_BACKUP_FILE, body);
}

// ── CRUD ─────────────────────────────────────────────────────────────────

function createTask(opts) {
  const tasks = readTasks();
  const rrule = opts.schedule?.rrule || null;

  const task = {
    id:          'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    kind:        opts.kind || 'cron',                  // cron | heartbeat | pipeline
    title:       opts.title || 'Untitled task',
    description: opts.description || '',
    status:      'pending',  // pending | scheduled | running | completed | failed | paused
    schedule: {
      type:     opts.schedule?.type || 'manual',       // manual | once | recurring
      rrule:    rrule,                                  // RRULE string (recurring)
      at:       opts.schedule?.at || null,              // ISO string (once)
      // legacy cron kept for backward compat — migrated on first read
      cron:     opts.schedule?.cron || null,
      timezone: opts.schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    targetConvId: opts.targetConvId || null,            // heartbeat: conversation to watch
    pipeline:    opts.pipeline || null,                 // pipeline: { nodes, edges }
    agents:      _normalizeAgents(opts.agents || opts.agent),
    actions:     opts.actions || [],
    context:     opts.context || '',
    permissions: {
      browser:  opts.permissions?.browser || false,
      figma:    opts.permissions?.figma || false,
      shell:    opts.permissions?.shell ?? true,
    },
    model:       opts.model || null,
    maxRetries:  opts.maxRetries ?? 2,
    timeout:     opts.timeout ?? 300000,
    maxSteps:    opts.maxSteps ?? 20,
    result:      null,
    lastRunAt:   null,
    nextRunAt:   null,
    history:     [{ timestamp: Date.now(), event: 'created', detail: null }],
    convId:      null,
    projectId:   opts.projectId || null,
    projectContextIds: opts.projectContextIds || [],
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };

  // Compute initial scheduling state
  if (task.schedule.type === 'once' && task.schedule.at) {
    task.status = 'scheduled';
    task.nextRunAt = task.schedule.at;
    task.history.push({ timestamp: Date.now(), event: 'scheduled', detail: task.schedule.at });
  }
  if (task.schedule.type === 'recurring') {
    const rruleStr = task.schedule.rrule || _cronToRrule(task.schedule.cron);
    if (rruleStr) {
      task.status = 'scheduled';
      task.nextRunAt = nextRruleOccurrence(rruleStr);
      task.history.push({ timestamp: Date.now(), event: 'scheduled', detail: humanizeRrule(rruleStr) });
    }
  }
  if (task.kind === 'heartbeat' && task.targetConvId) {
    task.status = 'scheduled';
    task.history.push({ timestamp: Date.now(), event: 'scheduled', detail: 'heartbeat: ' + task.targetConvId });
  }

  tasks.push(task);
  writeTasks(tasks);
  return task;
}

// Migrate legacy cron string → minimal RRULE (best-effort)
function _cronToRrule(cronExpr) {
  if (!cronExpr) return null;
  const p = cronExpr.trim().split(/\s+/);
  if (p.length < 5) return null;
  const min  = p[0] === '*' ? '0'  : p[0];
  const hour = p[1] === '*' ? '9'  : p[1];
  return 'FREQ=DAILY;BYHOUR=' + hour + ';BYMINUTE=' + min;
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
  return t ? _migrateTask(t) : null;
}

function getAllTasks() {
  return readTasks().map(_migrateTask);
}

// Migrate old task shapes forward (non-destructive — does not write)
function _migrateTask(t) {
  // agents array from legacy agent field
  if (!t.agents && t.agent !== undefined) {
    t.agents = _normalizeAgents(t.agent);
    delete t.agent;
  }
  if (!t.agents) t.agents = [];
  // kind default
  if (!t.kind) t.kind = 'cron';
  // migrate legacy cron → rrule
  if (!t.schedule.rrule && t.schedule.cron) {
    t.schedule.rrule = _cronToRrule(t.schedule.cron);
  }
  // ensure new fields present
  if (!('lastRunAt' in t)) t.lastRunAt = null;
  if (!('nextRunAt' in t)) {
    t.nextRunAt = t.schedule.rrule ? nextRruleOccurrence(t.schedule.rrule) : (t.schedule.at || null);
  }
  if (!('targetConvId' in t)) t.targetConvId = null;
  if (!('pipeline' in t)) t.pipeline = null;
  return t;
}

function updateTask(id, updates) {
  const tasks = readTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;

  const allowed = ['title', 'description', 'kind', 'status', 'schedule', 'agents', 'actions',
                   'context', 'permissions', 'model', 'maxRetries', 'timeout', 'maxSteps',
                   'result', 'convId', 'targetConvId', 'pipeline', 'lastRunAt', 'nextRunAt',
                   'projectId', 'projectContextIds'];
  for (const key of allowed) {
    if (key in updates) tasks[idx][key] = updates[key];
  }
  tasks[idx].updatedAt = new Date().toISOString();

  if (updates._historyEvent) {
    tasks[idx].history.push({
      timestamp: Date.now(),
      event: updates._historyEvent,
      detail: updates._historyDetail || null,
    });
  }

  writeTasks(tasks);
  return _migrateTask(tasks[idx]);
}

function deleteTask(id) {
  const tasks = readTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  writeTasks(tasks);
  return true;
}

// ── Cron Parsing — kept for backward compat, new code uses rruleMatchesNow ──

function cronMatchesNow(cronExpr) {
  if (!cronExpr) return false;
  const rrule = _cronToRrule(cronExpr);
  return rrule ? rruleMatchesNow(rrule, null) : false;
}

function nextCronOccurrence(cronExpr) {
  if (!cronExpr) return null;
  const rrule = _cronToRrule(cronExpr);
  return rrule ? nextRruleOccurrence(rrule) : null;
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
    if (task.kind === 'heartbeat') continue; // heartbeat is driven by the frontend bridge

    // One-time tasks
    if (task.schedule.type === 'once' && task.schedule.at) {
      const at = new Date(task.schedule.at).getTime();
      if (at <= now) {
        console.log('[task-mgr] One-time task due:', task.title);
        updateTask(task.id, {
          status: 'running',
          lastRunAt: new Date().toISOString(),
          _historyEvent: 'started',
          _historyDetail: 'scheduler',
        });
        if (_onTaskDue) _onTaskDue(task);
      }
      continue;
    }

    // Recurring tasks — RRULE or legacy cron
    if (task.schedule.type === 'recurring') {
      const rruleStr = task.schedule.rrule || _cronToRrule(task.schedule.cron);
      if (!rruleStr) continue;

      if (rruleMatchesNow(rruleStr, task.lastRunAt)) {
        console.log('[task-mgr] Recurring task due:', task.title);
        updateTask(task.id, {
          status: 'running',
          lastRunAt: new Date().toISOString(),
          nextRunAt: nextRruleOccurrence(rruleStr),
          _historyEvent: 'started',
          _historyDetail: 'scheduler (recurring)',
        });
        if (_onTaskDue) _onTaskDue(task);
      }
    }
  }
}

// ── Mark task complete / failed (called by task-runner) ──────────────────

function completeTask(id, result) {
  const task = getTask(id);
  if (!task) return null;

  const updates = {
    status: 'completed',
    result: { ok: true, summary: result?.summary || '', completedAt: new Date().toISOString() },
    lastRunAt: new Date().toISOString(),
    _historyEvent: 'completed',
    _historyDetail: result?.summary || null,
  };
  const updated = updateTask(id, updates);

  // Recurring tasks: re-schedule next occurrence
  if (updated && updated.schedule.type === 'recurring') {
    const rruleStr = updated.schedule.rrule || _cronToRrule(updated.schedule.cron);
    if (rruleStr) {
      const next = nextRruleOccurrence(rruleStr);
      updateTask(id, {
        status: 'scheduled',
        nextRunAt: next,
        _historyEvent: 'rescheduled',
        _historyDetail: next,
      });
    }
  }
  // Heartbeat: re-arm immediately (stays scheduled, eligibility re-checked by bridge)
  if (updated && updated.kind === 'heartbeat') {
    updateTask(id, { status: 'scheduled', _historyEvent: 'rescheduled', _historyDetail: 'heartbeat re-armed' });
  }
  return getTask(id);
}

// Strip code blocks and truncate error text for history display
function _truncateError(err) {
  if (!err || typeof err !== 'string') return err || '';
  return err.replace(/```[\s\S]*?```/g, '[code block]').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function failTask(id, error) {
  const task = getTask(id);
  if (!task) return null;

  const retries = task.history.filter(h => h.event === 'retry').length;
  if (retries < task.maxRetries) {
    updateTask(id, {
      status: 'scheduled',
      schedule: { ...task.schedule, at: new Date(Date.now() + 60000).toISOString() },
      nextRunAt: new Date(Date.now() + 60000).toISOString(),
      _historyEvent: 'retry',
      _historyDetail: _truncateError(error),
    });
    return getTask(id);
  }

  const updates = {
    status: 'failed',
    result: { ok: false, error: error, completedAt: new Date().toISOString() },
    _historyEvent: 'failed',
    _historyDetail: _truncateError(error),
  };
  const updated = updateTask(id, updates);

  // Recurring tasks: still schedule next occurrence despite failure
  if (updated && updated.schedule.type === 'recurring') {
    const rruleStr = updated.schedule.rrule || _cronToRrule(updated.schedule.cron);
    if (rruleStr) {
      const next = nextRruleOccurrence(rruleStr);
      updateTask(id, { status: 'scheduled', nextRunAt: next, _historyEvent: 'rescheduled', _historyDetail: next });
    }
  }
  // Heartbeat: re-arm
  if (updated && updated.kind === 'heartbeat') {
    updateTask(id, { status: 'scheduled', _historyEvent: 'rescheduled', _historyDetail: 'heartbeat re-armed' });
  }
  return getTask(id);
}

export {
  readTasks, writeTasks,
  createTask, getTask, getAllTasks, updateTask, deleteTask,
  startScheduler, stopScheduler,
  completeTask, failTask,
  // RRULE engine
  parseRrule, rruleMatchesNow, nextRruleOccurrence, humanizeRrule,
  // legacy compat
  cronMatchesNow, nextCronOccurrence,
};

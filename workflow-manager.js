// ── Workflow Manager — Scheduled multi-step AI workflows ─────────────────
// Users define workflows with natural-language schedules and step sequences.
// A 60-second timer loop checks for due workflows and executes steps sequentially.

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const WF_FILE    = path.join(CONFIG_DIR, 'workflows.json');
const HISTORY_MAX = 10; // runs per workflow

let _workflows = null;
let _timer = null;
let _aiCaller = null;   // function(prompt, model) → string
let _notifier = null;   // function(title, body)

// ── Persistence ────────────────────────────────────────────────────────

function _load() {
  if (_workflows) return _workflows;
  try {
    _workflows = JSON.parse(fs.readFileSync(WF_FILE, 'utf8'));
    if (!Array.isArray(_workflows)) _workflows = [];
  } catch (_) {
    _workflows = [];
  }
  return _workflows;
}

function _save() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(WF_FILE, JSON.stringify(_workflows, null, 2));
}

function _uid() {
  return 'wf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

// ── Schedule parser ────────────────────────────────────────────────────
// Parses natural-language schedules into { days: number[], hour: number, minute: number }
// Examples: "every weekday at 9am", "daily at 14:30", "every monday at 10am"

const DAY_MAP = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
                  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function parseSchedule(text) {
  const t = (text || '').toLowerCase().trim();
  let days = null;
  let hour = 9, minute = 0;

  // Parse time
  const timeMatch = t.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    minute = parseInt(timeMatch[2] || '0', 10);
    if (timeMatch[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (timeMatch[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
  }

  // Parse days
  if (/weekday|week day|mon.*fri/i.test(t)) {
    days = [1, 2, 3, 4, 5];
  } else if (/weekend/i.test(t)) {
    days = [0, 6];
  } else if (/daily|every\s*day/i.test(t)) {
    days = [0, 1, 2, 3, 4, 5, 6];
  } else {
    // Try specific day names
    const found = [];
    for (const [name, num] of Object.entries(DAY_MAP)) {
      if (t.includes(name)) found.push(num);
    }
    if (found.length) days = [...new Set(found)].sort();
    else days = [0, 1, 2, 3, 4, 5, 6]; // default: daily
  }

  return { days, hour, minute };
}

// ── CRUD ───────────────────────────────────────────────────────────────

export function createWorkflow(opts = {}) {
  const wfs = _load();
  const schedule = parseSchedule(opts.schedule || 'daily at 9am');
  const wf = {
    id: _uid(),
    name: (opts.name || 'New Workflow').slice(0, 120),
    description: opts.description || '',
    enabled: opts.enabled !== false,
    schedule,
    scheduleText: opts.schedule || 'daily at 9am',
    model: opts.model || '',  // empty = use active conversation model
    steps: (opts.steps || []).map((s, i) => ({
      id: 'step-' + (i + 1),
      prompt: String(s.prompt || s).slice(0, 4000),
      name: s.name || `Step ${i + 1}`,
    })),
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastRunAt: null,
  };
  wfs.push(wf);
  _save();
  return wf;
}

export function getWorkflow(id) {
  return _load().find(w => w.id === id) || null;
}

export function getAllWorkflows() {
  return _load();
}

export function updateWorkflow(id, patch) {
  const wfs = _load();
  const wf = wfs.find(w => w.id === id);
  if (!wf) return null;
  if (patch.name !== undefined) wf.name = String(patch.name).slice(0, 120);
  if (patch.description !== undefined) wf.description = String(patch.description);
  if (patch.enabled !== undefined) wf.enabled = !!patch.enabled;
  if (patch.schedule !== undefined) {
    wf.scheduleText = String(patch.schedule);
    wf.schedule = parseSchedule(patch.schedule);
  }
  if (patch.model !== undefined) wf.model = String(patch.model);
  if (patch.steps !== undefined) {
    wf.steps = patch.steps.map((s, i) => ({
      id: s.id || 'step-' + (i + 1),
      prompt: String(s.prompt || s).slice(0, 4000),
      name: s.name || `Step ${i + 1}`,
    }));
  }
  wf.updatedAt = Date.now();
  _save();
  return wf;
}

export function deleteWorkflow(id) {
  const wfs = _load();
  const idx = wfs.findIndex(w => w.id === id);
  if (idx === -1) return false;
  wfs.splice(idx, 1);
  _save();
  return true;
}

export function getHistory(id) {
  const wf = _load().find(w => w.id === id);
  return wf ? (wf.history || []).slice().reverse() : [];
}

// ── Workflow execution ─────────────────────────────────────────────────

export async function runWorkflow(id) {
  const wfs = _load();
  const wf = wfs.find(w => w.id === id);
  if (!wf) return { ok: false, error: 'Workflow not found' };
  if (!_aiCaller) return { ok: false, error: 'No AI caller configured' };

  const run = {
    id: 'run-' + Date.now(),
    startedAt: Date.now(),
    steps: [],
    status: 'running',
  };

  let prevOutput = '';
  for (const step of wf.steps) {
    const stepStart = Date.now();
    try {
      // Inject previous step output as context
      const prompt = prevOutput
        ? `Previous step output:\n${prevOutput}\n\n---\n\n${step.prompt}`
        : step.prompt;
      const output = await _aiCaller(prompt, wf.model);
      prevOutput = output;
      run.steps.push({
        id: step.id,
        name: step.name,
        status: 'completed',
        output: output.slice(0, 4000),
        durationMs: Date.now() - stepStart,
      });
    } catch (e) {
      run.steps.push({
        id: step.id,
        name: step.name,
        status: 'error',
        output: e.message,
        durationMs: Date.now() - stepStart,
      });
      run.status = 'error';
      break;
    }
  }

  if (run.status === 'running') run.status = 'completed';
  run.finishedAt = Date.now();
  wf.lastRunAt = Date.now();

  // Keep last N runs
  wf.history = wf.history || [];
  wf.history.push(run);
  if (wf.history.length > HISTORY_MAX) wf.history.splice(0, wf.history.length - HISTORY_MAX);
  _save();

  // Notify on completion or error
  if (_notifier) {
    const emoji = run.status === 'error' ? '❌' : '✅';
    _notifier(`${emoji} Workflow: ${wf.name}`, `${run.status} — ${run.steps.length} steps in ${Math.round((run.finishedAt - run.startedAt) / 1000)}s`);
  }

  return { ok: true, run };
}

// ── Timer loop (60-second tick) ────────────────────────────────────────

function _isDue(wf) {
  if (!wf.enabled || !wf.steps.length) return false;
  const now = new Date();
  const s = wf.schedule;
  if (!s) return false;
  const day = now.getDay();
  const hour = now.getHours();
  const minute = now.getMinutes();
  if (s.days && !s.days.includes(day)) return false;
  if (hour !== s.hour || minute !== s.minute) return false;
  // Don't re-run if already ran in this minute
  if (wf.lastRunAt) {
    const lastRun = new Date(wf.lastRunAt);
    if (lastRun.getFullYear() === now.getFullYear() &&
        lastRun.getMonth() === now.getMonth() &&
        lastRun.getDate() === now.getDate() &&
        lastRun.getHours() === now.getHours() &&
        lastRun.getMinutes() === now.getMinutes()) return false;
  }
  return true;
}

function _tick() {
  const wfs = _load();
  for (const wf of wfs) {
    if (_isDue(wf)) {
      console.log(`[workflows] Running due workflow: ${wf.name}`);
      runWorkflow(wf.id).catch(e => console.error(`[workflows] Error running ${wf.name}:`, e.message));
    }
  }
}

export function startWorkflowTimer(aiCaller, notifier) {
  _aiCaller = aiCaller;
  _notifier = notifier;
  _load();
  if (_timer) clearInterval(_timer);
  _timer = setInterval(_tick, 60 * 1000);
  console.log('[workflows] Timer started (60s tick)');
}

export function stopWorkflowTimer() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// Force reload (for testing)
export function _resetCache() {
  _workflows = null;
}

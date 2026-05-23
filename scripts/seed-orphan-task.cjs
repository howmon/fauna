#!/usr/bin/env node
// scripts/seed-orphan-task.cjs
//
// Helper for smoke-testing PR4.2 (orphan-task recovery sweep).
//
// USAGE
//   node scripts/seed-orphan-task.cjs              # seed one recurring orphan
//   node scripts/seed-orphan-task.cjs --once       # seed one one-time orphan
//   node scripts/seed-orphan-task.cjs --list       # list tasks + their status
//   node scripts/seed-orphan-task.cjs --cleanup    # remove every task whose
//                                                  # id starts with 'orphan-'
//
// After seeding, restart the Fauna app. On startup the scheduler's recovery
// sweep should reset 'running' → 'scheduled' (recurring) or → 'failed'
// (one-time) and append a history event of {event:'recovered'}.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const TASKS_FILE = path.join(CONFIG_DIR, 'tasks.json');

function readTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) || []; }
  catch (_) { return []; }
}

function writeTasks(tasks) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = TASKS_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  fs.renameSync(tmp, TASKS_FILE);
}

function nowIso() { return new Date().toISOString(); }

function seed(kind /* 'recurring' | 'once' */) {
  const tasks = readTasks();
  const id = 'orphan-' + Date.now().toString(36);
  const task = {
    id,
    title: kind === 'once' ? 'Orphan one-time (seeded)' : 'Orphan recurring (seeded)',
    kind: 'cron',
    status: 'running', // <-- the bit recovery should reset
    schedule: kind === 'once'
      ? { type: 'once', at: new Date(Date.now() - 60_000).toISOString() }
      : { type: 'recurring', rrule: 'FREQ=DAILY;BYHOUR=9' },
    history: [
      { ts: nowIso(), event: 'started', detail: 'seeded by scripts/seed-orphan-task.cjs' },
    ],
    lastRunAt: nowIso(),
  };
  tasks.push(task);
  writeTasks(tasks);
  console.log('Seeded orphan task:', id);
  console.log('  status   :', task.status);
  console.log('  schedule :', JSON.stringify(task.schedule));
  console.log('Restart the Fauna app — the scheduler recovery sweep should reset it.');
}

function listAll() {
  const tasks = readTasks();
  if (!tasks.length) { console.log('(no tasks)'); return; }
  for (const t of tasks) {
    const tag = t.id.startsWith('orphan-') ? '*' : ' ';
    console.log(`${tag} ${t.id.padEnd(22)} ${String(t.status).padEnd(10)} ${t.title || ''}`);
  }
}

function cleanup() {
  const tasks = readTasks();
  const kept = tasks.filter(t => !String(t.id).startsWith('orphan-'));
  const removed = tasks.length - kept.length;
  writeTasks(kept);
  console.log('Removed', removed, 'seeded orphan task(s).');
}

const arg = process.argv[2] || '';
if (arg === '--list')        listAll();
else if (arg === '--cleanup') cleanup();
else if (arg === '--once')   seed('once');
else                          seed('recurring');

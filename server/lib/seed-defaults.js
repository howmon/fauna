// server/lib/seed-defaults.js
// On first launch (when tasks.json and workflows.json are empty AND a marker
// file is absent) seed a handful of realistic, fully-deletable sample
// automations so users have something to play with. The marker prevents
// re-seeding after the user deletes the samples — if they want them back
// they can delete `~/.config/fauna/seeded.json`.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { saveJsonAtomic } from './json-store.js';

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(os.homedir(), '.config', 'fauna');
const MARKER_FILE = path.join(CONFIG_DIR, 'seeded.json');

// Sample tasks — all permission-safe (no shell/browser/figma) so they run
// as plain LLM prompts. Users can flip permissions on if they want power.
function _sampleTasks() {
  const tomorrow9am = new Date();
  tomorrow9am.setDate(tomorrow9am.getDate() + 1);
  tomorrow9am.setHours(9, 0, 0, 0);

  return [
    {
      kind: 'cron',
      title: 'Sample: Daily standup briefing',
      description:
        'Every weekday morning, write a 5-bullet briefing: top 3 priorities for today, anything carried over from yesterday, and one quick win to start with. Keep it under 120 words.',
      schedule: { type: 'recurring', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR' },
      context: 'Audience: just me. Tone: punchy, no filler.',
      permissions: { shell: false, browser: false, figma: false },
      maxRetries: 1,
      timeout: 90_000,
      maxSteps: 6,
    },
    {
      kind: 'cron',
      title: 'Sample: Weekly review',
      description:
        'Every Monday at 10am, draft a short weekly-review template: what shipped last week, what is blocked, top 3 outcomes for the next 5 days, and one experiment to try.',
      schedule: { type: 'recurring', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0' },
      context: '',
      permissions: { shell: false, browser: false, figma: false },
      maxRetries: 1,
      timeout: 120_000,
      maxSteps: 8,
    },
    {
      kind: 'cron',
      title: 'Sample: One-time follow-up reminder',
      description:
        'Write a friendly nudge message I can send to follow up on a pending request. Two tone variants: warm and professional. Max 60 words each.',
      schedule: { type: 'once', at: tomorrow9am.toISOString() },
      context: '',
      permissions: { shell: false, browser: false, figma: false },
      maxRetries: 1,
      timeout: 60_000,
      maxSteps: 4,
    },
    {
      kind: 'heartbeat',
      title: 'Sample: Watch active thread and continue',
      description:
        'Once attached to a conversation, this task watches for idle state and gently nudges the work forward — suggesting the next step, surfacing missing details, or proposing a small concrete action.',
      schedule: { type: 'manual' },
      context: 'Attach me to a conversation from the Tasks panel to enable.',
      permissions: { shell: false, browser: false, figma: false },
      maxRetries: 1,
      timeout: 45_000,
      maxSteps: 5,
    },
    {
      kind: 'pipeline',
      title: 'Sample: Research → Summarize → Action items',
      description:
        'A 3-node pipeline that takes a topic, gathers what is known, condenses it, and proposes concrete next actions. Click to open the visual builder.',
      schedule: { type: 'manual' },
      context: '',
      permissions: { shell: false, browser: false, figma: false },
      maxRetries: 1,
      timeout: 180_000,
      maxSteps: 12,
      pipeline: {
        nodes: [
          { id: 'node-research', label: 'Research',  type: 'prompt', x: 100, y: 120,
            prompt: 'List the 5 most important facts a newcomer should know about the topic: {{input}}. Cite sources where possible.' },
          { id: 'node-summary',  label: 'Summarize', type: 'prompt', x: 360, y: 120,
            prompt: 'Distill the research into a 3-sentence executive summary suitable for an exec who has 30 seconds.' },
          { id: 'node-actions',  label: 'Actions',   type: 'prompt', x: 620, y: 120,
            prompt: 'Propose 3 concrete next actions with owner-suggestions and a rough effort estimate (S/M/L).' },
        ],
        edges: [
          { source: 'node-research', target: 'node-summary' },
          { source: 'node-summary',  target: 'node-actions' },
        ],
      },
    },
  ];
}

function _sampleWorkflows() {
  return [
    {
      name: 'Sample: Morning briefing',
      description: 'A 3-step weekday morning workflow that primes my day.',
      schedule: 'every weekday at 8am',
      steps: [
        { name: 'Calendar check', prompt: 'List today\'s confirmed meetings in chronological order with a 1-line prep note for each. Skip recurring 1:1s with no agenda.' },
        { name: 'Top of mind',    prompt: 'What is the single most important outcome I should aim for today? Justify in one sentence.' },
        { name: 'Focus plan',     prompt: 'Draft a 90-minute deep-work block for this morning: pick one outcome from above, suggest a starting action, and call out the most likely distraction to pre-empt.' },
      ],
    },
    {
      name: 'Sample: End-of-day wrap-up',
      description: 'A 2-step weekday evening workflow that closes loops cleanly.',
      schedule: 'every weekday at 5pm',
      steps: [
        { name: 'What shipped', prompt: 'Summarize what I completed today in 3 bullets. Be specific (artifact + outcome), not generic.' },
        { name: 'Tomorrow setup', prompt: 'Identify the one thing I should start with tomorrow morning so I do not waste the first 30 minutes deciding. Make it small and concrete.' },
      ],
    },
  ];
}

/**
 * Seed default automations on first launch.
 *
 * The marker file `~/.config/fauna/seeded.json` is the only gate — once it
 * exists we never seed again, even if the user deletes every sample. To
 * re-seed (e.g. for a demo) delete the marker file. Pre-existing user
 * tasks/workflows are preserved; samples are appended alongside them.
 *
 * @param {object} deps
 * @param {() => any[]} deps.readTasks
 * @param {(opts:any) => any} deps.createTask
 * @param {() => any[]} deps.getAllWorkflows
 * @param {(opts:any) => any} deps.createWorkflow
 * @returns {{seeded: boolean, taskIds: string[], workflowIds: string[], reason?: string}}
 */
export function seedDefaults({ readTasks, createTask, getAllWorkflows, createWorkflow }) {
  try {
    if (fs.existsSync(MARKER_FILE)) {
      return { seeded: false, taskIds: [], workflowIds: [], reason: 'marker-present' };
    }

    const taskIds = [];
    for (const t of _sampleTasks()) {
      try { taskIds.push(createTask(t).id); }
      catch (e) { console.warn('[seed] task failed:', t.title, e?.message || e); }
    }
    const workflowIds = [];
    for (const w of _sampleWorkflows()) {
      try { workflowIds.push(createWorkflow(w).id); }
      catch (e) { console.warn('[seed] workflow failed:', w.name, e?.message || e); }
    }

    try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch (_) {}
    saveJsonAtomic(MARKER_FILE, {
      at: new Date().toISOString(),
      taskIds,
      workflowIds,
      version: 1,
    });
    console.log(`[seed] added ${taskIds.length} sample task(s) and ${workflowIds.length} sample workflow(s)`);
    return { seeded: true, taskIds, workflowIds };
  } catch (e) {
    console.warn('[seed] failed:', e?.message || e);
    return { seeded: false, taskIds: [], workflowIds: [], reason: 'error' };
  }
}

// Exposed for tests so suites can run without touching the home directory.
export const _internal = { MARKER_FILE, _sampleTasks, _sampleWorkflows };

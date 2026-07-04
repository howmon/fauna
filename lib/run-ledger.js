// lib/run-ledger.js
// Feature B5 — replayable run ledger (EventStore) + convergence detection.
//
// Promotes Fauna's autonomous-runs/*.jsonl logs from opaque narration into a
// typed, append-only event ledger. Every stage of a run appends one event, so a
// run is replayable and resumable across restarts (ouroboros "Ralph"), and the
// loop can stop on *convergence* instead of an arbitrary MAX_CONTINUES cap.
//
// Append-only + pure replay = deterministic, testable state reconstruction.
// No native deps.

import fs from 'node:fs';
import path from 'node:path';

// Known event types (free-form is allowed, these are the ones replay folds).
export const EVENT_TYPES = Object.freeze({
  RUN_START: 'run_start',
  SEED: 'seed',
  ACTION: 'action',
  STAGE: 'stage',           // an evaluate-gate stage result
  CRITERIA: 'criteria',     // { met, total }
  GENERATION: 'generation', // end of one loop generation { convergence, newQuestions, openQuestions[] }
  UNSTUCK: 'unstuck',
  RUN_END: 'run_end',
});

// Append one event to a ledger file (creates parent dir). Returns the stamped
// event. Never throws on write errors — logging must not crash a run.
export function appendEvent(file, event) {
  const stamped = { ts: Date.now(), ...event };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(stamped) + '\n');
  } catch (_) { /* best-effort */ }
  return stamped;
}

// Read + parse all events from a ledger file. Skips corrupt lines.
export function readEvents(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* skip */ }
  }
  return out;
}

// Fold an event array into current run state. Pure — same input, same output.
export function replay(events) {
  const state = {
    runId: null,
    seedId: null,
    status: 'unknown',
    actions: 0,
    stages: [],           // evaluate-gate stage outcomes
    criteria: { met: 0, total: 0 },
    generations: [],      // [{ convergence, newQuestions, openQuestions }]
    unstuckCount: 0,
    startedAt: null,
    endedAt: null,
  };
  for (const e of Array.isArray(events) ? events : []) {
    switch (e.type) {
      case EVENT_TYPES.RUN_START:
        state.runId = e.runId || state.runId;
        state.seedId = e.seedId || state.seedId;
        state.status = 'running';
        state.startedAt = e.ts || state.startedAt;
        break;
      case EVENT_TYPES.SEED:
        state.seedId = e.seedId || state.seedId;
        break;
      case EVENT_TYPES.ACTION:
        state.actions += 1;
        break;
      case EVENT_TYPES.STAGE:
        state.stages.push({ stage: e.stage, ok: !!e.ok, reason: e.reason || '' });
        break;
      case EVENT_TYPES.CRITERIA:
        state.criteria = {
          met: Number(e.met) || 0,
          total: Number(e.total) || 0,
        };
        break;
      case EVENT_TYPES.GENERATION:
        state.generations.push({
          convergence: typeof e.convergence === 'number' ? e.convergence : null,
          newQuestions: Number(e.newQuestions) || 0,
          openQuestions: Array.isArray(e.openQuestions) ? e.openQuestions : [],
        });
        break;
      case EVENT_TYPES.UNSTUCK:
        state.unstuckCount += 1;
        break;
      case EVENT_TYPES.RUN_END:
        state.status = e.status || 'ended';
        state.endedAt = e.ts || state.endedAt;
        break;
      default:
        break;
    }
  }
  return state;
}

// Decide whether a run has converged and should stop.
//   Converged when: all acceptance criteria are met AND the loop has stabilised
//   — the last `stableGenerations` generations introduced no new open questions
//   and reported a convergence score ≥ `convergenceFloor` (when scores exist).
// Returns { converged, criteriaMet, stable, reason }.
export function detectConvergence(events, opts = {}) {
  const state = Array.isArray(events) && events.length && events[0].type ? replay(events) : (events && events.stages ? events : replay(events));
  const window = Math.max(1, opts.stableGenerations || 2);
  const floor = typeof opts.convergenceFloor === 'number' ? opts.convergenceFloor : 0.95;

  const criteriaMet = state.criteria.total > 0 && state.criteria.met >= state.criteria.total;

  let stable = false;
  let scoreOk = true;
  if (state.generations.length >= window) {
    const recent = state.generations.slice(-window);
    stable = recent.every((g) => (g.newQuestions || 0) === 0);
    const scored = recent.filter((g) => typeof g.convergence === 'number');
    if (scored.length) scoreOk = scored.every((g) => g.convergence >= floor);
  }

  const converged = criteriaMet && stable && scoreOk;
  let reason;
  if (converged) reason = 'All acceptance criteria met and the loop stabilised.';
  else if (!criteriaMet) reason = `Acceptance criteria not all met (${state.criteria.met}/${state.criteria.total}).`;
  else if (!stable) reason = `Loop still surfacing new questions in the last ${window} generation(s).`;
  else reason = `Convergence score below ${floor}.`;

  return { converged, criteriaMet, stable, scoreOk, reason, state };
}

export default { EVENT_TYPES, appendEvent, readEvents, replay, detectConvergence };

import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendEvent, readEvents } from './run-ledger.js';

const DEFAULT_FILE = path.join(os.homedir(), '.config', 'fauna', 'routing-evidence.jsonl');

function queryEvidence(query) {
  const normalized = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return {
    queryHash: createHash('sha256').update(normalized).digest('hex'),
    queryLength: normalized.length,
  };
}

export function recordRoutingDecision(input = {}, opts = {}) {
  const episodeId = input.episodeId || randomUUID();
  appendEvent(opts.file || DEFAULT_FILE, {
    type: 'routing.decision',
    source: `router:${input.router || 'unknown'}`,
    runId: input.runId || null,
    projectId: input.projectId || null,
    correlationId: input.correlationId || input.runId || episodeId,
    outcome: input.selection ? 'selected' : 'clarify',
    payload: {
      episodeId,
      router: input.router || 'unknown',
      ...queryEvidence(input.query),
      selection: input.selection || null,
      confidence: Number.isFinite(input.confidence) ? input.confidence : null,
      alternatives: Array.isArray(input.alternatives) ? input.alternatives.slice(0, 5) : [],
      model: input.model || null,
      agent: input.agent || null,
    },
  }, { timestamp: opts.timestamp });
  return episodeId;
}

export function recordRoutingOutcome(input = {}, opts = {}) {
  if (!input.episodeId) return { ok: false, error: 'episodeId required' };
  const outcome = input.verified === true ? 'passed' : input.verified === false ? 'failed' : 'observed';
  appendEvent(opts.file || DEFAULT_FILE, {
    type: 'routing.outcome',
    source: 'routing-evidence',
    runId: input.runId || null,
    projectId: input.projectId || null,
    correlationId: input.correlationId || input.runId || input.episodeId,
    causationId: input.episodeId,
    outcome,
    payload: {
      episodeId: input.episodeId,
      verified: typeof input.verified === 'boolean' ? input.verified : null,
      verifier: input.verifier || null,
      correctedSelection: input.correctedSelection || null,
      retries: Number.isFinite(input.retries) ? input.retries : null,
      durationMs: Number.isFinite(input.durationMs) ? input.durationMs : null,
      cost: Number.isFinite(input.cost) ? input.cost : null,
      humanCorrection: input.humanCorrection === true,
    },
  }, { timestamp: opts.timestamp });
  return { ok: true, episodeId: input.episodeId, outcome };
}

export function recordRoutingOutcomesForRun(runId, input = {}, opts = {}) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) return { ok: false, error: 'runId required' };
  const file = opts.file || DEFAULT_FILE;
  const events = readEvents(file);
  const latestOutcomes = new Map();
  const decisions = new Map();
  for (const event of events) {
    const episodeId = event.payload?.episodeId;
    if (event.type === 'routing.decision' && event.runId === normalizedRunId && episodeId) {
      decisions.set(episodeId, event);
    } else if (event.type === 'routing.outcome' && episodeId) {
      latestOutcomes.set(episodeId, event);
    }
  }

  let recorded = 0;
  for (const episodeId of decisions.keys()) {
    const latest = latestOutcomes.get(episodeId);
    if (latest && typeof latest.payload?.verified === 'boolean') continue;
    if (latest && typeof input.verified !== 'boolean') continue;
    recordRoutingOutcome({
      episodeId,
      runId: normalizedRunId,
      projectId: input.projectId || null,
      verified: typeof input.verified === 'boolean' ? input.verified : undefined,
      verifier: input.verifier || null,
      correctedSelection: input.correctedSelection || null,
      retries: Number.isFinite(input.retries) ? input.retries : null,
      durationMs: Number.isFinite(input.durationMs) ? input.durationMs : null,
      cost: Number.isFinite(input.cost) ? input.cost : null,
      humanCorrection: input.humanCorrection === true,
    }, { file, timestamp: opts.timestamp });
    recorded++;
  }
  return { ok: true, runId: normalizedRunId, matched: decisions.size, recorded };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function summarizeDimension(decisions, outcomes, field) {
  const groups = new Map();
  for (const decision of decisions.values()) {
    const key = String(decision.payload?.[field] || 'unknown');
    const group = groups.get(key) || { decisions: 0, matched: 0, passed: 0, failed: 0, observed: 0, corrected: 0 };
    group.decisions++;
    const outcome = outcomes.get(decision.payload?.episodeId);
    if (outcome) {
      group.matched++;
      if (outcome.outcome === 'passed') group.passed++;
      else if (outcome.outcome === 'failed') group.failed++;
      else group.observed++;
      if (outcome.payload?.humanCorrection === true || outcome.payload?.correctedSelection) group.corrected++;
    }
    groups.set(key, group);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function summarizeRoutingEvidence(events = []) {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === 'routing.decision' || event?.type === 'routing.outcome')
    .sort((left, right) => (left.event.timestamp || left.event.ts || 0) - (right.event.timestamp || right.event.ts || 0)
      || left.index - right.index)
    .map(({ event }) => event);
  const decisions = new Map();
  const outcomes = new Map();
  for (const event of ordered) {
    const episodeId = event.payload?.episodeId;
    if (!episodeId) continue;
    if (event.type === 'routing.decision') decisions.set(episodeId, event);
    else outcomes.set(episodeId, event);
  }

  const matched = [...decisions.keys()].filter(episodeId => outcomes.has(episodeId));
  const linkedOutcomes = matched.map(episodeId => outcomes.get(episodeId));
  const passed = linkedOutcomes.filter(event => event.outcome === 'passed').length;
  const failed = linkedOutcomes.filter(event => event.outcome === 'failed').length;
  const observed = linkedOutcomes.length - passed - failed;
  const corrected = linkedOutcomes.filter(event => event.payload?.humanCorrection === true || event.payload?.correctedSelection).length;
  const retries = linkedOutcomes.map(event => event.payload?.retries).filter(Number.isFinite);
  const durations = linkedOutcomes.map(event => event.payload?.durationMs).filter(Number.isFinite);
  const costs = linkedOutcomes.map(event => event.payload?.cost).filter(Number.isFinite);
  const mean = values => values.length
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4))
    : null;
  const timestamps = ordered.map(event => Number(event.timestamp || event.ts)).filter(Number.isFinite);

  return {
    schemaVersion: 1,
    window: {
      firstTimestamp: timestamps.length ? Math.min(...timestamps) : null,
      lastTimestamp: timestamps.length ? Math.max(...timestamps) : null,
    },
    totals: {
      events: ordered.length,
      decisions: decisions.size,
      outcomes: outcomes.size,
      matched: matched.length,
      pending: Math.max(0, decisions.size - matched.length),
      orphanOutcomes: [...outcomes.keys()].filter(episodeId => !decisions.has(episodeId)).length,
      passed,
      failed,
      observed,
      corrected,
    },
    rates: {
      coverage: ratio(matched.length, decisions.size),
      pass: ratio(passed, passed + failed),
      failure: ratio(failed, passed + failed),
      correction: ratio(corrected, matched.length),
    },
    measurements: {
      retries: { samples: retries.length, mean: mean(retries), total: retries.reduce((sum, value) => sum + value, 0) },
      durationMs: { samples: durations.length, mean: mean(durations) },
      cost: { samples: costs.length, mean: mean(costs), total: Number(costs.reduce((sum, value) => sum + value, 0).toFixed(6)) },
    },
    byRouter: summarizeDimension(decisions, outcomes, 'router'),
    bySelection: summarizeDimension(decisions, outcomes, 'selection'),
  };
}

export function buildRoutingEvidenceReport(opts = {}) {
  return summarizeRoutingEvidence(readEvents(opts.file || DEFAULT_FILE));
}

export default {
  recordRoutingDecision,
  recordRoutingOutcome,
  recordRoutingOutcomesForRun,
  summarizeRoutingEvidence,
  buildRoutingEvidenceReport,
};
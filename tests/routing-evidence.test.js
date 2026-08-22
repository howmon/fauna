import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEvents } from '../lib/run-ledger.js';
import {
  buildRoutingEvidenceReport,
  recordRoutingDecision,
  recordRoutingOutcome,
  recordRoutingOutcomesForRun,
} from '../lib/routing-evidence.js';

describe('routing evidence', () => {
  it('records decisions without storing the raw query', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-routing-'));
    const file = path.join(dir, 'evidence.jsonl');
    const query = 'Diagnose the private production crash';
    const episodeId = recordRoutingDecision({
      episodeId: 'episode-1',
      router: 'skill',
      query,
      selection: 'diagnosing-bugs',
      confidence: 0.91,
      alternatives: ['code-review-and-quality'],
    }, { file, timestamp: 100 });

    const [event] = readEvents(file);
    expect(episodeId).toBe('episode-1');
    expect(event).toMatchObject({
      schemaVersion: 1,
      type: 'routing.decision',
      timestamp: 100,
      outcome: 'selected',
      payload: {
        episodeId: 'episode-1',
        router: 'skill',
        queryLength: query.length,
        selection: 'diagnosing-bugs',
        confidence: 0.91,
      },
    });
    expect(event.payload.queryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(event)).not.toContain(query);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('links verifier outcomes to routing episodes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-routing-'));
    const file = path.join(dir, 'evidence.jsonl');
    const result = recordRoutingOutcome({
      episodeId: 'episode-2',
      verified: false,
      verifier: 'npm test',
      correctedSelection: 'test-driven-development',
      retries: 1,
      durationMs: 250,
      humanCorrection: true,
    }, { file, timestamp: 200 });

    const [event] = readEvents(file);
    expect(result).toEqual({ ok: true, episodeId: 'episode-2', outcome: 'failed' });
    expect(event).toMatchObject({
      type: 'routing.outcome',
      causationId: 'episode-2',
      outcome: 'failed',
      payload: {
        episodeId: 'episode-2',
        correctedSelection: 'test-driven-development',
        retries: 1,
        humanCorrection: true,
      },
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects outcomes without an episode id', () => {
    expect(recordRoutingOutcome({ verified: true })).toEqual({ ok: false, error: 'episodeId required' });
  });

  it('settles unresolved decisions for one run exactly once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-routing-'));
    const file = path.join(dir, 'evidence.jsonl');
    recordRoutingDecision({ episodeId: 'a', router: 'skill', runId: 'run-1', query: 'one', selection: 'debug' }, { file, timestamp: 100 });
    recordRoutingDecision({ episodeId: 'b', router: 'flow', runId: 'run-1', query: 'two', selection: 'feature' }, { file, timestamp: 200 });
    recordRoutingDecision({ episodeId: 'c', router: 'skill', runId: 'run-2', query: 'three', selection: 'test' }, { file, timestamp: 300 });
    recordRoutingOutcome({ episodeId: 'a', runId: 'run-1', verified: false }, { file, timestamp: 400 });

    expect(recordRoutingOutcomesForRun('run-1', {
      verified: true,
      verifier: 'task completion',
      durationMs: 500,
    }, { file, timestamp: 500 })).toEqual({ ok: true, runId: 'run-1', matched: 2, recorded: 1 });
    expect(recordRoutingOutcomesForRun('run-1', { verified: true }, { file, timestamp: 600 }))
      .toEqual({ ok: true, runId: 'run-1', matched: 2, recorded: 0 });

    const report = buildRoutingEvidenceReport({ file });
    expect(report.totals).toMatchObject({ decisions: 3, outcomes: 2, matched: 2, pending: 1, passed: 1, failed: 1 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades an observed run outcome with one definitive verification', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-routing-'));
    const file = path.join(dir, 'evidence.jsonl');
    recordRoutingDecision({ episodeId: 'a', router: 'skill', runId: 'run-1', query: 'one', selection: 'debug' }, { file, timestamp: 100 });

    expect(recordRoutingOutcomesForRun('run-1', {
      verifier: 'task completion',
    }, { file, timestamp: 200 }).recorded).toBe(1);
    expect(recordRoutingOutcomesForRun('run-1', {
      verified: false,
      verifier: 'npm test',
    }, { file, timestamp: 200 }).recorded).toBe(1);
    expect(recordRoutingOutcomesForRun('run-1', {
      verified: true,
      verifier: 'later duplicate',
    }, { file, timestamp: 400 }).recorded).toBe(0);

    const report = buildRoutingEvidenceReport({ file });
    expect(report.totals).toMatchObject({ decisions: 1, outcomes: 1, matched: 1, failed: 1, observed: 0 });
    expect(readEvents(file).filter(event => event.type === 'routing.outcome')).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('summarizes linked evidence without inventing promotion thresholds', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-routing-'));
    const file = path.join(dir, 'evidence.jsonl');
    recordRoutingDecision({ episodeId: 'a', router: 'skill', query: 'one', selection: 'debug' }, { file, timestamp: 100 });
    recordRoutingDecision({ episodeId: 'b', router: 'skill', query: 'two', selection: 'test' }, { file, timestamp: 200 });
    recordRoutingDecision({ episodeId: 'c', router: 'flow', query: 'three', selection: 'debug' }, { file, timestamp: 300 });
    recordRoutingOutcome({ episodeId: 'a', verified: true, retries: 0, durationMs: 100, cost: 0.1 }, { file, timestamp: 400 });
    recordRoutingOutcome({ episodeId: 'b', verified: false, retries: 2, durationMs: 300, cost: 0.3, humanCorrection: true }, { file, timestamp: 500 });
    recordRoutingOutcome({ episodeId: 'orphan', verified: true }, { file, timestamp: 600 });

    expect(buildRoutingEvidenceReport({ file })).toEqual({
      schemaVersion: 1,
      window: { firstTimestamp: 100, lastTimestamp: 600 },
      totals: {
        events: 6, decisions: 3, outcomes: 3, matched: 2, pending: 1,
        orphanOutcomes: 1, passed: 1, failed: 1, observed: 0, corrected: 1,
      },
      rates: { coverage: 0.6667, pass: 0.5, failure: 0.5, correction: 0.5 },
      measurements: {
        retries: { samples: 2, mean: 1, total: 2 },
        durationMs: { samples: 2, mean: 200 },
        cost: { samples: 2, mean: 0.2, total: 0.4 },
      },
      byRouter: {
        flow: { decisions: 1, matched: 0, passed: 0, failed: 0, observed: 0, corrected: 0 },
        skill: { decisions: 2, matched: 2, passed: 1, failed: 1, observed: 0, corrected: 1 },
      },
      bySelection: {
        debug: { decisions: 2, matched: 1, passed: 1, failed: 0, observed: 0, corrected: 0 },
        test: { decisions: 1, matched: 1, passed: 0, failed: 1, observed: 0, corrected: 1 },
      },
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
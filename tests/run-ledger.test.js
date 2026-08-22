import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXECUTION_EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  createExecutionEvent,
  appendEvent,
  readEvents,
  replay,
  detectConvergence,
} from '../lib/run-ledger.js';
import { PERSONAS, unstuck, getPersona } from '../lib/personas.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-ledger-'));
  return { dir, file: path.join(dir, 'run.jsonl') };
}

describe('run-ledger append + read + replay', () => {
  let dir, file;
  beforeEach(() => { ({ dir, file } = tmpFile()); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it('appends and reads back events', () => {
    appendEvent(file, { type: EVENT_TYPES.RUN_START, runId: 'r1', seedId: 's1' });
    appendEvent(file, { type: EVENT_TYPES.ACTION, tool: 'edit' });
    const events = readEvents(file);
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({
      schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
      source: 'run-ledger',
      runId: 'r1',
      correlationId: 'r1',
    });
    expect(events[0].eventId).toBeTypeOf('string');
    expect(events[0].timestamp).toBe(events[0].ts);
    expect(events[0].runId).toBe('r1');
    expect(events[0].ts).toBeTypeOf('number');
  });

  it('preserves caller metadata in the versioned envelope', () => {
    const event = createExecutionEvent({
      type: 'verification.completed',
      runId: 'run-1',
      taskId: 'task-1',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      outcome: 'passed',
      payload: { verifier: 'npm test' },
    }, { source: 'verifier', timestamp: 123 });

    expect(event).toMatchObject({
      schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
      timestamp: 123,
      ts: 123,
      source: 'verifier',
      runId: 'run-1',
      taskId: 'task-1',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      outcome: 'passed',
      payload: { verifier: 'npm test' },
    });
  });

  it('does not let legacy fields override authoritative envelope metadata', () => {
    const event = createExecutionEvent({
      schemaVersion: 99,
      eventId: 'caller-event',
      timestamp: 'not-a-timestamp',
      ts: 456,
      source: '',
      type: 'legacy.event',
    }, { source: 'legacy-adapter' });
    expect(event).toMatchObject({
      schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
      eventId: 'caller-event',
      timestamp: 456,
      ts: 456,
      source: 'legacy-adapter',
      type: 'legacy.event',
    });
  });

  it('replays events into folded state', () => {
    appendEvent(file, { type: EVENT_TYPES.RUN_START, runId: 'r1', seedId: 's1' });
    appendEvent(file, { type: EVENT_TYPES.ACTION });
    appendEvent(file, { type: EVENT_TYPES.ACTION });
    appendEvent(file, { type: EVENT_TYPES.STAGE, stage: 'mechanical', ok: true });
    appendEvent(file, { type: EVENT_TYPES.CRITERIA, met: 2, total: 3 });
    appendEvent(file, { type: EVENT_TYPES.RUN_END, status: 'done' });
    const state = replay(readEvents(file));
    expect(state.runId).toBe('r1');
    expect(state.actions).toBe(2);
    expect(state.stages.length).toBe(1);
    expect(state.criteria).toEqual({ met: 2, total: 3 });
    expect(state.status).toBe('done');
  });

  it('skips corrupt lines', () => {
    fs.writeFileSync(file, '{"type":"action"}\nNOT JSON\n{"type":"action"}\n');
    expect(readEvents(file).length).toBe(2);
  });

  it('is resumable — replaying twice yields identical state', () => {
    appendEvent(file, { type: EVENT_TYPES.RUN_START, runId: 'r1' });
    appendEvent(file, { type: EVENT_TYPES.CRITERIA, met: 1, total: 1 });
    const a = replay(readEvents(file));
    const b = replay(readEvents(file));
    expect(a).toEqual(b);
  });
});

describe('detectConvergence', () => {
  it('does not converge while criteria are unmet', () => {
    const events = [
      { type: EVENT_TYPES.CRITERIA, met: 1, total: 3 },
      { type: EVENT_TYPES.GENERATION, newQuestions: 0, convergence: 0.99 },
      { type: EVENT_TYPES.GENERATION, newQuestions: 0, convergence: 0.99 },
    ];
    const r = detectConvergence(events);
    expect(r.converged).toBe(false);
    expect(r.criteriaMet).toBe(false);
  });

  it('does not converge while new questions keep appearing', () => {
    const events = [
      { type: EVENT_TYPES.CRITERIA, met: 3, total: 3 },
      { type: EVENT_TYPES.GENERATION, newQuestions: 2, convergence: 0.9 },
      { type: EVENT_TYPES.GENERATION, newQuestions: 1, convergence: 0.9 },
    ];
    expect(detectConvergence(events).converged).toBe(false);
  });

  it('converges when criteria met and the loop stabilised', () => {
    const events = [
      { type: EVENT_TYPES.CRITERIA, met: 3, total: 3 },
      { type: EVENT_TYPES.GENERATION, newQuestions: 0, convergence: 0.97 },
      { type: EVENT_TYPES.GENERATION, newQuestions: 0, convergence: 0.98 },
    ];
    const r = detectConvergence(events);
    expect(r.converged).toBe(true);
  });

  it('respects the convergence score floor', () => {
    const events = [
      { type: EVENT_TYPES.CRITERIA, met: 1, total: 1 },
      { type: EVENT_TYPES.GENERATION, newQuestions: 0, convergence: 0.5 },
      { type: EVENT_TYPES.GENERATION, newQuestions: 0, convergence: 0.6 },
    ];
    expect(detectConvergence(events, { convergenceFloor: 0.95 }).converged).toBe(false);
  });
});

describe('personas / unstuck', () => {
  it('returns only lateral-thinking personas', () => {
    const r = unstuck('stuck on a failing build');
    expect(r.personas.length).toBeGreaterThan(0);
    for (const p of r.personas) {
      expect(getPersona(p.id).lateral).toBe(true);
    }
  });

  it('respects count and exclude', () => {
    const r = unstuck('ctx', { count: 2, exclude: ['contrarian'] });
    expect(r.personas.length).toBe(2);
    expect(r.personas.find((p) => p.id === 'contrarian')).toBeUndefined();
  });

  it('exposes a stable roster', () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(9);
    expect(getPersona('simplifier')).toBeTruthy();
    expect(getPersona('nope')).toBeNull();
  });
});

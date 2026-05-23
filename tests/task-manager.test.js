// Tests for PR4.1 (RRULE INTERVAL math) and PR4.2 (orphan-task recovery sweep).
// We mock fs so the in-memory tasks array is what we control.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs BEFORE importing task-manager. The module reads tasks lazily from
// disk via fs.readFileSync; by mocking we control the returned JSON per test.
let _diskTasks = [];
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  const readFn = vi.fn(() => JSON.stringify(_diskTasks));
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: readFn,
      writeFileSync: vi.fn((_p, body) => {
        try { _diskTasks = JSON.parse(body); } catch (_) { /* ignore */ }
      }),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => true),
      copyFileSync: vi.fn(),
    },
    readFileSync: readFn,
    writeFileSync: vi.fn((_p, body) => {
      try { _diskTasks = JSON.parse(body); } catch (_) { /* ignore */ }
    }),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    copyFileSync: vi.fn(),
  };
});

const tm = await import('../task-manager.js');
const { rruleMatchesNow, startScheduler, stopScheduler, readTasks } = tm;

beforeEach(() => {
  _diskTasks = [];
  stopScheduler();
  vi.clearAllMocks();
});

// ── PR4.1 — INTERVAL math ───────────────────────────────────────────────
describe('PR4.1 rruleMatchesNow honours INTERVAL', () => {
  it('INTERVAL=2 HOURLY: blocks within 1 period of lastRunAt', () => {
    const lastRun = new Date(Date.now() - 30 * 60_000).toISOString(); // 30m ago
    expect(rruleMatchesNow('FREQ=HOURLY;INTERVAL=2', lastRun)).toBe(false);
  });

  it('INTERVAL=2 HOURLY: allows after ~2 periods elapsed', () => {
    const lastRun = new Date(Date.now() - 125 * 60_000).toISOString(); // 2h5m ago
    expect(rruleMatchesNow('FREQ=HOURLY;INTERVAL=2', lastRun)).toBe(true);
  });

  it('INTERVAL=3 DAILY: blocks at 1 day elapsed', () => {
    const lastRun = new Date(Date.now() - 1 * 86_400_000).toISOString();
    expect(rruleMatchesNow('FREQ=DAILY;INTERVAL=3', lastRun)).toBe(false);
  });

  it('INTERVAL=3 DAILY: allows past ~3 days elapsed', () => {
    const lastRun = new Date(Date.now() - 3 * 86_400_000 - 60_000).toISOString();
    expect(rruleMatchesNow('FREQ=DAILY;INTERVAL=3', lastRun)).toBe(true);
  });

  it('INTERVAL=2 MINUTELY: blocks immediately after lastRun', () => {
    const lastRun = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    expect(rruleMatchesNow('FREQ=MINUTELY;INTERVAL=2', lastRun)).toBe(false);
  });

  it('INTERVAL=2 MINUTELY: allows after 2 minutes elapsed', () => {
    const lastRun = new Date(Date.now() - 125_000).toISOString(); // 2m5s ago
    expect(rruleMatchesNow('FREQ=MINUTELY;INTERVAL=2', lastRun)).toBe(true);
  });

  it('INTERVAL=1 (default) is unchanged — no INTERVAL guard', () => {
    const lastRun = new Date(Date.now() - 60_000).toISOString();
    // DAILY w/ default interval still matches when minute-dedupe passes
    expect(rruleMatchesNow('FREQ=DAILY', lastRun)).toBe(true);
  });

  it('first run (no lastRunAt) always allowed regardless of INTERVAL', () => {
    expect(rruleMatchesNow('FREQ=DAILY;INTERVAL=5', null)).toBe(true);
    expect(rruleMatchesNow('FREQ=HOURLY;INTERVAL=10', null)).toBe(true);
  });
});

// ── PR4.2 — Orphan-task recovery ────────────────────────────────────────
describe('PR4.2 startScheduler orphan-task recovery sweep', () => {
  it('resets a stuck recurring task back to scheduled and adds history', () => {
    _diskTasks = [{
      id: 't1', title: 'Stuck recurring', kind: 'cron',
      status: 'running',
      schedule: { type: 'recurring', rrule: 'FREQ=DAILY;BYHOUR=9' },
      history: [],
    }];
    startScheduler(() => {});
    stopScheduler();
    const t = readTasks().find(x => x.id === 't1');
    expect(t.status).toBe('scheduled');
    expect(t.history.some(h => h.event === 'recovered')).toBe(true);
  });

  it('fails a stuck one-time task instead of rescheduling', () => {
    _diskTasks = [{
      id: 't2', title: 'Stuck one-time', kind: 'cron',
      status: 'running',
      schedule: { type: 'once', at: new Date(Date.now() - 60_000).toISOString() },
      history: [],
    }];
    startScheduler(() => {});
    stopScheduler();
    const t = readTasks().find(x => x.id === 't2');
    expect(t.status).toBe('failed');
    expect(t.history.some(h => h.event === 'recovered')).toBe(true);
  });

  it('leaves non-running tasks alone', () => {
    _diskTasks = [
      { id: 'a', status: 'scheduled', schedule: { type: 'recurring', rrule: 'FREQ=DAILY' }, history: [] },
      { id: 'b', status: 'completed', schedule: { type: 'once', at: new Date().toISOString() }, history: [] },
    ];
    startScheduler(() => {});
    stopScheduler();
    const tasks = readTasks();
    expect(tasks.find(t => t.id === 'a').status).toBe('scheduled');
    expect(tasks.find(t => t.id === 'b').status).toBe('completed');
    expect(tasks.find(t => t.id === 'a').history.some(h => h.event === 'recovered')).toBe(false);
  });
});

// tests/migrate-heartbeat.test.js
// Verifies the one-shot retirement migrator: schedule→RRULE conversion,
// pipeline shape, marker gating, and the disabled / not-enabled / no-config
// short-circuits.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// Avoid touching the real heartbeat.json — disableHeartbeat is fire-and-forget
// in the migrator's eyes.
vi.mock('../heartbeat.js', () => ({
  disableHeartbeat: vi.fn(),
}));

// loadJson is what reads heartbeat.json; mock it so we can hand in fake
// settings without writing fixtures to disk.
vi.mock('../server/lib/json-store.js', async () => {
  const actual = await vi.importActual('../server/lib/json-store.js');
  return {
    ...actual,
    loadJson: vi.fn(),
    saveJsonAtomic: vi.fn(),
  };
});

import { loadJson } from '../server/lib/json-store.js';
import {
  migrateHeartbeatToPipeline,
  _heartbeatScheduleToRrule,
  _buildHeartbeatPipeline,
} from '../server/lib/migrate-heartbeat.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('_heartbeatScheduleToRrule', () => {
  it('produces sub-hourly BYMINUTE list for clean divisors of 60', () => {
    const r = _heartbeatScheduleToRrule(30, { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 });
    expect(r).toContain('FREQ=HOURLY');
    expect(r).toContain('BYHOUR=9,10,11,12,13,14,15,16');
    expect(r).toContain('BYMINUTE=0,30');
    expect(r).toContain('BYDAY=MO,TU,WE,TH,FR');
  });

  it('uses INTERVAL for multi-hour cadence', () => {
    const r = _heartbeatScheduleToRrule(120, { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 });
    expect(r).toContain('FREQ=HOURLY');
    expect(r).toContain('INTERVAL=2');
    expect(r).toContain('BYMINUTE=0');
  });

  it('falls back to MINUTELY for odd cadence', () => {
    const r = _heartbeatScheduleToRrule(45, { days: [1], startHour: 0, endHour: 24 });
    expect(r).toContain('FREQ=MINUTELY');
    expect(r).toContain('INTERVAL=45');
  });

  it('defaults to every-day all-day with sensible interval', () => {
    const r = _heartbeatScheduleToRrule(60, {});
    expect(r).toContain('FREQ=HOURLY');
    expect(r).toContain('BYDAY=SU,MO,TU,WE,TH,FR,SA');
  });
});

describe('_buildHeartbeatPipeline', () => {
  it('produces a 4-node trigger→prompt→parse-urgent→os-notify chain', () => {
    const p = _buildHeartbeatPipeline({
      intervalMinutes: 30,
      schedule: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 },
      prompt: 'Check system status',
      osNotify: true,
      widgetNotify: false,
    });
    expect(p.nodes.map(n => n.type)).toEqual(['trigger', 'prompt', 'parse-urgent', 'os-notify']);
    expect(p.edges).toHaveLength(3);
    expect(p.nodes[0].config.subtype).toBe('schedule');
    expect(p.nodes[0].config.rrule).toContain('FREQ=HOURLY');
    expect(p.nodes[1].config.prompt).toBe('Check system status');
    expect(p.nodes[3].config.onlyUrgent).toBe('true');
    expect(p.nodes[3].config.os).toBe('true');
    expect(p.nodes[3].config.widget).toBe('false');
  });
});

describe('migrateHeartbeatToPipeline', () => {
  it('skips with marker-present when the marker file exists', () => {
    fs.existsSync.mockReturnValue(true);
    const createTask = vi.fn();
    const out = migrateHeartbeatToPipeline({ createTask });
    expect(out.migrated).toBe(false);
    expect(out.reason).toBe('marker-present');
    expect(createTask).not.toHaveBeenCalled();
  });

  it('writes marker and skips when heartbeat.json is absent', () => {
    fs.existsSync.mockImplementation(() => false);
    const createTask = vi.fn();
    const out = migrateHeartbeatToPipeline({ createTask });
    expect(out.migrated).toBe(false);
    expect(out.reason).toBe('no-config');
    expect(createTask).not.toHaveBeenCalled();
  });

  it('skips with not-enabled when settings.enabled is false', () => {
    // First call = marker check (false), second = hb file check (true)
    fs.existsSync
      .mockReturnValueOnce(false)  // marker absent
      .mockReturnValueOnce(true);  // hb file present
    loadJson.mockReturnValue({ settings: { enabled: false }, log: [] });
    const createTask = vi.fn();
    const out = migrateHeartbeatToPipeline({ createTask });
    expect(out.migrated).toBe(false);
    expect(out.reason).toBe('not-enabled');
    expect(createTask).not.toHaveBeenCalled();
  });

  it('creates a pipeline task when heartbeat is enabled', () => {
    fs.existsSync
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    loadJson.mockReturnValue({
      settings: {
        enabled: true,
        intervalMinutes: 30,
        prompt: 'Check things',
        schedule: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 },
        osNotify: true,
        widgetNotify: true,
      },
      log: [],
    });
    const createTask = vi.fn().mockImplementation(t => ({ id: 'task-123', ...t }));
    const out = migrateHeartbeatToPipeline({ createTask });
    expect(out.migrated).toBe(true);
    expect(out.taskId).toBe('task-123');
    expect(createTask).toHaveBeenCalledOnce();
    const taskArg = createTask.mock.calls[0][0];
    expect(taskArg.kind).toBe('pipeline');
    expect(taskArg.schedule.type).toBe('recurring');
    expect(taskArg.pipeline.nodes).toHaveLength(4);
  });
});

// server/lib/migrate-heartbeat.js
// One-shot migrator that retires the standalone heartbeat.js scheduler in
// favour of a pipeline task. Runs once per install:
//
//   • Reads ~/.config/fauna/heartbeat.json
//   • If settings.enabled is true and a marker file is absent, synthesizes
//     a pipeline task with the same prompt / schedule / notification toggles
//   • Disables the legacy module in heartbeat.json
//   • Writes ~/.config/fauna/heartbeat-migrated.json so we never run again
//
// If heartbeat isn't enabled we still write the marker so subsequent boots
// don't bother checking. The legacy module is no longer started either way
// — this function fully replaces the startHeartbeat() call in server.js.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadJson, saveJsonAtomic } from './json-store.js';
import { disableHeartbeat } from '../../heartbeat.js';

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(os.homedir(), '.config', 'fauna');
const MARKER_FILE = path.join(CONFIG_DIR, 'heartbeat-migrated.json');
const HB_FILE     = path.join(CONFIG_DIR, 'heartbeat.json');

const WEEKDAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Convert legacy heartbeat schedule + intervalMinutes into an RRULE.
 *
 *   { days:[1..5], startHour:9, endHour:17 } + intervalMinutes:30
 *     → FREQ=HOURLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10,...,16;BYMINUTE=0,30
 *
 * For intervalMinutes that doesn't divide 60 cleanly, falls back to
 * MINUTELY;INTERVAL=N constrained to BYHOUR + BYDAY. The runtime RRULE
 * matcher in task-manager.js honours all of these fields.
 */
export function _heartbeatScheduleToRrule(intervalMinutes, schedule) {
  const s = schedule || {};
  const im = Number(intervalMinutes) > 0 ? Number(intervalMinutes) : 30;
  const startHour = s.startHour != null ? s.startHour : 0;
  const endHour   = s.endHour   != null ? s.endHour   : 24;
  const days      = Array.isArray(s.days) && s.days.length ? s.days : [0,1,2,3,4,5,6];

  const byDay  = days.map(d => WEEKDAY_NAMES[d % 7]).filter(Boolean).join(',');
  const hours  = [];
  for (let h = startHour; h < endHour; h++) hours.push(h);
  const byHour = hours.join(',');

  const parts = [];
  if (im <= 60 && 60 % im === 0) {
    // Clean sub-hourly: pick minute marks.
    const mins = [];
    for (let m = 0; m < 60; m += im) mins.push(m);
    parts.push('FREQ=HOURLY');
    if (byHour) parts.push('BYHOUR=' + byHour);
    parts.push('BYMINUTE=' + mins.join(','));
  } else if (im % 60 === 0) {
    // Multi-hour interval: skip hours by INTERVAL on HOURLY, restricted to
    // the window. We still emit BYHOUR so the matcher only fires inside the
    // window; INTERVAL controls the cadence.
    parts.push('FREQ=HOURLY');
    parts.push('INTERVAL=' + (im / 60));
    if (byHour) parts.push('BYHOUR=' + byHour);
    parts.push('BYMINUTE=0');
  } else {
    // Odd cadence — minute-level INTERVAL, restricted to the window.
    parts.push('FREQ=MINUTELY');
    parts.push('INTERVAL=' + im);
    if (byHour) parts.push('BYHOUR=' + byHour);
  }
  if (byDay) parts.push('BYDAY=' + byDay);
  return parts.join(';');
}

/**
 * Build the pipeline that replaces heartbeat.js for one settings record.
 * The shape mirrors what the docked builder rail produces so the user can
 * open and edit it like any other pipeline.
 */
export function _buildHeartbeatPipeline(settings) {
  const rrule = _heartbeatScheduleToRrule(settings.intervalMinutes, settings.schedule);
  return {
    nodes: [
      { id: 'n1', type: 'trigger', label: 'Heartbeat schedule',
        x: 80, y: 120,
        config: { subtype: 'schedule', rrule } },
      { id: 'n2', type: 'prompt', label: 'System check',
        x: 320, y: 120,
        config: { prompt: settings.prompt || '' } },
      { id: 'n3', type: 'parse-urgent', label: 'Parse alert',
        x: 560, y: 120,
        config: {} },
      { id: 'n4', type: 'os-notify', label: 'Notify on urgent',
        x: 800, y: 120,
        config: {
          onlyUrgent: 'true',
          os: settings.osNotify === false ? 'false' : 'true',
          widget: settings.widgetNotify === false ? 'false' : 'true',
        } },
    ],
    edges: [
      { from: 'n1', to: 'n2', fromPort: 'out', toPort: 'in' },
      { from: 'n2', to: 'n3', fromPort: 'out', toPort: 'in' },
      { from: 'n3', to: 'n4', fromPort: 'out', toPort: 'in' },
    ],
  };
}

/**
 * Perform the one-shot retirement migration.
 *
 * @param {object} deps
 * @param {(opts:any) => any} deps.createTask  task-manager.createTask
 * @returns {{migrated: boolean, reason?: string, taskId?: string}}
 */
export function migrateHeartbeatToPipeline({ createTask }) {
  try {
    if (fs.existsSync(MARKER_FILE)) {
      return { migrated: false, reason: 'marker-present' };
    }
    // Heartbeat config absent → never used. Just lay down the marker so we
    // don't keep checking on every boot.
    if (!fs.existsSync(HB_FILE)) {
      _writeMarker({ migrated: false, reason: 'no-config' });
      return { migrated: false, reason: 'no-config' };
    }
    const data = loadJson(HB_FILE, { settings: {}, log: [] });
    const settings = data.settings || {};

    if (!settings.enabled) {
      // Module exists but is disabled — nothing to port. Mark done.
      _writeMarker({ migrated: false, reason: 'not-enabled' });
      return { migrated: false, reason: 'not-enabled' };
    }

    const pipeline = _buildHeartbeatPipeline(settings);
    const rrule = pipeline.nodes[0].config.rrule;
    const task = createTask({
      kind: 'pipeline',
      title: 'Heartbeat — system status check',
      description: 'Migrated from the legacy heartbeat module. Edit in the docked builder rail.',
      schedule: { type: 'recurring', rrule, at: '', timezone: null },
      pipeline,
      model: settings.model || null,
      permissions: { shell: false, browser: false, figma: false },
      maxRetries: 1,
      timeout: 60_000,
      maxSteps: 8,
    });

    // Disable the legacy module so it doesn't double-fire alongside the
    // pipeline task. The module is no longer started by server.js anyway,
    // but flipping the flag means re-enabling it manually requires intent.
    try { disableHeartbeat(); } catch (e) { console.warn('[hb-migrate] disable failed:', e?.message || e); }

    _writeMarker({ migrated: true, taskId: task?.id || null });
    console.log('[hb-migrate] retired heartbeat.js → pipeline task', task?.id);
    return { migrated: true, taskId: task?.id || null };
  } catch (e) {
    console.warn('[hb-migrate] failed:', e?.message || e);
    return { migrated: false, reason: 'error' };
  }
}

function _writeMarker(payload) {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch (_) {}
  try { saveJsonAtomic(MARKER_FILE, { at: new Date().toISOString(), version: 1, ...payload }); }
  catch (e) { console.warn('[hb-migrate] marker write failed:', e?.message || e); }
}

// Exposed for tests.
export const _internal = { MARKER_FILE, HB_FILE };

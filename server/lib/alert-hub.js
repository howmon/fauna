// server/lib/alert-hub.js
// Tiny pub/sub for widget alerts (heartbeat urgencies + chat/workflow
// completions). Subscribers are SSE response streams. Keeps a ring buffer
// of recent alerts so a freshly-connected widget can catch up on anything
// fired while it was closed. A master `enabled` flag lets the user mute
// the entire widget notification panel.

import path from 'node:path';
import os from 'node:os';
import { loadJson, saveJsonAtomic } from './json-store.js';

const RING_MAX = 20;
const SETTINGS_PATH = path.join(
  process.env.CONFIG_DIR || path.join(os.homedir(), '.config', 'fauna'),
  'widget-alerts.json',
);

const _ring = [];          // newest last
const _dismissed = new Set();
/** @type {Set<import('http').ServerResponse>} */
const _subs = new Set();

let _settings = loadJson(SETTINGS_PATH, { enabled: true });
function _persist() {
  try { saveJsonAtomic(SETTINGS_PATH, _settings); } catch (_) {}
}

function _send(res, payload) {
  try { res.write('data: ' + JSON.stringify(payload) + '\n\n'); } catch (_) {}
}

export function publish(alert) {
  if (!alert || !alert.id) return;
  if (_settings.enabled === false) return; // master mute
  _ring.push(alert);
  if (_ring.length > RING_MAX) _ring.splice(0, _ring.length - RING_MAX);
  for (const res of _subs) _send(res, { type: 'alert', alert });
}

export function subscribe(res) {
  _subs.add(res);
  // Replay anything not yet dismissed so a re-opened widget catches up.
  const pending = _ring.filter(a => !_dismissed.has(a.id));
  _send(res, { type: 'snapshot', alerts: pending });
  // Keepalive comments every 25s so proxies don't time out the connection.
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 25000);
  res.on('close', () => { clearInterval(ka); _subs.delete(res); });
}

export function dismiss(id) {
  if (!id) return false;
  _dismissed.add(id);
  const idx = _ring.findIndex(a => a.id === id);
  if (idx >= 0) _ring.splice(idx, 1);
  for (const res of _subs) _send(res, { type: 'dismissed', id });
  return true;
}

export function listActive() {
  return _ring.filter(a => !_dismissed.has(a.id));
}

export function getSettings() {
  return { ..._settings };
}

export function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();
  if (typeof patch.enabled === 'boolean') _settings.enabled = patch.enabled;
  _persist();
  // If the user just muted the panel, clear any pending alerts so the bell
  // count drops to zero and re-enabling doesn't dump stale items.
  if (_settings.enabled === false) {
    _ring.length = 0;
    for (const res of _subs) _send(res, { type: 'snapshot', alerts: [] });
  }
  return getSettings();
}

export function isEnabled() {
  return _settings.enabled !== false;
}

export function _reset() {
  _ring.length = 0;
  _dismissed.clear();
  _settings = { enabled: true };
  for (const res of _subs) { try { res.end(); } catch (_) {} }
  _subs.clear();
}


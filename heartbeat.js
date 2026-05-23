// ── Heartbeat Monitoring — Periodic AI-powered checks with alerts ─────────
// Runs a configurable prompt on a schedule, parses structured responses,
// fires native notifications for urgent items, and keeps a ring-buffer log.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadJson, saveJsonAtomic } from './server/lib/json-store.js';
import { runScheduledAI } from './server/lib/scheduled-ai.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const HB_FILE    = path.join(CONFIG_DIR, 'heartbeat.json');
const LOG_MAX    = 100; // ring buffer size

let _timer = null;
let _settings = null;
let _log = [];
let _aiCaller = null;     // function(prompt) → string
let _notifier = null;     // function(title, body)
let _powerSave = null;    // optional { acquire, release } guard

// ── Default settings ────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: false,
  intervalMinutes: 30,
  prompt: 'Check my system status. If anything needs immediate attention, prefix your response with HEARTBEAT_URGENT|source|summary. Otherwise respond with HEARTBEAT_OK followed by a brief summary.',
  schedule: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 }, // weekdays 9am-5pm
  model: '',  // empty = use active conversation model
};

// ── Persistence ────────────────────────────────────────────────────────

function _load() {
  if (_settings) return _settings;
  const data = loadJson(HB_FILE, { settings: {}, log: [] });
  _settings = { ...DEFAULTS, ...(data.settings || {}) };
  _log = Array.isArray(data.log) ? data.log.slice(-LOG_MAX) : [];
  return _settings;
}

function _save() {
  saveJsonAtomic(HB_FILE, { settings: _settings, log: _log });
}

// ── Public API ──────────────────────────────────────────────────────────

export function getSettings() {
  return { ..._load() };
}

export function updateSettings(patch) {
  _load();
  if (patch.enabled !== undefined) _settings.enabled = !!patch.enabled;
  if (patch.intervalMinutes !== undefined) _settings.intervalMinutes = Math.max(1, Math.min(1440, patch.intervalMinutes));
  if (patch.prompt !== undefined) _settings.prompt = String(patch.prompt).slice(0, 2000);
  if (patch.schedule) _settings.schedule = { ..._settings.schedule, ...patch.schedule };
  if (patch.model !== undefined) _settings.model = String(patch.model);
  _save();
  _reschedule();
  return _settings;
}

export function getLog() {
  _load();
  return _log.slice().reverse(); // newest first
}

export function clearLog() {
  _load();
  _log = [];
  _save();
}

// ── Schedule checking ──────────────────────────────────────────────────

function _isInSchedule() {
  const s = _settings.schedule;
  if (!s) return true;
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const hour = now.getHours();
  if (s.days && !s.days.includes(day)) return false;
  if (s.startHour !== undefined && hour < s.startHour) return false;
  if (s.endHour !== undefined && hour >= s.endHour) return false;
  return true;
}

// ── Run heartbeat ──────────────────────────────────────────────────────

export async function runHeartbeat(force = false) {
  _load();
  if (!force && !_settings.enabled) return { skipped: true, reason: 'disabled' };
  if (!force && !_isInSchedule()) return { skipped: true, reason: 'outside schedule' };
  if (!_aiCaller) return { skipped: true, reason: 'no AI caller configured' };

  const startTime = Date.now();
  let response = '';
  let status = 'ok';
  let urgent = null;

  try {
    // Shared helper: bounded timeout + 3-attempt exponential retry +
    // power-save hold around the AI call (PR2.1 / PR4.4).
    response = await runScheduledAI({
      aiCaller: _aiCaller,
      prompt:   _settings.prompt,
      model:    _settings.model,
      label:    'heartbeat AI call',
      timeoutMs: 30000,
      attempts: 3,
      baseMs:   1000,
      powerSave: _powerSave,
    });
    // Parse structured response
    const parsed = _parseResponse(response);
    status = parsed.status;
    urgent = parsed.urgent;

    if (urgent && _notifier) {
      _notifier('🫀 Heartbeat Alert', urgent.summary + (urgent.source ? ` (${urgent.source})` : ''));
    }
  } catch (e) {
    status = 'error';
    response = e.message;
  }

  const entry = {
    timestamp: startTime,
    durationMs: Date.now() - startTime,
    status,
    urgent,
    response: String(response || '').slice(0, 2000),
  };
  _log.push(entry);
  if (_log.length > LOG_MAX) _log.splice(0, _log.length - LOG_MAX);
  _save();

  return entry;
}

function _parseResponse(text) {
  // The AI caller can return a string OR a chat-completion object. Normalise
  // first so .match doesn't blow up on objects (previous behaviour silently
  // skipped parsing and always reported 'ok').
  if (text && typeof text === 'object') {
    text = text?.choices?.[0]?.message?.content
        ?? text?.content
        ?? text?.text
        ?? '';
  }
  text = String(text || '');

  // Look for HEARTBEAT_URGENT|source|summary. Anchored at a line boundary
  // (multiline flag) so a quoted example earlier in the response doesn't
  // trigger a false positive, and case-insensitive in case the model
  // varies casing. Summary is captured up to end-of-line.
  const urgentMatch = text.match(/^[\s>*-]*HEARTBEAT_URGENT\|([^|\n]*)\|([^\n]+)/im);
  if (urgentMatch) {
    return {
      status: 'urgent',
      urgent: { source: urgentMatch[1].trim(), summary: urgentMatch[2].trim() },
    };
  }
  // HEARTBEAT_OK — also anchor + case-insensitive.
  if (/^[\s>*-]*HEARTBEAT_OK\b/im.test(text)) {
    return { status: 'ok', urgent: null };
  }
  // Fallback: treat any response as informational
  return { status: 'ok', urgent: null };
}

// ── Timer management ───────────────────────────────────────────────────

function _reschedule() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (!_settings?.enabled || !_settings.intervalMinutes) return;
  const ms = _settings.intervalMinutes * 60 * 1000;
  _timer = setInterval(() => {
    runHeartbeat().catch(e => console.error('[heartbeat] Error:', e.message));
  }, ms);
  console.log(`[heartbeat] Scheduled every ${_settings.intervalMinutes}m`);
}

export function startHeartbeat(aiCaller, notifier) {
  _aiCaller = aiCaller;
  _notifier = notifier;
  _load();
  _reschedule();
}

export function setHeartbeatPowerSave(guard) {
  _powerSave = guard && typeof guard.acquire === 'function' ? guard : null;
}

export function stopHeartbeat() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// ── Voice settings store (Phase 7) ───────────────────────────────────────
//
// One JSON file at ~/.config/fauna/voice-settings.json that backs the
// settings UI. Resident-audio still owns its own ~/.config/fauna/voice.json
// for the enabled flag + pre-roll (operational state), but everything the
// user *configures* (wake words, TTS voice/rate, dictation hotkey,
// redaction toggles, tool budget…) lives here so the chat router, the
// voice pipeline, and the renderer share one source of truth.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'node:events';

const CONFIG_DIR  = path.join(os.homedir(), '.config', 'fauna');
const CONFIG_FILE = path.join(CONFIG_DIR, 'voice-settings.json');

export const DEFAULT_DICTATION_ACCEL_MAC   = 'Cmd+Alt+D';
export const DEFAULT_DICTATION_ACCEL_OTHER = 'Ctrl+Alt+D';

export const DEFAULTS = Object.freeze({
  // Wake words
  wakeWords:        ['fauna', 'hey fauna', 'ok fauna', 'okay fauna'],
  wakeRequired:     true,        // require a wake word for non-follow-up
  followUpWindowMs: 12000,

  // TTS defaults
  ttsVoice: '',                  // empty = engine default
  ttsRate:  null,                // null = engine default (mac wpm, linux wpm, win -10..10)
  ttsEnabled: true,

  // Dictation
  dictationAccel: process.platform === 'darwin'
    ? DEFAULT_DICTATION_ACCEL_MAC
    : DEFAULT_DICTATION_ACCEL_OTHER,
  dictationPasteOnFinish: false, // future: actually inject paste keystroke

  // Redaction (memory + playbook persist path)
  redactEmail:      false,
  redactPhone:      false,
  redactCreditCard: true,

  // Tool routing budget (consumed by chat router when wired)
  toolTopK:    12,
  toolMustKeep: ['agent_read_file', 'agent_write_file', 'remember_fact', 'recall_facts'],
});

const ALLOWED_KEYS = new Set(Object.keys(DEFAULTS));

let _cache = null;
const _bus  = new EventEmitter();

function _read() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return _sanitise({ ...DEFAULTS, ...raw });
  } catch (_) {
    return { ...DEFAULTS };
  }
}
function _write(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.warn('[voice-settings] write failed:', e.message);
  }
}

// Coerce + clamp every field so external writers can't poison the store.
function _sanitise(cfg) {
  const out = { ...DEFAULTS, ...cfg };
  if (!Array.isArray(out.wakeWords) || !out.wakeWords.length) out.wakeWords = [...DEFAULTS.wakeWords];
  out.wakeWords = out.wakeWords
    .map(w => String(w || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 16);

  out.wakeRequired     = !!out.wakeRequired;
  out.followUpWindowMs = Math.max(2000, Math.min(60000, Number(out.followUpWindowMs) || DEFAULTS.followUpWindowMs));

  out.ttsVoice   = typeof out.ttsVoice === 'string' ? out.ttsVoice.slice(0, 80) : '';
  if (out.ttsRate === null || out.ttsRate === '' || out.ttsRate === undefined) out.ttsRate = null;
  else {
    const n = Number(out.ttsRate);
    out.ttsRate = Number.isFinite(n) ? n : null;
  }
  out.ttsEnabled = !!out.ttsEnabled;

  out.dictationAccel = typeof out.dictationAccel === 'string' && out.dictationAccel.trim()
    ? out.dictationAccel.trim()
    : DEFAULTS.dictationAccel;
  out.dictationPasteOnFinish = !!out.dictationPasteOnFinish;

  out.redactEmail      = !!out.redactEmail;
  out.redactPhone      = !!out.redactPhone;
  out.redactCreditCard = out.redactCreditCard !== false;

  out.toolTopK   = Math.max(1, Math.min(64, Number(out.toolTopK) || DEFAULTS.toolTopK));
  out.toolMustKeep = Array.isArray(out.toolMustKeep)
    ? out.toolMustKeep.map(s => String(s)).filter(Boolean).slice(0, 32)
    : [...DEFAULTS.toolMustKeep];

  return out;
}

export function getSettings() {
  if (!_cache) _cache = _read();
  return { ..._cache };
}

/** Merge a partial patch in. Unknown keys are ignored. Emits `change`. */
export function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();
  const cur = getSettings();
  const merged = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    merged[k] = v;
  }
  _cache = _sanitise(merged);
  _write(_cache);
  _bus.emit('change', { ..._cache });
  return { ..._cache };
}

export function resetSettings() {
  _cache = { ...DEFAULTS };
  _write(_cache);
  _bus.emit('change', { ..._cache });
  return { ..._cache };
}

/** Subscribe to settings changes. Returns an unsubscribe fn. */
export function onSettingsChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _bus.on('change', fn);
  return () => _bus.off('change', fn);
}

/** Convenience: redaction opts shaped for redactor.scrubSecrets(). */
export function getRedactionOpts() {
  const s = getSettings();
  return { email: s.redactEmail, phone: s.redactPhone, creditCard: s.redactCreditCard };
}

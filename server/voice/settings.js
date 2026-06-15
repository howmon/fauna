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

// Whitelisted Whisper.cpp model aliases. These match the filenames hosted at
// https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<alias>.bin
// Order is meaningful: settings UI renders in this order.
export const WHISPER_MODELS = Object.freeze([
  'tiny',
  'tiny.en',
  'base',
  'base.en',
  'small',
  'small.en',
  'medium',
  'medium.en',
  'large-v3-turbo',
]);

export const DEFAULTS = Object.freeze({
  // Wake words
  wakeWords:        ['fauna', 'hey fauna', 'ok fauna', 'okay fauna'],
  wakeRequired:     true,        // require a wake word for non-follow-up
  followUpWindowMs: 12000,

  // TTS defaults
  ttsVoice: '',                  // empty = Kokoro neural (default engine)
  ttsRate:  null,                // null = engine default (mac wpm, linux wpm, win -10..10)
  ttsEnabled: true,

  // Dictation
  dictationAccel: process.platform === 'darwin'
    ? DEFAULT_DICTATION_ACCEL_MAC
    : DEFAULT_DICTATION_ACCEL_OTHER,
  dictationPasteOnFinish: false, // future: actually inject paste keystroke

  // Whisper STT
  whisperModel:    'base.en',    // one of: tiny, tiny.en, base, base.en, small, small.en, medium, medium.en, large-v3-turbo
  whisperLanguage: 'auto',       // 'auto' = detect; or BCP-47 code: 'en', 'es', 'fr', ...
  whisperHotWords: '',           // free-form initial-prompt text fed to whisper-cli --prompt to bias decoding
                                 // toward project names, acronyms, jargon (e.g. "Fauna, Kokoro, MCP, afterPack").

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

  // Whisper STT — restrict to a known whitelist so we never spawn whisper-cli
  // against an attacker-controlled filename.
  out.whisperModel = WHISPER_MODELS.includes(String(out.whisperModel))
    ? String(out.whisperModel)
    : DEFAULTS.whisperModel;
  // Language: 'auto' or a 2–5 char alpha code. Whisper accepts 'en', 'zh',
  // 'es', etc. We don't validate against a full BCP-47 set, just shape.
  out.whisperLanguage = (() => {
    const v = String(out.whisperLanguage || '').trim().toLowerCase();
    if (!v || v === 'auto') return 'auto';
    if (/^[a-z]{2,5}(?:-[a-z0-9]{2,8})?$/i.test(v)) return v;
    return DEFAULTS.whisperLanguage;
  })();
  // Hot-words / initial prompt. Whisper.cpp caps the prompt at ~224 tokens
  // (~900 chars in practice); cap conservatively. Strip control chars so an
  // accidental newline/NUL can't break the spawn args.
  out.whisperHotWords = (() => {
    let v = String(out.whisperHotWords || '');
    // eslint-disable-next-line no-control-regex
    v = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (v.length > 800) v = v.slice(0, 800);
    return v;
  })();

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

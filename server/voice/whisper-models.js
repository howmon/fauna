// ── Whisper model catalogue helpers ──────────────────────────────────────
//
// Centralises the alias → filename mapping and the on-disk layout so the
// dictation route, the REST /api/transcribe route, and the settings UI all
// agree on what "base.en" means.
//
// Model files live at:
//   ~/.config/fauna/whisper/ggml-<alias>.bin
// and are sourced from:
//   https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<alias>.bin

import fs from 'fs';
import os from 'os';
import path from 'path';

import { WHISPER_MODELS } from './settings.js';

export { WHISPER_MODELS };

export const MODEL_DIR = path.join(os.homedir(), '.config', 'fauna', 'whisper');

// Pretty labels + rough sizes for the settings UI. Values came from
// https://github.com/ggerganov/whisper.cpp/blob/master/models/README.md
// English-only variants are ~same size as their multilingual sibling but a
// tad more accurate for English audio.
export const MODEL_INFO = Object.freeze({
  'tiny':            { label: 'Tiny (multilingual)',           sizeMB: 75,   speed: 'fastest' },
  'tiny.en':         { label: 'Tiny (English-only)',           sizeMB: 75,   speed: 'fastest' },
  'base':            { label: 'Base (multilingual)',           sizeMB: 142,  speed: 'fast' },
  'base.en':         { label: 'Base (English-only) \u2014 default', sizeMB: 142,  speed: 'fast' },
  'small':           { label: 'Small (multilingual)',          sizeMB: 466,  speed: 'balanced' },
  'small.en':        { label: 'Small (English-only)',          sizeMB: 466,  speed: 'balanced' },
  'medium':          { label: 'Medium (multilingual)',         sizeMB: 1500, speed: 'slow' },
  'medium.en':       { label: 'Medium (English-only)',         sizeMB: 1500, speed: 'slow' },
  'large-v3-turbo':  { label: 'Large v3 Turbo (multilingual)', sizeMB: 1600, speed: 'slow' },
});

export function isWhisperAlias(alias) {
  return typeof alias === 'string' && WHISPER_MODELS.includes(alias);
}

export function fileNameFor(alias) {
  return 'ggml-' + alias + '.bin';
}

export function modelPathFor(alias) {
  if (!isWhisperAlias(alias)) return null;
  return path.join(MODEL_DIR, fileNameFor(alias));
}

export function downloadUrlFor(alias) {
  if (!isWhisperAlias(alias)) return null;
  return 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + fileNameFor(alias);
}

export function isInstalled(alias) {
  const p = modelPathFor(alias);
  return !!p && fs.existsSync(p);
}

/**
 * Pick the best available model: caller's preference if installed, else the
 * first installed model from the catalog, else null. Lets callers degrade
 * gracefully when the user selected something that hasn't been downloaded
 * yet (vs. hard-erroring mid-recording).
 */
export function resolveActiveModel(preferred) {
  if (preferred && isInstalled(preferred)) return preferred;
  for (const m of WHISPER_MODELS) {
    if (isInstalled(m)) return m;
  }
  return null;
}

/** Returns an array of `{alias, label, sizeMB, speed, installed, sizeBytes}`. */
export function listModels() {
  return WHISPER_MODELS.map(alias => {
    const info = MODEL_INFO[alias] || {};
    const p    = modelPathFor(alias);
    let installed = false, sizeBytes = 0;
    try {
      const st = fs.statSync(p);
      installed = true;
      sizeBytes = st.size;
    } catch (_) { /* not installed */ }
    return {
      alias,
      label:     info.label || alias,
      sizeMB:    info.sizeMB || 0,
      speed:     info.speed  || 'unknown',
      installed,
      sizeBytes,
      path:      p,
    };
  });
}

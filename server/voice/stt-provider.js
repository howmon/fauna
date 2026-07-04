// ── STT provider selector ────────────────────────────────────────────────
//
// Single seam that lets the voice pipeline pick between the two speech-to-text
// engines fauna ships, based on the `sttEngine` voice setting:
//
//   'whisper'  (default) → transcribe-pcm.js       (whisper.cpp, bundled CLI)
//   'parakeet'           → transcribe-parakeet.js  (sherpa-onnx, in-process)
//
// Both engines expose the same PCM16-in / `{ ok, text }`-out contract, so
// callers (dictation.js, utterance-pipeline.js) only need this module — they
// never import a concrete engine directly.
//
// The Parakeet engine (and its native binding) is imported LAZILY the first
// time a Parakeet transcription is requested. That keeps startup cheap and
// means an install that never selects Parakeet — or a platform where the
// optional binary is missing — is completely unaffected.
//
// `isSttReady()` stays synchronous: Parakeet readiness is a pure fs check in
// parakeet-models.js and needs no native require, matching the old
// isWhisperReady() call sites.

import * as whisper from './transcribe-pcm.js';
import { resolveActiveModel as resolveParakeet } from './parakeet-models.js';
import { getSettings } from './settings.js';

export const STT_ENGINES = Object.freeze(['whisper', 'parakeet']);

let _parakeetMod = null;
async function _parakeet() {
  if (!_parakeetMod) _parakeetMod = await import('./transcribe-parakeet.js');
  return _parakeetMod;
}

/** Which engine is currently selected. Defaults to whisper. */
export function activeEngine() {
  return getSettings().sttEngine === 'parakeet' ? 'parakeet' : 'whisper';
}

/** True when the currently-selected engine has a usable model installed. */
export function isSttReady() {
  if (activeEngine() === 'parakeet') {
    return !!resolveParakeet(getSettings().parakeetModel);
  }
  return whisper.isWhisperReady();
}

/**
 * Transcribe a PCM16 mono buffer with the active engine.
 * @see transcribe-pcm.js / transcribe-parakeet.js for the opts contract.
 */
export async function transcribePcm(pcm, opts) {
  if (activeEngine() === 'parakeet') {
    const mod = await _parakeet();
    return mod.transcribePcm(pcm, opts);
  }
  return whisper.transcribePcm(pcm, opts);
}

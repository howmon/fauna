// ── STT provider selector ────────────────────────────────────────────────
//
// Single seam the voice pipeline uses for speech-to-text. Fauna ships one
// engine — Parakeet (sherpa-onnx, in-process, cross-platform):
//
//   transcribe-parakeet.js  (sherpa-onnx NeMo transducer)
//
// The engine takes PCM16 mono in and returns `{ ok, text }`, so callers
// (dictation.js, utterance-pipeline.js) only need this module — they never
// import the concrete engine directly.
//
// The Parakeet engine (and its native binding) is imported LAZILY the first
// time a transcription is requested. That keeps startup cheap and means a
// platform where the optional binary is missing only fails when voice is
// actually used, not at launch.
//
// `isSttReady()` stays synchronous: Parakeet readiness is a pure fs check in
// parakeet-models.js and needs no native require.

import { resolveActiveModel as resolveParakeet } from './parakeet-models.js';
import { getSettings } from './settings.js';

export const STT_ENGINES = Object.freeze(['parakeet']);

let _parakeetMod = null;
async function _parakeet() {
  if (!_parakeetMod) _parakeetMod = await import('./transcribe-parakeet.js');
  return _parakeetMod;
}

/** Which engine is currently selected. Always Parakeet. */
export function activeEngine() {
  return 'parakeet';
}

/** True when a usable Parakeet model is installed. */
export function isSttReady() {
  return !!resolveParakeet(getSettings().parakeetModel);
}

/**
 * Transcribe a PCM16 mono buffer with Parakeet.
 * @see transcribe-parakeet.js for the opts contract.
 */
export async function transcribePcm(pcm, opts) {
  const mod = await _parakeet();
  return mod.transcribePcm(pcm, opts);
}

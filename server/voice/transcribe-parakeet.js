// ── PCM → Parakeet transcription (sherpa-onnx, cross-platform) ────────────
//
// Drop-in alternative to transcribe-pcm.js (Whisper). Same input contract —
// a raw PCM16 mono buffer plus opts.sampleRate — and the same result shape
// `{ ok, text?, error?, code? }` so stt-provider.js can route to either engine
// transparently.
//
// Unlike whisper.cpp (a bundled native CLI we spawn), sherpa-onnx runs
// in-process via its prebuilt Node binding (`sherpa-onnx-node`), which pulls
// the correct platform binary as an optional dependency:
//   macOS   → sherpa-onnx-darwin-arm64 / -x64
//   Windows → sherpa-onnx-win-x64
//   Linux   → sherpa-onnx-linux-x64
// The .onnx weights themselves are identical across all three, so this path
// gives fauna low-latency Parakeet dictation on Windows too.
//
// The native binding is imported LAZILY (only when this module's transcribePcm
// is first called) so that installs without a Parakeet model — or platforms
// where the optional binary is missing — never pay the load cost or crash at
// startup. Readiness (`isReady`) is a pure fs check with no native require.

import os from 'os';
import { createRequire } from 'module';

import {
  resolveActiveModel,
  modelPathsFor,
} from './parakeet-models.js';
import { getSettings } from './settings.js';

const _require = createRequire(import.meta.url);

// Cache: one recognizer per model alias. Recognizers are expensive to build
// (they load ~600 MB of ONNX weights) so we keep them warm for the session.
const _recognizers = new Map();
let _sherpa = null;

function _loadSherpa() {
  if (_sherpa) return _sherpa;
  _sherpa = _require('sherpa-onnx-node');
  return _sherpa;
}

function _getRecognizer(alias) {
  if (_recognizers.has(alias)) return _recognizers.get(alias);
  const sherpa = _loadSherpa();
  const paths = modelPathsFor(alias);
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: paths.encoder,
        decoder: paths.decoder,
        joiner:  paths.joiner,
      },
      tokens:     paths.tokens,
      // NeMo transducer decoding differs from the generic Kaldi transducer;
      // this flag is what makes Parakeet TDT decode correctly.
      modelType:  'nemo_transducer',
      numThreads: Math.max(1, Math.min(4, (os.cpus?.().length || 2) - 1)),
      provider:   'cpu',
      debug:      0,
    },
    decodingMethod: 'greedy_search',
  });
  _recognizers.set(alias, rec);
  return rec;
}

/** Ready when at least one Parakeet model is fully installed on disk. */
export function isReady() {
  return !!resolveActiveModel(getSettings().parakeetModel);
}

/** Drop already-built recognizers (e.g. after a model is (un)installed). */
export function reset() {
  _recognizers.clear();
}

// Int16 LE mono → Float32 [-1, 1], the format sherpa-onnx expects.
function _pcm16ToFloat32(pcm) {
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i++) {
    const s = view[i];
    out[i] = s < 0 ? s / 32768 : s / 32767;
  }
  return out;
}

/**
 * Transcribe a PCM16 mono buffer with Parakeet.
 *
 * @param {Buffer} pcm                 raw PCM16 mono, little-endian
 * @param {object} opts
 * @param {number} [opts.sampleRate]   sample rate of the PCM (default 16000)
 * @param {string} [opts.model]        force a specific Parakeet alias
 * @returns {Promise<{ok:boolean, text?:string, error?:string, code?:string}>}
 */
export async function transcribePcm(pcm, opts = {}) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
    return { ok: false, error: 'Empty PCM buffer' };
  }
  const alias = resolveActiveModel(opts.model || getSettings().parakeetModel);
  if (!alias) {
    return { ok: false, error: 'No Parakeet model installed', code: 'MODEL_MISSING' };
  }

  let rec;
  try {
    rec = _getRecognizer(alias);
  } catch (e) {
    // Most likely the optional platform binary isn't available here.
    return { ok: false, error: 'Parakeet engine unavailable: ' + e.message, code: 'ENGINE_MISSING' };
  }

  try {
    const samples = _pcm16ToFloat32(pcm);
    const sampleRate = opts.sampleRate || 16000;
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate, samples });
    // decodeAsync keeps the event loop free during the ONNX forward pass.
    const result = await rec.decodeAsync(stream);
    return { ok: true, text: (result?.text || '').trim() };
  } catch (e) {
    return { ok: false, error: 'Parakeet decode failed: ' + e.message, code: 'DECODE_FAIL' };
  }
}

// Kokoro TTS engine — high-quality, fully local, pure-Node neural TTS.
//
// Wraps `kokoro-js` (which uses 🤗 Transformers.js + onnxruntime-web) to run
// the 82M-parameter Kokoro model entirely in-process. No Python, no native
// binary, no separate runtime — works the same on macOS, Linux, and Windows.
//
// On first use the ONNX weights (~90 MB quantized) are downloaded by
// transformers.js into its HF cache (~/.cache/huggingface by default). We
// override that to live under ~/.fauna/kokoro/ so it's discoverable and
// removable alongside the rest of Fauna's state.
//
// Voice spec: `kokoro:<voice-id>` (e.g. `kokoro:af_bella`). Pass the bare
// string `"kokoro"` to use the default voice. Anything else is treated as
// an OS-native voice name and handled by the caller.

import fs from 'fs';
import os from 'os';
import path from 'path';

export const DEFAULT_KOKORO_VOICE = 'af_bella';
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// Point the transformers.js / HF cache at ~/.fauna/kokoro before the module
// loads. Setting all three covers the various env vars different versions
// of transformers.js / huggingface-hub respect.
const CACHE_DIR = path.join(os.homedir(), '.fauna', 'kokoro');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}
process.env.HF_HOME = process.env.HF_HOME || CACHE_DIR;
process.env.TRANSFORMERS_CACHE = process.env.TRANSFORMERS_CACHE || path.join(CACHE_DIR, 'hub');
process.env.HF_HUB_CACHE = process.env.HF_HUB_CACHE || path.join(CACHE_DIR, 'hub');

let _ttsPromise = null;

async function _getTTS({ onProgress } = {}) {
  if (_ttsPromise) return _ttsPromise;
  _ttsPromise = (async () => {
    const { KokoroTTS } = await import('kokoro-js');
    if (onProgress) onProgress({ phase: 'load-model', fraction: 0 });
    const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      // q8 = 8-bit quantization. ~90 MB, runs comfortably on CPU/WASM, with
      // negligible quality loss vs fp32 (per the model card).
      dtype: 'q8',
      // In Node, transformers.js loads onnxruntime-node and only accepts
      // "cpu" here. (The "wasm" / "webgpu" options are browser-only.)
      device: 'cpu',
      progress_callback: (p) => {
        if (!onProgress) return;
        const f = typeof p?.progress === 'number' ? p.progress / 100 : null;
        onProgress({ phase: 'load-model', fraction: f ?? 0, file: p?.file });
      },
    });
    if (onProgress) onProgress({ phase: 'load-model', fraction: 1 });
    return tts;
  })().catch((e) => { _ttsPromise = null; throw e; });
  return _ttsPromise;
}

/**
 * Synthesize narration with Kokoro.
 * @param {object} args
 * @param {string} args.text
 * @param {string} args.outWav      — destination .wav path
 * @param {string} [args.voice]     — e.g. "af_bella" (defaults to DEFAULT_KOKORO_VOICE)
 * @param {(p:{phase:string,fraction?:number})=>void} [args.onProgress]
 */
export async function synthesizeKokoro({ text, outWav, voice, onProgress }) {
  if (!text || !text.trim()) throw new Error('text is required');
  if (!outWav) throw new Error('outWav is required');
  const voiceId = voice || DEFAULT_KOKORO_VOICE;

  const tts = await _getTTS({ onProgress });
  if (onProgress) onProgress({ phase: 'synthesize', fraction: 0 });

  const audio = await tts.generate(text, { voice: voiceId });

  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  await audio.save(outWav);

  if (onProgress) onProgress({ phase: 'synthesize', fraction: 1 });
  return { wavFile: outWav, voice: voiceId };
}

/**
 * List available Kokoro voices (American/British, male/female).
 * Returns the static catalog from the model card so callers don't have to
 * load the model just to populate a dropdown.
 */
export function listKokoroVoices() {
  return [
    // American — female
    { id: 'af_heart',    label: 'Heart (US, female)',    quality: 'A'  },
    { id: 'af_bella',    label: 'Bella (US, female)',    quality: 'A-' },
    { id: 'af_nicole',   label: 'Nicole (US, female)',   quality: 'B-' },
    { id: 'af_aoede',    label: 'Aoede (US, female)',    quality: 'C+' },
    { id: 'af_kore',     label: 'Kore (US, female)',     quality: 'C+' },
    { id: 'af_sarah',    label: 'Sarah (US, female)',    quality: 'C+' },
    { id: 'af_nova',     label: 'Nova (US, female)',     quality: 'C'  },
    { id: 'af_alloy',    label: 'Alloy (US, female)',    quality: 'C'  },
    { id: 'af_jessica',  label: 'Jessica (US, female)',  quality: 'D'  },
    { id: 'af_river',    label: 'River (US, female)',    quality: 'D'  },
    { id: 'af_sky',      label: 'Sky (US, female)',      quality: 'C-' },
    // American — male
    { id: 'am_fenrir',   label: 'Fenrir (US, male)',     quality: 'C+' },
    { id: 'am_michael',  label: 'Michael (US, male)',    quality: 'C+' },
    { id: 'am_puck',     label: 'Puck (US, male)',       quality: 'C+' },
    { id: 'am_echo',     label: 'Echo (US, male)',       quality: 'D'  },
    { id: 'am_eric',     label: 'Eric (US, male)',       quality: 'D'  },
    { id: 'am_liam',     label: 'Liam (US, male)',       quality: 'D'  },
    { id: 'am_onyx',     label: 'Onyx (US, male)',       quality: 'D'  },
    { id: 'am_adam',     label: 'Adam (US, male)',       quality: 'F+' },
    { id: 'am_santa',    label: 'Santa (US, male)',      quality: 'D-' },
    // British — female
    { id: 'bf_emma',     label: 'Emma (UK, female)',     quality: 'B-' },
    { id: 'bf_isabella', label: 'Isabella (UK, female)', quality: 'C'  },
    { id: 'bf_alice',    label: 'Alice (UK, female)',    quality: 'D'  },
    { id: 'bf_lily',     label: 'Lily (UK, female)',     quality: 'D'  },
    // British — male
    { id: 'bm_fable',    label: 'Fable (UK, male)',      quality: 'C'  },
    { id: 'bm_george',   label: 'George (UK, male)',     quality: 'C'  },
    { id: 'bm_lewis',    label: 'Lewis (UK, male)',      quality: 'D+' },
    { id: 'bm_daniel',   label: 'Daniel (UK, male)',     quality: 'D'  },
  ];
}

/** Parse a voice string like "kokoro:af_bella" → { engine, voiceId }. */
export function parseVoiceSpec(voice) {
  const s = String(voice || '').trim();
  if (!s) return { engine: 'native', voiceId: null };
  const lower = s.toLowerCase();
  if (lower.startsWith('kokoro:')) {
    return { engine: 'kokoro', voiceId: s.slice('kokoro:'.length) || DEFAULT_KOKORO_VOICE };
  }
  if (lower === 'kokoro') {
    return { engine: 'kokoro', voiceId: DEFAULT_KOKORO_VOICE };
  }
  return { engine: 'native', voiceId: s };
}

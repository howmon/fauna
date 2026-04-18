// ── Whisper Transcription Worker ───────────────────────────────────────────
// Uses @xenova/transformers (Whisper Tiny English) served from /transformers/.
// Loaded with: new Worker('/js/whisper-worker.js', { type: 'module' })
// Expects Float32Array at 16 kHz.  First use downloads ~40 MB model from
// HuggingFace Hub; subsequent runs use the cached copy from IndexedDB.

import { pipeline, env } from '/transformers/transformers.min.js';

// Point ONNX WASM binaries to our local server route
env.backends.onnx.wasm.wasmPaths = '/transformers/';
env.allowLocalModels = false;

let transcriber = null;

async function init() {
  self.postMessage({ type: 'status', msg: 'Downloading voice model (first run only)…' });
  try {
    transcriber = await pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-tiny.en'
    );
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', error: 'Failed to load voice model: ' + err.message });
  }
}

self.onmessage = async function(e) {
  const { type, audio } = e.data;
  if (type === 'transcribe') {
    if (!transcriber) {
      self.postMessage({ type: 'error', error: 'Model not ready' });
      return;
    }
    try {
      const result = await transcriber(audio, {
        language: 'english',
        task: 'transcribe',
        sampling_rate: 16000,
      });
      self.postMessage({ type: 'result', text: (result.text || '').trim() });
    } catch (err) {
      self.postMessage({ type: 'error', error: err.message });
    }
  }
};

init();

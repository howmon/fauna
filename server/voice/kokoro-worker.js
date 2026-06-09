// ── Kokoro synthesis worker ──────────────────────────────────────────────
//
// Runs Kokoro's ONNX inference on a dedicated worker thread so the heavy,
// fully-synchronous CPU work never blocks the Electron main-process event
// loop. Without this the UI freezes for the whole duration of each
// synthesis (you can't switch conversations, move the window, etc.).
//
// The Kokoro model (~82M params) is loaded lazily on the first request and
// kept resident in this worker for the lifetime of the process, so repeated
// utterances don't pay the model-load cost again.
//
// Protocol (parentPort messages):
//   in : { id, text, outWav, voice }
//   out: { id, ok: true,  voice }            on success (WAV written to outWav)
//        { id, ok: false, error }            on failure

import { parentPort } from 'worker_threads';
import { synthesizeKokoro } from '../video/kokoro.js';

if (!parentPort) {
  throw new Error('kokoro-worker must be run as a worker thread');
}

// Synthesis is inherently sequential (one model, one inference at a time).
// Serialize incoming requests so a burst of messages can't interleave
// generate() calls on the shared model.
let _chain = Promise.resolve();

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { id, text, outWav, voice } = msg;

  _chain = _chain.then(async () => {
    try {
      const res = await synthesizeKokoro({ text, outWav, voice });
      parentPort.postMessage({ id, ok: true, voice: res?.voice || voice || null });
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
    }
  });
});

// Local "mini" LLM — a tiny instruct model run fully in-process for cheap,
// latency-tolerant tasks (recommended-action suggestions, titles, short
// summaries, classification, context packing). No API key, no network at
// inference time, no separate runtime/sidecar.
//
// This mirrors kokoro.js exactly: it wraps `@huggingface/transformers`
// (transformers.js + onnxruntime-node) to run the model in-process, and points
// the HF/transformers cache at ~/.fauna/local-mini so the quantized weights are
// downloaded once (lazily, on first use) and live alongside the rest of Fauna's
// state — discoverable and removable, never packed into app.asar.
//
// Default model: Qwen2.5-1.5B-Instruct (ONNX q4, ~1 GB) — strong instruction
// following with reliable JSON output and ~1.3s warm latency on Apple Silicon
// CPU, which is the right balance for the short-output tasks above. Override
// with the env var FAUNA_LOCAL_MINI_MODEL (e.g. onnx-community/Qwen2.5-0.5B-
// Instruct for a smaller/faster but weaker model, or a 3B for more quality).

import fs from 'fs';
import os from 'os';
import path from 'path';

// Default to a small, fast, transformers.js-compatible instruct model. The
// onnx-community conversions ship the ONNX graph + tokenizer transformers.js
// needs (the official microsoft/*-onnx repos target onnxruntime-genai instead).
export const DEFAULT_MINI_MODEL = 'onnx-community/Qwen2.5-1.5B-Instruct';
const MODEL_ID = (process.env.FAUNA_LOCAL_MINI_MODEL || DEFAULT_MINI_MODEL).trim();

// q4 = 4-bit weight quantization: smallest/fastest on CPU with minimal quality
// loss for these tasks. Override with FAUNA_LOCAL_MINI_DTYPE if a given model
// only ships a different quant (e.g. q4f16, int8, fp16).
const MODEL_DTYPE = (process.env.FAUNA_LOCAL_MINI_DTYPE || 'q4').trim();

// IMPORTANT — opt-in by default.
//
// The server (and therefore this module) runs in the Electron MAIN process, and
// onnxruntime-node creates the inference session synchronously on the calling
// thread. If that native load fails (e.g. OOM while allocating the model's
// initialized tensors) it raises a SIGTRAP that JavaScript try/catch CANNOT
// intercept — it crashes the entire app. We observed exactly this with the
// ~1GB Qwen2.5-1.5B q4 model (CPUAllocator::Alloc -> _posix_memalign -> trap).
//
// Until the model is isolated in a separate child/utility process, loading it
// in-process is unsafe to do automatically. So it is DISABLED unless the user
// explicitly opts in via FAUNA_ENABLE_LOCAL_MINI=1. FAUNA_DISABLE_LOCAL_MINI=1
// remains a hard kill switch that wins over everything.
export function isLocalMiniEnabled() {
  if (process.env.FAUNA_DISABLE_LOCAL_MINI === '1') return false;
  return process.env.FAUNA_ENABLE_LOCAL_MINI === '1';
}

// Point the transformers.js / HF cache at ~/.fauna/local-mini BEFORE the module
// loads. Setting all three covers the various env vars different versions of
// transformers.js / huggingface-hub respect. (Same approach as kokoro.js.)
const CACHE_DIR = path.join(os.homedir(), '.fauna', 'local-mini');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}
process.env.HF_HOME = process.env.HF_HOME || CACHE_DIR;
process.env.TRANSFORMERS_CACHE = process.env.TRANSFORMERS_CACHE || path.join(CACHE_DIR, 'hub');
process.env.HF_HUB_CACHE = process.env.HF_HUB_CACHE || path.join(CACHE_DIR, 'hub');

let _pipePromise = null;
// Serialize generations: a single ONNX model instance isn't meant to run two
// decode loops concurrently. Tasks here are background/async, so a small queue
// is fine and avoids races / doubled memory pressure.
let _genChain = Promise.resolve();

async function _getPipeline({ onProgress } = {}) {
  // Hard guard: never load the native model unless explicitly opted in. A
  // failed load crashes the whole app (see isLocalMiniEnabled note above).
  if (!isLocalMiniEnabled()) {
    throw new Error('local-mini disabled (set FAUNA_ENABLE_LOCAL_MINI=1 to enable)');
  }
  if (_pipePromise) return _pipePromise;
  _pipePromise = (async () => {
    // Force transformers.js to use a writable cache OUTSIDE the Electron
    // app.asar bundle (its Node default is `<package_dir>/.cache/...`, which
    // gets packed into asar and then onnxruntime fails with ENOTDIR). Same
    // belt-and-braces fix kokoro.js applies.
    const transformers = await import('@huggingface/transformers');
    if (transformers?.env) {
      transformers.env.cacheDir = path.join(CACHE_DIR, 'hub');
      transformers.env.allowLocalModels = false;
    }
    const { pipeline } = transformers;
    if (onProgress) onProgress({ phase: 'load-model', fraction: 0 });
    const generator = await pipeline('text-generation', MODEL_ID, {
      dtype: MODEL_DTYPE,
      // In Node, transformers.js loads onnxruntime-node and only accepts "cpu".
      device: 'cpu',
      progress_callback: (p) => {
        if (!onProgress) return;
        const f = typeof p?.progress === 'number' ? p.progress / 100 : null;
        onProgress({ phase: 'load-model', fraction: f ?? 0, file: p?.file });
      },
    });
    if (onProgress) onProgress({ phase: 'load-model', fraction: 1 });
    return generator;
  })().catch((e) => { _pipePromise = null; throw e; });
  return _pipePromise;
}

/**
 * Has the local model already been downloaded/cached? Lets callers decide
 * whether to use it inline (fast, warm) or to skip/preload in the background
 * so the very first request doesn't pay the multi-hundred-MB download cost.
 * @returns {boolean}
 */
export function isModelCached() {
  try {
    const hub = path.join(CACHE_DIR, 'hub');
    if (!fs.existsSync(hub)) return false;
    // transformers.js stores under hub/models--<org>--<name>/. Look for any
    // *.onnx weight file to confirm a usable snapshot exists.
    const stack = [hub];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else if (ent.name.endsWith('.onnx')) return true;
      }
    }
    return false;
  } catch (_) { return false; }
}

/** The resolved model id this module will load. */
export function getMiniModelId() { return MODEL_ID; }

/**
 * Kick off model download/load in the background (fire-and-forget). Safe to
 * call repeatedly — the underlying promise is memoized. Returns the load
 * promise so callers can await it if they want.
 * @param {(p:{phase:string,fraction?:number,file?:string})=>void} [onProgress]
 */
export function warmupMini(onProgress) {
  // No-op when disabled — don't even attempt to touch onnxruntime.
  if (!isLocalMiniEnabled()) return Promise.resolve(null);
  return _getPipeline({ onProgress });
}

/**
 * Generate a completion from the local mini model using chat messages.
 * transformers.js applies the model's chat template automatically.
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=128]    — max new tokens to generate
 * @param {number} [opts.temperature=0.4]  — sampling temperature (0 => greedy)
 * @param {(p:{phase:string,fraction?:number})=>void} [opts.onProgress]
 * @returns {Promise<string>} the assistant's reply text
 */
export async function generateMini(messages, opts = {}) {
  if (!isLocalMiniEnabled()) {
    throw new Error('local-mini disabled (set FAUNA_ENABLE_LOCAL_MINI=1 to enable)');
  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('generateMini requires a non-empty messages array');
  }
  const maxTokens   = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 128;
  const temperature = Number.isFinite(opts.temperature) ? opts.temperature : 0.4;

  const generator = await _getPipeline({ onProgress: opts.onProgress });

  // Chain onto the previous generation so only one decode runs at a time.
  const run = _genChain.then(async () => {
    const genArgs = {
      max_new_tokens: maxTokens,
      return_full_text: false,
      do_sample: temperature > 0,
    };
    if (temperature > 0) genArgs.temperature = temperature;
    const output = await generator(messages, genArgs);
    return _extractText(output);
  });
  // Keep the chain alive even if this run rejects.
  _genChain = run.catch(() => {});
  return run;
}

// transformers.js text-generation returns different shapes depending on input.
// With chat messages + return_full_text:false the last assistant turn lands in
// output[0].generated_text — which may be a plain string OR the full message
// array (older/newer versions differ). Normalize to the assistant's text.
function _extractText(output) {
  const first = Array.isArray(output) ? output[0] : output;
  if (!first) return '';
  let gen = first.generated_text != null ? first.generated_text : first;
  if (typeof gen === 'string') return gen.trim();
  if (Array.isArray(gen)) {
    // Find the last assistant message; fall back to the last entry.
    for (let i = gen.length - 1; i >= 0; i--) {
      const m = gen[i];
      if (m && m.role === 'assistant' && typeof m.content === 'string') return m.content.trim();
    }
    const last = gen[gen.length - 1];
    if (last && typeof last.content === 'string') return last.content.trim();
  }
  return '';
}

/**
 * Best-effort local generation for cheap, latency-tolerant tasks. NEVER throws
 * and NEVER blocks on a model download: if the weights aren't cached yet it
 * kicks off a background warmup and returns null so the caller can fall back to
 * a remote model for this request. Returns null on any error or empty output.
 *
 * This is the helper the rest of the app should use to make a task "local-first
 * with remote fallback" — e.g. titles, memory-fact extraction, suggestions.
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} [opts]  same shape as generateMini's opts
 * @returns {Promise<string|null>}
 */
export async function tryMini(messages, opts = {}) {
  if (!isLocalMiniEnabled()) return null;
  if (!Array.isArray(messages) || !messages.length) return null;
  if (!isModelCached()) {
    // Warm the cache in the background for next time; don't block this request.
    warmupMini().catch(() => {});
    return null;
  }
  try {
    const out = await generateMini(messages, opts);
    const text = (out || '').trim();
    return text || null;
  } catch (e) {
    console.error('[local-mini] tryMini error:', e.message);
    return null;
  }
}


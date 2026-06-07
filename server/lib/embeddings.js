// ── Embeddings — content-addressed vector cache + provider adapter ──────────
//
// Phase 2 of the supermemory-inspired roadmap. Centralizes:
//   1. A SHA256-keyed on-disk cache so we never re-embed the same text twice
//      (embedding calls cost both latency and tokens).
//   2. A thin provider adapter that defaults to the Copilot embeddings
//      endpoint but accepts an injected embedder for tests and alternative
//      providers (Ollama, OpenAI-compat, etc).
//   3. Cosine similarity utilities consumed by memory-store's hybrid recall.
//
// The cache is intentionally separate from facts.json so it can be wiped or
// re-built without touching user-visible facts. File: ~/.config/fauna/
//   embeddings-cache.json   { model -> { sha256(text) -> [floats] } }
//
// Vectors are stored as plain JSON arrays for simplicity. With the default
// text-embedding-3-small (1536 dims) and ~200 facts the file stays well
// under 5 MB.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { quantize, isQuantized, prepareQuery as _qPrepare, quantizedCosine } from './quantize.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const CACHE_FILE = path.join(CONFIG_DIR, 'embeddings-cache.json');

export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

let _cache = null; // { [model]: { [sha]: number[] } }

function _load() {
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    _cache = (raw && typeof raw === 'object') ? raw : {};
  } catch (_) {
    _cache = {};
  }
  return _cache;
}

function _save() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache));
  } catch (e) {
    // Cache writes are best-effort — don't crash callers if disk is full.
    console.warn('[embeddings] cache write failed:', e.message);
  }
}

function _sha256(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

/**
 * Cosine similarity between two equal-length numeric vectors.
 * Returns 0 for mismatched/empty inputs so callers can skip safely.
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Quantized storage (TurboQuant-style, opt-in) ────────────────────────────
//
// When FAUNA_QUANTIZE_EMBEDDINGS=1, stored embeddings are kept as compact
// quantized records (~8x smaller at 4-bit) instead of fp32 arrays. The scoring
// path below transparently handles BOTH shapes, so existing fp32 facts keep
// working and quantized facts are scored via the rotated-query estimator.

/** Whether new embeddings should be stored quantized. */
export function quantizeEnabled() {
  return process.env.FAUNA_QUANTIZE_EMBEDDINGS === '1';
}

/** Bit-width for quantized storage (2 or 4; default 4). */
function _quantBits() {
  return process.env.FAUNA_QUANTIZE_BITS === '2' ? 2 : 4;
}

/**
 * Quantize a float vector into a compact storage record.
 * @param {number[]} vec
 * @param {object} [opts] {bits}
 */
export function quantizeEmbedding(vec, opts = {}) {
  return quantize(vec, { bits: opts.bits || _quantBits() });
}

/**
 * Normalize a freshly-produced embedding for storage: returns a quantized
 * record when quantization is enabled, otherwise the original float array.
 * @param {number[]} vec
 * @returns {number[]|object}
 */
export function prepareForStorage(vec) {
  if (!Array.isArray(vec) || !vec.length) return vec;
  return quantizeEnabled() ? quantizeEmbedding(vec) : vec;
}

/**
 * Prepare a query vector for scoring against a mix of fp32 and quantized
 * stored embeddings. Rotate once, reuse across the whole candidate loop.
 * @param {number[]} vec
 * @returns {{raw:number[], q:{rot:Float64Array, norm:number}}|null}
 */
export function prepareQuery(vec) {
  if (!Array.isArray(vec) || !vec.length) return null;
  return { raw: vec, q: _qPrepare(vec) };
}

/**
 * Score a prepared query against one stored embedding (fp32 array OR quantized
 * record). Returns cosine similarity (clamped ≥ 0 is the caller's choice).
 * @param {{raw:number[], q:object}|null} prepared  from prepareQuery()
 * @param {number[]|object} stored
 * @returns {number}
 */
export function scoreStored(prepared, stored) {
  if (!prepared || stored == null) return 0;
  if (isQuantized(stored)) return quantizedCosine(prepared.q, stored);
  if (Array.isArray(stored)) return cosine(prepared.raw, stored);
  return 0;
}

/** True if a stored embedding value is present (fp32 array or quantized). */
export function hasEmbedding(stored) {
  return Array.isArray(stored) ? stored.length > 0 : isQuantized(stored);
}

/**
 * Default embedder backed by the Copilot embeddings endpoint.
 * Lazy-loads to keep tests / non-server contexts from pulling in auth code.
 */
let _defaultEmbedder = null;
async function _getDefaultEmbedder() {
  if (_defaultEmbedder) return _defaultEmbedder;
  const { getCopilotClient } = await import('../copilot/auth.js');
  _defaultEmbedder = async (texts, model = DEFAULT_EMBED_MODEL) => {
    const client = getCopilotClient();
    const r = await client.embeddings.create({ model, input: texts });
    return r.data.map(d => d.embedding);
  };
  return _defaultEmbedder;
}

/**
 * Embed an array of texts, using the cache to skip already-seen entries.
 * Returns vectors in the SAME ORDER as the input.
 *
 * @param {string[]} texts
 * @param {object}   [opts]
 * @param {string}   [opts.model=DEFAULT_EMBED_MODEL]
 * @param {(texts:string[], model:string) => Promise<number[][]>} [opts.embedder]
 *        Override for tests or alternative providers. Receives only the
 *        cache-miss subset.
 * @param {boolean}  [opts.persist=true] write updated cache to disk
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts, opts = {}) {
  if (!Array.isArray(texts) || !texts.length) return [];
  const model = opts.model || DEFAULT_EMBED_MODEL;
  const cache = _load();
  const bucket = cache[model] || (cache[model] = {});

  const out = new Array(texts.length);
  const missingIdx = [];
  const missingTexts = [];
  const missingShas = [];
  for (let i = 0; i < texts.length; i++) {
    const sha = _sha256(texts[i]);
    if (bucket[sha]) {
      out[i] = bucket[sha];
    } else {
      missingIdx.push(i);
      missingTexts.push(texts[i]);
      missingShas.push(sha);
    }
  }

  if (missingTexts.length) {
    const embedder = opts.embedder || await _getDefaultEmbedder();
    const vectors = await embedder(missingTexts, model);
    if (!Array.isArray(vectors) || vectors.length !== missingTexts.length) {
      throw new Error(`embedder returned ${Array.isArray(vectors) ? vectors.length : typeof vectors} vectors, expected ${missingTexts.length}`);
    }
    for (let k = 0; k < missingIdx.length; k++) {
      bucket[missingShas[k]] = vectors[k];
      out[missingIdx[k]] = vectors[k];
    }
    if (opts.persist !== false) _save();
  }

  return out;
}

/**
 * Convenience: embed a single string. Same caching rules.
 * @returns {Promise<number[]>}
 */
export async function embedText(text, opts = {}) {
  const [v] = await embedTexts([text], opts);
  return v || [];
}

/**
 * Stats for diagnostics / debugging UI.
 */
export function getCacheStats() {
  const c = _load();
  const byModel = {};
  let total = 0;
  for (const [m, bucket] of Object.entries(c)) {
    const n = Object.keys(bucket).length;
    byModel[m] = n;
    total += n;
  }
  return { total, byModel, file: CACHE_FILE };
}

/** Clear the on-disk cache. Returns count of removed entries. */
export function clearCache() {
  const before = getCacheStats().total;
  _cache = {};
  try { fs.unlinkSync(CACHE_FILE); } catch (_) { /* ignore */ }
  return { removed: before };
}

// Test hook — drop in-memory cache without touching disk.
export function _resetCache() {
  _cache = null;
  _defaultEmbedder = null;
}

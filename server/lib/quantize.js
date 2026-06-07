// ── TurboQuant-style scalar quantization (pure JS, zero deps) ───────────────
//
// A portable reimplementation of the ideas behind Google Research's TurboQuant
// (arXiv:2504.19874) and the RaBitQ length-renormalization correction
// (arXiv:2405.12497), adapted for Fauna's Node/Electron runtime where native
// crates (turbovec, FAISS) are not an option.
//
// The pipeline is data-oblivious — no codebook training, no separate train
// phase, no rebuilds as the corpus grows:
//
//   1. Normalize       — strip the L2 norm; keep the unit direction.
//   2. Random rotation — a fixed, shared randomized Hadamard transform. After
//                        it every coordinate is ~N(0, 1/D), regardless of the
//                        input distribution.
//   3. Standardize     — scale coords to ~N(0,1) so a single Gaussian
//                        Lloyd-Max codebook quantizes every dimension.
//   4. Lloyd-Max       — optimal scalar buckets for a standard normal,
//                        computed once from the math (not the data).
//   5. Bit-pack        — 2-bit (4 levels) or 4-bit (16 levels) nibbles packed
//                        tightly into bytes → ~16x / ~8x smaller than fp32.
//   6. Length-renorm   — store one scalar per vector so the quantized
//                        inner-product estimator is unbiased (self-cosine = 1).
//
// Scoring rotates the query once into the same domain and dots directly
// against the codebook values — no per-vector decompression.

const DEFAULT_BITS = 4;

// Fixed seeds so EVERY vector shares the SAME rotation (required for inner
// products to survive). Two sign-flip rounds Gaussianize better than one.
const SEED_A = 0x9e3779b1;
const SEED_B = 0x85ebca77;

// ── Math helpers ────────────────────────────────────────────────────────────

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Standard normal pdf / cdf (cdf via Abramowitz-Stegun 7.1.26 erf).
const SQRT2PI = Math.sqrt(2 * Math.PI);
function _pdf(x) { return Math.exp(-0.5 * x * x) / SQRT2PI; }
function _erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function _cdf(x) { return 0.5 * (1 + _erf(x / Math.SQRT2)); }

// Deterministic PRNG (mulberry32) so rotations are reproducible across runs.
function _mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Lloyd-Max codebook for a standard Gaussian ──────────────────────────────
// Exact conditional-mean iteration: for interval (a,b),
//   E[X | a<X<b] = (phi(a) - phi(b)) / (Phi(b) - Phi(a)).
// Converges in a few dozen iterations. Cached per bit-width.

const _levelCache = new Map();
function getLevels(bits) {
  if (_levelCache.has(bits)) return _levelCache.get(bits);
  const n = 1 << bits;
  // Initialize centroids spread over a sensible Gaussian range.
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = -3 + (6 * (i + 0.5)) / n;
  const thr = new Float64Array(n - 1);
  for (let iter = 0; iter < 100; iter++) {
    for (let i = 0; i < n - 1; i++) thr[i] = 0.5 * (c[i] + c[i + 1]);
    let maxShift = 0;
    for (let i = 0; i < n; i++) {
      const a = i === 0 ? -Infinity : thr[i - 1];
      const b = i === n - 1 ? Infinity : thr[i];
      const pa = a === -Infinity ? 0 : _pdf(a);
      const pb = b === Infinity ? 0 : _pdf(b);
      const ca = a === -Infinity ? 0 : _cdf(a);
      const cb = b === Infinity ? 1 : _cdf(b);
      const mass = cb - ca;
      const nc = mass > 1e-12 ? (pa - pb) / mass : c[i];
      maxShift = Math.max(maxShift, Math.abs(nc - c[i]));
      c[i] = nc;
    }
    if (maxShift < 1e-10) break;
  }
  const levels = { bits, n, centroids: c, thresholds: thr };
  _levelCache.set(bits, levels);
  return levels;
}

function _bucketOf(levels, x) {
  // Binary search over thresholds → bucket index.
  const thr = levels.thresholds;
  let lo = 0, hi = thr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < thr[mid]) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// ── Randomized Hadamard rotation (orthonormal, O(D log D)) ───────────────────

const _signCache = new Map();
function _signs(D, seed) {
  const key = D + ':' + seed;
  let s = _signCache.get(key);
  if (s) return s;
  const rnd = _mulberry32(seed ^ D);
  s = new Int8Array(D);
  for (let i = 0; i < D; i++) s[i] = rnd() < 0.5 ? -1 : 1;
  _signCache.set(key, s);
  return s;
}

// In-place Fast Walsh-Hadamard Transform (length must be a power of two).
function _fwht(a) {
  const n = a.length;
  for (let len = 1; len < n; len <<= 1) {
    for (let i = 0; i < n; i += len << 1) {
      for (let j = i; j < i + len; j++) {
        const x = a[j], y = a[j + len];
        a[j] = x + y;
        a[j + len] = x - y;
      }
    }
  }
}

// One orthonormal round: sign-flip then Hadamard normalized by 1/sqrt(D).
function _round(a, seed) {
  const D = a.length;
  const s = _signs(D, seed);
  for (let i = 0; i < D; i++) a[i] *= s[i];
  _fwht(a);
  const inv = 1 / Math.sqrt(D);
  for (let i = 0; i < D; i++) a[i] *= inv;
}

/**
 * Rotate a vector into the quantization domain. Pads to the next power of two,
 * then applies two orthonormal randomized-Hadamard rounds. Norm-preserving.
 * @param {ArrayLike<number>} vec
 * @returns {Float64Array} length nextPow2(vec.length)
 */
export function rotate(vec) {
  const d = vec.length;
  const D = nextPow2(d);
  const a = new Float64Array(D);
  for (let i = 0; i < d; i++) a[i] = vec[i];
  _round(a, SEED_A);
  _round(a, SEED_B);
  return a;
}

function _l2(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  return Math.sqrt(s);
}

// ── Bit-packing ─────────────────────────────────────────────────────────────

function _pack(indices, bits) {
  const D = indices.length;
  const bytes = new Uint8Array(Math.ceil((D * bits) / 8));
  let bitPos = 0;
  for (let i = 0; i < D; i++) {
    const v = indices[i] & ((1 << bits) - 1);
    const byte = bitPos >> 3;
    const off = bitPos & 7;
    bytes[byte] |= (v << off) & 0xff;
    if (off + bits > 8) bytes[byte + 1] |= v >> (8 - off);
    bitPos += bits;
  }
  return bytes;
}

function _unpack(bytes, D, bits) {
  const out = new Uint8Array(D);
  const mask = (1 << bits) - 1;
  let bitPos = 0;
  for (let i = 0; i < D; i++) {
    const byte = bitPos >> 3;
    const off = bitPos & 7;
    let v = bytes[byte] >> off;
    if (off + bits > 8) v |= bytes[byte + 1] << (8 - off);
    out[i] = v & mask;
    bitPos += bits;
  }
  return out;
}

function _toB64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function _fromB64(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Quantize a float embedding into a compact record.
 * @param {ArrayLike<number>} vec
 * @param {object} [opts]
 * @param {number} [opts.bits=4]  2 or 4
 * @returns {{q:string, bits:number, dim:number, scale:number, norm:number}}
 *          A self-describing record; `q` is base64 packed indices.
 */
export function quantize(vec, opts = {}) {
  const bits = opts.bits === 2 ? 2 : DEFAULT_BITS;
  const d = vec.length;
  const norm = _l2(vec);
  const D = nextPow2(d);
  if (norm === 0) {
    return { q: _toB64(_pack(new Uint8Array(D), bits)), bits, dim: d, scale: 0, norm: 0 };
  }
  // Unit direction, rotated, then standardized to ~N(0,1).
  const u = new Float64Array(d);
  for (let i = 0; i < d; i++) u[i] = vec[i] / norm;
  const rot = rotate(u);               // ||rot|| ~ 1
  const levels = getLevels(bits);
  const sqrtD = Math.sqrt(D);
  const idx = new Uint8Array(D);
  let dotSS = 0;                        // <s, s_hat>
  for (let i = 0; i < D; i++) {
    const s = rot[i] * sqrtD;           // standardized coord
    const k = _bucketOf(levels, s);
    idx[i] = k;
    dotSS += s * levels.centroids[k];
  }
  // Length-renormalization: makes the inner-product estimator unbiased so a
  // vector scored against itself returns exactly 1.
  const scale = dotSS > 1e-9 ? sqrtD / dotSS : 0;
  return { q: _toB64(_pack(idx, bits)), bits, dim: d, scale, norm };
}

/** Is this stored value a quantized record (vs a plain float array)? */
export function isQuantized(rec) {
  return !!rec && typeof rec === 'object' && !Array.isArray(rec) &&
    typeof rec.q === 'string' && typeof rec.bits === 'number';
}

/**
 * Prepare a query vector for scoring against quantized records: rotate once
 * and capture its norm. Reuse across many `quantizedCosine` calls.
 * @param {ArrayLike<number>} vec
 * @returns {{rot:Float64Array, norm:number}}
 */
export function prepareQuery(vec) {
  return { rot: rotate(vec), norm: _l2(vec) };
}

/**
 * Estimated cosine similarity between a prepared query and a quantized record.
 * @param {{rot:Float64Array, norm:number}} prepared  from prepareQuery()
 * @param {{q:string, bits:number, dim:number, scale:number}} rec
 * @returns {number} in [-1, 1]
 */
export function quantizedCosine(prepared, rec) {
  if (!prepared || !rec || !rec.scale || !prepared.norm) return 0;
  const D = nextPow2(rec.dim);
  const levels = getLevels(rec.bits);
  const centroids = levels.centroids;
  const idx = _unpack(_fromB64(rec.q), D, rec.bits);
  const rot = prepared.rot;
  let dot = 0;
  const lim = Math.min(D, rot.length);
  for (let i = 0; i < lim; i++) dot += rot[i] * centroids[idx[i]];
  let est = (dot * rec.scale) / prepared.norm;
  if (est > 1) est = 1; else if (est < -1) est = -1;
  return est;
}

// Test/diagnostic hooks.
export const _internal = { getLevels, rotate, nextPow2, _pack, _unpack, _l2 };

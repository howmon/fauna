import { describe, it, expect, afterEach } from 'vitest';
import {
  quantize, quantizedCosine, prepareQuery, isQuantized, rotate, _internal,
} from '../server/lib/quantize.js';
import {
  prepareForStorage, scoreStored, prepareQuery as embPrepareQuery,
  hasEmbedding, quantizeEmbedding, cosine,
} from '../server/lib/embeddings.js';

function seededVec(d, seed) {
  // Deterministic pseudo-random vector.
  let s = seed >>> 0;
  const v = new Array(d);
  for (let i = 0; i < d; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    v[i] = (s / 4294967296) * 2 - 1;
  }
  return v;
}
function cosFull(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / Math.sqrt(na * nb);
}

describe('quantize: Lloyd-Max codebook', () => {
  it('produces symmetric, monotonically increasing centroids', () => {
    for (const bits of [2, 4]) {
      const { centroids, n } = _internal.getLevels(bits);
      expect(centroids.length).toBe(1 << bits);
      for (let i = 1; i < n; i++) expect(centroids[i]).toBeGreaterThan(centroids[i - 1]);
      // symmetric about zero
      for (let i = 0; i < n / 2; i++) {
        expect(centroids[i]).toBeCloseTo(-centroids[n - 1 - i], 3);
      }
    }
  });

  it('2-bit centroids match the known Gaussian Lloyd-Max values', () => {
    const { centroids } = _internal.getLevels(2);
    // Max (1960): ±0.4528, ±1.5104
    expect(centroids[1]).toBeCloseTo(-0.4528, 2);
    expect(centroids[2]).toBeCloseTo(0.4528, 2);
    expect(centroids[3]).toBeCloseTo(1.5104, 2);
  });
});

describe('quantize: rotation', () => {
  it('is norm-preserving (orthonormal)', () => {
    const v = seededVec(1536, 7);
    const r = rotate(v);
    const nv = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const nr = Math.sqrt(r.reduce((s, x) => s + x * x, 0));
    expect(nr).toBeCloseTo(nv, 6);
  });

  it('pads to the next power of two', () => {
    expect(_internal.nextPow2(1536)).toBe(2048);
    expect(rotate(seededVec(1536, 1)).length).toBe(2048);
    expect(rotate(seededVec(768, 1)).length).toBe(1024);
  });
});

describe('quantize: pack/unpack round-trip', () => {
  it('round-trips 4-bit indices', () => {
    const idx = new Uint8Array([0, 15, 7, 8, 1, 14, 3, 12]);
    const packed = _internal._pack(idx, 4);
    const out = _internal._unpack(packed, idx.length, 4);
    expect(Array.from(out)).toEqual(Array.from(idx));
  });
  it('round-trips 2-bit indices', () => {
    const idx = new Uint8Array([0, 3, 1, 2, 3, 0, 2, 1, 3]);
    const packed = _internal._pack(idx, 2);
    const out = _internal._unpack(packed, idx.length, 2);
    expect(Array.from(out)).toEqual(Array.from(idx));
  });
});

describe('quantize: self-cosine (length renormalization)', () => {
  it('scores a vector against itself at ~1.0 (4-bit)', () => {
    const v = seededVec(1536, 42);
    const rec = quantize(v, { bits: 4 });
    expect(quantizedCosine(prepareQuery(v), rec)).toBeCloseTo(1, 2);
  });
  it('scores a vector against itself at ~1.0 (2-bit)', () => {
    const v = seededVec(1536, 99);
    const rec = quantize(v, { bits: 2 });
    expect(quantizedCosine(prepareQuery(v), rec)).toBeCloseTo(1, 2);
  });
  it('handles a zero vector without throwing', () => {
    const rec = quantize(new Array(256).fill(0), { bits: 4 });
    expect(rec.scale).toBe(0);
    expect(quantizedCosine(prepareQuery(new Array(256).fill(0)), rec)).toBe(0);
  });
});

describe('quantize: similarity approximation', () => {
  it('estimates cosine within a small error and preserves ranking', () => {
    const d = 1536;
    const base = seededVec(d, 1);
    const pq = prepareQuery(base);
    let maxErr = 0;
    const N = 60;
    const trueC = [], estC = [];
    for (let i = 0; i < N; i++) {
      const x = seededVec(d, 1000 + i);
      const rec = quantize(x, { bits: 4 });
      const t = cosFull(base, x);
      const e = quantizedCosine(pq, rec);
      trueC.push([t, i]); estC.push([e, i]);
      maxErr = Math.max(maxErr, Math.abs(t - e));
    }
    expect(maxErr).toBeLessThan(0.05);
    // top-10 overlap on random vectors (hardest case) should be strong
    const topT = new Set(trueC.slice().sort((a, b) => b[0] - a[0]).slice(0, 10).map(x => x[1]));
    const topE = estC.slice().sort((a, b) => b[0] - a[0]).slice(0, 10).map(x => x[1]);
    const overlap = topE.filter(i => topT.has(i)).length;
    expect(overlap).toBeGreaterThanOrEqual(7);
  });

  it('packs 4-bit far smaller than fp32', () => {
    const rec = quantize(seededVec(1536, 5), { bits: 4 });
    const bytes = Buffer.from(rec.q, 'base64').length;
    expect(bytes).toBeLessThan(1536 * 4 / 4); // < 1/4 of raw fp32
  });
});

describe('quantize: isQuantized', () => {
  it('distinguishes records from plain arrays', () => {
    expect(isQuantized(quantize(seededVec(64, 3), { bits: 4 }))).toBe(true);
    expect(isQuantized([1, 2, 3])).toBe(false);
    expect(isQuantized(null)).toBe(false);
    expect(isQuantized({ foo: 1 })).toBe(false);
  });
});

describe('embeddings glue: scoreStored / prepareForStorage', () => {
  const ORIG = process.env.FAUNA_QUANTIZE_EMBEDDINGS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.FAUNA_QUANTIZE_EMBEDDINGS;
    else process.env.FAUNA_QUANTIZE_EMBEDDINGS = ORIG;
  });

  it('scoreStored handles fp32 arrays (cosine path)', () => {
    const q = seededVec(128, 11);
    const prepared = embPrepareQuery(q);
    expect(scoreStored(prepared, q)).toBeCloseTo(cosine(q, q), 6);
  });

  it('scoreStored handles quantized records', () => {
    const v = seededVec(1536, 21);
    const rec = quantizeEmbedding(v, { bits: 4 });
    const prepared = embPrepareQuery(v);
    expect(scoreStored(prepared, rec)).toBeCloseTo(1, 2);
  });

  it('prepareForStorage keeps fp32 by default, quantizes when enabled', () => {
    const v = seededVec(256, 31);
    delete process.env.FAUNA_QUANTIZE_EMBEDDINGS;
    expect(Array.isArray(prepareForStorage(v))).toBe(true);
    process.env.FAUNA_QUANTIZE_EMBEDDINGS = '1';
    const stored = prepareForStorage(v);
    expect(isQuantized(stored)).toBe(true);
    expect(hasEmbedding(stored)).toBe(true);
  });

  it('hasEmbedding recognizes both shapes and rejects empties', () => {
    expect(hasEmbedding([1, 2, 3])).toBe(true);
    expect(hasEmbedding([])).toBe(false);
    expect(hasEmbedding(null)).toBe(false);
    expect(hasEmbedding(quantize(seededVec(64, 4), { bits: 4 }))).toBe(true);
  });
});

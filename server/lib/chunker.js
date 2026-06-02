// ── Chunker — split long documents into overlapping windows for embedding ──
//
// Phase 3 prep. We chunk on natural boundaries (paragraph → sentence → word)
// so each window stays semantically coherent. Overlap ensures a relevant
// passage that straddles a chunk boundary still surfaces in at least one
// embedded chunk.
//
// Tuned for retrieval, not training:
//   * targetChars ~= 1000 (≈ 200-250 tokens) — small enough that one chunk
//     stays focused, large enough to fit a useful unit of context.
//   * overlapChars  = 150  — ~15% overlap, standard RAG default.
//   * minChars      = 200  — short docs are kept whole (better than padding).
//
// Caller is responsible for embedding the resulting chunks and persisting
// them via server/lib/context-store.js.

/**
 * @typedef {{ index:number, text:string, start:number, end:number }} Chunk
 */

const DEFAULTS = {
  targetChars: 1000,
  overlapChars: 150,
  minChars: 200,
};

/**
 * Split `text` into overlapping chunks. Returns the original string as a
 * single chunk when shorter than `minChars`.
 *
 * @param {string} text
 * @param {object} [opts]
 * @returns {Chunk[]}
 */
export function chunkText(text, opts = {}) {
  const { targetChars, overlapChars, minChars } = { ...DEFAULTS, ...opts };
  const src = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!src) return [];
  if (src.length <= Math.max(minChars, targetChars)) {
    return [{ index: 0, text: src, start: 0, end: src.length }];
  }
  if (overlapChars >= targetChars) {
    throw new Error('overlapChars must be < targetChars');
  }

  const chunks = [];
  let cursor = 0;
  let index = 0;
  while (cursor < src.length) {
    const end = Math.min(src.length, cursor + targetChars);
    // Try to end at a sensible boundary so chunks don't slice mid-word.
    const boundary = _findBoundary(src, cursor, end);
    const sliceEnd = boundary > cursor + minChars ? boundary : end;
    const slice = src.slice(cursor, sliceEnd).trim();
    if (slice) {
      chunks.push({ index: index++, text: slice, start: cursor, end: sliceEnd });
    }
    if (sliceEnd >= src.length) break;
    cursor = Math.max(cursor + 1, sliceEnd - overlapChars);
  }
  return chunks;
}

/**
 * Look for the latest natural boundary in [start, end). Preference order:
 * blank line > sentence end > newline > word break. Returns `end` if none
 * found — caller falls back to a hard cut.
 */
function _findBoundary(src, start, end) {
  // Prefer paragraph breaks
  const para = src.lastIndexOf('\n\n', end);
  if (para > start) return para + 2;
  // Then sentence ends
  for (let i = end - 1; i > start; i--) {
    const c = src[i];
    if ((c === '.' || c === '!' || c === '?') && /\s/.test(src[i + 1] || ' ')) {
      return i + 1;
    }
  }
  // Then newlines
  const nl = src.lastIndexOf('\n', end);
  if (nl > start) return nl + 1;
  // Word break
  const sp = src.lastIndexOf(' ', end);
  if (sp > start) return sp + 1;
  return end;
}

export const _internals = { DEFAULTS, _findBoundary };

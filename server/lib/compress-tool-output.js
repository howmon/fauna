// Smart tool-output compression (headroom SmartCrusher idea, in plain JS).
//
// The agent loop hard-caps oversized tool results before they re-enter the
// conversation. The old approach was a blind head+tail char slice — which is
// schema-blind and can chop the one ERROR line out of the middle of a 50k-line
// log or drop the failing row out of a 5,000-item JSON array.
//
// This module is structure-aware. For JSON arrays it keeps the first/last
// items, every error-ish item, items relevant to the user's query, and a
// statistical sample of the rest — preserving the schema (real items, no
// synthesized summary objects). For logs/plaintext it keeps the head, the
// tail, and every line that looks like an error/warning, dropping the inert
// middle. Outputs already under the cap pass through byte-identical.
//
// The function is PURE (no disk I/O, no markers about retrieval) so it is
// trivially testable. Reversible offload (CCR) and the retrieval marker are
// layered on top by the caller via tool-output-cache.js.

const ERROR_RE = /\b(errors?|failed|failing|failure|fatal|exception|traceback|stack\s?trace|panic|segfault|denied|refused|forbidden|unauthorized|enoent|eacces|eperm|econnrefused|etimedout|cannot|could\s?not|couldn'?t|unable|timeout|timed\s?out|assert(ion)?|reject(ed)?|warn(ing)?|deprecat)/i;

const FIRST_KEEP = 12;   // always keep the first N array items (context/header)
const LAST_KEEP = 6;     // always keep the last N array items (recency/summary)
const QUERY_KEEP = 10;   // at most this many query-relevant items
const MAX_ITEMS = 60;    // soft ceiling on kept items before the char-budget trim

/**
 * Compress an oversized tool-output string.
 * @param {string} text  raw tool output
 * @param {{cap?: number, query?: string}} [opts]
 *        cap   – target max chars (output may run slightly over for safety markers)
 *        query – the user's latest message, used for relevance scoring
 * @returns {{ text: string, modified: boolean, original: string, strategy: string }}
 */
export function compressToolOutput(text, opts = {}) {
  const cap = Math.max(1000, opts.cap || 40000);
  const query = typeof opts.query === 'string' ? opts.query : '';
  if (typeof text !== 'string' || text.length <= cap) {
    return { text: typeof text === 'string' ? text : String(text ?? ''), modified: false, original: text, strategy: 'passthrough' };
  }

  // 1. Structured JSON path (arrays, or objects wrapping a big array).
  const parsed = tryParseJson(text);
  if (parsed !== undefined) {
    const out = compressJson(parsed, cap, query);
    if (out && out.text.length < text.length) {
      return { text: out.text, modified: true, original: text, strategy: out.strategy };
    }
  }

  // 2. Log / plaintext path — line-aware, preserves error lines.
  const log = compressLog(text, cap, query);
  return { text: log.text, modified: true, original: text, strategy: log.strategy };
}

// ── JSON ────────────────────────────────────────────────────────────────────

function tryParseJson(text) {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try { return JSON.parse(t); } catch (_) { return undefined; }
}

function compressJson(value, cap, query) {
  if (Array.isArray(value)) {
    return compressArray(value, cap, query);
  }
  if (value && typeof value === 'object') {
    // Find the largest array-valued property and compress that in place
    // (handles the common {results:[...]}, {entries:[...]}, {items:[...]} shape).
    let bestKey = null, bestLen = 0;
    for (const k of Object.keys(value)) {
      if (Array.isArray(value[k])) {
        const len = safeStringify(value[k]).length;
        if (len > bestLen) { bestLen = len; bestKey = k; }
      }
    }
    if (bestKey == null) return null;
    const inner = compressArray(value[bestKey], cap, query, true);
    if (!inner) return null;
    // Rebuild a shallow clone with the compressed array; serialize the wrapper
    // and append the human-readable note after it so the JSON stays parseable.
    const clone = { ...value, [bestKey]: inner.items };
    const body = safeStringify(clone);
    return { text: body + '\n' + inner.note, strategy: inner.strategy };
  }
  return null;
}

/**
 * @param {any[]} items
 * @param {boolean} [innerMode] when true, return {items, note, strategy} for the
 *        caller to splice back into a wrapper object; otherwise return {text, strategy}.
 */
function compressArray(items, cap, query, innerMode = false) {
  const n = items.length;
  if (n === 0) return null;

  const itemStrs = items.map((it) => safeStringify(it));
  const keep = new Set();

  // First / last anchors.
  const firstK = Math.min(FIRST_KEEP, n);
  const lastK = Math.min(LAST_KEEP, n);
  for (let i = 0; i < firstK; i++) keep.add(i);
  for (let i = Math.max(0, n - lastK); i < n; i++) keep.add(i);

  // Error-ish items — never drop these.
  let errorCount = 0;
  for (let i = 0; i < n; i++) {
    if (ERROR_RE.test(itemStrs[i])) { keep.add(i); errorCount++; }
  }

  // Query-relevant items.
  let queryCount = 0;
  const qTokens = tokenize(query);
  if (qTokens.length) {
    const scored = [];
    for (let i = 0; i < n; i++) {
      if (keep.has(i)) continue;
      const s = itemStrs[i].toLowerCase();
      let score = 0;
      for (const t of qTokens) if (s.includes(t)) score++;
      if (score > 0) scored.push([score, i]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    for (let j = 0; j < Math.min(QUERY_KEEP, scored.length); j++) { keep.add(scored[j][1]); queryCount++; }
  }

  // Stride-sample the rest up to MAX_ITEMS so the model still sees the shape.
  let sampleCount = 0;
  if (keep.size < MAX_ITEMS && n > keep.size) {
    const want = MAX_ITEMS - keep.size;
    const stride = Math.max(1, Math.floor(n / Math.max(1, want)));
    for (let i = 0; i < n && keep.size < MAX_ITEMS; i += stride) {
      if (!keep.has(i)) { keep.add(i); sampleCount++; }
    }
  }

  // Char-budget trim: drop sampled items (lowest priority) until we fit.
  // Anchors (first/last) and error items are protected.
  const protectedIdx = new Set();
  for (let i = 0; i < firstK; i++) protectedIdx.add(i);
  for (let i = Math.max(0, n - lastK); i < n; i++) protectedIdx.add(i);
  for (let i = 0; i < n; i++) if (ERROR_RE.test(itemStrs[i])) protectedIdx.add(i);

  let kept = [...keep].sort((a, b) => a - b);
  while (kept.length > protectedIdx.size && estimateArrayBytes(kept, itemStrs) > cap) {
    // Remove the middle-most droppable index (keeps the extremes informative).
    let removeAt = -1;
    for (let p = Math.floor(kept.length / 2); p < kept.length; p++) {
      if (!protectedIdx.has(kept[p])) { removeAt = p; break; }
    }
    if (removeAt === -1) {
      for (let p = Math.floor(kept.length / 2); p >= 0; p--) {
        if (!protectedIdx.has(kept[p])) { removeAt = p; break; }
      }
    }
    if (removeAt === -1) break;
    kept.splice(removeAt, 1);
  }

  const keptItems = kept.map((i) => items[i]);
  const dropped = n - keptItems.length;
  const parts = [`first ${firstK}`, `last ${lastK}`];
  if (errorCount) parts.push(`${errorCount} error-matching`);
  if (queryCount) parts.push(`${queryCount} query-relevant`);
  if (sampleCount) parts.push(`${sampleCount} sampled`);
  const note = `[compressed JSON array: kept ${keptItems.length}/${n} items (${parts.join(', ')}); ${dropped} dropped]`;
  const strategy = `json_array:${keptItems.length}of${n}`;

  if (innerMode) {
    return { items: keptItems, note, strategy };
  }
  let body = safeStringify(keptItems);
  // Defensive: if a few huge items still blow the cap, char-truncate the body.
  if (body.length > cap) body = headTail(body, cap);
  return { text: body + '\n' + note, strategy };
}

function estimateArrayBytes(indices, itemStrs) {
  let total = 2; // []
  for (const i of indices) total += itemStrs[i].length + 1; // + comma
  return total;
}

// ── Logs / plaintext ─────────────────────────────────────────────────────────

function compressLog(text, cap, query) {
  const lines = text.split('\n');
  if (lines.length < 6) {
    // Too few lines to be line-structured — just head/tail the raw string.
    return { text: headTail(text, cap), strategy: 'text_headtail' };
  }

  const headBudget = Math.floor(cap * 0.5);
  const tailBudget = Math.min(4000, Math.floor(cap * 0.15));
  const errorBudget = Math.max(0, cap - headBudget - tailBudget);

  // Head.
  const head = [];
  let headChars = 0, hi = 0;
  for (; hi < lines.length && headChars < headBudget; hi++) {
    head.push(lines[hi]); headChars += lines[hi].length + 1;
  }
  // Tail.
  const tail = [];
  let tailChars = 0, ti = lines.length - 1;
  for (; ti >= hi && tailChars < tailBudget; ti--) {
    tail.push(lines[ti]); tailChars += lines[ti].length + 1;
  }
  tail.reverse();
  const tailStart = ti + 1; // first index belonging to tail

  // Error/warn lines from the elided middle (hi .. tailStart-1), in order.
  const errs = [];
  let errChars = 0, errTotal = 0;
  for (let i = hi; i < tailStart; i++) {
    if (ERROR_RE.test(lines[i])) {
      errTotal++;
      if (errChars < errorBudget) { errs.push(lines[i]); errChars += lines[i].length + 1; }
    }
  }

  const hiddenBefore = errs.length ? (hi) : hi; // informational only
  const out = [];
  out.push(...head);
  const middleHidden = tailStart - hi;
  if (middleHidden > 0) {
    if (errs.length) {
      out.push(`\n[\u2026 ${middleHidden} middle lines elided; ${errTotal} error/warning line(s) surfaced below \u2026]`);
      out.push(...errs);
      out.push(`[\u2026 end of surfaced error/warning lines \u2026]\n`);
    } else {
      out.push(`\n[\u2026 ${middleHidden} middle lines elided (no error/warning lines detected) \u2026]\n`);
    }
  }
  out.push(...tail);
  void hiddenBefore; void query;
  return { text: out.join('\n'), strategy: `log:${errTotal}err` };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function headTail(text, cap) {
  if (text.length <= cap) return text;
  const tailBudget = Math.min(2000, Math.floor(cap * 0.1));
  const headBudget = cap - tailBudget;
  return (
    text.slice(0, headBudget) +
    `\n\n[\u2026 truncated ${text.length - cap} chars; showing first ${headBudget} + last ${tailBudget} of ${text.length} total \u2026]\n\n` +
    text.slice(-tailBudget)
  );
}

function tokenize(s) {
  if (!s) return [];
  const seen = new Set();
  const out = [];
  for (const w of String(s).toLowerCase().match(/[a-z0-9_./-]{4,}/g) || []) {
    if (!seen.has(w)) { seen.add(w); out.push(w); }
    if (out.length >= 24) break;
  }
  return out;
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

// server/lib/token-budget.js
// Lightweight, dependency-free token estimation + per-model context budgets.
//
// Why a fallback estimator?  We can't ship a real tokenizer (no native deps,
// keep install small).  The chars/CHARS_PER_TOKEN heuristic is within ~10–15%
// of cl100k_base for English+code, which is plenty for trim/compact decisions.
//
// If `js-tiktoken` is ever added to deps it will be loaded lazily at first call.

const CHARS_PER_TOKEN = 3.8; // empirical avg across English prose + JS/TS/PHP

// ── per-model context windows + auto-compact thresholds ────────────────────
// `compactAt` is the fraction of the body budget (window − sys − reservedOut)
// at which we trigger summarization.  Conservative defaults; tuned per family.
const MODEL_LIMITS = {
  // OpenAI
  'gpt-5':         { window: 272_000,  compactAt: 0.75 },
  'gpt-5-mini':    { window: 272_000,  compactAt: 0.75 },
  'gpt-5.1':       { window: 272_000,  compactAt: 0.75 },
  'gpt-5.5':       { window: 272_000,  compactAt: 0.75 },
  'gpt-4.1':       { window: 1_000_000, compactAt: 0.60 },
  'gpt-4o':        { window: 128_000,  compactAt: 0.70 },
  'gpt-4o-mini':   { window: 128_000,  compactAt: 0.70 },
  'o1':            { window: 200_000,  compactAt: 0.70 },
  'o3':            { window: 200_000,  compactAt: 0.70 },
  'o4-mini':       { window: 200_000,  compactAt: 0.70 },
  // Anthropic
  'claude-sonnet': { window: 200_000,  compactAt: 0.70 },
  'claude-opus':   { window: 200_000,  compactAt: 0.70 },
  'claude-haiku':  { window: 200_000,  compactAt: 0.70 },
  // Default — used when no fuzzy match
  '__default__':   { window: 128_000,  compactAt: 0.70 },
};

// Tokens we keep in reserve for the model's response (not chargeable to body).
const DEFAULT_RESERVED_OUTPUT_TOKENS = 4_096;

let _tiktoken = null;
let _tiktokenTried = false;

async function _tryLoadTiktoken() {
  if (_tiktokenTried) return _tiktoken;
  _tiktokenTried = true;
  try {
    const mod = await import('js-tiktoken');
    const enc = mod.getEncoding ? mod.getEncoding('cl100k_base') : null;
    if (enc && typeof enc.encode === 'function') {
      _tiktoken = enc;
    }
  } catch (_) {
    _tiktoken = null;
  }
  return _tiktoken;
}

/**
 * Estimate tokens for a string.  Synchronous, deterministic, no I/O.
 * Uses tiktoken if it was loaded via primeTokenizer(); otherwise heuristic.
 */
export function estimateTokens(input) {
  if (input == null) return 0;
  if (typeof input === 'number') return Math.max(0, Math.ceil(input / CHARS_PER_TOKEN));
  if (Array.isArray(input)) {
    // Array of OpenAI-style messages OR content parts
    let total = 0;
    for (const item of input) total += estimateTokens(item);
    return total;
  }
  if (typeof input === 'object') {
    // Message-like { role, content } or content-part { type, text, image_url }
    let total = 4; // per-message overhead (role + separator)
    if (typeof input.content === 'string') total += estimateTokens(input.content);
    else if (Array.isArray(input.content)) total += estimateTokens(input.content);
    if (typeof input.text === 'string') total += estimateTokens(input.text);
    if (input.image_url || input.type === 'image_url' || input.type === 'image') total += 765; // rough vision cost
    if (typeof input.name === 'string') total += estimateTokens(input.name);
    if (typeof input.tool_call_id === 'string') total += 4;
    if (Array.isArray(input.tool_calls)) {
      for (const tc of input.tool_calls) {
        if (tc?.function?.arguments) total += estimateTokens(tc.function.arguments);
        if (tc?.function?.name) total += estimateTokens(tc.function.name);
      }
    }
    return total;
  }
  const str = String(input);
  if (_tiktoken) {
    try { return _tiktoken.encode(str).length; } catch (_) { /* fall through */ }
  }
  return Math.ceil(str.length / CHARS_PER_TOKEN);
}

/** Optional one-shot prime if js-tiktoken happens to be installed. */
export async function primeTokenizer() {
  await _tryLoadTiktoken();
  return !!_tiktoken;
}

/** Lowercase + strip provider prefix for fuzzy matching ('openai/gpt-5' → 'gpt-5'). */
function _normalizeModel(model) {
  if (!model || typeof model !== 'string') return '';
  let m = model.toLowerCase().trim();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  return m;
}

/**
 * Resolve the budget descriptor for a model.  Tries exact, then prefix match.
 * Always returns a populated object — never null.
 */
export function pickBudget(model) {
  const m = _normalizeModel(model);
  if (m && MODEL_LIMITS[m]) return { model: m, ...MODEL_LIMITS[m] };
  if (m) {
    // longest-prefix match (e.g. 'gpt-5-2025-08-01' → 'gpt-5')
    const keys = Object.keys(MODEL_LIMITS)
      .filter(k => k !== '__default__')
      .sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (m.startsWith(k)) return { model: m, matched: k, ...MODEL_LIMITS[k] };
    }
  }
  return { model: m || 'unknown', matched: '__default__', ...MODEL_LIMITS.__default__ };
}

/**
 * Compute the chargeable-body token budget for a turn.
 *
 *   bodyTokenLimit = floor((window − systemTokens − reservedOutput) * compactAt)
 *
 * @returns {{
 *   model: string, window: number, compactAt: number,
 *   systemTokens: number, reservedOutput: number,
 *   bodyTokenLimit: number, hardBodyCeiling: number
 * }}
 */
export function computeBudget({ model, systemTokens = 0, reservedOutput = DEFAULT_RESERVED_OUTPUT_TOKENS } = {}) {
  const b = pickBudget(model);
  const safeSys = Math.max(0, systemTokens | 0);
  const safeOut = Math.max(0, reservedOutput | 0);
  const available = Math.max(1024, b.window - safeSys - safeOut);
  const bodyTokenLimit = Math.floor(available * b.compactAt);
  return {
    model: b.model,
    matched: b.matched || b.model,
    window: b.window,
    compactAt: b.compactAt,
    systemTokens: safeSys,
    reservedOutput: safeOut,
    bodyTokenLimit,
    hardBodyCeiling: available,
  };
}

/** Convenience: total tokens for an array of OpenAI-style messages. */
export function measureMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return estimateTokens(messages);
}

// Exported for tests + manual tuning
export const _internals = {
  MODEL_LIMITS,
  CHARS_PER_TOKEN,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
};

// ── Tool scorer (Phase 6) ────────────────────────────────────────────────
//
// Rank a tool list by relevance to a user query. The chat router can use
// this to trim the catalogue sent to the model when it's large, which:
//   * shortens system prompts (cheaper, faster)
//   * reduces tool-use hallucinations (model can't call a tool it didn't
//     see described)
//
// Two backends:
//
//   1. **Lexical** (default, zero deps). Tokenises the query and each tool
//      ({name, description, parameters.properties}) into lower-case words,
//      strips a built-in stoplist, scores by token overlap with light IDF
//      weighting based on token rarity across the tool set. Fast (≪1 ms
//      for hundreds of tools) and deterministic — perfectly fine for the
//      common case where the user's request shares vocabulary with the
//      tool surface (e.g. "open the browser to nairaland" → browser_*).
//
//   2. **Embedding** (opt-in). Caller supplies an async embedder
//      `embed(texts) → number[][]` (e.g. local model, OpenAI, Voyage…)
//      plus an optional cache. We cosine-rank in JS. The lexical score is
//      blended in (60/40) so exact-name matches still win — this keeps
//      results sensible even when the embedding model is wrong about a
//      novel tool description.
//
// Both backends return the same shape:
//   `[{ tool, score, lexical, semantic? }, …]` sorted desc by `score`.

const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','for','to','of','in','on',
  'at','by','with','from','into','is','are','was','were','be','been','being',
  'do','does','did','have','has','had','this','that','these','those','it','its',
  'as','i','you','he','she','they','we','us','me','my','your','their','our',
  'can','could','should','would','may','might','will','shall','please','pls',
  'help','want','need','get','make','use','using','run','call',
  'tool','tools','function','functions','api','some','any','what','how','why',
  // generic shape tokens common in tool descriptions:
  'returns','return','given','optional','required','params','parameter','type',
]);

const TOKEN_RE = /[a-z0-9]+/g;

function _tokens(s) {
  if (!s) return [];
  const out = [];
  const m = String(s).toLowerCase().match(TOKEN_RE);
  if (!m) return out;
  for (const t of m) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

function _toolText(tool) {
  if (!tool || typeof tool !== 'object') return '';
  const name  = tool.name || '';
  const desc  = tool.description || '';
  const props = tool.parameters?.properties || tool.input_schema?.properties || {};
  const paramKeys = Object.keys(props).join(' ');
  // Name tokens repeated so they outweigh prose tokens.
  return `${name} ${name} ${name} ${paramKeys} ${desc}`;
}

/**
 * Score tools lexically against a query. Returns array sorted desc.
 *
 * @param {string} query
 * @param {Array<{name:string,description?:string,parameters?:object}>} tools
 * @returns {Array<{tool:object,score:number,lexical:number,matches:string[]}>}
 */
export function scoreLexical(query, tools) {
  const queryTokens = _tokens(query);
  if (!queryTokens.length || !Array.isArray(tools) || !tools.length) {
    return (tools || []).map(t => ({ tool: t, score: 0, lexical: 0, matches: [] }));
  }
  const qSet = new Set(queryTokens);

  // Build doc-frequency table across the tool set.
  const df = new Map();
  const toolTokenSets = tools.map(t => {
    const set = new Set(_tokens(_toolText(t)));
    for (const tok of set) df.set(tok, (df.get(tok) || 0) + 1);
    return set;
  });
  const N = tools.length;

  const results = tools.map((tool, i) => {
    const toolSet = toolTokenSets[i];
    let score = 0;
    const matches = [];
    for (const qt of qSet) {
      if (toolSet.has(qt)) {
        const idf = Math.log(1 + (N / (df.get(qt) || 1)));
        score += idf;
        matches.push(qt);
      }
    }
    // Normalise to [0,1] by dividing by max possible (sum of IDFs for the
    // query tokens that exist anywhere in the catalogue).
    const maxPossible = [...qSet].reduce((s, qt) => s + (df.has(qt) ? Math.log(1 + (N / df.get(qt))) : 0), 0);
    const normalised = maxPossible > 0 ? score / maxPossible : 0;
    return { tool, score: normalised, lexical: normalised, matches };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Score tools using an external embedder, blended with lexical for safety.
 *
 * @param {string} query
 * @param {Array<object>} tools
 * @param {object} opts
 * @param {(texts:string[]) => Promise<number[][]>} opts.embed
 *        Function that returns one vector per input string in order.
 * @param {Map<string,number[]>} [opts.cache]
 *        Optional cache keyed by tool text — embedder is only called for
 *        cache misses. Caller is responsible for invalidating on schema
 *        changes.
 * @param {number} [opts.lexicalWeight=0.4]
 * @returns {Promise<Array<{tool:object,score:number,lexical:number,semantic:number,matches:string[]}>>}
 */
export async function scoreEmbedding(query, tools, opts) {
  if (!opts || typeof opts.embed !== 'function') {
    throw new Error('scoreEmbedding requires opts.embed(texts)');
  }
  const lexicalWeight = typeof opts.lexicalWeight === 'number' ? opts.lexicalWeight : 0.4;
  const semanticWeight = 1 - lexicalWeight;
  const cache = opts.cache instanceof Map ? opts.cache : new Map();

  const lex = scoreLexical(query, tools);
  const lexByTool = new Map(lex.map(r => [r.tool, r]));

  const toolTexts = tools.map(_toolText);
  const missingIdx = [];
  const missingTexts = [];
  for (let i = 0; i < toolTexts.length; i++) {
    if (!cache.has(toolTexts[i])) {
      missingIdx.push(i);
      missingTexts.push(toolTexts[i]);
    }
  }
  // Always include the query, plus any uncached tool texts.
  const batch = [query, ...missingTexts];
  const vectors = await opts.embed(batch);
  if (!Array.isArray(vectors) || vectors.length !== batch.length) {
    throw new Error(`embed() must return ${batch.length} vectors (got ${Array.isArray(vectors) ? vectors.length : typeof vectors})`);
  }
  const qVec = vectors[0];
  for (let k = 0; k < missingIdx.length; k++) {
    cache.set(toolTexts[missingIdx[k]], vectors[k + 1]);
  }

  const results = tools.map((tool, i) => {
    const semantic = _cosine(qVec, cache.get(toolTexts[i]));
    const lexEntry = lexByTool.get(tool) || { lexical: 0, matches: [] };
    const blended = (lexEntry.lexical * lexicalWeight) + (semantic * semanticWeight);
    return { tool, score: blended, lexical: lexEntry.lexical, semantic, matches: lexEntry.matches };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Convenience: rank tools and return the top-K. Always keeps `mustKeep`
 * tools (by name) so callers can pin always-available primitives like
 * `agent_read_file` that the model needs irrespective of the query.
 *
 * @param {string} query
 * @param {Array<object>} tools
 * @param {object} [opts]
 * @param {number}        [opts.topK=12]
 * @param {number}        [opts.minScore=0]    drop entries below this
 * @param {string[]}      [opts.mustKeep=[]]   tool names always included
 * @param {Function}      [opts.embed]         see scoreEmbedding
 * @param {Map}           [opts.cache]
 * @returns {Promise<Array<object>>}            ordered tool objects
 */
export async function pickTopTools(query, tools, opts = {}) {
  const topK    = opts.topK ?? 12;
  const minScore= opts.minScore ?? 0;
  const mustKeep= new Set(opts.mustKeep || []);
  if (!Array.isArray(tools) || !tools.length) return [];
  if (!query || !query.trim()) return tools.slice(0, topK);

  const ranked = opts.embed
    ? await scoreEmbedding(query, tools, { embed: opts.embed, cache: opts.cache })
    : scoreLexical(query, tools);

  const picked = [];
  const seen = new Set();
  // First pass: mustKeep entries.
  for (const t of tools) {
    if (mustKeep.has(t.name) && !seen.has(t.name)) {
      picked.push(t);
      seen.add(t.name);
    }
  }
  // Second pass: ranked entries respecting topK + minScore.
  for (const r of ranked) {
    if (picked.length >= topK) break;
    if (seen.has(r.tool.name)) continue;
    if (r.score < minScore) continue;
    picked.push(r.tool);
    seen.add(r.tool.name);
  }
  return picked;
}

function _cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

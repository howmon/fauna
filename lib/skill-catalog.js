// lib/skill-catalog.js
// Feature A — Semantic Skill Router ("Skill Atlas").
//
// Replaces Fauna's keyword-substring skill discovery with a ranked router that
// returns skills with a confidence score, the evidence that matched, and a
// clarification question when the top match is uncertain.
//
// Design notes:
//   - The CORE ranker is purely lexical (BM25-ish term overlap + field boosts +
//     facet/graph proximity). That makes it deterministic, offline, and
//     unit-testable with golden-route fixtures — no network, no native deps.
//   - Embeddings are an OPTIONAL booster (lazy @xenova/transformers, already a
//     Fauna dependency). When vectors are available the ranker blends cosine
//     similarity in; when they are not, it degrades gracefully to lexical only.
//   - Burned-in lesson (user memory): never +score short single-word skill ids
//     ("list", "grid") — they appear inside natural prompts and overpower better
//     matches. Skill-name hits only count for multi-token (kebab) ids or
//     word-boundary matches.
//
// Zero mandatory dependencies beyond lib/skill-anatomy.js. Pure functions where
// possible so the router is easy to test in isolation.

import fs from 'node:fs';
import { parseFrontmatter, findSection, listSections } from './skill-anatomy.js';

// ── Tokenisation ──────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of',
  'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'this', 'that', 'these', 'those', 'it', 'its', 'my', 'your',
  'our', 'their', 'we', 'you', 'i', 'me', 'us', 'them', 'he', 'she', 'they',
  'do', 'does', 'did', 'done', 'can', 'could', 'should', 'would', 'will', 'shall',
  'may', 'might', 'must', 'have', 'has', 'had', 'not', 'no', 'yes', 'so', 'up',
  'out', 'about', 'into', 'over', 'after', 'before', 'when', 'while', 'how',
  'what', 'which', 'who', 'why', 'where', 'use', 'using', 'used', 'want', 'need',
  'please', 'help', 'lets', 'let', 'get', 'make', 'add', 'new',
]);

// Conservative suffix stemmer — collapses common inflections so "fails"~"fail"
// and "unexpectedly"~"unexpected" match. Deliberately minimal to avoid the
// over-stemming failure mode (e.g. never touches short words).
function stem(t) {
  if (t.length <= 4) return t;
  if (t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.endsWith('ing') && t.length > 5) return t.slice(0, -3);
  if (t.endsWith('edly')) return t.slice(0, -4);
  if (t.endsWith('ly')) return t.slice(0, -2);
  if (t.endsWith('ed') && t.length > 4) return t.slice(0, -2);
  if (t.endsWith('es') && t.length > 4) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss') && t.length > 4) return t.slice(0, -1);
  return t;
}

// Split arbitrary text into normalised, stopword-filtered, stemmed terms.
export function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}

// Split a kebab/underscore id into its component word tokens (stemmed).
function idTokens(id) {
  return String(id || '')
    .toLowerCase()
    .split(/[-_]+/)
    .filter((t) => t.length >= 2)
    .map(stem);
}

// Is this skill id "safe to lexically score"? Multi-token kebab ids
// ("test-driven-development") are; bare single words ("list") are NOT — per the
// burned-in memory rule. Callers still allow word-boundary matches for singles.
function isMultiToken(id) {
  return idTokens(id).length >= 2;
}

// ── Indexing ────────────────────────────────────────────────────────────────

// Turn one skill descriptor into a searchable document. `skill` is the shape
// returned by self-tools._listSkillsOnDisk: { name, scope, description, path }.
// The body is read from disk (best-effort) for richer signal.
export function indexSkill(skill) {
  const name = String(skill?.name || '');
  const scope = skill?.scope || 'global';
  let description = String(skill?.description || '');
  let body = typeof skill?.body === 'string' ? skill.body : '';
  if (!body && skill?.path) {
    try { body = fs.readFileSync(skill.path, 'utf8'); } catch (_) { body = ''; }
  }

  const parsed = parseFrontmatter(body);
  if (!description && parsed.frontmatter?.description) description = parsed.frontmatter.description;

  // "When to Use" / trigger section is the highest-signal routing field.
  const whenToUse = findSection(parsed.body || body, ['When to Use', 'When to Apply', 'Triggers', 'Usage']) || '';
  const overview = findSection(parsed.body || body, ['Overview']) || '';
  const sectionTitles = listSections(parsed.body || body).map((s) => s.title).join(' ');

  // Domain / facet tags: explicit frontmatter `domains`/`tags`, else derived
  // from the id tokens.
  const facetRaw = [parsed.frontmatter?.domains, parsed.frontmatter?.tags, parsed.frontmatter?.facets]
    .filter(Boolean).join(' ');
  const domains = Array.from(new Set([...tokenize(facetRaw), ...idTokens(name)]));

  // Weighted term bag. Each field contributes its tokens with a field weight so
  // a query term appearing in "When to Use" outranks one buried in the body.
  const weights = new Map();
  const bump = (tokens, w) => {
    for (const t of tokens) weights.set(t, (weights.get(t) || 0) + w);
  };
  bump(idTokens(name), 3);
  bump(tokenize(description), 4);
  bump(tokenize(whenToUse), 5);
  bump(tokenize(overview), 2);
  bump(tokenize(sectionTitles), 1);
  bump(tokenize(parsed.body || body), 0.5);

  return {
    name,
    scope,
    description,
    whenToUse,
    domains,
    idTokens: idTokens(name),
    multiToken: isMultiToken(name),
    weights,               // Map<term, weight>
    terms: new Set(weights.keys()),
    vector: null,          // populated lazily by attachEmbeddings()
  };
}

// Build an in-memory catalog from a list of skill descriptors.
export function buildCatalog(skills) {
  const docs = (Array.isArray(skills) ? skills : []).map(indexSkill).filter((d) => d.name);
  // Simple co-occurrence graph: skills sharing a domain tag are "related".
  const byDomain = new Map();
  for (const d of docs) {
    for (const dom of d.domains) {
      if (!byDomain.has(dom)) byDomain.set(dom, new Set());
      byDomain.get(dom).add(d.name);
    }
  }
  for (const d of docs) {
    const related = new Set();
    for (const dom of d.domains) {
      for (const other of byDomain.get(dom) || []) if (other !== d.name) related.add(other);
    }
    d.related = Array.from(related);
  }
  return { docs, byDomain };
}

// ── Lexical scoring ──────────────────────────────────────────────────────────

// Score one document against tokenised query terms. Returns { score, evidence }.
function scoreDoc(doc, queryTerms, queryText, opts) {
  const activeSkill = opts?.activeSkill || null;
  let score = 0;
  const evidence = [];
  const qset = new Set(queryTerms);

  // 1) Weighted term overlap. A query term present in the doc contributes its
  //    field weight, dampened logarithmically so long bodies don't dominate.
  let overlapTerms = 0;
  for (const term of qset) {
    const w = doc.weights.get(term);
    if (w) {
      score += Math.log2(1 + w);
      overlapTerms += 1;
    }
  }
  if (overlapTerms) {
    evidence.push(`matched ${overlapTerms} term(s): ${[...qset].filter((t) => doc.weights.has(t)).slice(0, 6).join(', ')}`);
  }

  // 2) Coverage bonus — reward matching a large share of the query.
  const coverage = qset.size ? overlapTerms / qset.size : 0;
  score += coverage * 2;

  // 3) Skill-id (name) match. Guarded by the burned-in rule: a single common
  //    word that happens to be part of a multi-token id ("test" inside
  //    "test-driven-development") is a WEAK route signal — many prompts mention
  //    it incidentally. Only reward strongly when MULTIPLE id words are present
  //    (the skill name is genuinely being referenced).
  const nameHit = doc.idTokens.filter((t) => qset.has(t));
  if (nameHit.length >= 2) {
    score += 3 * nameHit.length;
    evidence.push(`skill id matched: ${nameHit.join('-')}`);
  } else if (nameHit.length === 1) {
    // One id word only — require a word-boundary hit in the raw query and give
    // just a small nudge, whether the id is single- or multi-token.
    const re = new RegExp(`\\b${nameHit[0]}\\w*\\b`, 'i');
    if (re.test(queryText)) { score += 0.5; evidence.push(`weak id hit: ${nameHit[0]}`); }
  }

  // 4) Domain/facet proximity to the currently-active skill (graph edge).
  if (activeSkill && Array.isArray(doc.related) && doc.related.includes(activeSkill)) {
    score += 0.75;
    evidence.push(`related to active skill "${activeSkill}"`);
  }

  // 5) Optional embedding cosine blend.
  if (doc.vector && opts?.queryVector) {
    const cos = cosine(doc.vector, opts.queryVector);
    score += cos * (opts.embeddingWeight ?? 4);
    if (cos > 0.25) evidence.push(`semantic match (cos ${cos.toFixed(2)})`);
  }

  return { score, evidence };
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Public router ─────────────────────────────────────────────────────────

const DEFAULTS = {
  topK: 4,
  clarifyFloor: 0.38,   // confidence below this ⇒ ask a clarifying question
  scoreScale: 4,        // saturation constant for confidence strength
};

// Route a natural-language query to the best skill(s).
//   query   — the user's request / task text
//   catalog — output of buildCatalog(), OR a raw skill list (auto-built)
//   opts    — { topK, activeSkill, queryVector, embeddingWeight, clarifyFloor }
// Returns { ok, plan: [{name, scope, score, confidence, evidence[]}],
//           top, confidence, clarify? }
export function routeSkill(query, catalog, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const cat = catalog && Array.isArray(catalog.docs) ? catalog : buildCatalog(catalog);
  const queryText = String(query || '');
  const queryTerms = tokenize(queryText);

  if (!cat.docs.length) {
    return { ok: false, error: 'no skills in catalog', plan: [], confidence: 0 };
  }
  if (!queryTerms.length) {
    return { ok: true, plan: [], top: null, confidence: 0, clarify: 'What are you trying to accomplish? Describe the task so I can pick the right skill.' };
  }

  const scored = cat.docs.map((doc) => {
    const { score, evidence } = scoreDoc(doc, queryTerms, queryText, cfg);
    return { name: doc.name, scope: doc.scope, description: doc.description, score, evidence };
  }).filter((r) => r.score > 0);

  scored.sort((a, b) => b.score - a.score);
  const plan = scored.slice(0, cfg.topK);

  if (!plan.length) {
    return {
      ok: true,
      plan: [],
      top: null,
      confidence: 0,
      clarify: `No skill clearly matches "${queryText.slice(0, 80)}". Which area is this — testing, debugging, code review, spec writing, or implementation?`,
    };
  }

  const top = plan[0].score;
  const second = plan[1]?.score || 0;
  // Confidence = saturating strength of the top score × how dominant it is.
  const strength = 1 - Math.exp(-top / cfg.scoreScale);
  const share = top > 0 ? top / (top + second) : 0;     // 0.5 = tie, 1 = uncontested
  const confidence = +(strength * (0.5 + 0.5 * share)).toFixed(3);

  const result = {
    ok: true,
    plan: plan.map((p) => ({ ...p, confidence: p === plan[0] ? confidence : +(strength * (0.5 + 0.5 * (p.score / (top + second)))).toFixed(3) })),
    top: plan[0].name,
    confidence,
  };

  if (confidence < cfg.clarifyFloor) {
    const names = plan.slice(0, 3).map((p) => `\`${p.name}\``).join(' or ');
    result.clarify = `I'm not fully sure which skill fits — did you mean ${names}? Tell me a bit more about the goal.`;
  }
  return result;
}

// ── Optional embeddings (lazy) ───────────────────────────────────────────────

let _embedder = null;
let _embedderPromise = null;

// Lazily construct a feature-extraction pipeline. Returns null if the optional
// dependency or model is unavailable (offline / not installed) — callers then
// fall back to lexical-only routing.
async function getEmbedder() {
  if (_embedder) return _embedder;
  if (_embedderPromise) return _embedderPromise;
  _embedderPromise = (async () => {
    try {
      const mod = await import('@xenova/transformers');
      const pipeline = mod.pipeline || mod.default?.pipeline;
      if (!pipeline) return null;
      _embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      return _embedder;
    } catch (_) {
      return null;
    }
  })();
  return _embedderPromise;
}

// Embed a single string ⇒ Float32Array (mean-pooled, normalised) or null.
export async function embedText(text) {
  const embed = await getEmbedder();
  if (!embed) return null;
  try {
    const out = await embed(String(text || ''), { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  } catch (_) {
    return null;
  }
}

// Attach embedding vectors to every doc in a catalog (best-effort). No-op when
// embeddings are unavailable. Returns true if any vectors were attached.
export async function attachEmbeddings(catalog) {
  const cat = catalog && Array.isArray(catalog.docs) ? catalog : null;
  if (!cat) return false;
  const embed = await getEmbedder();
  if (!embed) return false;
  let any = false;
  for (const doc of cat.docs) {
    if (doc.vector) { any = true; continue; }
    const text = [doc.name.replace(/[-_]/g, ' '), doc.description, doc.whenToUse].filter(Boolean).join('. ');
    const v = await embedText(text);
    if (v) { doc.vector = v; any = true; }
  }
  return any;
}

export default { tokenize, indexSkill, buildCatalog, routeSkill, embedText, attachEmbeddings };

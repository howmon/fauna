// ── Structured Memory Store — Persistent facts with decay and recall scoring ──
// Complements the existing category/skill memory system.
// Stores individual facts the AI learns about the user, project preferences,
// decisions, and context — with automatic decay of unused entries.
//
// Persists to ~/.config/fauna/facts.json

import fs from 'fs';
import path from 'path';
import os from 'os';
import { scrubSecrets } from './server/lib/redactor.js';
import { cosine } from './server/lib/embeddings.js';

const CONFIG_DIR  = path.join(os.homedir(), '.config', 'fauna');
const FACTS_FILE  = path.join(CONFIG_DIR, 'facts.json');
const MAX_FACTS   = 200;
const MAX_CHARS   = 500;
const DECAY_DAYS  = 60;
const CATEGORIES  = ['preference', 'fact', 'decision', 'context'];
const KINDS       = ['static', 'dynamic', 'temporal'];
const GLOBAL_TAG  = 'global';

/**
 * @typedef {{
 *   id: string,
 *   text: string,
 *   category: string,
 *   createdAt: number,
 *   lastAccessedAt: number,
 *   accessCount: number,
 *   containerTag?: string,
 *   kind?: 'static'|'dynamic'|'temporal',
 *   expiresAt?: number,
 *   supersedes?: string,
 *   supersededBy?: string,
 *   sourceTurnId?: string,
 *   embedding?: number[],
 *   embeddingModel?: string,
 * }} Fact
 * @typedef {{ok: boolean, error?: string, id?: string, deduplicated?: boolean, supersededId?: string}} RememberResult
 * @typedef {{total: number, maxFacts: number, maxChars: number, decayDays: number, byCategory: Record<string,number>, categories: string[]}} FactStats
 */

let _facts = null; // lazy-loaded cache

// ── Persistence ────────────────────────────────────────────────────────────

function _load() {
  if (_facts) return _facts;
  try {
    const raw = JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8'));
    _facts = Array.isArray(raw) ? raw : [];
  } catch (_) {
    _facts = [];
  }
  return _facts;
}

function _save() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(FACTS_FILE, JSON.stringify(_facts, null, 2));
}

function _uid() {
  return 'fact-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function _normalize(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Core API ──────────────────────────────────────────────────────────────

/**
 * Normalize the 2nd arg: legacy callers pass a string category;
 * new callers pass an options bag.
 */
function _normalizeOpts(catOrOpts) {
  if (catOrOpts == null) return {};
  if (typeof catOrOpts === 'string') return { category: catOrOpts };
  return catOrOpts;
}

/**
 * Remember a fact.
 * Legacy:  remember(text, 'preference')
 * New:     remember(text, { category, containerTag, kind, expiresAt, sourceTurnId, supersedes })
 * @returns {RememberResult}
 */
export function remember(text, catOrOpts) {
  const opts = _normalizeOpts(catOrOpts);
  const category = opts.category || 'fact';
  const containerTag = opts.containerTag || GLOBAL_TAG;
  const kind = opts.kind && KINDS.includes(opts.kind) ? opts.kind : 'static';
  const expiresAt = (typeof opts.expiresAt === 'number' && opts.expiresAt > 0) ? opts.expiresAt : undefined;
  const sourceTurnId = opts.sourceTurnId || undefined;
  const supersedesId = opts.supersedes || undefined;

  const facts = _load();
  const trimmed = (text || '').trim();
  if (!trimmed) return { ok: false, error: 'Empty text' };
  if (trimmed.length > MAX_CHARS) return { ok: false, error: `Text exceeds ${MAX_CHARS} characters (got ${trimmed.length})` };
  if (!CATEGORIES.includes(category)) return { ok: false, error: `Invalid category. Use: ${CATEGORIES.join(', ')}` };

  // Phase 6: scrub secrets BEFORE persisting. We replace the value in-place
  // so the surrounding fact context ("my prod API key for service X is ...")
  // is preserved — useful for recall — while the secret itself never
  // touches disk.
  const scrub = scrubSecrets(trimmed);
  const safeText = scrub.text;

  // Dedup: check for exact normalized match within the same containerTag.
  // Cross-tag duplicates are allowed (a project fact may legitimately repeat
  // global guidance).
  const norm = _normalize(safeText);
  const existing = facts.find(f =>
    _normalize(f.text) === norm &&
    (f.containerTag || GLOBAL_TAG) === containerTag &&
    !f.supersededBy
  );
  if (existing) {
    existing.lastAccessedAt = Date.now();
    existing.accessCount = (existing.accessCount || 0) + 1;
    _save();
    return { ok: true, id: existing.id, deduplicated: true };
  }

  // Enforce limit — remove oldest by lastAccessedAt
  if (facts.length >= MAX_FACTS) {
    facts.sort((a, b) => (a.lastAccessedAt || a.createdAt) - (b.lastAccessedAt || b.createdAt));
    facts.splice(0, facts.length - MAX_FACTS + 1);
  }

  const fact = {
    id: _uid(),
    category,
    text: safeText,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    containerTag,
    kind,
    ...(expiresAt ? { expiresAt } : {}),
    ...(sourceTurnId ? { sourceTurnId } : {}),
    ...(scrub.mutated ? { redactions: scrub.redactions } : {}),
  };

  // If this remember() call explicitly supersedes another fact, link them.
  let supersededId;
  if (supersedesId) {
    const target = facts.find(f => f.id === supersedesId);
    if (target && !target.supersededBy) {
      target.supersededBy = fact.id;
      fact.supersedes = target.id;
      supersededId = target.id;
    }
  }

  facts.push(fact);
  _save();
  return { ok: true, id: fact.id, deduplicated: false,
    ...(supersededId ? { supersededId } : {}),
    ...(scrub.mutated ? { redacted: scrub.redactions } : {}) };
}

/**
 * Replace one fact with another in a single atomic op.
 * Convenience wrapper around remember({ supersedes }).
 */
export function supersede(oldId, newText, opts = {}) {
  return remember(newText, { ...opts, supersedes: oldId });
}

/**
 * Search facts.
 * Legacy:  recall('keywords')
 * New:     recall('keywords', { containerTag, includeGlobal = true, kind, limit = 20 })
 */
export function recall(keywords, opts = {}) {
  const containerTag = opts.containerTag || null;
  const includeGlobal = opts.includeGlobal !== false;
  const kindFilter = opts.kind || null;
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 20;

  const _eligible = (f) => {
    if (f.supersededBy) return false;
    if (f.expiresAt && f.expiresAt <= Date.now()) return false;
    if (kindFilter && (f.kind || 'static') !== kindFilter) return false;
    if (containerTag) {
      const tag = f.containerTag || GLOBAL_TAG;
      if (tag !== containerTag && !(includeGlobal && tag === GLOBAL_TAG)) return false;
    }
    return true;
  };

  const facts = _load().filter(_eligible);
  if (!keywords || !keywords.trim()) {
    // Return top by recency
    return facts
      .slice()
      .sort((a, b) => (b.lastAccessedAt || b.createdAt) - (a.lastAccessedAt || a.createdAt))
      .slice(0, limit)
      .map(f => { f.lastAccessedAt = Date.now(); return f; });
  }

  const terms = keywords.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = facts.map(f => {
    const text = f.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (text.includes(term)) score++;
    }
    if (score === 0) return null;
    // Boost by recency (0-1 scale, 1 = accessed today, 0 = 60+ days ago)
    const daysSinceAccess = (Date.now() - (f.lastAccessedAt || f.createdAt)) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 1 - daysSinceAccess / DECAY_DAYS);
    return { fact: f, score: score + recencyBoost };
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit).map(s => s.fact);

  // Mark accessed
  const now = Date.now();
  for (const f of results) {
    f.lastAccessedAt = now;
    f.accessCount = (f.accessCount || 0) + 1;
  }
  _save();

  return results;
}

export function forget(id) {
  const facts = _load();
  const idx = facts.findIndex(f => f.id === id);
  if (idx === -1) return { ok: false, error: 'Fact not found' };
  facts.splice(idx, 1);
  _save();
  return { ok: true };
}

export function listFacts(categoryOrOpts = null) {
  const opts = typeof categoryOrOpts === 'string' || categoryOrOpts == null
    ? { category: categoryOrOpts }
    : categoryOrOpts;
  const { category = null, containerTag = null, includeGlobal = true, includeSuperseded = false, includeExpired = false } = opts;
  const now = Date.now();
  const facts = _load();
  const filtered = facts.filter(f => {
    if (!includeSuperseded && f.supersededBy) return false;
    if (!includeExpired && f.expiresAt && f.expiresAt <= now) return false;
    if (category && f.category !== category) return false;
    if (containerTag) {
      const tag = f.containerTag || GLOBAL_TAG;
      if (tag !== containerTag && !(includeGlobal && tag === GLOBAL_TAG)) return false;
    }
    return true;
  });
  return filtered.sort((a, b) => (b.lastAccessedAt || b.createdAt) - (a.lastAccessedAt || a.createdAt));
}

/** Convenience: build the conventional container tag for a project. */
export function projectContainerTag(projectId) {
  return projectId ? `project:${projectId}` : GLOBAL_TAG;
}

/** Convenience: build the conventional container tag for an agent. */
export function agentContainerTag(agentName) {
  return agentName ? `agent:${agentName}` : GLOBAL_TAG;
}

export { GLOBAL_TAG, KINDS };

export function getFact(id) {
  return _load().find(f => f.id === id) || null;
}

// ── Embeddings ────────────────────────────────────────────────
//
// Embeddings live alongside the fact for fast hybrid recall. They are
// optional — omitted facts fall back to keyword-only scoring in
// recallHybrid(). Writes are sync; producing the vector is the caller's
// responsibility (see server/lib/embeddings.js#embedText) since the AI
// call is async and we don't want to block remember().

/**
 * Attach (or replace) an embedding on an existing fact.
 * @param {string} id
 * @param {number[]} vector
 * @param {string} [model]
 * @returns {{ok: boolean, error?: string}}
 */
export function attachEmbedding(id, vector, model) {
  const facts = _load();
  const f = facts.find(x => x.id === id);
  if (!f) return { ok: false, error: 'Fact not found' };
  if (!Array.isArray(vector) || !vector.length) return { ok: false, error: 'Empty vector' };
  f.embedding = vector;
  if (model) f.embeddingModel = model;
  _save();
  return { ok: true };
}

/**
 * Return facts that have no embedding yet — used by backfill scripts and
 * the on-write embed hook to find pending work.
 */
export function listFactsWithoutEmbedding(opts = {}) {
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 100;
  return _load()
    .filter(f => !f.supersededBy && !Array.isArray(f.embedding))
    .slice(0, limit);
}

/**
 * Hybrid recall — blends lexical keyword scoring with cosine similarity
 * against a precomputed query vector. Facts without embeddings still
 * compete on the lexical side, so the function is safe to call even when
 * only some facts have been embedded.
 *
 * @param {string} keywords        free-text query (used for lexical pass)
 * @param {number[]|null} queryVec embedding of the query (or null to fall
 *                                  back to lexical-only)
 * @param {object} [opts]
 * @param {string}  [opts.containerTag]
 * @param {boolean} [opts.includeGlobal=true]
 * @param {string}  [opts.kind]
 * @param {number}  [opts.limit=20]
 * @param {number}  [opts.semanticWeight=0.6]  weight given to cosine vs lex
 * @returns {Fact[]}
 */
export function recallHybrid(keywords, queryVec, opts = {}) {
  const containerTag = opts.containerTag || null;
  const includeGlobal = opts.includeGlobal !== false;
  const kindFilter = opts.kind || null;
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 20;
  const semanticWeight = typeof opts.semanticWeight === 'number'
    ? Math.max(0, Math.min(1, opts.semanticWeight))
    : 0.6;
  const lexicalWeight = 1 - semanticWeight;
  const now = Date.now();

  const eligible = _load().filter(f => {
    if (f.supersededBy) return false;
    if (f.expiresAt && f.expiresAt <= now) return false;
    if (kindFilter && (f.kind || 'static') !== kindFilter) return false;
    if (containerTag) {
      const tag = f.containerTag || GLOBAL_TAG;
      if (tag !== containerTag && !(includeGlobal && tag === GLOBAL_TAG)) return false;
    }
    return true;
  });
  if (!eligible.length) return [];

  const hasQueryVec = Array.isArray(queryVec) && queryVec.length > 0;
  const terms = (keywords || '').toLowerCase().split(/\s+/).filter(Boolean);

  const scored = eligible.map(f => {
    // Lexical: term-hit count, normalized by term count so longer queries
    // don't dominate. Falls to 0 with no terms / no embedding—pure cosine.
    let lex = 0;
    if (terms.length) {
      const text = f.text.toLowerCase();
      let hits = 0;
      for (const t of terms) if (text.includes(t)) hits++;
      lex = hits / terms.length;
    }
    const sem = (hasQueryVec && Array.isArray(f.embedding))
      ? Math.max(0, cosine(queryVec, f.embedding))
      : 0;
    // Recency nudge — same shape as recall() so behavior is consistent.
    const daysSinceAccess = (now - (f.lastAccessedAt || f.createdAt)) / (1000 * 60 * 60 * 24);
    const recency = Math.max(0, 1 - daysSinceAccess / DECAY_DAYS) * 0.1;
    const blended = (lex * lexicalWeight) + (sem * semanticWeight) + recency;
    return { fact: f, score: blended, lex, sem };
  })
  .filter(s => s.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, limit);

  // Mark accessed (parity with recall())
  for (const s of scored) {
    s.fact.lastAccessedAt = now;
    s.fact.accessCount = (s.fact.accessCount || 0) + 1;
  }
  if (scored.length) _save();

  return scored.map(s => s.fact);
}

// ── Decay — remove facts not accessed within DECAY_DAYS ──────────────────

export function runDecay(maxAgeDays = DECAY_DAYS) {
  const facts = _load();
  const now = Date.now();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const before = facts.length;
  _facts = facts.filter(f => {
    // Temporal facts expire on their own clock, independent of access decay.
    if (f.expiresAt && f.expiresAt <= now) return false;
    // Superseded facts are kept briefly for audit, then decayed normally.
    return (f.lastAccessedAt || f.createdAt) > cutoff;
  });
  if (_facts.length < before) {
    _save();
    console.log(`[memory-store] Decayed ${before - _facts.length} facts (older than ${maxAgeDays} days or expired)`);
  }
  return { removed: before - _facts.length, remaining: _facts.length };
}

// ── System prompt injection ──────────────────────────────────────────────

/**
 * Format facts for system prompt injection.
 * Legacy:  formatForSystemPrompt(20)
 * New:     formatForSystemPrompt({ containerTag, limit, includeGlobal })
 */
export function formatForSystemPrompt(limitOrOpts = 20) {
  const opts = typeof limitOrOpts === 'number'
    ? { limit: limitOrOpts }
    : (limitOrOpts || {});
  const limit = typeof opts.limit === 'number' ? opts.limit : 20;
  const containerTag = opts.containerTag || null;
  const includeGlobal = opts.includeGlobal !== false;
  const now = Date.now();

  const facts = _load().filter(f => {
    if (f.supersededBy) return false;
    if (f.expiresAt && f.expiresAt <= now) return false;
    if (containerTag) {
      const tag = f.containerTag || GLOBAL_TAG;
      if (tag !== containerTag && !(includeGlobal && tag === GLOBAL_TAG)) return false;
    }
    return true;
  });
  if (!facts.length) return '';

  // Score by access recency + count
  const scored = facts.map(f => {
    const daysSinceAccess = (now - (f.lastAccessedAt || f.createdAt)) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1 - daysSinceAccess / DECAY_DAYS);
    const accessScore = Math.min(1, (f.accessCount || 0) / 10);
    return { fact: f, score: recencyScore * 0.7 + accessScore * 0.3 };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  if (!top.length) return '';

  const lines = top.map(s => `- [${s.fact.category}] ${s.fact.text}`);
  const header = containerTag && containerTag !== GLOBAL_TAG
    ? `\n\n## Remembered Facts (scope: ${containerTag})\n`
    : '\n\n## Remembered Facts About This User\n';
  return header + lines.join('\n');
}

// ── Import / Export ──────────────────────────────────────────────────────

export function exportFacts() {
  return _load();
}

export function importFacts(factsArray) {
  if (!Array.isArray(factsArray)) return { ok: false, error: 'Expected array' };
  // Validate and merge
  const existing = _load();
  let added = 0;
  for (const f of factsArray) {
    if (!f.text || !f.text.trim()) continue;
    const norm = _normalize(f.text);
    if (existing.some(e => _normalize(e.text) === norm)) continue;
    existing.push({
      id: f.id || _uid(),
      category: CATEGORIES.includes(f.category) ? f.category : 'fact',
      text: f.text.trim().slice(0, MAX_CHARS),
      createdAt: f.createdAt || Date.now(),
      lastAccessedAt: f.lastAccessedAt || Date.now(),
      accessCount: f.accessCount || 0,
    });
    added++;
  }
  // Trim to max
  if (existing.length > MAX_FACTS) {
    existing.sort((a, b) => (a.lastAccessedAt || a.createdAt) - (b.lastAccessedAt || b.createdAt));
    existing.splice(0, existing.length - MAX_FACTS);
  }
  _facts = existing;
  _save();
  return { ok: true, added, total: _facts.length };
}

// ── Stats ────────────────────────────────────────────────────────────────

export function getStats() {
  const facts = _load();
  const byCategory = {};
  for (const cat of CATEGORIES) byCategory[cat] = 0;
  for (const f of facts) byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  return {
    total: facts.length,
    maxFacts: MAX_FACTS,
    maxChars: MAX_CHARS,
    decayDays: DECAY_DAYS,
    byCategory,
    categories: CATEGORIES,
  };
}

// Force cache reload (for testing)
export function _resetCache() {
  _facts = null;
}

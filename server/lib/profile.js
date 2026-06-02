// ── Profile builder — assembles a query-aware "what fauna knows" snapshot ──
//
// Phase 4. A profile bundles three buckets the chat pipeline needs at the
// start of every turn:
//
//   1. static  — durable facts (kind=static). User identity, project tech
//                choices, decisions that don't expire. These rarely change.
//   2. dynamic — recent activity (kind=dynamic) and temporal facts that
//                are still valid (expiresAt > now). Re-computed per turn.
//   3. context — top-K passages from context-store matching the query.
//
// The static + dynamic split keeps the system prompt organized so the model
// can distinguish "what's true" from "what just happened" — supermemory's
// key insight: not all memory should be weighted the same.
//
// Cache: per-containerTag with a 60s TTL on the static slice. Dynamic and
// context are recomputed every call because they're query-dependent.

import { listFacts, recallHybrid, projectContainerTag, GLOBAL_TAG } from '../../memory-store.js';
import { searchContext } from './context-store.js';
import { embedText } from './embeddings.js';

const STATIC_TTL_MS    = 60 * 1000;     // 60s
const DEFAULT_STATIC   = 20;
const DEFAULT_DYNAMIC  = 10;
const DEFAULT_CONTEXT  = 6;

const _staticCache = new Map(); // key=containerTag -> { facts, expiresAt }

/**
 * Build a profile object for the given scope + optional query.
 *
 * @param {object} opts
 * @param {string} [opts.containerTag]      — defaults to GLOBAL_TAG
 * @param {boolean} [opts.includeGlobal=true]
 * @param {string} [opts.q]                  — query text for dynamic+context retrieval
 * @param {boolean} [opts.includeContext=true]
 * @param {number} [opts.staticLimit]
 * @param {number} [opts.dynamicLimit]
 * @param {number} [opts.contextLimit]
 * @param {Function} [opts.embedder]         — test hook
 * @returns {Promise<{containerTag, query, static, dynamic, context, generatedAt}>}
 */
export async function buildProfile(opts = {}) {
  const containerTag = opts.containerTag || GLOBAL_TAG;
  const includeGlobal = opts.includeGlobal !== false;
  const q = (opts.q || '').trim();
  const staticLimit  = opts.staticLimit  ?? DEFAULT_STATIC;
  const dynamicLimit = opts.dynamicLimit ?? DEFAULT_DYNAMIC;
  const contextLimit = opts.contextLimit ?? DEFAULT_CONTEXT;

  const staticFacts = _getStaticFacts(containerTag, includeGlobal, staticLimit);

  // Dynamic + temporal — query-aware via hybrid recall when a query exists,
  // otherwise the recent-by-access window. Embedding is best-effort.
  let queryVec = null;
  if (q) {
    try {
      queryVec = await embedText(q, { embedder: opts.embedder });
    } catch (_) { /* lexical-only fallback */ }
  }
  const dynamicSeed = q
    ? recallHybrid(q, queryVec, {
        containerTag, includeGlobal,
        limit: dynamicLimit * 2,    // overfetch, filter to non-static below
      })
    : listFacts({ containerTag, includeGlobal })
        .filter(f => (f.kind || 'static') !== 'static')
        .slice(0, dynamicLimit);
  const dynamic = dynamicSeed
    .filter(f => (f.kind || 'static') !== 'static')
    .slice(0, dynamicLimit);

  let context = [];
  if (q && opts.includeContext !== false) {
    try {
      const hits = await searchContext(q, {
        containerTag, includeGlobal,
        limit: contextLimit,
        embedder: opts.embedder,
      });
      context = hits.map(h => ({
        docId: h.chunk.docId,
        chunkId: h.chunk.id,
        score: Number(h.score.toFixed(4)),
        sourcePath: h.chunk.sourcePath,
        sourceType: h.chunk.sourceType,
        title: h.chunk.title,
        text: h.chunk.text,
      }));
    } catch (_) { /* soft-fail */ }
  }

  return {
    containerTag,
    query: q || null,
    static: staticFacts,
    dynamic,
    context,
    generatedAt: Date.now(),
  };
}

function _getStaticFacts(containerTag, includeGlobal, limit) {
  const cacheKey = `${containerTag}::${includeGlobal ? 1 : 0}::${limit}`;
  const now = Date.now();
  const hit = _staticCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.facts;

  const facts = listFacts({ containerTag, includeGlobal })
    .filter(f => (f.kind || 'static') === 'static')
    .slice(0, limit);
  _staticCache.set(cacheKey, { facts, expiresAt: now + STATIC_TTL_MS });
  return facts;
}

/**
 * Format a profile into a two-section system-prompt block. Designed to be
 * appended after the base system message in the chat pipeline.
 */
export function formatProfileForPrompt(profile) {
  if (!profile) return '';
  const parts = [];
  const scopeLabel = profile.containerTag && profile.containerTag !== GLOBAL_TAG
    ? ` (scope: ${profile.containerTag})`
    : '';

  if (profile.static && profile.static.length) {
    parts.push(`## Durable facts${scopeLabel}\n` +
      profile.static.map(f => `- [${f.category}] ${f.text}`).join('\n'));
  }
  if (profile.dynamic && profile.dynamic.length) {
    parts.push(`## Recent / time-bound\n` +
      profile.dynamic.map(f => `- [${f.category}${f.kind ? '/' + f.kind : ''}] ${f.text}`).join('\n'));
  }
  if (profile.context && profile.context.length) {
    parts.push(`## Relevant context passages\n` +
      profile.context.map((c, i) => {
        const head = c.sourcePath ? `(${c.sourcePath})` : `(${c.sourceType || 'note'})`;
        return `### Passage ${i + 1} ${head}\n${c.text}`;
      }).join('\n\n'));
  }
  return parts.length ? '\n\n' + parts.join('\n\n') : '';
}

/** Drop the static cache (after writes that may have changed durable facts). */
export function invalidateStaticCache(containerTag) {
  if (containerTag) {
    for (const k of _staticCache.keys()) {
      if (k.startsWith(containerTag + '::')) _staticCache.delete(k);
    }
  } else {
    _staticCache.clear();
  }
}

/** Convenience for project-scoped callers. */
export function buildProjectProfile(projectId, opts = {}) {
  return buildProfile({ ...opts, containerTag: projectContainerTag(projectId) });
}

export const _internals = { _staticCache, STATIC_TTL_MS };

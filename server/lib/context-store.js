// ── Context store — persistent embedded document chunks ────────────────────
//
// Phase 3. Complements memory-store.js: facts are short, hand-curated truths;
// context chunks are longer passages from ingested documents (README, design
// docs, source files, web pages…) that we semantically search to ground
// replies. Both live in ~/.config/fauna/ and share the embedding cache.
//
// Storage: ~/.config/fauna/context-chunks.json  (single JSON file, fine for
// the ~thousands-of-chunks scale we target before introducing sqlite).
//
// Schema per chunk:
//   {
//     id, docId, sourceId, sourceType, sourcePath, title,
//     index, text, start, end, containerTag,
//     embedding?, embeddingModel?, createdAt
//   }
//
// `docId` groups all chunks from one ingestion call so we can replace or
// delete a document atomically.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { chunkText } from './chunker.js';
import { embedTexts, DEFAULT_EMBED_MODEL, prepareQuery, scoreStored, hasEmbedding, prepareForStorage } from './embeddings.js';

const CONFIG_DIR  = path.join(os.homedir(), '.config', 'fauna');
const CHUNKS_FILE = path.join(CONFIG_DIR, 'context-chunks.json');
const MAX_CHUNKS  = 5000;       // safety cap; FIFO trim by createdAt
const GLOBAL_TAG  = 'global';

let _chunks = null;

function _load() {
  if (_chunks) return _chunks;
  try {
    const raw = JSON.parse(fs.readFileSync(CHUNKS_FILE, 'utf8'));
    _chunks = Array.isArray(raw) ? raw : [];
  } catch (_) {
    _chunks = [];
  }
  return _chunks;
}

function _save() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CHUNKS_FILE, JSON.stringify(_chunks));
  } catch (e) {
    console.warn('[context-store] write failed:', e.message);
  }
}

function _uid(prefix = 'cnk') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function _docIdFor(sourceId, sourcePath) {
  // Stable hash so re-ingesting the same source replaces the same docId.
  const key = `${sourceId || ''}::${sourcePath || ''}`;
  return 'doc-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/**
 * Ingest a document — chunk, embed, persist, and replace any prior chunks
 * for the same (sourceId|sourcePath).
 *
 * @param {object} input
 * @param {string} input.text                  required raw text
 * @param {string} [input.sourceId]            stable id (e.g. file abspath or URL)
 * @param {string} [input.sourceType]          'file'|'url'|'note'|'pasted'
 * @param {string} [input.sourcePath]          display path
 * @param {string} [input.title]
 * @param {string} [input.containerTag]        scoping (defaults to 'global')
 * @param {object} [input.chunkOpts]           passed to chunker
 * @param {object} [opts]
 * @param {string}   [opts.model]
 * @param {Function} [opts.embedder]           override for tests
 * @returns {Promise<{ok:boolean, docId?:string, added?:number, replaced?:number, error?:string}>}
 */
export async function ingestDocument(input, opts = {}) {
  if (!input || !input.text || !String(input.text).trim()) {
    return { ok: false, error: 'text is required' };
  }
  const containerTag = input.containerTag || GLOBAL_TAG;
  const sourceId    = input.sourceId    || input.sourcePath || _uid('src');
  const sourcePath  = input.sourcePath  || null;
  const sourceType  = input.sourceType  || 'note';
  const title       = input.title       || null;
  const docId       = _docIdFor(sourceId, sourcePath);
  const model       = opts.model || DEFAULT_EMBED_MODEL;

  const pieces = chunkText(input.text, input.chunkOpts || {});
  if (!pieces.length) return { ok: false, error: 'empty after chunking' };

  let vectors;
  try {
    vectors = await embedTexts(pieces.map(p => p.text), { model, embedder: opts.embedder });
  } catch (e) {
    return { ok: false, error: `embedding failed: ${e.message}` };
  }

  const now = Date.now();
  const newChunks = pieces.map((p, i) => ({
    id: _uid(),
    docId,
    sourceId,
    sourceType,
    sourcePath,
    title,
    index: p.index,
    text: p.text,
    start: p.start,
    end: p.end,
    containerTag,
    embedding: vectors[i] ? prepareForStorage(vectors[i]) : null,
    embeddingModel: model,
    createdAt: now,
  }));

  const all = _load();
  // Replace existing chunks for this docId atomically.
  const replaced = all.filter(c => c.docId === docId).length;
  _chunks = all.filter(c => c.docId !== docId).concat(newChunks);

  // FIFO trim if we blew the cap (very large libraries).
  if (_chunks.length > MAX_CHUNKS) {
    _chunks.sort((a, b) => a.createdAt - b.createdAt);
    _chunks.splice(0, _chunks.length - MAX_CHUNKS);
  }
  _save();
  return { ok: true, docId, added: newChunks.length, replaced };
}

/**
 * Semantic + lexical search over context chunks.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {number[]} [args.queryVec]      precomputed query embedding
 * @param {string}   [args.containerTag]
 * @param {boolean}  [args.includeGlobal=true]
 * @param {number}   [args.limit=8]
 * @param {number}   [args.semanticWeight=0.7]
 * @param {Iterable<string>} [args.allowlist]  restrict the dense rerank to
 *        these chunk ids or docIds (a candidate set from another system).
 * @returns {Array<{chunk:object, score:number, lex:number, sem:number}>}
 */
export function searchChunks(args = {}) {
  const {
    query = '',
    queryVec = null,
    containerTag = null,
    includeGlobal = true,
    limit = 8,
    semanticWeight = 0.7,
  } = args;
  const lexicalWeight = 1 - Math.max(0, Math.min(1, semanticWeight));
  const semW = 1 - lexicalWeight;

  const allowSet = args.allowlist != null
    ? (args.allowlist instanceof Set ? args.allowlist : new Set(args.allowlist))
    : null;

  const all = _load().filter(c => {
    if (allowSet && !allowSet.has(c.id) && !allowSet.has(c.docId)) return false;
    if (!containerTag) return true;
    const tag = c.containerTag || GLOBAL_TAG;
    return tag === containerTag || (includeGlobal && tag === GLOBAL_TAG);
  });
  if (!all.length) return [];

  const hasQueryVec = Array.isArray(queryVec) && queryVec.length > 0;
  const prepared = hasQueryVec ? prepareQuery(queryVec) : null;
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);

  const scored = all.map(c => {
    let lex = 0;
    if (terms.length) {
      const text = c.text.toLowerCase();
      let hits = 0;
      for (const t of terms) if (text.includes(t)) hits++;
      lex = hits / terms.length;
    }
    const sem = (prepared && hasEmbedding(c.embedding))
      ? Math.max(0, scoreStored(prepared, c.embedding))
      : 0;
    const blended = (lex * lexicalWeight) + (sem * semW);
    return { chunk: c, score: blended, lex, sem };
  })
  .filter(s => s.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, limit);

  return scored;
}

/**
 * High-level helper used by the chat pipeline and the fauna_context_search
 * tool. Embeds the query (cache-aware) then runs hybrid search.
 */
export async function searchContext(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  let queryVec = null;
  try {
    const [v] = await embedTexts([q], { model: opts.model, embedder: opts.embedder });
    queryVec = v || null;
  } catch (e) {
    // Soft-fail to lexical-only; semantic-less search is still useful.
    console.warn('[context-store] embed query failed, lexical-only:', e.message);
  }
  return searchChunks({ ...opts, query: q, queryVec });
}

export function listDocuments(opts = {}) {
  const { containerTag = null, includeGlobal = true } = opts;
  const all = _load();
  const byDoc = new Map();
  for (const c of all) {
    if (containerTag) {
      const tag = c.containerTag || GLOBAL_TAG;
      if (tag !== containerTag && !(includeGlobal && tag === GLOBAL_TAG)) continue;
    }
    const entry = byDoc.get(c.docId) || {
      docId: c.docId, sourceId: c.sourceId, sourcePath: c.sourcePath,
      sourceType: c.sourceType, title: c.title, containerTag: c.containerTag,
      chunks: 0, createdAt: c.createdAt,
    };
    entry.chunks++;
    entry.createdAt = Math.min(entry.createdAt, c.createdAt);
    byDoc.set(c.docId, entry);
  }
  return Array.from(byDoc.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function getDocumentChunks(docId) {
  return _load()
    .filter(c => c.docId === docId)
    .sort((a, b) => a.index - b.index);
}

export function deleteDocument(docId) {
  const before = _load().length;
  _chunks = _load().filter(c => c.docId !== docId);
  const removed = before - _chunks.length;
  if (removed) _save();
  return { ok: true, removed };
}

export function getStats() {
  const all = _load();
  const docIds = new Set(all.map(c => c.docId));
  return {
    chunks: all.length,
    documents: docIds.size,
    maxChunks: MAX_CHUNKS,
    file: CHUNKS_FILE,
  };
}

// Test hook
export function _resetCache() { _chunks = null; }

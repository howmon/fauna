// ── Memory Extractor — Auto-extract facts from conversation turns ──
//
// Replaces the "model must remember to call fauna_remember" pattern with a
// background pass that scans recent turns and proposes facts. Proposals are
// persisted to a queue; auto-approved by default unless the project sets
// `memoryConfig.requireApproval: true`.
//
// Wired in:
//   - server/routes/chat.js (end-of-loop, fire-and-forget)
//   - server/routes/conversations.js (on PUT save, debounced)
//
// Uses the same internalAICaller as heartbeat/workflows — single LLM call
// per extraction with structured JSON output. Cheap enough to run per turn,
// configurable via per-project `memoryConfig.autoExtract`.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { remember, listFacts, projectContainerTag } from '../../memory-store.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const PROPOSALS_FILE = path.join(CONFIG_DIR, 'memory-proposals.json');

const MAX_PROPOSALS  = 500;     // cap on pending+recent proposals retained
const MAX_TURN_CHARS = 12000;   // truncate conversation snippet sent to LLM
const SIMILARITY_THRESHOLD = 0.6; // Jaccard threshold for contradiction match.
                                  // Tuned for short fact texts after stop-word
                                  // filtering — 0.6 catches "lives in NYC" vs
                                  // "lives in NYC suburbs" without falsing on
                                  // unrelated short facts.

// ── Persistence ──────────────────────────────────────────────────────────

/** @type {Array<Proposal>|null} */
let _proposals = null;

/**
 * @typedef {{
 *   id: string,
 *   text: string,
 *   category: 'preference'|'fact'|'decision'|'context',
 *   kind: 'static'|'dynamic'|'temporal',
 *   expiresAt?: number,
 *   containerTag: string,
 *   supersedes?: string,
 *   sourceTurnId?: string,
 *   conversationId?: string,
 *   projectId?: string,
 *   status: 'pending'|'approved'|'rejected',
 *   createdAt: number,
 *   resolvedAt?: number,
 *   resolvedFactId?: string,
 * }} Proposal
 */

function _loadProposals() {
  if (_proposals) return _proposals;
  try {
    const raw = JSON.parse(fs.readFileSync(PROPOSALS_FILE, 'utf8'));
    _proposals = Array.isArray(raw) ? raw : [];
  } catch (_) {
    _proposals = [];
  }
  return _proposals;
}

function _saveProposals() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(_proposals, null, 2));
}

function _uid() {
  return 'prop-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// ── Test hook ────────────────────────────────────────────────────────────

export function _resetProposalsCache() {
  _proposals = null;
}

// ── Prompt construction ──────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You extract durable facts from a conversation between a user and an AI assistant.

Output ONLY a JSON object matching this schema (no prose, no markdown fences):
{
  "facts": [
    {
      "text": "string, <= 300 chars, third-person about the user or project",
      "category": "preference" | "fact" | "decision" | "context",
      "kind": "static" | "dynamic" | "temporal",
      "expiresAt": <unix-ms> (only when kind=temporal)
    }
  ]
}

Rules:
- Extract durable signal only. Skip pleasantries, restated questions, generic AI explanations.
- "preference": stable user choices ("prefers TypeScript", "uses Vim").
- "decision": commitments made ("decided to use Postgres for X").
- "fact": stable truths ("works at Acme", "the API gateway is in /api/v2").
- "context": recent activity worth remembering for ~1 week ("debugging the auth flow").
- "temporal": time-bound facts. Set expiresAt to when the fact becomes irrelevant.
  Example: "user has an exam on June 5" → expiresAt: <ms-after-June-5>.
- kind="static" for preferences/long-term facts; "dynamic" for recent activity;
  "temporal" for anything with an expiry.
- If existing facts are listed, prefer not to duplicate them. If a fact CONTRADICTS
  an existing one, emit a new fact and add "supersedes": "<existing-id>".
- If nothing durable was shared, return {"facts": []}.
- Maximum 5 facts per extraction. Be conservative — fewer better facts beat more noise.`;

function _formatConversationSnippet(messages, limit = 8) {
  const tail = messages.slice(-limit);
  let chars = 0;
  const lines = [];
  for (const m of tail) {
    if (!m || !m.role || !m.content) continue;
    if (m.role === 'system') continue;
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(p => p?.text || '').filter(Boolean).join(' ')
        : JSON.stringify(m.content);
    const line = `${m.role.toUpperCase()}: ${content}`;
    chars += line.length;
    if (chars > MAX_TURN_CHARS) {
      lines.push('[earlier turns truncated]');
      break;
    }
    lines.push(line);
  }
  return lines.reverse().reverse().join('\n\n'); // preserve original order
}

function _formatExistingFacts(facts) {
  if (!facts.length) return '(no existing facts in this scope)';
  return facts.slice(0, 30).map(f => `- [${f.id}] [${f.category}] ${f.text}`).join('\n');
}

// ── Similarity (Jaccard over normalized word tokens) ─────────────────────

function _tokenize(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
  );
}

function _jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Look up the closest existing fact in the same container.
 * Returns the existing fact id when similarity ≥ threshold, else null.
 */
function _findContradictionTarget(text, existingFacts) {
  const cand = _tokenize(text);
  let best = { id: null, score: 0 };
  for (const f of existingFacts) {
    const score = _jaccard(cand, _tokenize(f.text));
    if (score > best.score) best = { id: f.id, score };
  }
  return best.score >= SIMILARITY_THRESHOLD ? best.id : null;
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Extract facts from a conversation snippet. Returns an array of proposals
 * (already persisted to the queue). Caller decides whether to auto-apply.
 *
 * @param {{
 *   messages: Array<{role: string, content: any}>,
 *   projectId?: string|null,
 *   conversationId?: string|null,
 *   aiCaller: (prompt: string, model?: string) => Promise<string>,
 *   model?: string,
 *   autoApprove?: boolean,
 * }} opts
 * @returns {Promise<{proposals: Proposal[], applied: number, skipped: number}>}
 */
export async function extractFacts(opts) {
  const {
    messages = [],
    projectId = null,
    conversationId = null,
    aiCaller,
    model,
    autoApprove = true,
  } = opts || {};

  if (typeof aiCaller !== 'function') {
    return { proposals: [], applied: 0, skipped: 0, error: 'no aiCaller' };
  }
  if (!Array.isArray(messages) || messages.length < 2) {
    return { proposals: [], applied: 0, skipped: 0 };
  }

  const containerTag = projectId ? projectContainerTag(projectId) : 'global';
  const existing = listFacts({ containerTag, includeGlobal: false });

  const snippet = _formatConversationSnippet(messages, 10);
  if (!snippet.trim()) return { proposals: [], applied: 0, skipped: 0 };

  const prompt =
    EXTRACTION_SYSTEM_PROMPT + '\n\n' +
    `Container: ${containerTag}\n` +
    `Current time (unix ms): ${Date.now()}\n\n` +
    '## Existing facts in this scope\n' + _formatExistingFacts(existing) + '\n\n' +
    '## Conversation\n' + snippet + '\n\n' +
    'Output the JSON object now:';

  let raw;
  try {
    raw = await aiCaller(prompt, model);
  } catch (e) {
    console.warn('[memory-extractor] aiCaller failed:', e?.message || e);
    return { proposals: [], applied: 0, skipped: 0, error: e?.message || String(e) };
  }

  const parsed = _parseExtractionResponse(raw);
  if (!parsed || !Array.isArray(parsed.facts)) {
    return { proposals: [], applied: 0, skipped: 0 };
  }

  const created = [];
  const proposals = _loadProposals();
  let applied = 0;
  let skipped = 0;

  for (const f of parsed.facts.slice(0, 5)) {
    if (!f || typeof f.text !== 'string') { skipped++; continue; }
    const text = f.text.trim();
    if (!text || text.length > 500) { skipped++; continue; }

    // Resolve contradictions: model-suggested supersedes OR similarity match.
    let supersedes = typeof f.supersedes === 'string' ? f.supersedes : null;
    if (!supersedes) supersedes = _findContradictionTarget(text, existing);
    if (supersedes && !existing.some(e => e.id === supersedes)) supersedes = null;

    const proposal = {
      id: _uid(),
      text,
      category: ['preference','fact','decision','context'].includes(f.category) ? f.category : 'fact',
      kind: ['static','dynamic','temporal'].includes(f.kind) ? f.kind : 'static',
      ...(typeof f.expiresAt === 'number' && f.expiresAt > Date.now() ? { expiresAt: f.expiresAt } : {}),
      containerTag,
      ...(supersedes ? { supersedes } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(projectId ? { projectId } : {}),
      status: 'pending',
      createdAt: Date.now(),
    };

    proposals.push(proposal);
    created.push(proposal);

    if (autoApprove) {
      const r = remember(proposal.text, {
        category: proposal.category,
        containerTag: proposal.containerTag,
        kind: proposal.kind,
        expiresAt: proposal.expiresAt,
        supersedes: proposal.supersedes,
        sourceTurnId: conversationId || undefined,
      });
      if (r.ok) {
        proposal.status = 'approved';
        proposal.resolvedAt = Date.now();
        proposal.resolvedFactId = r.id;
        applied++;
      } else {
        proposal.status = 'rejected';
        proposal.resolvedAt = Date.now();
        proposal.rejectReason = r.error;
        skipped++;
      }
    }
  }

  // Cap queue size; drop oldest resolved proposals first.
  if (proposals.length > MAX_PROPOSALS) {
    proposals.sort((a, b) => {
      const aPending = a.status === 'pending' ? 1 : 0;
      const bPending = b.status === 'pending' ? 1 : 0;
      if (aPending !== bPending) return bPending - aPending; // keep pending
      return (b.resolvedAt || b.createdAt) - (a.resolvedAt || a.createdAt);
    });
    proposals.splice(MAX_PROPOSALS);
  }

  _saveProposals();
  return { proposals: created, applied, skipped };
}

function _parseExtractionResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip code fences if present.
  let body = raw.trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();
  // Find first {...} block.
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

// ── Proposals queue API ──────────────────────────────────────────────────

export function listProposals(opts = {}) {
  const { status = null, projectId = null, limit = 100 } = opts;
  const all = _loadProposals();
  return all
    .filter(p => (!status || p.status === status))
    .filter(p => (!projectId || p.projectId === projectId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function approveProposal(id) {
  const all = _loadProposals();
  const p = all.find(x => x.id === id);
  if (!p) return { ok: false, error: 'Proposal not found' };
  if (p.status !== 'pending') return { ok: false, error: `Already ${p.status}` };
  const r = remember(p.text, {
    category: p.category,
    containerTag: p.containerTag,
    kind: p.kind,
    expiresAt: p.expiresAt,
    supersedes: p.supersedes,
  });
  if (!r.ok) return { ok: false, error: r.error };
  p.status = 'approved';
  p.resolvedAt = Date.now();
  p.resolvedFactId = r.id;
  _saveProposals();
  return { ok: true, factId: r.id };
}

export function rejectProposal(id, reason) {
  const all = _loadProposals();
  const p = all.find(x => x.id === id);
  if (!p) return { ok: false, error: 'Proposal not found' };
  if (p.status !== 'pending') return { ok: false, error: `Already ${p.status}` };
  p.status = 'rejected';
  p.resolvedAt = Date.now();
  if (reason) p.rejectReason = String(reason).slice(0, 200);
  _saveProposals();
  return { ok: true };
}

export function getProposalStats() {
  const all = _loadProposals();
  const byStatus = { pending: 0, approved: 0, rejected: 0 };
  for (const p of all) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  return { total: all.length, byStatus, max: MAX_PROPOSALS };
}

// Exported for tests
export const _internals = {
  _parseExtractionResponse,
  _findContradictionTarget,
  _jaccard,
  _tokenize,
  SIMILARITY_THRESHOLD,
};

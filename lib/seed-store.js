// lib/seed-store.js
// Feature B1/B2 — Interview + Seed + ambiguity gate (ouroboros-inspired).
//
// Before an autonomous run (or promoting an under-specified Kanban card) the
// agent runs a short Socratic interview, then freezes an immutable *Seed*: the
// contract the evaluator later checks against. A Seed captures the goal,
// acceptance criteria, constraints, and a small ontology of key terms, plus an
// ambiguity score. Code work is gated until the ambiguity score drops below a
// threshold (ouroboros uses ≤0.2) so the loop never runs off a vague prompt.
//
// The ambiguity score here is a DETERMINISTIC heuristic — no LLM required — so
// it is offline-testable and cheap. A model can refine it later, but the
// heuristic is the reliable floor: it rewards concrete acceptance criteria and
// penalises hedging language and unanswered questions.
//
// Seeds are immutable once created: persisted as read-only JSON under
// ~/.config/fauna/seeds/<id>.json. Re-planning creates a NEW seed (lineage via
// `supersedes`), never mutates an old one.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME = process.env.HOME || process.env.USERPROFILE || '';

export function defaultSeedDir() {
  return path.join(HOME, '.config', 'fauna', 'seeds');
}

// ── Ambiguity scoring (deterministic heuristic, 0 = crystal clear, 1 = vague) ─

// Hedging / vagueness markers that signal an under-specified goal.
const VAGUE_TERMS = [
  'maybe', 'somehow', 'etc', 'and so on', 'improve', 'better', 'nicer', 'clean up',
  'some', 'stuff', 'things', 'various', 'appropriate', 'reasonable', 'as needed',
  'or something', 'ideally', 'probably', 'might', 'kind of', 'sort of', 'tbd',
  'good', 'nice', 'fast', 'robust', 'flexible', 'scalable',
];

function _countVague(text) {
  const t = String(text || '').toLowerCase();
  let n = 0;
  for (const term of VAGUE_TERMS) {
    // Word-boundary-ish match for single words; substring for phrases.
    const re = term.includes(' ')
      ? new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      : new RegExp(`\\b${term}\\b`, 'g');
    const m = t.match(re);
    if (m) n += m.length;
  }
  return n;
}

// Score how ambiguous a (proto-)spec is. Lower is clearer.
//   input: { goal, acceptanceCriteria[], constraints[], ontology[], openQuestions[] }
// openQuestions are UNANSWERED clarifications — each one raises ambiguity.
export function scoreAmbiguity(input = {}) {
  const goal = String(input.goal || '').trim();
  const criteria = Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.filter(Boolean) : [];
  const constraints = Array.isArray(input.constraints) ? input.constraints.filter(Boolean) : [];
  const ontology = Array.isArray(input.ontology) ? input.ontology.filter(Boolean) : [];
  const openQuestions = Array.isArray(input.openQuestions) ? input.openQuestions.filter(Boolean) : [];

  let score = 0.6; // base: an unqualified goal is fairly ambiguous.

  // Concrete acceptance criteria are the strongest clarity signal.
  score -= Math.min(0.35, criteria.length * 0.14);
  // Constraints and an explicit ontology reduce ambiguity.
  if (constraints.length) score -= Math.min(0.12, constraints.length * 0.06);
  if (ontology.length) score -= Math.min(0.12, ontology.length * 0.04);

  // A goal that is present and reasonably specified helps; empty or ultra-short
  // goals are very ambiguous.
  if (!goal) score += 0.3;
  else if (goal.length < 15) score += 0.2;
  else if (goal.length >= 30) score -= 0.08;

  // Hedging language raises ambiguity.
  score += Math.min(0.3, _countVague(goal) * 0.1);
  // Unanswered questions raise ambiguity sharply.
  score += Math.min(0.4, openQuestions.length * 0.15);

  return +Math.max(0, Math.min(1, score)).toFixed(3);
}

// Does this proto-spec clear the ambiguity gate?
export function passesAmbiguityGate(input, threshold = 0.2) {
  return scoreAmbiguity(input) <= threshold;
}

// ── Socratic interview question generation ───────────────────────────────────

// Produce clarifying questions targeting whatever is missing. Deterministic and
// dependency-free; a model can add domain-specific ones on top.
export function interviewQuestions(input = {}) {
  const goal = String(input.goal || '').trim();
  const criteria = Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.filter(Boolean) : [];
  const constraints = Array.isArray(input.constraints) ? input.constraints.filter(Boolean) : [];
  const qs = [];

  if (!goal || goal.length < 15) {
    qs.push('What exactly are you trying to accomplish? State the goal in one concrete sentence.');
  }
  if (!criteria.length) {
    qs.push('How will we know it is done? List the observable acceptance criteria.');
  } else if (criteria.length < 2) {
    qs.push('Are there other success conditions beyond the one criterion listed? What must NOT break?');
  }
  if (!constraints.length) {
    qs.push('What is out of scope, and are there constraints (perf, compatibility, files not to touch)?');
  }
  const vague = _countVague(goal);
  if (vague > 0) {
    qs.push('The goal contains vague terms — can you make them measurable (e.g. define "fast", "better", "clean")?');
  }
  if (!qs.length) {
    qs.push('Any hidden assumptions or edge cases I should confirm before starting?');
  }
  return qs;
}

// ── Seed persistence (immutable) ─────────────────────────────────────────────

function _slug(s) {
  return String(s || 'seed').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'seed';
}

// Freeze a Seed. Throws if the ambiguity gate isn't cleared, unless
// `opts.force` is set (e.g. the user explicitly accepts the risk).
//   spec: { goal, acceptanceCriteria[], constraints[], ontology[], projectId?, supersedes? }
//   opts: { dir?, threshold?, force? }
export function createSeed(spec = {}, opts = {}) {
  const dir = opts.dir || defaultSeedDir();
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.2;
  const ambiguity = scoreAmbiguity(spec);

  if (ambiguity > threshold && !opts.force) {
    return {
      ok: false,
      blocked: true,
      ambiguityScore: ambiguity,
      threshold,
      questions: interviewQuestions(spec),
      error: `Ambiguity ${ambiguity} exceeds gate ${threshold}. Answer the interview questions and try again, or pass force:true.`,
    };
  }

  const id = `${Date.now().toString(36)}-${_slug(spec.goal)}-${crypto.randomBytes(3).toString('hex')}`;
  const seed = {
    id,
    createdAt: new Date().toISOString(),
    immutable: true,
    goal: String(spec.goal || '').trim(),
    acceptanceCriteria: Array.isArray(spec.acceptanceCriteria) ? spec.acceptanceCriteria.filter(Boolean) : [],
    constraints: Array.isArray(spec.constraints) ? spec.constraints.filter(Boolean) : [],
    ontology: Array.isArray(spec.ontology) ? spec.ontology.filter(Boolean) : [],
    projectId: spec.projectId || null,
    supersedes: spec.supersedes || null,
    ambiguityScore: ambiguity,
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(seed, null, 2), { mode: 0o440 });
    return { ok: true, seed, path: file };
  } catch (e) {
    return { ok: false, error: `Failed to persist seed: ${e?.message || String(e)}` };
  }
}

export function getSeed(id, opts = {}) {
  const dir = opts.dir || defaultSeedDir();
  const safe = String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${safe}.json`), 'utf8'));
  } catch (_) {
    return null;
  }
}

export function listSeeds(opts = {}) {
  const dir = opts.dir || defaultSeedDir();
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ id: s.id, goal: s.goal, createdAt: s.createdAt, ambiguityScore: s.ambiguityScore, projectId: s.projectId });
    } catch (_) { /* skip corrupt */ }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

export default {
  defaultSeedDir, scoreAmbiguity, passesAmbiguityGate, interviewQuestions,
  createSeed, getSeed, listSeeds,
};

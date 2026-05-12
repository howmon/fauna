// ── Structured Memory Store — Persistent facts with decay and recall scoring ──
// Complements the existing category/skill memory system.
// Stores individual facts the AI learns about the user, project preferences,
// decisions, and context — with automatic decay of unused entries.
//
// Persists to ~/.config/fauna/facts.json

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR  = path.join(os.homedir(), '.config', 'fauna');
const FACTS_FILE  = path.join(CONFIG_DIR, 'facts.json');
const MAX_FACTS   = 200;
const MAX_CHARS   = 500;
const DECAY_DAYS  = 60;
const CATEGORIES  = ['preference', 'fact', 'decision', 'context'];

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

export function remember(text, category = 'fact') {
  const facts = _load();
  const trimmed = (text || '').trim();
  if (!trimmed) return { ok: false, error: 'Empty text' };
  if (trimmed.length > MAX_CHARS) return { ok: false, error: `Text exceeds ${MAX_CHARS} characters (got ${trimmed.length})` };
  if (!CATEGORIES.includes(category)) return { ok: false, error: `Invalid category. Use: ${CATEGORIES.join(', ')}` };

  // Dedup: check for exact normalized match
  const norm = _normalize(trimmed);
  const existing = facts.find(f => _normalize(f.text) === norm);
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
    text: trimmed,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
  };
  facts.push(fact);
  _save();
  return { ok: true, id: fact.id, deduplicated: false };
}

export function recall(keywords) {
  const facts = _load();
  if (!keywords || !keywords.trim()) {
    // Return top 20 by recency
    return facts
      .slice()
      .sort((a, b) => (b.lastAccessedAt || b.createdAt) - (a.lastAccessedAt || a.createdAt))
      .slice(0, 20)
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
  const results = scored.slice(0, 20).map(s => s.fact);

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

export function listFacts(category = null) {
  const facts = _load();
  const filtered = category ? facts.filter(f => f.category === category) : facts;
  return filtered.sort((a, b) => (b.lastAccessedAt || b.createdAt) - (a.lastAccessedAt || a.createdAt));
}

export function getFact(id) {
  return _load().find(f => f.id === id) || null;
}

// ── Decay — remove facts not accessed within DECAY_DAYS ──────────────────

export function runDecay(maxAgeDays = DECAY_DAYS) {
  const facts = _load();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const before = facts.length;
  _facts = facts.filter(f => (f.lastAccessedAt || f.createdAt) > cutoff);
  if (_facts.length < before) {
    _save();
    console.log(`[memory-store] Decayed ${before - _facts.length} facts (older than ${maxAgeDays} days)`);
  }
  return { removed: before - _facts.length, remaining: _facts.length };
}

// ── System prompt injection ──────────────────────────────────────────────

export function formatForSystemPrompt(limit = 20) {
  const facts = _load();
  if (!facts.length) return '';

  // Score by access recency + count
  const scored = facts.map(f => {
    const daysSinceAccess = (Date.now() - (f.lastAccessedAt || f.createdAt)) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1 - daysSinceAccess / DECAY_DAYS);
    const accessScore = Math.min(1, (f.accessCount || 0) / 10);
    return { fact: f, score: recencyScore * 0.7 + accessScore * 0.3 };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  if (!top.length) return '';

  const lines = top.map(s => `- [${s.fact.category}] ${s.fact.text}`);
  return '\n\n## Remembered Facts About This User\n' + lines.join('\n');
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

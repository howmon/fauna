// ── Playbook Store — Persistent saved widgets/skills the AI can re-mount ──
// A "playbook entry" is a reusable Dynamic-Widget bundle: HTML/CSS/JS + a
// manifest of ephemeral tools the widget exposes. Once saved, the AI can
// recall it by name and re-emit the same widget on a future task.
//
// Persists to ~/.config/fauna/playbooks.json

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const MAX_ENTRIES    = 100;
const MAX_BUNDLE_KB  = 256;          // per-entry cap
const MAX_TOOLS      = 12;            // per widget

function _playbookFile() {
  return process.env.FAUNA_PLAYBOOK_FILE ||
    path.join(os.homedir(), '.config', 'fauna', 'playbooks.json');
}

/**
 * @typedef {{
 *   name: string,
 *   description?: string,
 *   parameters?: object,
 * }} WidgetToolDef
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   tags: string[],
 *   bundle: { html: string, css?: string, js: string },
 *   tools: WidgetToolDef[],
 *   createdAt: number,
 *   lastUsedAt: number,
 *   useCount: number,
 * }} PlaybookEntry
 */

let _entries = null;

function _load() {
  if (_entries) return _entries;
  try {
    const raw = JSON.parse(fs.readFileSync(_playbookFile(), 'utf8'));
    _entries = Array.isArray(raw) ? raw : [];
  } catch (_) {
    _entries = [];
  }
  return _entries;
}

function _save() {
  const file = _playbookFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(_entries, null, 2));
}

function _uid() {
  return 'pb-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function _bundleSize(bundle) {
  const html = String(bundle?.html || '');
  const css  = String(bundle?.css || '');
  const js   = String(bundle?.js  || '');
  return Buffer.byteLength(html + css + js, 'utf8');
}

function _validateTools(tools) {
  if (!Array.isArray(tools)) throw new Error('tools must be an array');
  if (tools.length > MAX_TOOLS) throw new Error(`Too many tools (max ${MAX_TOOLS})`);
  const seen = new Set();
  for (const t of tools) {
    if (!t || typeof t.name !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/i.test(t.name)) {
      throw new Error(`Invalid tool name: ${t?.name}`);
    }
    if (seen.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    seen.add(t.name);
    if (t.parameters && typeof t.parameters !== 'object') {
      throw new Error(`tool "${t.name}".parameters must be an object`);
    }
  }
}

/** @param {Omit<PlaybookEntry,'id'|'createdAt'|'lastUsedAt'|'useCount'>} input */
export function savePlaybookEntry(input) {
  const entries = _load();
  if (!input?.name || typeof input.name !== 'string') throw new Error('name required');
  if (!input.bundle || typeof input.bundle !== 'object') throw new Error('bundle required');
  if (typeof input.bundle.html !== 'string' || typeof input.bundle.js !== 'string') {
    throw new Error('bundle.html and bundle.js are required strings');
  }
  const size = _bundleSize(input.bundle);
  if (size > MAX_BUNDLE_KB * 1024) {
    throw new Error(`Bundle too large: ${(size/1024).toFixed(1)} KB > ${MAX_BUNDLE_KB} KB`);
  }
  _validateTools(input.tools || []);

  // Dedup by name (case-insensitive) — replace existing entry to allow updates
  const idx = entries.findIndex(e => e.name.toLowerCase() === input.name.trim().toLowerCase());
  const now = Date.now();
  const entry = {
    id: idx >= 0 ? entries[idx].id : _uid(),
    name: input.name.trim(),
    description: (input.description || '').trim(),
    tags: Array.isArray(input.tags) ? input.tags.filter(t => typeof t === 'string').slice(0, 8) : [],
    bundle: { html: input.bundle.html, css: input.bundle.css || '', js: input.bundle.js },
    tools: (input.tools || []).map(t => ({
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    })),
    createdAt: idx >= 0 ? entries[idx].createdAt : now,
    lastUsedAt: now,
    useCount: idx >= 0 ? entries[idx].useCount : 0,
  };

  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);

  // Evict oldest if we exceed MAX_ENTRIES (LRU by lastUsedAt)
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    entries.length = MAX_ENTRIES;
  }

  _save();
  return { ok: true, id: entry.id, replaced: idx >= 0 };
}

export function listPlaybookEntries({ tag = null, query = null } = {}) {
  const entries = _load();
  const q = query ? String(query).toLowerCase() : null;
  return entries
    .filter(e => !tag || e.tags.includes(tag))
    .filter(e => !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .map(({ bundle, ...meta }) => ({
      ...meta,
      toolNames: (meta.tools || []).map(t => t.name),
      bundleSize: _bundleSize(bundle),
    }));
}

export function getPlaybookEntry(idOrName) {
  const entries = _load();
  const key = String(idOrName || '').toLowerCase();
  const entry = entries.find(e =>
    e.id === idOrName ||
    e.name.toLowerCase() === key
  );
  return entry || null;
}

export function touchPlaybookEntry(idOrName) {
  const entry = getPlaybookEntry(idOrName);
  if (!entry) return null;
  entry.lastUsedAt = Date.now();
  entry.useCount = (entry.useCount || 0) + 1;
  _save();
  return entry;
}

export function deletePlaybookEntry(idOrName) {
  const entries = _load();
  const key = String(idOrName || '').toLowerCase();
  const before = entries.length;
  _entries = entries.filter(e => e.id !== idOrName && e.name.toLowerCase() !== key);
  if (_entries.length === before) return { ok: false, error: 'Not found' };
  _save();
  return { ok: true, deleted: before - _entries.length };
}

// ── Test hooks ────────────────────────────────────────────────────────────
export function _resetForTests() { _entries = null; }

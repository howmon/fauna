// ── Browser Recordings Store ──────────────────────────────────────────────
// Persists cross-tab browser action recordings captured by the Fauna browser
// extension. A "recording" is a named, ordered sequence of steps (clicks,
// inputs, navigations, tab switches, selections, key chords, scrolls) with
// timing and optional screenshot thumbnails. Fauna can view, edit, replay,
// and learn from them.
//
// Persists to ~/.config/fauna/browser-recordings.json

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const MAX_ENTRIES = 200;
const MAX_STEPS = 2000;

function _file() {
  return process.env.FAUNA_RECORDINGS_FILE ||
    path.join(os.homedir(), '.config', 'fauna', 'browser-recordings.json');
}

/**
 * @typedef {{
 *   id: string, t: number, type: string, tabId?: number|null,
 *   windowId?: number|null,
 *   url?: string|null, title?: string|null,
 *   selector?: string, label?: string, value?: string, text?: string,
 *   keys?: string, x?: number, y?: number, shot?: string, note?: string
 * }} RecStep
 * @typedef {{
 *   id: string, name: string, description: string, tags: string[],
 *   startedAt: number, endedAt: number, durationMs: number,
 *   steps: RecStep[], stepCount: number,
 *   createdAt: number, updatedAt: number, lastUsedAt: number, useCount: number
 * }} Recording
 */

let _cache = null;

function _load() {
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(_file(), 'utf8'));
    _cache = Array.isArray(raw) ? raw : [];
  } catch (_) {
    _cache = [];
  }
  return _cache;
}

function _save() {
  const f = _file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(_cache || [], null, 2));
}

function _uid() {
  return 'rec_' + crypto.randomBytes(6).toString('hex');
}

function _now() { return Date.now(); }

// Lightweight summary (no step bodies / screenshots) for list views.
function _summary(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description || '',
    tags: r.tags || [],
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.durationMs || 0,
    stepCount: r.stepCount != null ? r.stepCount : (r.steps || []).length,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastUsedAt: r.lastUsedAt || 0,
    useCount: r.useCount || 0,
    startUrl: (r.steps && r.steps[0] && r.steps[0].url) || '',
  };
}

function _sanitizeStep(s, i) {
  const out = {
    id: (s && s.id) || ('st_' + i),
    t: Number(s && s.t) || 0,
    type: String((s && s.type) || 'action'),
  };
  if (s == null) return out;
  if (s.tabId != null) out.tabId = s.tabId;
  if (s.windowId != null) out.windowId = s.windowId;
  for (const k of ['url', 'title', 'selector', 'label', 'value', 'text', 'keys', 'note']) {
    if (s[k] != null && s[k] !== '') out[k] = String(s[k]).slice(0, 2000);
  }
  if (s.x != null) out.x = Math.round(Number(s.x));
  if (s.y != null) out.y = Math.round(Number(s.y));
  if (typeof s.shot === 'string' && s.shot.startsWith('data:image') && s.shot.length < 500000) out.shot = s.shot;
  if (typeof s.value === 'boolean') out.value = s.value;
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────

/** Create a new recording (or update by id / sessionId if it already exists). */
export function saveRecording(input = {}) {
  const list = _load();
  let steps = Array.isArray(input.steps) ? input.steps.slice(0, MAX_STEPS).map(_sanitizeStep) : [];

  let entry;
  if (input.id) entry = list.find((r) => r.id === input.id);
  if (!entry && input.sessionId) entry = list.find((r) => r.sessionId && r.sessionId === input.sessionId);

  if (entry) {
    if (input.name != null) entry.name = String(input.name).slice(0, 200);
    if (input.description != null) entry.description = String(input.description).slice(0, 2000);
    if (Array.isArray(input.tags)) entry.tags = input.tags.map((t) => String(t).slice(0, 40)).slice(0, 20);
    // Keep the fuller step list (the extension's authoritative buffer may arrive
    // after the renderer's quick save with the same sessionId).
    if (Array.isArray(input.steps) && steps.length >= (entry.steps || []).length) { entry.steps = steps; entry.stepCount = steps.length; }
    if (input.durationMs) entry.durationMs = Number(input.durationMs);
    if (input.sessionId) entry.sessionId = input.sessionId;
    entry.updatedAt = _now();
  } else {
    entry = {
      id: input.id || _uid(),
      sessionId: input.sessionId || null,
      name: String(input.name || ('Recording — ' + new Date().toLocaleString())).slice(0, 200),
      description: String(input.description || '').slice(0, 2000),
      tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).slice(0, 40)).slice(0, 20) : [],
      startedAt: Number(input.startedAt) || _now(),
      endedAt: Number(input.endedAt) || _now(),
      durationMs: Number(input.durationMs) || 0,
      steps,
      stepCount: steps.length,
      createdAt: _now(),
      updatedAt: _now(),
      lastUsedAt: 0,
      useCount: 0,
    };
    list.unshift(entry);
    if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  }
  _save();
  _exportToDocuments(entry);
  return entry;
}

// Also write a standalone copy to ~/Documents/Fauna/recordings so recordings
// are visible/portable and never depend solely on the config-dir index.
function _exportToDocuments(entry) {
  try {
    const dir = process.env.FAUNA_RECORDINGS_DOCS_DIR ||
      path.join(os.homedir(), 'Documents', 'Fauna', 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(entry.name || 'recording').replace(/[^\w.\-]+/g, '_').slice(0, 60) || 'recording';
    fs.writeFileSync(path.join(dir, safe + '-' + entry.id + '.json'), JSON.stringify(entry, null, 2));
  } catch (_) { /* best-effort */ }
}

/** List recordings (summaries only), newest first, optional text filter. */
export function listRecordings({ query } = {}) {
  const list = _load();
  let out = list.map(_summary);
  if (query) {
    const q = String(query).toLowerCase();
    out = out.filter((r) => (r.name + ' ' + r.description + ' ' + r.tags.join(' ') + ' ' + r.startUrl).toLowerCase().includes(q));
  }
  return out;
}

/** Get a full recording (with steps) by id. */
export function getRecording(id) {
  return _load().find((r) => r.id === id) || null;
}

/** Update mutable fields / replace steps of a recording. */
export function updateRecording(id, patch = {}) {
  const entry = _load().find((r) => r.id === id);
  if (!entry) return null;
  if (patch.name != null) entry.name = String(patch.name).slice(0, 200);
  if (patch.description != null) entry.description = String(patch.description).slice(0, 2000);
  if (Array.isArray(patch.tags)) entry.tags = patch.tags.map((t) => String(t).slice(0, 40)).slice(0, 20);
  if (Array.isArray(patch.steps)) {
    entry.steps = patch.steps.slice(0, MAX_STEPS).map(_sanitizeStep);
    entry.stepCount = entry.steps.length;
  }
  entry.updatedAt = _now();
  _save();
  return entry;
}

/** Record a use (replay) — bumps lastUsedAt + useCount. */
export function touchRecording(id) {
  const entry = _load().find((r) => r.id === id);
  if (!entry) return null;
  entry.lastUsedAt = _now();
  entry.useCount = (entry.useCount || 0) + 1;
  _save();
  return entry;
}

/** Delete a recording. */
export function deleteRecording(id) {
  const list = _load();
  const i = list.findIndex((r) => r.id === id);
  if (i === -1) return false;
  list.splice(i, 1);
  _save();
  return true;
}

// Map a recorded step to a replayable browser-ext-action command. Returns null
// for steps that aren't independently replayable (e.g. scroll noise).
function _stepToAction(s) {
  const tabId = s.tabId != null ? s.tabId : undefined;
  switch (s.type) {
    case 'navigate':
      return s.url ? { action: 'navigate', url: s.url, tabId } : null;
    case 'tabswitch':
      // Reuse an already-open tab (by URL) rather than a stale numeric tabId.
      // The recorded tabId is passed as a hint but URL is the reliable matcher.
      return (s.url || tabId != null)
        ? { action: 'tab:ensure', url: s.url || undefined, tabId }
        : null;
    case 'click':
      return { action: 'click', selector: s.selector, text: s.label || undefined, tabId };
    case 'input':
      return { action: 'type', selector: s.selector, value: s.value || '', tabId };
    case 'select':
      return { action: 'select', selector: s.selector, value: s.value, tabId };
    case 'toggle':
      return { action: 'click', selector: s.selector, tabId };
    case 'submit':
      return { action: 'key', keys: 'Enter', selector: s.selector, tabId };
    case 'key':
      return { action: 'key', keys: s.keys, tabId };
    case 'copy':
      return { action: 'copy', tabId };
    case 'cut':
      return { action: 'cut', tabId };
    case 'paste':
      return { action: 'paste', tabId };
    case 'scroll':
      return { action: 'scroll', tabId };
    case 'selection':
      return null; // selection is context, not a replayable action
    default:
      return null;
  }
}

/** Compile a recording into an ordered list of browser-ext-action commands. */
export function compileRecording(id) {
  const rec = getRecording(id);
  if (!rec) return null;
  const actions = [];
  let anchored = false;
  for (const s of (rec.steps || [])) {
    // The first navigation marks the tab the user started on. Emit a tab:ensure
    // so replay reuses an already-open tab at that URL (or opens one) instead of
    // grabbing whatever tab happens to be active — keeps replay in-browser and
    // avoids duplicate tabs. Later in-tab navigations stay plain 'navigate'.
    if (!anchored && s.type === 'navigate' && s.url) {
      actions.push({ action: 'tab:ensure', url: s.url, tabId: s.tabId != null ? s.tabId : undefined });
      anchored = true;
      continue;
    }
    if (s.type === 'navigate' || s.type === 'tabswitch') anchored = true;
    const a = _stepToAction(s);
    if (a) actions.push(a);
  }
  return { id: rec.id, name: rec.name, actions };
}

/** A compact, human/AI-readable outline of a recording (no screenshots). */
export function describeRecording(id) {
  const rec = getRecording(id);
  if (!rec) return null;
  const lines = (rec.steps || []).map((s, i) => {
    const at = '+' + Math.round((s.t || 0) / 1000) + 's';
    let d = s.type;
    if (s.type === 'navigate') d = 'navigate → ' + (s.title || s.url || '');
    else if (s.type === 'tabswitch') d = 'switch tab → ' + (s.title || s.url || '');
    else if (s.type === 'click') d = 'click ' + (s.label ? '“' + s.label + '”' : (s.selector || ''));
    else if (s.type === 'input') d = 'type "' + (s.masked ? '••••' : (s.value || '')) + '" into ' + (s.label || s.selector || '');
    else if (s.type === 'select') d = 'select "' + (s.label || s.value) + '"';
    else if (s.type === 'toggle') d = 'toggle ' + (s.label || s.selector || '');
    else if (s.type === 'submit') d = 'submit form';
    else if (s.type === 'key') d = 'press ' + s.keys;
    else if (s.type === 'copy') d = 'copy' + (s.text ? ' “' + String(s.text).slice(0, 40) + '”' : '');
    else if (s.type === 'cut') d = 'cut' + (s.text ? ' “' + String(s.text).slice(0, 40) + '”' : '');
    else if (s.type === 'paste') d = 'paste' + (s.text ? ' “' + String(s.text).slice(0, 40) + '”' : '');
    else if (s.type === 'selection') d = 'select text: "' + (s.text || '').slice(0, 60) + '"';
    else if (s.type === 'scroll') d = 'scroll';
    return `${i + 1}. [${at}] ${d}`;
  });
  return {
    id: rec.id, name: rec.name, description: rec.description,
    durationMs: rec.durationMs, stepCount: rec.stepCount,
    outline: lines.join('\n'),
  };
}

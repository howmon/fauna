// ── Credentials Store — encrypted secrets vault for automation nodes ───────
//
// Phase: n8n-parity #1. Stores reusable secrets (API keys, OAuth tokens,
// basic-auth, bearer tokens) that action nodes reference by id. Values are
// encrypted at rest with Electron's safeStorage (OS keychain-backed) when
// available; on platforms/sessions without an OS keyring we fall back to a
// clearly-flagged plaintext mode so the feature still works in dev/tests.
//
// SECURITY MODEL:
//   * Secret VALUES never leave this module except via resolveCredential(),
//     which is only called inside the task runner. The REST/list surface
//     returns metadata only ({ id, name, type, fields: [...keys] }).
//   * Persisted to ~/.config/fauna/credentials.json. Each entry's `data`
//     holds per-field ciphertext (base64) plus an `enc` flag.
//
// Persists to ~/.config/fauna/credentials.json

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

// Lazily resolve Electron safeStorage — absent when run standalone/tests.
let _safeStorage = null;
let _safeStorageChecked = false;
function _getSafeStorage() {
  if (_safeStorageChecked) return _safeStorage;
  _safeStorageChecked = true;
  try {
    const { safeStorage } = _require('electron');
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function'
        && safeStorage.isEncryptionAvailable()) {
      _safeStorage = safeStorage;
    }
  } catch (_) { /* not in Electron */ }
  return _safeStorage;
}

const CRED_TYPES = ['apiKey', 'bearer', 'basic', 'oauth2', 'custom'];

// Allowed field keys per type — keeps the shape predictable for node authors.
const TYPE_FIELDS = {
  apiKey: ['apiKey'],
  bearer: ['token'],
  basic:  ['username', 'password'],
  oauth2: ['accessToken', 'refreshToken', 'clientId', 'clientSecret', 'tokenUrl'],
  custom: null, // any keys allowed
};

function _credFile() {
  return process.env.FAUNA_CREDENTIALS_FILE ||
    path.join(os.homedir(), '.config', 'fauna', 'credentials.json');
}

let _entries = null;

function _load() {
  if (_entries) return _entries;
  try {
    const raw = JSON.parse(fs.readFileSync(_credFile(), 'utf8'));
    _entries = Array.isArray(raw) ? raw : [];
  } catch (_) {
    _entries = [];
  }
  return _entries;
}

function _save() {
  const file = _credFile();
  const tmp  = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(_entries, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
}

// ── Field-level encryption ─────────────────────────────────────────────────

function _encryptValue(plain) {
  const ss = _getSafeStorage();
  if (ss) {
    return { enc: 'safeStorage', v: ss.encryptString(String(plain)).toString('base64') };
  }
  // Plaintext fallback — flagged so callers/UI can warn. Base64 only to avoid
  // accidental shoulder-surfing of the raw value in the JSON file.
  return { enc: 'plain', v: Buffer.from(String(plain), 'utf8').toString('base64') };
}

function _decryptValue(field) {
  if (!field || typeof field !== 'object') return '';
  if (field.enc === 'safeStorage') {
    const ss = _getSafeStorage();
    if (!ss) throw new Error('Credential encrypted with safeStorage but it is unavailable');
    return ss.decryptString(Buffer.from(field.v, 'base64'));
  }
  // plain
  return Buffer.from(field.v || '', 'base64').toString('utf8');
}

function _genId() {
  return 'cred-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

// ── Public metadata projection (NEVER includes secret values) ──────────────

function _meta(entry) {
  return {
    id:        entry.id,
    name:      entry.name,
    type:      entry.type,
    fields:    Object.keys(entry.data || {}),
    encrypted: Object.values(entry.data || {}).every(f => f && f.enc === 'safeStorage'),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────────

function listCredentials() {
  return _load().map(_meta);
}

function getCredentialMeta(id) {
  const e = _load().find(x => x.id === id);
  return e ? _meta(e) : null;
}

function _validateFields(type, data) {
  const allowed = TYPE_FIELDS[type];
  if (allowed === null) return; // custom — any keys
  if (!allowed) throw new Error('Unknown credential type: ' + type);
  for (const k of Object.keys(data || {})) {
    if (!allowed.includes(k)) throw new Error(`Field "${k}" not allowed for type "${type}"`);
  }
}

function createCredential(input) {
  const name = (input && input.name || '').trim();
  if (!name) throw new Error('Credential name is required');
  const type = (input.type || 'apiKey');
  if (!CRED_TYPES.includes(type)) throw new Error('Invalid credential type: ' + type);
  const rawData = input.data || {};
  _validateFields(type, rawData);

  const data = {};
  for (const [k, v] of Object.entries(rawData)) {
    if (v == null || v === '') continue;
    data[k] = _encryptValue(v);
  }

  const entries = _load();
  const now = Date.now();
  const entry = { id: _genId(), name, type, data, createdAt: now, updatedAt: now };
  entries.push(entry);
  _save();
  return _meta(entry);
}

function updateCredential(id, input) {
  const entries = _load();
  const entry = entries.find(x => x.id === id);
  if (!entry) return null;
  if (input.name != null) entry.name = String(input.name).trim() || entry.name;
  if (input.type && CRED_TYPES.includes(input.type)) entry.type = input.type;
  if (input.data && typeof input.data === 'object') {
    _validateFields(entry.type, input.data);
    // Merge: only re-encrypt fields that are provided non-empty; empty string
    // deletes the field, undefined leaves it untouched.
    for (const [k, v] of Object.entries(input.data)) {
      if (v === '') { delete entry.data[k]; continue; }
      if (v == null) continue;
      entry.data[k] = _encryptValue(v);
    }
  }
  entry.updatedAt = Date.now();
  _save();
  return _meta(entry);
}

function deleteCredential(id) {
  const entries = _load();
  const idx = entries.findIndex(x => x.id === id);
  if (idx === -1) return false;
  entries.splice(idx, 1);
  _save();
  return true;
}

/**
 * Resolve a credential's decrypted fields. ONLY for use inside the task
 * runner. Returns null if not found. Throws if decryption is impossible.
 * @returns {{ id, name, type, data: Record<string,string> } | null}
 */
function resolveCredential(id) {
  const entry = _load().find(x => x.id === id);
  if (!entry) return null;
  const data = {};
  for (const [k, f] of Object.entries(entry.data || {})) {
    data[k] = _decryptValue(f);
  }
  return { id: entry.id, name: entry.name, type: entry.type, data };
}

// Test/runtime helper — drop the in-memory cache so a changed file is re-read.
function _resetCache() { _entries = null; }

export {
  CRED_TYPES, TYPE_FIELDS,
  listCredentials, getCredentialMeta,
  createCredential, updateCredential, deleteCredential,
  resolveCredential,
  _resetCache,
};

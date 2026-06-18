// ── Sync E2E Crypto — client-side end-to-end encryption for cloud sync ─────
//
// Goal: the agentstore server (and anyone with DB access) must never see
// plaintext payloads. Everything that crosses the wire — conversation
// bodies, project metadata, file contents — is AES-256-GCM ciphertext
// keyed off a passphrase the server never receives.
//
// Threat model:
//   * Server storage is fully untrusted (DB dump, ops snooping, breach).
//   * Network is TLS but considered hostile (defense in depth).
//   * The user's local OS keychain + login password are the trust anchors.
//
// What's protected: payloads (the `payload` column).
// What's NOT protected: routing metadata required for sync mechanics —
// namespace, objectId, clientVersion (HLC), timestamps, deleted flag,
// payloadHash. These leak shape and timing only.
//
// Key derivation:
//   masterKey = PBKDF2-SHA256(password, salt, 600_000 iters, 32 bytes)
//
// Envelope wire format (single JSON object replacing the plaintext payload):
//   { e2e: 1, n: <12-byte nonce, base64>, c: <ciphertext+tag, base64> }
//
// AAD = `${ns}:${id}` so a server can't shuffle a ciphertext from one row
// onto another. AES-GCM with a *fresh random nonce per encryption* (never
// counter-based — a nonce reuse with the same key is catastrophic for GCM).
//
// Provisioning flow (first device):
//   1. Login produces a bearer.
//   2. Client GETs /api/sync/e2e-meta. Server returns { salt, check } where
//      `salt` is auto-generated server-side on first call (random 16 bytes,
//      base64) and `check` is null until the client sets it.
//   3. Client derives a key from password + salt, encrypts a known
//      plaintext (`E2E:CHECK:v1`) and PUTs the envelope as `check`.
//   4. Future devices: GET /api/sync/e2e-meta, derive key, decrypt `check`.
//      If decryption fails → wrong password; refuse to sync (no plaintext
//      ever leaves until we have the right key).
//
// Locked state:
//   * After adoptToken() (Agent Store sign-in) we have a bearer but no
//     password. The engine refuses to push or apply pulled envelopes
//     until /api/sync/unlock is called with the password.
//   * On logout, the cached key is wiped from memory and from the
//     keychain blob on disk.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';

import * as agentstore from './agentstore-client.js';

const _require = createRequire(import.meta.url);

// ── Tunables ─────────────────────────────────────────────────────────────
const PBKDF2_ITERATIONS = 600_000;       // OWASP 2024 SHA-256 floor
const KEY_BYTES         = 32;            // AES-256
const NONCE_BYTES       = 12;            // GCM standard
const TAG_BYTES         = 16;            // GCM auth tag
const SALT_BYTES        = 16;
const CHECK_PLAINTEXT   = 'E2E:CHECK:v1';

// ── safeStorage (Electron only; absent in tests / Node CLI) ──────────────
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

function _syncDir() {
  return process.env.FAUNA_SYNC_DIR ||
    path.join(os.homedir(), '.config', 'fauna', 'sync');
}
function _keyFile() { return path.join(_syncDir(), 'e2e-key.bin'); }

// ── Module state (in-memory; cleared on logout) ──────────────────────────
let _key = null;              // Buffer | null
let _saltB64 = null;          // string | null — cached so we know what to send if user re-enters password
let _lastEvent = null;        // { type: 'unlocked'|'locked'|'error', message? }

// Optional emitter — wired by sync-engine so route handlers can broadcast.
const _listeners = new Set();
function _emit(type, payload = {}) {
  _lastEvent = { type, ...payload, ts: Date.now() };
  for (const fn of _listeners) {
    try { fn({ type, ...payload }); } catch (_) {}
  }
}

export function onEvent(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
export function getLastEvent() { return _lastEvent; }

// ── Key derivation ───────────────────────────────────────────────────────

/** PBKDF2-SHA256(password, salt, 600k, 32). Returns a 32-byte Buffer. */
export function deriveKey(password, saltB64) {
  if (!password || typeof password !== 'string') throw new Error('password required');
  if (!saltB64) throw new Error('salt required');
  const salt = Buffer.from(saltB64, 'base64');
  if (salt.length < 8) throw new Error('salt too short');
  return crypto.pbkdf2Sync(
    Buffer.from(password, 'utf8'),
    salt,
    PBKDF2_ITERATIONS,
    KEY_BYTES,
    'sha256'
  );
}

// ── Envelope crypto ──────────────────────────────────────────────────────

/**
 * Encrypts a UTF-8 string under the current key. AAD binds the ciphertext
 * to its (namespace, id) so the server can't move it between rows.
 *
 * @param {string} plaintext  serialized JSON to encrypt
 * @param {string} aad        e.g. `${ns}:${id}`
 * @returns {{ e2e: 1, n: string, c: string }} envelope
 */
export function encryptString(plaintext, aad) {
  if (!_key) throw new Error('E2E locked: no key available');
  if (typeof plaintext !== 'string') throw new Error('plaintext must be a string');
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', _key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    e2e: 1,
    n: nonce.toString('base64'),
    c: Buffer.concat([ct, tag]).toString('base64'),
  };
}

/**
 * Decrypts an envelope. Throws on auth failure (wrong key, tampered data,
 * AAD mismatch). Returns the original UTF-8 plaintext.
 */
export function decryptEnvelope(env, aad) {
  if (!_key) throw new Error('E2E locked: no key available');
  if (!isEnvelope(env)) throw new Error('not an E2E envelope');
  const nonce = Buffer.from(env.n, 'base64');
  const blob  = Buffer.from(env.c, 'base64');
  if (nonce.length !== NONCE_BYTES) throw new Error('bad nonce length');
  if (blob.length < TAG_BYTES) throw new Error('ciphertext too short');
  const ct  = blob.subarray(0, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', _key, nonce);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/** Duck-types the envelope shape: { e2e: 1, n: string, c: string }. */
export function isEnvelope(obj) {
  return !!obj
    && typeof obj === 'object'
    && obj.e2e === 1
    && typeof obj.n === 'string'
    && typeof obj.c === 'string';
}

// ── Key state ────────────────────────────────────────────────────────────

export function hasKey() { return _key !== null; }
export function getSaltB64() { return _saltB64; }

/** Test/diagnostics only — never ship a UI that exposes this. */
export function _setKeyForTests(buf, saltB64) {
  if (!Buffer.isBuffer(buf) || buf.length !== KEY_BYTES) {
    throw new Error('test key must be a 32-byte Buffer');
  }
  _key = buf;
  _saltB64 = saltB64 || _saltB64 || Buffer.alloc(SALT_BYTES, 0).toString('base64');
  _emit('unlocked', { source: 'test' });
}

export function clearKey() {
  if (_key) {
    try { _key.fill(0); } catch (_) {}
  }
  _key = null;
  _saltB64 = null;
  try { fs.unlinkSync(_keyFile()); } catch (_) {}
  _emit('locked', { reason: 'cleared' });
}

// ── Keychain persistence (between launches on the same device) ───────────
//
// We persist the derived key (not the password) to disk encrypted with
// Electron's safeStorage so the user doesn't have to re-enter their
// password on every app start. If safeStorage is unavailable (Linux
// without a keyring, for example) we DO NOT fall back to plaintext —
// re-derivation on each launch is the correct behavior there.

async function _persistKeyToDisk() {
  const ss = _getSafeStorage();
  if (!ss || !_key || !_saltB64) return false;
  try {
    const blob = ss.encryptString(JSON.stringify({
      v: 1,
      key: _key.toString('base64'),
      salt: _saltB64,
    }));
    await fsp.mkdir(_syncDir(), { recursive: true });
    const file = _keyFile();
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, blob, { mode: 0o600 });
    await fsp.rename(tmp, file);
    try { await fsp.chmod(file, 0o600); } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Try to restore a previously cached key from the OS keychain. Returns
 * true on success. Safe to call on every app start.
 */
export async function tryRestoreFromKeychain() {
  const ss = _getSafeStorage();
  if (!ss) return false;
  try {
    const blob = await fsp.readFile(_keyFile());
    const decoded = ss.decryptString(blob);
    const parsed = JSON.parse(decoded);
    if (parsed?.v !== 1 || !parsed.key || !parsed.salt) return false;
    const buf = Buffer.from(parsed.key, 'base64');
    if (buf.length !== KEY_BYTES) return false;
    _key = buf;
    _saltB64 = parsed.salt;
    _emit('unlocked', { source: 'keychain' });
    return true;
  } catch (_) {
    return false;
  }
}

// ── Server provisioning (salt + check value) ─────────────────────────────

async function _fetchMeta() {
  // Returns { salt, check } from the server. Server auto-generates salt on
  // first call. `check` is null until this client provisions it.
  return await agentstore.request('GET', '/api/sync/e2e-meta', null);
}

async function _putCheck(envelope) {
  return await agentstore.request('PUT', '/api/sync/e2e-meta', { check: envelope });
}

/**
 * Unlock E2E with the user's password. This is the ONLY public path that
 * derives a key. Steps:
 *
 *   1. Fetch salt + existing check from server.
 *   2. Derive candidate key.
 *   3a. If `check` exists: try to decrypt it with the candidate key.
 *       Match → key is correct, cache and return.
 *       Fail  → wrong password, do NOT cache.
 *   3b. If `check` is null: this is the first device. Encrypt the known
 *       plaintext with the candidate key, PUT it, cache the key.
 *
 * Throws on network / 5xx so callers can distinguish "wrong password"
 * (returns ok:false) from "couldn't reach server".
 *
 * @returns {{ ok: boolean, error?: string, firstDevice?: boolean }}
 */
export async function unlock({ password } = {}) {
  if (!password) return { ok: false, error: 'password required' };

  let meta;
  try {
    meta = await _fetchMeta();
  } catch (e) {
    _emit('error', { message: 'fetch e2e meta failed: ' + (e.message || e) });
    throw e;
  }
  if (!meta?.salt) {
    _emit('error', { message: 'server did not return salt' });
    throw new Error('server did not return salt');
  }

  const candidate = deriveKey(password, meta.salt);

  // ── Existing user: verify against the stored check ──
  if (meta.check && isEnvelope(meta.check)) {
    try {
      const tmpKey = _key;
      _key = candidate;
      const plain = decryptEnvelope(meta.check, 'e2e:check');
      _key = tmpKey; // restore so we don't half-commit
      if (plain !== CHECK_PLAINTEXT) {
        candidate.fill(0);
        return { ok: false, error: 'wrong password (check mismatch)' };
      }
    } catch (_) {
      candidate.fill(0);
      _key = null;
      return { ok: false, error: 'wrong password' };
    }
    _key = candidate;
    _saltB64 = meta.salt;
    await _persistKeyToDisk();
    _emit('unlocked', { source: 'password' });
    return { ok: true };
  }

  // ── First device: provision the check value ──
  _key = candidate;
  _saltB64 = meta.salt;
  let envelope;
  try {
    envelope = encryptString(CHECK_PLAINTEXT, 'e2e:check');
  } catch (e) {
    _key = null; _saltB64 = null;
    candidate.fill(0);
    throw e;
  }
  try {
    await _putCheck(envelope);
  } catch (e) {
    _key = null; _saltB64 = null;
    candidate.fill(0);
    _emit('error', { message: 'put e2e meta failed: ' + (e.message || e) });
    throw e;
  }
  await _persistKeyToDisk();
  _emit('unlocked', { source: 'password', firstDevice: true });
  return { ok: true, firstDevice: true };
}

// Test helper.
export function _resetForTests() {
  if (_key) { try { _key.fill(0); } catch (_) {} }
  _key = null;
  _saltB64 = null;
  _lastEvent = null;
  _listeners.clear();
  try { fs.unlinkSync(_keyFile()); } catch (_) {}
}

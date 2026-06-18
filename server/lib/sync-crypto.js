// ── Sync E2E Crypto — client-side end-to-end encryption for cloud sync ─────
//
// Goal: the agentstore server (and anyone with DB access) must never see
// plaintext payloads. Everything that crosses the wire — conversation
// bodies, project metadata, file contents — is AES-256-GCM ciphertext
// keyed off a master key the server never receives in clear.
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
// ── KEY HIERARCHY (two-key scheme) ────────────────────────────────────────
//
//   Password ──PBKDF2-SHA256(salt, 600k)──► PDK (password-derived key)
//   random_bytes(32)                       ► MK  (master key — encrypts all data)
//   wrappedMK = AES-GCM(MK, PDK, aad="e2e:mk")    ◄── stored on the server
//
//   For every payload:
//     payload_envelope = AES-GCM(plaintext, MK, aad=`${ns}:${id}`)
//
// Why two keys instead of one? So the user can change their account
// password without re-encrypting megabytes (or gigabytes) of synced data.
// Password change is a trivial re-wrap of the 32-byte MK with a freshly
// derived PDK — none of the payload ciphertext on the server is touched.
//
// Envelope wire format (single JSON object replacing the plaintext payload):
//   { e2e: 1, n: <12-byte nonce, base64>, c: <ciphertext+tag, base64> }
//
// AAD on payloads = `${ns}:${id}` so a server can't shuffle a ciphertext
// from one row onto another. AAD on the wrapped-MK = "e2e:mk" so a server
// can't try to pass off a payload envelope as the wrap.
//
// AES-GCM with a *fresh random nonce per encryption* (never counter-based —
// a nonce reuse with the same key is catastrophic for GCM).
//
// ── Provisioning flow (first device) ──
//   1. Login produces a bearer.
//   2. Client GETs /api/sync/e2e-meta. Server returns { salt, wrappedMk }
//      where `salt` is auto-generated server-side on first call (random
//      16 bytes, base64) and `wrappedMk` is null until provisioned.
//   3. Client derives PDK from password+salt, generates a random MK,
//      wraps MK with PDK, and PUTs the envelope as `wrappedMk`.
//
// ── Subsequent devices ──
//   1. GET /api/sync/e2e-meta → { salt, wrappedMk }.
//   2. Derive PDK from password+salt.
//   3. Unwrap MK = AES-GCM-decrypt(wrappedMk, PDK, aad="e2e:mk").
//      Decrypt failure → wrong password (refuse to sync; no data movement).
//   4. Cache MK locally (in OS keychain via safeStorage).
//
// ── Password change ──
//   1. User enters old + new password.
//   2. Derive PDK_old, unwrap MK from server's wrappedMk.
//   3. Derive PDK_new, wrap MK with PDK_new.
//   4. PUT new wrappedMk. The MK itself never changes, so all existing
//      payload ciphertext on the server stays valid.
//
// ── Locked state ──
//   * After adoptToken() (Agent Store sign-in) we have a bearer but no
//     password. The engine refuses to push or apply pulled envelopes
//     until /api/sync/unlock is called with the password.
//   * On logout, the cached MK is wiped from memory and from the
//     keychain blob on disk.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { createRequire } from 'module';

import * as agentstore from './agentstore-client.js';

const _require = createRequire(import.meta.url);

// ── Tunables ─────────────────────────────────────────────────────────────
const PBKDF2_ITERATIONS = 600_000;       // OWASP 2024 SHA-256 floor
const KEY_BYTES         = 32;            // AES-256
const NONCE_BYTES       = 12;            // GCM standard
const TAG_BYTES         = 16;            // GCM auth tag
const SALT_BYTES        = 16;
const MK_AAD            = 'e2e:mk';      // bound to the wrap envelope only

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
let _mk = null;               // Buffer | null — Master Key (32 bytes)
let _saltB64 = null;          // string | null — PBKDF2 salt for PDK
let _lastEvent = null;

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
//
// _encryptWith / _decryptWith take an explicit key so we can use them for
// both payload-with-MK and MK-with-PDK. The public encryptString /
// decryptEnvelope wrap _mk for the common payload path.

function _encryptWith(plaintextBuf, key, aad) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    e2e: 1,
    n: nonce.toString('base64'),
    c: Buffer.concat([ct, tag]).toString('base64'),
  };
}

function _decryptWith(env, key, aad) {
  if (!isEnvelope(env)) throw new Error('not an E2E envelope');
  const nonce = Buffer.from(env.n, 'base64');
  const blob  = Buffer.from(env.c, 'base64');
  if (nonce.length !== NONCE_BYTES) throw new Error('bad nonce length');
  if (blob.length < TAG_BYTES) throw new Error('ciphertext too short');
  const ct  = blob.subarray(0, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Encrypts a UTF-8 string under the current Master Key. AAD binds the
 * ciphertext to its (namespace, id) so the server can't move it between
 * rows.
 *
 * Optionally gzips the plaintext before encryption. Set `compress: true`
 * for large or text-heavy payloads (source files, conversation logs)
 * where the bandwidth + on-disk savings beat the CPU cost. We only emit
 * the compressed form if it's actually smaller than the raw plaintext —
 * otherwise short payloads would grow after compression overhead.
 *
 * The compression flag rides on the envelope as `z: 1`. The receiving
 * client (or this same process pulling its own writes back) detects it
 * via `decryptEnvelope` and gunzips transparently.
 *
 * @param {string} plaintext  serialized JSON to encrypt
 * @param {string} aad        e.g. `${ns}:${id}`
 * @param {{ compress?: boolean }} [opts]
 * @returns {{ e2e: 1, n: string, c: string, z?: 1 }} envelope
 */
export function encryptString(plaintext, aad, opts = {}) {
  if (!_mk) throw new Error('E2E locked: no key available');
  if (typeof plaintext !== 'string') throw new Error('plaintext must be a string');

  const raw = Buffer.from(plaintext, 'utf8');
  let body = raw;
  let compressed = false;
  // Don't bother trying to compress payloads smaller than this — gzip
  // headers + dict overhead would make them bigger.
  if (opts.compress && raw.length >= 256) {
    try {
      const gz = zlib.gzipSync(raw, { level: zlib.constants.Z_DEFAULT_COMPRESSION });
      // Only adopt if it actually saved bytes. JSON of an already-
      // compressed image, for instance, would balloon under gzip.
      if (gz.length < raw.length) {
        body = gz;
        compressed = true;
      }
    } catch (_) {
      // Fall through to uncompressed — encryption is what matters.
    }
  }

  const env = _encryptWith(body, _mk, aad);
  if (compressed) env.z = 1;
  return env;
}

/**
 * Decrypts an envelope under the current Master Key. Throws on auth
 * failure (wrong key, tampered data, AAD mismatch). Returns the original
 * UTF-8 plaintext.
 *
 * Auto-detects gzipped payloads via `env.z === 1` and decompresses
 * transparently, so callers don't need to know how the writer chose to
 * encode the body.
 */
export function decryptEnvelope(env, aad) {
  if (!_mk) throw new Error('E2E locked: no key available');
  const plainBuf = _decryptWith(env, _mk, aad);
  if (env && env.z === 1) {
    try {
      return zlib.gunzipSync(plainBuf).toString('utf8');
    } catch (e) {
      throw new Error('gunzip failed: ' + (e?.message || e));
    }
  }
  return plainBuf.toString('utf8');
}

/** Duck-types the envelope shape: { e2e: 1, n: string, c: string, z?: 1 }. */
export function isEnvelope(obj) {
  return !!obj
    && typeof obj === 'object'
    && obj.e2e === 1
    && typeof obj.n === 'string'
    && typeof obj.c === 'string';
}

// ── Key state ────────────────────────────────────────────────────────────

export function hasKey() { return _mk !== null; }
export function getSaltB64() { return _saltB64; }

/** Test/diagnostics only — never ship a UI that exposes this. */
export function _setKeyForTests(buf, saltB64) {
  if (!Buffer.isBuffer(buf) || buf.length !== KEY_BYTES) {
    throw new Error('test key must be a 32-byte Buffer');
  }
  _mk = buf;
  _saltB64 = saltB64 || _saltB64 || Buffer.alloc(SALT_BYTES, 0).toString('base64');
  _emit('unlocked', { source: 'test' });
}

export function clearKey() {
  if (_mk) {
    try { _mk.fill(0); } catch (_) {}
  }
  _mk = null;
  _saltB64 = null;
  try { fs.unlinkSync(_keyFile()); } catch (_) {}
  _emit('locked', { reason: 'cleared' });
}

// ── Keychain persistence (between launches on the same device) ───────────
//
// We persist the Master Key (not the password, not the PDK) to disk
// encrypted with Electron's safeStorage so the user doesn't have to
// re-enter their password on every app start.

async function _persistKeyToDisk() {
  const ss = _getSafeStorage();
  if (!ss || !_mk || !_saltB64) return false;
  try {
    const blob = ss.encryptString(JSON.stringify({
      v: 2,
      mk: _mk.toString('base64'),
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
 * true on success. Tolerates the v1 single-key blob format from the
 * pre-MK release so existing devices don't get force-locked on upgrade.
 */
export async function tryRestoreFromKeychain() {
  const ss = _getSafeStorage();
  if (!ss) return false;
  try {
    const blob = await fsp.readFile(_keyFile());
    const decoded = ss.decryptString(blob);
    const parsed = JSON.parse(decoded);
    let buf = null;
    if (parsed?.v === 2 && parsed.mk) {
      buf = Buffer.from(parsed.mk, 'base64');
    } else if (parsed?.v === 1 && parsed.key) {
      // Legacy single-key blob (pre two-key release). Treat the cached
      // PBKDF2-derived key as the MK so we don't lock the user out; the
      // next unlock() will rebind to a proper wrapped-MK on the server.
      buf = Buffer.from(parsed.key, 'base64');
    }
    if (!buf || buf.length !== KEY_BYTES) return false;
    _mk = buf;
    _saltB64 = parsed.salt || null;
    _emit('unlocked', { source: 'keychain' });
    return true;
  } catch (_) {
    return false;
  }
}

// ── Server provisioning (salt + wrapped MK) ──────────────────────────────

async function _fetchMeta() {
  return await agentstore.request('GET', '/api/sync/e2e-meta', null);
}

async function _putMeta(payload) {
  return await agentstore.request('PUT', '/api/sync/e2e-meta', payload);
}

/**
 * Unlock E2E with the user's password. This is the ONLY public path that
 * derives a key from the password. Steps:
 *
 *   1. Fetch salt + existing wrappedMk from server.
 *   2. Derive PDK = PBKDF2(password, salt).
 *   3a. If `wrappedMk` exists: unwrap MK with PDK. Auth-tag failure means
 *       wrong password — reject without touching state.
 *   3b. If `wrappedMk` is null: this is the first device. Generate a random
 *       MK, wrap it with PDK, PUT the wrappedMk, cache the MK.
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

  const pdk = deriveKey(password, meta.salt);

  // ── Returning device: unwrap the MK with the freshly derived PDK ──
  if (meta.wrappedMk && isEnvelope(meta.wrappedMk)) {
    let mk;
    try {
      mk = _decryptWith(meta.wrappedMk, pdk, MK_AAD);
    } catch (_) {
      pdk.fill(0);
      return { ok: false, error: 'wrong password' };
    }
    pdk.fill(0);
    if (mk.length !== KEY_BYTES) {
      mk.fill(0);
      return { ok: false, error: 'wrapped MK has wrong length' };
    }
    _mk = mk;
    _saltB64 = meta.salt;
    await _persistKeyToDisk();
    _emit('unlocked', { source: 'password' });
    return { ok: true };
  }

  // ── First device: generate a fresh random MK, wrap it, persist ──
  const mk = crypto.randomBytes(KEY_BYTES);
  let wrapped;
  try {
    wrapped = _encryptWith(mk, pdk, MK_AAD);
  } catch (e) {
    mk.fill(0); pdk.fill(0);
    throw e;
  }
  try {
    await _putMeta({ wrappedMk: wrapped });
  } catch (e) {
    mk.fill(0); pdk.fill(0);
    _emit('error', { message: 'put e2e meta failed: ' + (e.message || e) });
    throw e;
  }
  pdk.fill(0);
  _mk = mk;
  _saltB64 = meta.salt;
  await _persistKeyToDisk();
  _emit('unlocked', { source: 'password', firstDevice: true });
  return { ok: true, firstDevice: true };
}

/**
 * Compute a fresh wrappedMk envelope for the given password using the
 * currently-cached MK. Used by the atomic change-password flow, where
 * the server expects the client to PUT the new wrap inside the same
 * request that updates the account password.
 *
 * Requires the engine to already be unlocked. The returned envelope is
 * NOT uploaded; callers do that themselves.
 *
 * @returns {{ e2e: 1, n: string, c: string }}
 */
export function computeWrappedMkForPassword(password) {
  if (!_mk || !_saltB64) throw new Error('E2E locked: cannot rewrap');
  if (!password) throw new Error('password required');
  const pdk = deriveKey(password, _saltB64);
  let wrap;
  try {
    wrap = _encryptWith(_mk, pdk, MK_AAD);
  } finally {
    pdk.fill(0);
  }
  return wrap;
}

/**
 * Adopt a freshly-computed wrapped MK as our local cached state. Called
 * by the engine after a successful atomic change-password round trip so
 * a subsequent app launch uses the new wrap (the MK itself is unchanged
 * but we re-persist the keychain blob to refresh its timestamp).
 */
export async function rebindAfterRewrap() {
  if (!_mk) return false;
  await _persistKeyToDisk();
  _emit('unlocked', { source: 'rewrap' });
  return true;
}

// Test helper.
export function _resetForTests() {
  if (_mk) { try { _mk.fill(0); } catch (_) {} }
  _mk = null;
  _saltB64 = null;
  _lastEvent = null;
  _listeners.clear();
  try { fs.unlinkSync(_keyFile()); } catch (_) {}
}

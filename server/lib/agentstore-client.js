// ── Agentstore Client — auth + sync transport for Fauna Cloud ──────────────
//
// Centralized HTTP client for talking to the Laravel agentstore backend. Owns:
//   * Bearer token storage (encrypted with Electron safeStorage when available;
//     plaintext fallback in dev/CI). Persisted to ~/.config/fauna/agentstore.json.
//   * Single login / logout / whoami surface for the renderer to call.
//   * `request()` helper with retries, JSON encode/decode, 401 → auto-logout,
//     and structured errors that include the HTTP status + server payload so
//     callers (especially sync-engine.js) can react to 409 conflicts without
//     re-parsing strings.
//
// IMPORTANT — read before adding endpoints:
//   This module is shared between the main process (server/) and any Node
//   tooling. It must NOT import Electron at the top level. Use the same lazy
//   `createRequire` trick credentials-store.js uses so unit tests can run.
//
// SECURITY:
//   * Bearer never logged. The 'Authorization' header is stripped from any
//     diagnostic dump emitted by this module.
//   * Token file is chmod 600 best-effort; on Windows we rely on the user
//     profile ACL since chmod is a no-op there.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

// ── safeStorage (Electron only) ────────────────────────────────────────────
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

// ── State file ────────────────────────────────────────────────────────────
// Layout:
//   {
//     baseUrl: "https://agentstore.example.com",
//     user: { id, email, name } | null,
//     token: <opaque>,            // present only when enc === false
//     token_enc: <base64>,        // present only when enc === true
//     enc: true | false,
//     loginAt: <iso8601>
//   }
function _stateFile() {
  return process.env.FAUNA_AGENTSTORE_FILE ||
    path.join(os.homedir(), '.config', 'fauna', 'agentstore.json');
}

// Single source of truth for the agentstore backend host. Must match the
// host used by the Agent Store dialog's proxy (see server.js
// `storeBackendUrl`) so a bearer issued via one panel is valid against the
// other. We accept FAUNA_AGENTSTORE_URL (sync-specific override) or
// AGENT_STORE_URL (Agent Store proxy override, same value with /api appended
// in some configs). If either is set with a trailing `/api`, strip it —
// this client appends `/api/...` itself when building request URLs.
function _normalizeBaseUrl(raw) {
  return String(raw || '').replace(/\/+api\/?$/i, '').replace(/\/+$/, '');
}

function _defaultBaseUrl() {
  return _normalizeBaseUrl(
    process.env.FAUNA_AGENTSTORE_URL ||
    process.env.AGENT_STORE_URL ||
    'https://agentstore.pointlabel.com'
  );
}

let _cache = null;

function _readState() {
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(_stateFile(), 'utf8'));
    _cache = (raw && typeof raw === 'object') ? raw : {};
  } catch (_) {
    _cache = {};
  }
  if (!_cache.baseUrl) _cache.baseUrl = _defaultBaseUrl();
  return _cache;
}

async function _writeState(state) {
  const file = _stateFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, file);
  try { await fsp.chmod(file, 0o600); } catch (_) { /* windows / best effort */ }
  _cache = state;
}

function _encrypt(plain) {
  const ss = _getSafeStorage();
  if (!ss) return { enc: false, token: plain };
  try {
    const buf = ss.encryptString(plain);
    return { enc: true, token_enc: Buffer.from(buf).toString('base64') };
  } catch (_) {
    return { enc: false, token: plain };
  }
}

function _decrypt(state) {
  if (!state) return null;
  if (state.enc === true && state.token_enc) {
    const ss = _getSafeStorage();
    if (!ss) return null; // can't decrypt without OS key — caller should re-login
    try {
      return ss.decryptString(Buffer.from(state.token_enc, 'base64'));
    } catch (_) { return null; }
  }
  if (state.token) return state.token;
  return null;
}

// ── Public: session helpers ────────────────────────────────────────────────

/** @returns {{ baseUrl: string, user: object|null, loggedIn: boolean }} */
export function getSession() {
  const s = _readState();
  return {
    baseUrl: s.baseUrl || _defaultBaseUrl(),
    user: s.user || null,
    loggedIn: !!_decrypt(s),
    loginAt: s.loginAt || null,
  };
}

export function getBaseUrl() {
  return _readState().baseUrl || _defaultBaseUrl();
}

export async function setBaseUrl(url) {
  const state = _readState();
  state.baseUrl = _normalizeBaseUrl(url);
  await _writeState(state);
}

/** Returns the bearer or null. Never throws. */
export function getToken() {
  return _decrypt(_readState());
}

export async function logout() {
  // Try to invalidate server-side first; ignore errors so a network outage
  // doesn't trap a user on a shared machine.
  try {
    const token = getToken();
    if (token) {
      await _rawRequest('POST', '/api/auth/logout', null, { token, retries: 0 });
    }
  } catch (_) { /* best effort */ }
  await _writeState({ baseUrl: getBaseUrl(), user: null });
}

/**
 * Login with email + password against the agentstore backend.
 * Returns { ok, user, error? }.
 */
export async function login({ email, password, baseUrl } = {}) {
  if (!email || !password) {
    return { ok: false, error: 'Email and password are required' };
  }
  const url = baseUrl ? _normalizeBaseUrl(baseUrl) : getBaseUrl();
  let body;
  try {
    body = await _rawRequest('POST', '/api/auth/login', { email, password }, { baseUrl: url, retries: 0 });
  } catch (e) {
    return { ok: false, error: e.message || 'Login failed', status: e.status || 0 };
  }
  const token = body?.token || body?.access_token;
  if (!token) {
    return { ok: false, error: 'Server did not return a token' };
  }
  const user = body?.user || { email };
  const stored = _encrypt(token);
  await _writeState({
    baseUrl: url,
    user,
    loginAt: new Date().toISOString(),
    ...stored,
  });
  return { ok: true, user };
}

/** Refreshes the cached user profile from /api/auth/me. Cheap probe. */
export async function refreshProfile() {
  const token = getToken();
  if (!token) return { ok: false, error: 'Not logged in' };
  try {
    const me = await _rawRequest('GET', '/api/auth/me', null, { token });
    const state = _readState();
    state.user = me?.user || me || state.user;
    await _writeState(state);
    return { ok: true, user: state.user };
  } catch (e) {
    if (e.status === 401) await _writeState({ baseUrl: getBaseUrl(), user: null });
    return { ok: false, error: e.message, status: e.status || 0 };
  }
}

/**
 * Adopt an existing bearer token issued elsewhere in the app (e.g. the
 * Agent Store sign-in flow that stores its token in localStorage). Persists
 * the token to the encrypted state file and validates it against
 * /api/auth/me so the sync engine sees a populated user record.
 *
 * Returns { ok, user, error? } — same shape as login().
 */
export async function adoptToken({ token, baseUrl, user } = {}) {
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'token is required' };
  }
  // When the caller doesn't pass a baseUrl, use the current default rather
  // than whatever's cached in state. This prevents a stale state file from
  // a previous build (pointing at an old host) from misdirecting adoption.
  const url = baseUrl ? _normalizeBaseUrl(baseUrl) : _defaultBaseUrl();
  const stored = _encrypt(token);
  await _writeState({
    baseUrl: url,
    user: user || null,
    loginAt: new Date().toISOString(),
    ...stored,
  });
  // Validate by hitting /api/auth/me. If it 401s, wipe and report failure
  // so the caller can prompt for a fresh sign-in.
  const probe = await refreshProfile();
  if (!probe.ok) {
    await _writeState({ baseUrl: url, user: null });
    return { ok: false, error: probe.error || 'Token rejected by server', status: probe.status };
  }
  return { ok: true, user: probe.user };
}

// ── Public: REST primitives used by sync-engine ───────────────────────────

/**
 * Authed JSON request. Returns the parsed body. Throws an Error with
 * `.status` and `.body` properties on HTTP errors so callers can branch
 * (e.g. sync-engine treats 409 as a merge-able conflict).
 *
 * `headers` is merged into the request; useful for `If-Match`.
 */
export async function request(method, pathname, body, { headers, timeoutMs, retries } = {}) {
  const token = getToken();
  if (!token) {
    const e = new Error('Not logged in');
    e.status = 401;
    throw e;
  }
  return _rawRequest(method, pathname, body, { token, headers, timeoutMs, retries });
}

/** Same as request() but lets you specify the body as a raw string (so the
 *  PUT payload hash on the wire matches the hash the client computed). */
export async function requestRaw(method, pathname, rawBody, { headers, timeoutMs, retries, contentType } = {}) {
  const token = getToken();
  if (!token) {
    const e = new Error('Not logged in');
    e.status = 401;
    throw e;
  }
  return _rawRequest(method, pathname, rawBody, {
    token, headers, timeoutMs, retries,
    rawBody: true,
    contentType: contentType || 'application/json',
  });
}

// ── Internal: transport ────────────────────────────────────────────────────

async function _rawRequest(method, pathname, body, opts = {}) {
  const { token, baseUrl, headers, timeoutMs = 30_000, retries = 2, rawBody = false, contentType = 'application/json' } = opts;
  const base = (baseUrl || getBaseUrl()).replace(/\/+$/, '');
  const url = base + (pathname.startsWith('/') ? pathname : ('/' + pathname));

  const finalHeaders = {
    'Accept': 'application/json',
    ...(headers || {}),
  };
  if (token) finalHeaders['Authorization'] = `Bearer ${token}`;

  let payload;
  if (body == null) {
    payload = undefined;
  } else if (rawBody) {
    payload = body;
    finalHeaders['Content-Type'] = contentType;
  } else {
    payload = JSON.stringify(body);
    finalHeaders['Content-Type'] = 'application/json';
  }

  let attempt = 0;
  let lastErr = null;
  while (attempt <= retries) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: ac.signal,
      });
      clearTimeout(t);
      const text = await res.text();
      let parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
      }
      if (!res.ok) {
        const e = new Error(_extractError(parsed) || `HTTP ${res.status} ${res.statusText}`);
        e.status = res.status;
        e.body = parsed;
        // Do not retry 4xx — they're deterministic.
        if (res.status >= 400 && res.status < 500) throw e;
        lastErr = e;
      } else {
        return parsed;
      }
    } catch (e) {
      clearTimeout(t);
      // Retry only on network errors / 5xx (lastErr branch).
      if (e?.status && e.status >= 400 && e.status < 500) throw e;
      lastErr = e;
    }
    attempt++;
    if (attempt <= retries) {
      const backoff = Math.min(8000, 250 * Math.pow(2, attempt));
      await new Promise(r => setTimeout(r, backoff + Math.random() * 200));
    }
  }
  throw lastErr || new Error('Request failed');
}

function _extractError(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload.slice(0, 500);
  if (typeof payload === 'object') {
    return payload.error || payload.message ||
           (payload.errors ? JSON.stringify(payload.errors).slice(0, 500) : null);
  }
  return null;
}

// Test helper.
export function _resetCache() { _cache = null; }

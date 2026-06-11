// ── GitHub Accounts Store — multi-account PAT vault for per-project git ops ─
//
// Mirrors VS Code's GitHub auth model: users add one or more accounts, then
// each project can be linked to a specific account + repo for commit / pull /
// push / sync operations.
//
// Tokens are encrypted at rest via the existing credentials-store
// (Electron safeStorage with a plaintext fallback for dev/tests). Only the
// account metadata (id, login, name, avatar, scopes) is persisted to
// ~/.config/fauna/github-accounts.json.
//
// SECURITY MODEL:
//   * Token values never leave this module except via getGitHubAccountToken(),
//     which is only called inside route handlers that perform git ops on the
//     server. They are NEVER sent to the renderer or to the LLM.
//   * Adding an account validates the PAT against api.github.com/user before
//     persisting, so invalid tokens are rejected immediately.

import fs    from 'fs';
import path  from 'path';
import os    from 'os';
import crypto from 'crypto';
import {
  createCredential,
  deleteCredential,
  resolveCredential,
} from './credentials-store.js';

const ACCOUNTS_FILE_DEFAULT = path.join(os.homedir(), '.config', 'fauna', 'github-accounts.json');
function _accountsFile() {
  return process.env.FAUNA_GITHUB_ACCOUNTS_FILE || ACCOUNTS_FILE_DEFAULT;
}

let _accounts = null;

function _load() {
  if (_accounts) return _accounts;
  try {
    const raw = JSON.parse(fs.readFileSync(_accountsFile(), 'utf8'));
    _accounts = Array.isArray(raw) ? raw : [];
  } catch (_) {
    _accounts = [];
  }
  return _accounts;
}

function _save() {
  const file = _accountsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_accounts, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
}

function _genId() {
  return 'gh-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
}

function _meta(account) {
  return {
    id:           account.id,
    login:        account.login,
    name:         account.name,
    avatarUrl:    account.avatarUrl,
    email:        account.email,
    scopes:       account.scopes || [],
    addedAt:      account.addedAt,
    lastUsedAt:   account.lastUsedAt,
    lastError:    account.lastError || null,
  };
}

/**
 * Validate a PAT against GitHub's API and return the user info + granted
 * scopes. Throws on auth failure / network error.
 */
async function _validateToken(token) {
  const tok = String(token || '').trim();
  if (!tok) throw new Error('Token is required.');
  let res;
  try {
    res = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': 'Bearer ' + tok,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'fauna-app',
      },
    });
  } catch (e) {
    throw new Error('Could not reach api.github.com: ' + (e?.message || e));
  }
  if (res.status === 401) throw new Error('GitHub rejected the token (401). Check that it has not been revoked or expired.');
  if (!res.ok) throw new Error('GitHub returned HTTP ' + res.status + ' validating the token.');
  const user = await res.json();
  // X-OAuth-Scopes is set for classic PATs; fine-grained PATs return an empty
  // list here and we surface scopes:contents/metadata in the UI instead.
  const scopes = (res.headers.get('x-oauth-scopes') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return { user, scopes };
}

// ── Public API ──────────────────────────────────────────────────────────────

export function listGitHubAccounts() {
  return _load().map(_meta);
}

export function getGitHubAccountMeta(id) {
  const acct = _load().find(a => a.id === id);
  return acct ? _meta(acct) : null;
}

/**
 * Add a new GitHub account. Validates the token, fetches the user, and stores
 * the token encrypted via the credentials-store. Throws if validation fails
 * or if the same login is already registered (use updateGitHubAccountToken
 * to rotate an existing account's token).
 */
export async function addGitHubAccount({ token, label } = {}) {
  const { user, scopes } = await _validateToken(token);
  const accounts = _load();
  // Dedupe by login.
  const existing = accounts.find(a => String(a.login || '').toLowerCase() === String(user.login).toLowerCase());
  if (existing) {
    throw new Error('Account "' + user.login + '" is already linked. Remove it first if you want to replace the token.');
  }
  // Store the token in the credentials vault under a deterministic name.
  const credName = 'github:' + user.login + (label ? ' (' + label + ')' : '');
  const cred = createCredential({
    name: credName,
    type: 'bearer',
    data: { token: String(token).trim() },
  });
  const now = new Date().toISOString();
  const account = {
    id:           _genId(),
    login:        user.login,
    name:         user.name || user.login,
    avatarUrl:    user.avatar_url || null,
    email:        user.email || null,
    scopes,
    credentialId: cred.id,
    addedAt:      now,
    lastUsedAt:   now,
    lastError:    null,
  };
  accounts.push(account);
  _save();
  return _meta(account);
}

/**
 * Re-test an account's token against GitHub. Updates lastUsedAt + lastError
 * on the stored account. Returns the fresh metadata.
 */
export async function testGitHubAccount(id) {
  const accounts = _load();
  const acct = accounts.find(a => a.id === id);
  if (!acct) return null;
  const resolved = resolveCredential(acct.credentialId);
  if (!resolved || !resolved.data?.token) {
    acct.lastError = 'Token missing from credentials vault.';
    _save();
    return _meta(acct);
  }
  try {
    const { user, scopes } = await _validateToken(resolved.data.token);
    acct.login        = user.login;
    acct.name         = user.name || user.login;
    acct.avatarUrl    = user.avatar_url || acct.avatarUrl;
    acct.email        = user.email || acct.email;
    acct.scopes       = scopes;
    acct.lastUsedAt   = new Date().toISOString();
    acct.lastError    = null;
  } catch (e) {
    acct.lastError = String(e?.message || e);
  }
  _save();
  return _meta(acct);
}

/**
 * Remove an account and its stored token. Returns true if found.
 */
export function removeGitHubAccount(id) {
  const accounts = _load();
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) return false;
  const acct = accounts[idx];
  if (acct.credentialId) {
    try { deleteCredential(acct.credentialId); } catch (_) { /* best effort */ }
  }
  accounts.splice(idx, 1);
  _save();
  return true;
}

/**
 * Resolve the decrypted token for an account. ONLY for use inside the server
 * route handlers that perform git operations. Updates lastUsedAt as a side
 * effect. Returns null if the account or token is missing.
 */
export function getGitHubAccountToken(id) {
  const accounts = _load();
  const acct = accounts.find(a => a.id === id);
  if (!acct || !acct.credentialId) return null;
  const resolved = resolveCredential(acct.credentialId);
  if (!resolved || !resolved.data?.token) return null;
  acct.lastUsedAt = new Date().toISOString();
  try { _save(); } catch (_) { /* best effort */ }
  return resolved.data.token;
}

// Test/runtime helper — drop the in-memory cache so a changed file is re-read.
export function _resetGitHubAccountsCache() { _accounts = null; }

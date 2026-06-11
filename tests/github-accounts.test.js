// Tests for github-accounts.js — the multi-account PAT vault.
//
// Strategy: mock the global fetch so PAT validation doesn't hit the network,
// and redirect both the credentials-store file AND the github-accounts file
// to a temp dir via env vars.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs   from 'fs';
import os   from 'os';
import path from 'path';

let tmpDir;
let mod;
let credStore;
let origFetch;

function _mockFetchFor(login, opts) {
  opts = opts || {};
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes('api.github.com/user')) {
      if (opts.fail) {
        return {
          ok: false, status: opts.status || 401,
          headers: { get: () => '' },
          async json() { return { message: 'Bad credentials' }; },
        };
      }
      return {
        ok: true, status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'x-oauth-scopes' ? (opts.scopes || 'repo, read:user') : '') },
        async json() {
          return {
            login,
            name: opts.name || login,
            avatar_url: 'https://example.test/' + login + '.png',
            email: opts.email || null,
          };
        },
      };
    }
    throw new Error('Unexpected fetch in test: ' + url);
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-gh-'));
  process.env.FAUNA_CREDENTIALS_FILE       = path.join(tmpDir, 'credentials.json');
  process.env.FAUNA_GITHUB_ACCOUNTS_FILE   = path.join(tmpDir, 'github-accounts.json');
  origFetch = globalThis.fetch;
  // Fresh module instances per test so the in-memory caches are clean.
  credStore = await import('../credentials-store.js?t=' + Date.now());
  credStore._resetCache();
  mod = await import('../github-accounts.js?t=' + Date.now());
  mod._resetGitHubAccountsCache();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.FAUNA_CREDENTIALS_FILE;
  delete process.env.FAUNA_GITHUB_ACCOUNTS_FILE;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('github-accounts.js', () => {
  it('addGitHubAccount validates the PAT and persists metadata only', async () => {
    _mockFetchFor('octocat');
    const acct = await mod.addGitHubAccount({ token: 'ghp_fake_token_value_abc' });
    expect(acct.login).toBe('octocat');
    expect(acct.avatarUrl).toContain('octocat');
    // Metadata projection never includes the raw token.
    expect(JSON.stringify(acct)).not.toContain('ghp_fake_token_value_abc');
    // Persisted JSON also never contains the plaintext token.
    const raw = fs.readFileSync(process.env.FAUNA_GITHUB_ACCOUNTS_FILE, 'utf8');
    expect(raw).not.toContain('ghp_fake_token_value_abc');
  });

  it('listGitHubAccounts returns metadata only — no tokens', async () => {
    _mockFetchFor('octocat');
    await mod.addGitHubAccount({ token: 'ghp_secret_value_xyz' });
    const list = mod.listGitHubAccounts();
    expect(list).toHaveLength(1);
    expect(list[0].login).toBe('octocat');
    expect(JSON.stringify(list)).not.toContain('ghp_secret_value_xyz');
  });

  it('rejects a token that GitHub refuses (401)', async () => {
    _mockFetchFor('nobody', { fail: true });
    await expect(mod.addGitHubAccount({ token: 'bad' })).rejects.toThrow(/401|reject/i);
    expect(mod.listGitHubAccounts()).toHaveLength(0);
  });

  it('rejects duplicate logins', async () => {
    _mockFetchFor('octocat');
    await mod.addGitHubAccount({ token: 'ghp_first' });
    await expect(mod.addGitHubAccount({ token: 'ghp_second' })).rejects.toThrow(/already linked/i);
  });

  it('getGitHubAccountToken returns the decrypted PAT for server-side ops', async () => {
    _mockFetchFor('octocat');
    const acct = await mod.addGitHubAccount({ token: 'ghp_round_trip' });
    const token = mod.getGitHubAccountToken(acct.id);
    expect(token).toBe('ghp_round_trip');
  });

  it('removeGitHubAccount deletes both the account row and the credential entry', async () => {
    _mockFetchFor('octocat');
    const acct = await mod.addGitHubAccount({ token: 'ghp_remove_me' });
    expect(credStore.listCredentials()).toHaveLength(1);
    expect(mod.removeGitHubAccount(acct.id)).toBe(true);
    expect(mod.listGitHubAccounts()).toHaveLength(0);
    expect(credStore.listCredentials()).toHaveLength(0);
  });

  it('testGitHubAccount captures the lastError when validation fails', async () => {
    _mockFetchFor('octocat');
    const acct = await mod.addGitHubAccount({ token: 'ghp_then_revoked' });
    _mockFetchFor('octocat', { fail: true });
    const fresh = await mod.testGitHubAccount(acct.id);
    expect(fresh.lastError).toMatch(/401|reject/i);
  });

  it('supports two distinct accounts side-by-side', async () => {
    _mockFetchFor('alice');
    await mod.addGitHubAccount({ token: 'ghp_alice' });
    _mockFetchFor('bob');
    await mod.addGitHubAccount({ token: 'ghp_bob' });
    const logins = mod.listGitHubAccounts().map(a => a.login).sort();
    expect(logins).toEqual(['alice', 'bob']);
  });
});

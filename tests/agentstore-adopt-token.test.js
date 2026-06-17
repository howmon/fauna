// ── adoptToken() — reuse an externally-issued bearer for sync ─────────────
//
// adoptToken lets the renderer hand the sync engine a bearer that was issued
// by another in-app sign-in flow (the Agent Store dialog), so users don't
// have to authenticate twice against the same backend.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir;
let tmpFile;
let origFetch;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-adopt-'));
  tmpFile = path.join(tmpDir, 'agentstore.json');
  process.env.FAUNA_AGENTSTORE_FILE = tmpFile;
  process.env.FAUNA_AGENTSTORE_URL = 'https://test.example.com';
  origFetch = global.fetch;
  vi.resetModules();
});

afterEach(async () => {
  global.fetch = origFetch;
  delete process.env.FAUNA_AGENTSTORE_FILE;
  delete process.env.FAUNA_AGENTSTORE_URL;
  try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('agentstore-client.adoptToken', () => {
  it('persists a valid token and populates user from /api/auth/me', async () => {
    const meCalls = [];
    global.fetch = vi.fn(async (url, opts) => {
      meCalls.push({ url, auth: opts.headers.Authorization });
      return new Response(JSON.stringify({ user: { id: 7, email: 'sam@example.com', name: 'Sam' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    const { adoptToken, getSession, getToken } = await import('../server/lib/agentstore-client.js');
    const r = await adoptToken({ token: 'tok-abc', user: { email: 'sam@example.com' } });
    expect(r.ok).toBe(true);
    expect(r.user.email).toBe('sam@example.com');
    expect(getToken()).toBe('tok-abc');
    expect(getSession().loggedIn).toBe(true);
    // The probe must have used the new token.
    expect(meCalls.length).toBeGreaterThan(0);
    expect(meCalls[0].auth).toBe('Bearer tok-abc');
    expect(meCalls[0].url).toContain('/api/auth/me');
    // State persisted on disk.
    const onDisk = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    expect(onDisk.user.email).toBe('sam@example.com');
    // Token is stored either encrypted (Electron) or plaintext (test env).
    expect(onDisk.token || onDisk.token_enc).toBeTruthy();
  });

  it('rejects an empty token without touching disk', async () => {
    global.fetch = vi.fn();
    const { adoptToken } = await import('../server/lib/agentstore-client.js');
    const r = await adoptToken({ token: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/token is required/i);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('wipes the session and reports failure when the server returns 401', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'Unauthenticated.' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    }));
    const { adoptToken, getSession, getToken } = await import('../server/lib/agentstore-client.js');
    const r = await adoptToken({ token: 'stale-token' });
    expect(r.ok).toBe(false);
    expect(getToken()).toBeNull();
    expect(getSession().loggedIn).toBe(false);
  });

  it('honors a custom baseUrl', async () => {
    let seenUrl = null;
    global.fetch = vi.fn(async (url) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ user: { email: 'x@y.z' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    const { adoptToken, getBaseUrl } = await import('../server/lib/agentstore-client.js');
    const r = await adoptToken({ token: 't', baseUrl: 'https://custom.example.org/' });
    expect(r.ok).toBe(true);
    expect(seenUrl).toContain('https://custom.example.org/api/auth/me');
    expect(getBaseUrl()).toBe('https://custom.example.org');
  });

  it('strips a trailing /api from supplied baseUrls', async () => {
    let seenUrl = null;
    global.fetch = vi.fn(async (url) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ user: { email: 'x@y.z' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    const { adoptToken, getBaseUrl } = await import('../server/lib/agentstore-client.js');
    const r = await adoptToken({ token: 't', baseUrl: 'https://agentstore.pointlabel.com/api' });
    expect(r.ok).toBe(true);
    // Must NOT double-prefix /api.
    expect(seenUrl).toBe('https://agentstore.pointlabel.com/api/auth/me');
    expect(getBaseUrl()).toBe('https://agentstore.pointlabel.com');
  });

  it('falls back to AGENT_STORE_URL when FAUNA_AGENTSTORE_URL is unset', async () => {
    delete process.env.FAUNA_AGENTSTORE_URL;
    process.env.AGENT_STORE_URL = 'https://agentstore.pointlabel.com/api';
    let seenUrl = null;
    global.fetch = vi.fn(async (url) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ user: { email: 'x@y.z' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    const { adoptToken, getBaseUrl } = await import('../server/lib/agentstore-client.js');
    const r = await adoptToken({ token: 't' });
    expect(r.ok).toBe(true);
    expect(seenUrl).toBe('https://agentstore.pointlabel.com/api/auth/me');
    expect(getBaseUrl()).toBe('https://agentstore.pointlabel.com');
    delete process.env.AGENT_STORE_URL;
  });
});

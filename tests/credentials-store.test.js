// Tests for the encrypted credentials vault (credentials-store.js).
// safeStorage is unavailable in tests, so the store uses its base64 plaintext
// fallback (enc:'plain'). We isolate the on-disk file via env + a temp dir.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir;
let store;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-cred-'));
  process.env.FAUNA_CREDENTIALS_FILE = path.join(tmpDir, 'credentials.json');
  // Fresh module instance per test so the in-memory cache + env are clean.
  store = await import('../credentials-store.js?t=' + Date.now());
  store._resetCache();
});

afterEach(() => {
  delete process.env.FAUNA_CREDENTIALS_FILE;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('credentials-store CRUD', () => {
  it('creates a credential and returns metadata WITHOUT secret values', () => {
    const meta = store.createCredential({ name: 'My API', type: 'apiKey', data: { apiKey: 'sk-secret-123' } });
    expect(meta.id).toMatch(/^cred-/);
    expect(meta.name).toBe('My API');
    expect(meta.type).toBe('apiKey');
    expect(meta.fields).toEqual(['apiKey']);
    // Crucially: no secret value anywhere in the projection.
    expect(JSON.stringify(meta)).not.toContain('sk-secret-123');
  });

  it('listCredentials never leaks secret values', () => {
    store.createCredential({ name: 'A', type: 'bearer', data: { token: 'topsecret' } });
    const list = store.listCredentials();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('topsecret');
    expect(list[0].fields).toEqual(['token']);
  });

  it('persists ciphertext, not plaintext, to disk', () => {
    store.createCredential({ name: 'B', type: 'apiKey', data: { apiKey: 'plain-value-xyz' } });
    const raw = fs.readFileSync(process.env.FAUNA_CREDENTIALS_FILE, 'utf8');
    expect(raw).not.toContain('plain-value-xyz'); // base64-encoded at minimum
  });

  it('resolveCredential decrypts fields (round-trip)', () => {
    const meta = store.createCredential({ name: 'C', type: 'basic', data: { username: 'admin', password: 'hunter2' } });
    const resolved = store.resolveCredential(meta.id);
    expect(resolved.data.username).toBe('admin');
    expect(resolved.data.password).toBe('hunter2');
  });

  it('updateCredential re-encrypts provided fields and removes empty ones', () => {
    const meta = store.createCredential({ name: 'D', type: 'basic', data: { username: 'u', password: 'p' } });
    store.updateCredential(meta.id, { data: { password: 'newpass', username: '' } });
    const resolved = store.resolveCredential(meta.id);
    expect(resolved.data.password).toBe('newpass');
    expect(resolved.data.username).toBeUndefined();
  });

  it('deleteCredential removes the entry', () => {
    const meta = store.createCredential({ name: 'E', type: 'apiKey', data: { apiKey: 'k' } });
    expect(store.deleteCredential(meta.id)).toBe(true);
    expect(store.getCredentialMeta(meta.id)).toBeNull();
    expect(store.deleteCredential('nope')).toBe(false);
  });

  it('rejects missing name and invalid type', () => {
    expect(() => store.createCredential({ type: 'apiKey', data: {} })).toThrow(/name/i);
    expect(() => store.createCredential({ name: 'x', type: 'bogus' })).toThrow(/type/i);
  });

  it('rejects disallowed fields for a typed credential', () => {
    expect(() => store.createCredential({ name: 'x', type: 'apiKey', data: { token: 'no' } }))
      .toThrow(/not allowed/i);
  });

  it('custom type allows arbitrary fields', () => {
    const meta = store.createCredential({ name: 'Cust', type: 'custom', data: { anything: '1', other: '2' } });
    expect(meta.fields.sort()).toEqual(['anything', 'other']);
  });

  it('resolveCredential returns null for unknown id', () => {
    expect(store.resolveCredential('missing')).toBeNull();
  });
});

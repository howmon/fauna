// ── sync-engine.changePassword orchestration ────────────────────────────
//
// Verifies the two-key scheme: the Master Key (MK) is unchanged across a
// password rotation, so all existing payload ciphertext stays valid. The
// only thing that changes is the wrappedMk envelope on the server.
//
// What's covered:
//   * computeWrappedMkForPassword produces an envelope decryptable with
//     PBKDF2(newPassword, salt) + AAD "e2e:mk" → original MK
//   * engine.changePassword posts to /api/auth/change-password with
//     wrappedMk + oldPassword + newPassword
//   * Wrong oldPassword (server returns 401) surfaces as a typed error
//     and does NOT mutate any local state
//   * Data encrypted BEFORE the password change still decrypts AFTER
//     (because the MK in memory hasn't changed)
//   * Calling changePassword while locked returns an error instead of
//     hitting the network (we'd have no MK to rewrap)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

let tmpDir;

const mockClient = vi.hoisted(() => {
  const log = [];
  return {
    log,
    // Every test sets these before calling.
    nextResponse: null,
    nextStatus: 200,
    getSession() { return { loggedIn: true, user: { email: 'a@b.c' } }; },
    async request(method, urlPath, body /* , opts */) {
      log.push({ method, urlPath, body });
      if (method === 'POST' && urlPath === '/api/auth/change-password') {
        if (this.nextStatus >= 400) {
          const e = new Error(this.nextResponse?.error || 'auth failure');
          e.status = this.nextStatus;
          throw e;
        }
        return this.nextResponse || { ok: true };
      }
      throw new Error('Unexpected ' + method + ' ' + urlPath);
    },
  };
});

vi.mock('../server/lib/agentstore-client.js', () => ({
  getSession: () => mockClient.getSession(),
  request: (...a) => mockClient.request(...a),
  requestRaw: () => { throw new Error('requestRaw not used in these tests'); },
  getToken: () => 'fake',
  getBaseUrl: () => 'http://test',
}));

let engine, syncCrypto;

const SALT_B64 = Buffer.from('0123456789abcdef').toString('base64'); // fixed test salt

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-cpw-'));
  process.env.FAUNA_SYNC_DIR = tmpDir;
  process.env.FAUNA_SYNC_E2E = 'on';
  mockClient.log.length = 0;
  mockClient.nextResponse = null;
  mockClient.nextStatus = 200;
  vi.resetModules();
  engine = await import('../server/lib/sync-engine.js');
  syncCrypto = await import('../server/lib/sync-crypto.js');
  engine._resetForTests();
  syncCrypto._resetForTests();
});

afterEach(async () => {
  if (engine) await engine.stop();
  syncCrypto && syncCrypto._resetForTests();
  try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FAUNA_SYNC_DIR;
  delete process.env.FAUNA_SYNC_E2E;
});

describe('computeWrappedMkForPassword', () => {
  it('produces an envelope that PBKDF2(password, salt) can unwrap to the cached MK', () => {
    const mk = crypto.randomBytes(32);
    syncCrypto._setKeyForTests(mk, SALT_B64);

    const wrap = syncCrypto.computeWrappedMkForPassword('hunter2-new');
    expect(wrap).toBeTruthy();
    expect(wrap.e2e).toBe(1);
    expect(typeof wrap.n).toBe('string');
    expect(typeof wrap.c).toBe('string');

    // Independently derive the PDK and unwrap — this is what the next
    // device login will do on its own.
    const pdk = syncCrypto.deriveKey('hunter2-new', SALT_B64);
    const nonce = Buffer.from(wrap.n, 'base64');
    const ctTag = Buffer.from(wrap.c, 'base64');
    const ct = ctTag.slice(0, ctTag.length - 16);
    const tag = ctTag.slice(ctTag.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', pdk, nonce);
    decipher.setAAD(Buffer.from('e2e:mk', 'utf8'));
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    expect(Buffer.compare(out, mk)).toBe(0);
  });

  it('throws when the engine is locked (no MK to wrap)', () => {
    syncCrypto.clearKey();
    expect(() => syncCrypto.computeWrappedMkForPassword('whatever')).toThrow(/locked/i);
  });
});

describe('engine.changePassword orchestration', () => {
  it('rejects when locked (no cached MK)', async () => {
    syncCrypto.clearKey();
    const r = await engine.changePassword({ oldPassword: 'old', newPassword: 'newPassword123' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/locked/i);
    // Must not have hit the network.
    expect(mockClient.log.length).toBe(0);
  });

  it('rejects when newPassword is too short, before any network call', async () => {
    syncCrypto._setKeyForTests(crypto.randomBytes(32), SALT_B64);
    const r = await engine.changePassword({ oldPassword: 'old-pass-ok', newPassword: 'short' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/8 characters/);
    expect(mockClient.log.length).toBe(0);
  });

  it('rejects when newPassword equals oldPassword', async () => {
    syncCrypto._setKeyForTests(crypto.randomBytes(32), SALT_B64);
    const r = await engine.changePassword({ oldPassword: 'samePassword', newPassword: 'samePassword' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/differ/i);
    expect(mockClient.log.length).toBe(0);
  });

  it('posts oldPassword + newPassword + wrappedMk to /api/auth/change-password', async () => {
    const mk = crypto.randomBytes(32);
    syncCrypto._setKeyForTests(mk, SALT_B64);
    mockClient.nextResponse = { ok: true };

    const r = await engine.changePassword({ oldPassword: 'oldpass99', newPassword: 'brandNewPass' });
    expect(r.ok).toBe(true);

    expect(mockClient.log.length).toBe(1);
    const call = mockClient.log[0];
    expect(call.method).toBe('POST');
    expect(call.urlPath).toBe('/api/auth/change-password');
    expect(call.body.oldPassword).toBe('oldpass99');
    expect(call.body.newPassword).toBe('brandNewPass');
    expect(call.body.wrappedMk).toBeTruthy();
    expect(call.body.wrappedMk.e2e).toBe(1);

    // The server-side handler would unwrap with PBKDF2(newPassword, salt);
    // verify that succeeds and recovers the original MK.
    const pdk = syncCrypto.deriveKey('brandNewPass', SALT_B64);
    const nonce = Buffer.from(call.body.wrappedMk.n, 'base64');
    const ctTag = Buffer.from(call.body.wrappedMk.c, 'base64');
    const ct = ctTag.slice(0, ctTag.length - 16);
    const tag = ctTag.slice(ctTag.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', pdk, nonce);
    decipher.setAAD(Buffer.from('e2e:mk', 'utf8'));
    decipher.setAuthTag(tag);
    const recovered = Buffer.concat([decipher.update(ct), decipher.final()]);
    expect(Buffer.compare(recovered, mk)).toBe(0);
  });

  it('surfaces a 401 from the server as "wrong current password" without mutating local state', async () => {
    const mk = crypto.randomBytes(32);
    syncCrypto._setKeyForTests(mk, SALT_B64);
    // Encrypt a payload BEFORE attempting the change so we can check
    // afterwards that the cached MK didn't shift under us.
    const env = syncCrypto.encryptString('hello', 'ns:1');

    mockClient.nextStatus = 401;
    mockClient.nextResponse = { error: 'wrong current password' };

    const r = await engine.changePassword({ oldPassword: 'wrongOld', newPassword: 'brandNewPass' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/wrong/i);

    // MK still cached — existing ciphertext still decrypts.
    expect(syncCrypto.decryptEnvelope(env, 'ns:1')).toBe('hello');
  });

  it('preserves the Master Key across a password change (data encrypted before still decrypts after)', async () => {
    const mk = crypto.randomBytes(32);
    syncCrypto._setKeyForTests(mk, SALT_B64);

    // Encrypt a few payloads under various AADs, mimicking real synced data.
    const payloads = [
      { aad: 'conversation:c1', plain: '{"id":"c1","title":"hello"}' },
      { aad: 'project:p1',      plain: '{"id":"p1","name":"Demo"}' },
      { aad: 'task:t1',         plain: '{"id":"t1","status":"open"}' },
    ];
    const envelopes = payloads.map(p => ({ ...p, env: syncCrypto.encryptString(p.plain, p.aad) }));

    mockClient.nextResponse = { ok: true };
    const r = await engine.changePassword({ oldPassword: 'oldpass99', newPassword: 'newPassword456' });
    expect(r.ok).toBe(true);

    // Critical assertion: the same cached MK still round-trips ALL the
    // envelopes that were encrypted before the password change. If the
    // engine accidentally rotated the MK we'd see auth-tag failures here.
    for (const { env, aad, plain } of envelopes) {
      expect(syncCrypto.decryptEnvelope(env, aad)).toBe(plain);
    }
  });
});

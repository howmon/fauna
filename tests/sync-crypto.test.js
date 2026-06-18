// ── sync-crypto — round-trip + tamper resistance for E2E envelopes ───────
//
// The crypto module is the trust anchor for cross-device privacy. These
// tests pin down the contract every other sync layer relies on:
//   * deriveKey is deterministic (same password+salt → same key).
//   * encrypt → decrypt round-trips faithfully.
//   * decrypt fails on AAD mismatch (server can't move ciphertext between
//     rows).
//   * decrypt fails on a flipped ciphertext byte (auth tag works).
//   * isEnvelope ducks the wire shape correctly.

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import * as sc from '../server/lib/sync-crypto.js';

beforeEach(() => {
  sc._resetForTests();
});

describe('deriveKey', () => {
  it('returns a 32-byte buffer', () => {
    const key = sc.deriveKey('hunter2', Buffer.alloc(16, 0x01).toString('base64'));
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it('is deterministic for the same password + salt', () => {
    const salt = Buffer.alloc(16, 0x02).toString('base64');
    const a = sc.deriveKey('correct horse battery staple', salt);
    const b = sc.deriveKey('correct horse battery staple', salt);
    expect(a.equals(b)).toBe(true);
  });

  it('changes with the salt', () => {
    const a = sc.deriveKey('p', Buffer.alloc(16, 0x01).toString('base64'));
    const b = sc.deriveKey('p', Buffer.alloc(16, 0x02).toString('base64'));
    expect(a.equals(b)).toBe(false);
  });

  it('throws on missing password or short salt', () => {
    expect(() => sc.deriveKey('', 'AAAAAAAAAAAAAAAAAAAAAA==')).toThrow();
    expect(() => sc.deriveKey('p', '')).toThrow();
    expect(() => sc.deriveKey('p', Buffer.alloc(4, 0).toString('base64'))).toThrow();
  });
});

describe('encrypt / decrypt round-trip', () => {
  beforeEach(() => {
    sc._setKeyForTests(crypto.randomBytes(32));
  });

  it('decrypts what it encrypted', () => {
    const env = sc.encryptString('{"hello":"world"}', 'conversation:abc');
    expect(env.e2e).toBe(1);
    expect(typeof env.n).toBe('string');
    expect(typeof env.c).toBe('string');
    const out = sc.decryptEnvelope(env, 'conversation:abc');
    expect(out).toBe('{"hello":"world"}');
  });

  it('uses a fresh nonce each call', () => {
    const a = sc.encryptString('x', 'ns:id');
    const b = sc.encryptString('x', 'ns:id');
    expect(a.n).not.toBe(b.n);
    expect(a.c).not.toBe(b.c);
  });

  it('fails when AAD does not match (server cannot reroute ciphertext)', () => {
    const env = sc.encryptString('secret', 'project:111');
    expect(() => sc.decryptEnvelope(env, 'project:222')).toThrow();
  });

  it('fails when ciphertext is tampered (auth tag detects flip)', () => {
    const env = sc.encryptString('secret', 'ns:id');
    const buf = Buffer.from(env.c, 'base64');
    buf[0] ^= 0x01;
    env.c = buf.toString('base64');
    expect(() => sc.decryptEnvelope(env, 'ns:id')).toThrow();
  });

  it('fails when nonce is wrong length', () => {
    expect(() => sc.decryptEnvelope({ e2e: 1, n: 'AAAA', c: 'BBBB' }, 'ns:id')).toThrow();
  });
});

describe('isEnvelope', () => {
  it('accepts the wire shape', () => {
    expect(sc.isEnvelope({ e2e: 1, n: 'a', c: 'b' })).toBe(true);
  });
  it('rejects plain payloads', () => {
    expect(sc.isEnvelope({ projectId: 'p1', name: 'hi' })).toBe(false);
    expect(sc.isEnvelope(null)).toBe(false);
    expect(sc.isEnvelope('string')).toBe(false);
    expect(sc.isEnvelope({ e2e: 2, n: 'a', c: 'b' })).toBe(false);
    expect(sc.isEnvelope({ e2e: 1 })).toBe(false);
  });
});

describe('locked state', () => {
  it('encrypt throws when no key is set', () => {
    expect(sc.hasKey()).toBe(false);
    expect(() => sc.encryptString('x', 'ns:id')).toThrow(/locked/);
  });

  it('decrypt throws when no key is set', () => {
    sc._setKeyForTests(crypto.randomBytes(32));
    const env = sc.encryptString('x', 'ns:id');
    sc._resetForTests();
    expect(() => sc.decryptEnvelope(env, 'ns:id')).toThrow(/locked/);
  });

  it('clearKey wipes hasKey', () => {
    sc._setKeyForTests(crypto.randomBytes(32));
    expect(sc.hasKey()).toBe(true);
    sc.clearKey();
    expect(sc.hasKey()).toBe(false);
  });
});

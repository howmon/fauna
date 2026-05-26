// ── Redactor tests ────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { scrubSecrets, containsSecret } from '../server/lib/redactor.js';

describe('scrubSecrets', () => {
  it('passes through innocuous text untouched', () => {
    const r = scrubSecrets('Hello world, this is a perfectly ordinary sentence with numbers 1 2 3.');
    expect(r.mutated).toBe(false);
    expect(r.count).toBe(0);
    expect(r.text).toBe('Hello world, this is a perfectly ordinary sentence with numbers 1 2 3.');
  });

  it('handles empty / non-string input', () => {
    expect(scrubSecrets('').text).toBe('');
    expect(scrubSecrets(null).text).toBe('');
    expect(scrubSecrets(undefined).count).toBe(0);
  });

  it('redacts AWS access key IDs', () => {
    const r = scrubSecrets('My key is AKIAIOSFODNN7EXAMPLE for the bucket.');
    expect(r.text).toContain('[REDACTED:AWS_ACCESS_KEY_ID]');
    expect(r.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts GitHub personal access tokens', () => {
    const tok = 'ghp_' + 'a'.repeat(40);
    const r = scrubSecrets(`use ${tok} to auth`);
    expect(r.text).toContain('[REDACTED:GITHUB_PAT_CLASSIC]');
    expect(r.text).not.toContain(tok);
  });

  it('redacts Stripe live + test secrets distinctly', () => {
    const live = 'sk_live_' + 'A1b2C3d4E5f6G7h8I9j0K1L2';
    const test = 'sk_test_' + 'A1b2C3d4E5f6G7h8I9j0K1L2';
    const r = scrubSecrets(`live=${live} test=${test}`);
    expect(r.text).toContain('[REDACTED:STRIPE_LIVE_SECRET]');
    expect(r.text).toContain('[REDACTED:STRIPE_TEST_SECRET]');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_GHI';
    const r = scrubSecrets('Authorization: ' + jwt);
    expect(r.text).toContain('[REDACTED:JWT]');
    expect(r.text).not.toContain(jwt);
  });

  it('redacts Bearer tokens but keeps the literal "Bearer" prefix', () => {
    const tok = 'A'.repeat(40);
    const r = scrubSecrets(`Authorization: Bearer ${tok}`);
    expect(r.text).toBe('Authorization: Bearer [REDACTED:BEARER_TOKEN]');
  });

  it('redacts PEM private key blocks (multi-line)', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA...lotsoflines...',
      'morebase64data==',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const r = scrubSecrets(`before\n${pem}\nafter`);
    expect(r.text).toContain('[REDACTED:PEM_PRIVATE_KEY]');
    expect(r.text).toContain('before');
    expect(r.text).toContain('after');
    expect(r.text).not.toContain('MIIEow');
  });

  it('redacts generic key=value secrets but keeps the key visible', () => {
    const r = scrubSecrets('api_key="abc123DEFGHIJK456"  password = hunter22XYZ987abc');
    expect(r.text).toContain('api_key=[REDACTED:GENERIC_SECRET]');
    expect(r.text).toContain('password=[REDACTED:GENERIC_SECRET]');
  });

  it('does not flag placeholder values that lack digit+letter mix', () => {
    const r = scrubSecrets('api_key=your-token-here');
    expect(r.mutated).toBe(false);
  });

  it('redacts Anthropic and OpenAI keys distinctly', () => {
    const a = 'sk-ant-' + 'abc123DEF456ghi789JKL';
    const o = 'sk-proj-' + 'X1y2Z3w4V5u6T7s8R9q0P1';
    const r = scrubSecrets(`anthropic=${a} openai=${o}`);
    expect(r.text).toContain('[REDACTED:ANTHROPIC_API_KEY]');
    expect(r.text).toContain('[REDACTED:OPENAI_API_KEY]');
  });

  it('redacts Luhn-valid credit cards by default', () => {
    const r = scrubSecrets('Charge 4111 1111 1111 1111 please.');
    expect(r.text).toContain('[REDACTED:CREDIT_CARD]');
  });

  it('does NOT touch invalid 16-digit sequences (Luhn fails)', () => {
    const r = scrubSecrets('Reference 1234 5678 9012 3456 from invoice');
    expect(r.text).toContain('1234 5678 9012 3456');
  });

  it('does NOT touch emails / phones unless opted in', () => {
    const r = scrubSecrets('Reach Jane at jane@example.com or 555-123-4567');
    expect(r.mutated).toBe(false);
    const r2 = scrubSecrets('Reach Jane at jane@example.com or 555-123-4567', { email: true, phone: true });
    expect(r2.text).toContain('[REDACTED:EMAIL]');
    expect(r2.text).toContain('[REDACTED:PHONE]');
  });

  it('counts redactions per type', () => {
    const r = scrubSecrets(`AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPL2`);
    const aws = r.redactions.find(x => x.type === 'AWS_ACCESS_KEY_ID');
    expect(aws.count).toBe(2);
    expect(r.count).toBe(2);
  });
});

describe('containsSecret', () => {
  it('returns true for obvious secrets', () => {
    expect(containsSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });
  it('returns false for normal prose', () => {
    expect(containsSecret('the quick brown fox jumps over the lazy dog')).toBe(false);
  });
});

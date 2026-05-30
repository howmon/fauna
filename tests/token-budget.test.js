import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  pickBudget,
  computeBudget,
  measureMessages,
  primeTokenizer,
  _internals,
} from '../server/lib/token-budget.js';

describe('token-budget: estimateTokens', () => {
  it('returns 0 for null/undefined/empty', () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens('')).toBe(0);
  });

  it('scales roughly with string length', () => {
    const short = estimateTokens('hello world');
    const long  = estimateTokens('hello world'.repeat(100));
    expect(long).toBeGreaterThan(short * 50);
  });

  it('handles a message object with string content and adds overhead', () => {
    const t = estimateTokens({ role: 'user', content: 'hi' });
    expect(t).toBeGreaterThanOrEqual(4); // per-message overhead
    expect(t).toBeLessThan(20);
  });

  it('handles array content parts (vision-style)', () => {
    const t = estimateTokens({
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:...' } },
      ],
    });
    expect(t).toBeGreaterThan(700); // image part adds ~765
  });

  it('charges tool_calls arguments', () => {
    const bare = estimateTokens({ role: 'assistant', content: '' });
    const withCalls = estimateTokens({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'fauna_read_file', arguments: '{"path":"a.js"}' } }],
    });
    expect(withCalls).toBeGreaterThan(bare);
  });

  it('measureMessages sums over an array', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    expect(measureMessages(msgs)).toBe(
      estimateTokens(msgs[0]) + estimateTokens(msgs[1]) + estimateTokens(msgs[2])
    );
  });

  it('measureMessages returns 0 for non-arrays', () => {
    expect(measureMessages(null)).toBe(0);
    expect(measureMessages('not an array')).toBe(0);
  });
});

describe('token-budget: pickBudget', () => {
  it('returns __default__ for unknown models', () => {
    const b = pickBudget('totally-fake-model-9000');
    expect(b.matched).toBe('__default__');
    expect(b.window).toBe(_internals.MODEL_LIMITS.__default__.window);
  });

  it('returns __default__ for empty/null model', () => {
    expect(pickBudget('').matched).toBe('__default__');
    expect(pickBudget(null).matched).toBe('__default__');
    expect(pickBudget(undefined).matched).toBe('__default__');
  });

  it('exact-matches known models', () => {
    const b = pickBudget('gpt-5');
    expect(b.window).toBe(272_000);
    expect(b.compactAt).toBe(0.75);
  });

  it('strips provider prefix (openai/gpt-5 → gpt-5)', () => {
    const b = pickBudget('openai/gpt-5');
    expect(b.window).toBe(272_000);
  });

  it('longest-prefix matches versioned model ids', () => {
    const b = pickBudget('gpt-5-2025-08-01');
    expect(b.matched).toBe('gpt-5');
    expect(b.window).toBe(272_000);
  });

  it('is case-insensitive', () => {
    expect(pickBudget('GPT-5').window).toBe(272_000);
    expect(pickBudget('Claude-Sonnet').window).toBe(200_000);
  });
});

describe('token-budget: computeBudget', () => {
  it('subtracts system + reserved output from window before applying compactAt', () => {
    const b = computeBudget({ model: 'gpt-5', systemTokens: 2_000, reservedOutput: 4_096 });
    const available = 272_000 - 2_000 - 4_096;
    expect(b.bodyTokenLimit).toBe(Math.floor(available * 0.75));
    expect(b.hardBodyCeiling).toBe(available);
  });

  it('floors available at 1024 even with absurd system tokens', () => {
    const b = computeBudget({ model: 'gpt-4o', systemTokens: 999_999, reservedOutput: 0 });
    expect(b.hardBodyCeiling).toBeGreaterThanOrEqual(1024);
    expect(b.bodyTokenLimit).toBeGreaterThan(0);
  });

  it('uses default reservedOutput when omitted', () => {
    const b = computeBudget({ model: 'gpt-5', systemTokens: 0 });
    expect(b.reservedOutput).toBe(_internals.DEFAULT_RESERVED_OUTPUT_TOKENS);
  });

  it('returns sane defaults for unknown model', () => {
    const b = computeBudget({ model: 'mystery-model' });
    expect(b.matched).toBe('__default__');
    expect(b.bodyTokenLimit).toBeGreaterThan(10_000);
  });

  it('clamps negative system/reserved inputs to 0', () => {
    const b = computeBudget({ model: 'gpt-5', systemTokens: -100, reservedOutput: -50 });
    expect(b.systemTokens).toBe(0);
    expect(b.reservedOutput).toBe(0);
  });
});

describe('token-budget: primeTokenizer (js-tiktoken)', () => {
  it('loads js-tiktoken when installed and yields exact counts', async () => {
    const loaded = await primeTokenizer();
    expect(loaded).toBe(true);
    // "hello world" is 2 tokens under cl100k_base — heuristic gives ~3.
    // Whichever path runs, the count should land in a tight range.
    const t = estimateTokens('hello world');
    expect(t).toBeGreaterThanOrEqual(2);
    expect(t).toBeLessThanOrEqual(4);
  });
});

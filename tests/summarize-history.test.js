import { describe, it, expect, vi } from 'vitest';
import { summarizeHistory, normalizeMessage } from '../server/lib/summarize-history.js';

function makeClient({ content = 'SUMMARY OK', shouldThrow = null, shouldThrowOnce = null } = {}) {
  let calls = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async (params) => {
          calls++;
          if (shouldThrow) throw new Error(shouldThrow);
          if (shouldThrowOnce && calls === 1) throw new Error(shouldThrowOnce);
          return { choices: [{ message: { content } }] };
        }),
      },
    },
    get _calls() { return calls; },
  };
}

describe('normalizeMessage', () => {
  it('keeps simple {role,content} messages', () => {
    expect(normalizeMessage({ role: 'user', content: 'hi' })).toEqual({ role: 'user', content: 'hi' });
  });

  it('flattens array content (vision) to text-only', () => {
    const out = normalizeMessage({
      role: 'user',
      content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'b' }],
    });
    expect(out.content).toBe('a\nb');
  });

  it('returns null for empty/no-text messages', () => {
    expect(normalizeMessage({ role: 'user', content: '' })).toBe(null);
    expect(normalizeMessage({ role: 'user', content: '   ' })).toBe(null);
    expect(normalizeMessage(null)).toBe(null);
    expect(normalizeMessage({})).toBe(null);
  });

  it('coerces unknown roles to user', () => {
    expect(normalizeMessage({ role: 'tool', content: 'x' }).role).toBe('user');
  });

  it('caps each message at 3000 chars', () => {
    const big = 'x'.repeat(5000);
    expect(normalizeMessage({ role: 'user', content: big }).content.length).toBe(3000);
  });
});

describe('summarizeHistory', () => {
  it('returns empty for empty input', async () => {
    const client = makeClient();
    expect(await summarizeHistory([], { client })).toBe('');
    expect(client._calls).toBe(0);
  });

  it('returns empty when no client provided', async () => {
    expect(await summarizeHistory([{ role: 'user', content: 'hi' }], { client: null })).toBe('');
  });

  it('returns empty when all messages normalize to null', async () => {
    const client = makeClient();
    expect(await summarizeHistory([{ role: 'user', content: '' }], { client })).toBe('');
    expect(client._calls).toBe(0);
  });

  it('produces a summary on happy path', async () => {
    const client = makeClient({ content: 'Task done.' });
    const out = await summarizeHistory(
      [{ role: 'user', content: 'do X' }, { role: 'assistant', content: 'ok did X' }],
      { client, model: 'gpt-4o-mini' }
    );
    expect(out).toBe('Task done.');
    expect(client._calls).toBe(1);
  });

  it('uses max_completion_tokens for o-series and gpt-5 models', async () => {
    const client = makeClient();
    await summarizeHistory([{ role: 'user', content: 'x' }], { client, model: 'gpt-5' });
    const params = client.chat.completions.create.mock.calls[0][0];
    expect(params.max_completion_tokens).toBe(600);
    expect(params.max_tokens).toBeUndefined();
  });

  it('uses max_tokens for non-o-series models', async () => {
    const client = makeClient();
    await summarizeHistory([{ role: 'user', content: 'x' }], { client, model: 'claude-sonnet-4.6' });
    const params = client.chat.completions.create.mock.calls[0][0];
    expect(params.max_tokens).toBe(600);
    expect(params.max_completion_tokens).toBeUndefined();
  });

  it('retries once with gpt-4o-mini fallback on model error', async () => {
    const client = makeClient({ content: 'fallback ok', shouldThrowOnce: 'unknown model' });
    const out = await summarizeHistory(
      [{ role: 'user', content: 'x' }],
      { client, model: 'totally-unknown' }
    );
    expect(out).toBe('fallback ok');
    expect(client._calls).toBe(2);
    const second = client.chat.completions.create.mock.calls[1][0];
    expect(second.model).toBe('gpt-4o-mini');
  });

  it('returns empty string (never throws) on hard failure', async () => {
    const client = makeClient({ shouldThrow: 'boom' });
    const out = await summarizeHistory(
      [{ role: 'user', content: 'x' }],
      { client, model: 'gpt-4o-mini' } // model === fallback so no retry
    );
    expect(out).toBe('');
  });
});

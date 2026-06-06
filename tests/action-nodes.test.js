// Tests for the action-node registry (server/lib/action-nodes.js):
// HTTP + Slack connector nodes, credential auth application, and registry
// lookup. fetch is stubbed per test.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getActionNode, isActionNode, listActionNodeDescriptors, _applyAuth } from '../server/lib/action-nodes.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

const idInterp = (s) => s; // identity interpolation for tests

describe('action-nodes registry', () => {
  it('exposes http and slack', () => {
    expect(isActionNode('http')).toBe(true);
    expect(isActionNode('slack')).toBe(true);
    expect(isActionNode('nope')).toBe(false);
    expect(getActionNode('http')).toBeTruthy();
  });

  it('lists descriptors for the UI without executors', () => {
    const descs = listActionNodeDescriptors();
    const http = descs.find(d => d.type === 'http');
    expect(http.label).toBe('HTTP Request');
    expect(http.run).toBeUndefined();
  });
});

describe('_applyAuth', () => {
  it('bearer -> Authorization Bearer', () => {
    const h = {}; _applyAuth(h, { type: 'bearer', data: { token: 'abc' } }, {});
    expect(h.Authorization).toBe('Bearer abc');
  });
  it('basic -> base64 Authorization', () => {
    const h = {}; _applyAuth(h, { type: 'basic', data: { username: 'u', password: 'p' } }, {});
    expect(h.Authorization).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
  });
  it('apiKey -> custom header name', () => {
    const h = {}; _applyAuth(h, { type: 'apiKey', data: { apiKey: 'k' } }, { apiKeyHeader: 'X-Token' });
    expect(h['X-Token']).toBe('k');
  });
  it('oauth2 -> Authorization Bearer accessToken', () => {
    const h = {}; _applyAuth(h, { type: 'oauth2', data: { accessToken: 'tok' } }, {});
    expect(h.Authorization).toBe('Bearer tok');
  });
});

describe('http node', () => {
  it('GET returns the response body', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'hello' }));
    const out = await getActionNode('http').run({
      input: null, cfg: { url: 'https://x.test', method: 'GET' }, interp: idInterp, resolveCred: () => null,
    });
    expect(out).toBe('hello');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('applies a credential and sends the body on POST', async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, statusText: 'OK', text: async () => 'done' }; });
    const out = await getActionNode('http').run({
      input: 'payload',
      cfg: { url: 'https://api.test/p', method: 'POST', credentialId: 'c1' },
      interp: idInterp,
      resolveCred: () => ({ type: 'bearer', data: { token: 'sekret' } }),
    });
    expect(out).toBe('done');
    expect(captured.opts.method).toBe('POST');
    expect(captured.opts.headers.Authorization).toBe('Bearer sekret');
    expect(captured.opts.body).toBe('payload');
  });

  it('returns a Node error on non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Err', text: async () => 'boom' }));
    const out = await getActionNode('http').run({ input: null, cfg: { url: 'https://x.test' }, interp: idInterp, resolveCred: () => null });
    expect(out).toMatch(/^Node error: HTTP 500/);
  });

  it('errors when no URL is configured', async () => {
    const out = await getActionNode('http').run({ input: null, cfg: {}, interp: idInterp, resolveCred: () => null });
    expect(out).toMatch(/^Node error: HTTP node has no URL/);
  });

  it('returns a binary item when responseFormat is binary', async () => {
    const bytes = Buffer.from('PNGBYTES');
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => bytes,
    }));
    const out = await getActionNode('http').run({
      input: null,
      cfg: { url: 'https://x.test/logo.png', method: 'GET', responseFormat: 'binary' },
      interp: idInterp, resolveCred: () => null,
    });
    expect(out.binary.data.data).toBe(bytes.toString('base64'));
    expect(out.binary.data.mimeType).toBe('image/png');
    expect(out.json.fileName).toBe('logo.png');
    expect(out.json.contentType).toBe('image/png');
  });
});

describe('slack node', () => {
  it('posts a message with the bot token', async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, opts) => { captured = { url, opts }; return { json: async () => ({ ok: true, ts: '123.45', channel: 'C1' }) }; });
    const out = await getActionNode('slack').run({
      input: 'hi there',
      cfg: { channel: '#general', credentialId: 'c1' },
      interp: idInterp,
      resolveCred: () => ({ type: 'bearer', data: { token: 'xoxb-1' } }),
    });
    expect(captured.url).toBe('https://slack.com/api/chat.postMessage');
    expect(captured.opts.headers.Authorization).toBe('Bearer xoxb-1');
    expect(JSON.parse(captured.opts.body)).toEqual({ channel: '#general', text: 'hi there' });
    expect(JSON.parse(out).ok).toBe(true);
  });

  it('errors without a credential', async () => {
    const out = await getActionNode('slack').run({ input: 'x', cfg: { channel: '#g' }, interp: idInterp, resolveCred: () => null });
    expect(out).toMatch(/^Node error: Slack node requires/);
  });

  it('surfaces a Slack API error', async () => {
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: false, error: 'channel_not_found' }) }));
    const out = await getActionNode('slack').run({
      input: 'x', cfg: { channel: '#nope', credentialId: 'c1' }, interp: idInterp,
      resolveCred: () => ({ type: 'bearer', data: { token: 't' } }),
    });
    expect(out).toMatch(/channel_not_found/);
  });
});

describe('connector catalog', () => {
  it('registers a broad set of connectors with field metadata', () => {
    const descs = listActionNodeDescriptors();
    expect(descs.length).toBeGreaterThanOrEqual(30);
    // representative connectors are present
    ['discord', 'openai', 'telegram', 'github', 'sendgrid', 'stripe', 'notion'].forEach((t) => {
      expect(isActionNode(t)).toBe(true);
    });
    const openai = descs.find(d => d.type === 'openai');
    expect(openai.fields.some(f => f.key === 'model')).toBe(true);
    expect(openai.run).toBeUndefined();
  });

  it('discord webhook posts the message content', async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, statusText: 'OK', text: async () => '' }; });
    const out = await getActionNode('discord').run({
      input: 'hello world', cfg: { url: 'https://discord.test/hook' }, interp: idInterp, resolveCred: () => null,
    });
    expect(captured.url).toBe('https://discord.test/hook');
    expect(JSON.parse(captured.opts.body)).toEqual({ content: 'hello world' });
    expect(out).toMatch(/ok/);
  });

  it('discord errors without a webhook URL', async () => {
    const out = await getActionNode('discord').run({ input: 'x', cfg: {}, interp: idInterp, resolveCred: () => null });
    expect(out).toMatch(/^Node error: .* has no webhook URL/);
  });

  it('openai chat connector sends messages and parses the reply', async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ choices: [{ message: { content: 'hi back' } }] }) };
    });
    const out = await getActionNode('openai').run({
      input: 'say hi', cfg: { credentialId: 'c1' }, interp: idInterp,
      resolveCred: () => ({ type: 'bearer', data: { token: 'sk-1' } }),
    });
    expect(captured.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured.opts.headers.Authorization).toBe('Bearer sk-1');
    const body = JSON.parse(captured.opts.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages[0]).toEqual({ role: 'user', content: 'say hi' });
    expect(out).toBe('hi back');
  });

  it('openai errors without a credential', async () => {
    const out = await getActionNode('openai').run({ input: 'x', cfg: {}, interp: idInterp, resolveCred: () => null });
    expect(out).toMatch(/requires an API key credential/);
  });

  it('telegram posts via the bot-token URL', async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, statusText: 'OK', text: async () => '{"ok":true}' }; });
    const out = await getActionNode('telegram').run({
      input: 'ping', cfg: { chatId: '@me', credentialId: 'c1' }, interp: idInterp,
      resolveCred: () => ({ type: 'apiKey', data: { token: 'BOT123' } }),
    });
    expect(captured.url).toBe('https://api.telegram.org/botBOT123/sendMessage');
    expect(JSON.parse(captured.opts.body)).toEqual({ chat_id: '@me', text: 'ping' });
    expect(out).toMatch(/ok/);
  });

  it('sendgrid sends mail with a bearer credential', async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, opts) => { captured = { url, opts }; return { ok: true, status: 202, statusText: 'Accepted', text: async () => '' }; });
    const out = await getActionNode('sendgrid').run({
      input: 'body text',
      cfg: { to: 'a@test.com', from: 'b@test.com', subject: 'Hi', credentialId: 'c1' },
      interp: idInterp,
      resolveCred: () => ({ type: 'bearer', data: { token: 'SG.key' } }),
    });
    expect(captured.url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(captured.opts.headers.Authorization).toBe('Bearer SG.key');
    expect(out).not.toMatch(/^Node error/);
  });
});


import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativeHttpsFetch } from '../server/copilot/native-https-fetch.js';

describe('native HTTP fetch transport', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/binary' });
        response.end();
        return;
      }
      if (request.url === '/binary') {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(Buffer.from([0, 127, 128, 255]));
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ method: request.method, body }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('returns a Fetch-compatible response without WebAssembly', async () => {
    const response = await nativeHttpsFetch(`${baseUrl}/models`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4.8' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4.8' }),
    });
  });

  it('follows redirects and preserves streamed binary data', async () => {
    const response = await nativeHttpsFetch(`${baseUrl}/redirect`);

    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 127, 128, 255]);
  });

  it('does not emit an uncaught EPIPE when aborted during worker startup', async () => {
    const errors = [];
    const onUncaughtException = error => errors.push(error);
    process.on('uncaughtException', onUncaughtException);

    try {
      for (let index = 0; index < 20; index++) {
        const controller = new AbortController();
        const request = nativeHttpsFetch(`${baseUrl}/models`, { signal: controller.signal });
        controller.abort();
        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      }
      await new Promise(resolve => setImmediate(resolve));
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaughtException);
    }
  });
});
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativeHttpsFetch } from '../server/copilot/native-https-fetch.js';

describe('native HTTP fetch transport', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
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
});
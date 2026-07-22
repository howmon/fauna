import https from 'node:https';
import { Readable } from 'node:stream';

export function nativeHttpsFetch(input, init = {}) {
  const source = typeof input === 'string' || input instanceof URL ? null : input;
  const url = new URL(source ? source.url : input);
  if (url.protocol !== 'https:') {
    return Promise.reject(new TypeError(`nativeHttpsFetch only supports HTTPS URLs, received ${url.protocol}`));
  }

  const headers = new Headers(source?.headers || undefined);
  new Headers(init.headers || undefined).forEach((value, name) => headers.set(name, value));
  const body = init.body ?? source?.body ?? null;

  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: init.method || source?.method || 'GET',
      headers: Object.fromEntries(headers.entries()),
      signal: init.signal,
    }, response => {
      resolve(new Response(Readable.toWeb(response), {
        status: response.statusCode || 500,
        statusText: response.statusMessage || '',
        headers: response.headers,
      }));
    });
    request.on('error', reject);
    if (body == null) {
      request.end();
    } else if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
      request.end(body);
    } else {
      reject(new TypeError('nativeHttpsFetch received an unsupported request body'));
      request.destroy();
    }
  });
}
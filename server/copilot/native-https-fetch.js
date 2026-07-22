import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const WORKER_PATH = fileURLToPath(new URL('./native-fetch-worker.cjs', import.meta.url));

export function nativeHttpsFetch(input, init = {}) {
  const source = typeof input === 'string' || input instanceof URL ? null : input;
  const url = new URL(source ? source.url : input);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return Promise.reject(new TypeError(`nativeHttpsFetch does not support ${url.protocol}`));
  }

  const headers = new Headers(source?.headers || undefined);
  new Headers(init.headers || undefined).forEach((value, name) => headers.set(name, value));
  const body = init.body ?? source?.body ?? null;

  if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    return Promise.reject(new TypeError('nativeHttpsFetch received an unsupported request body'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responseBody = new PassThrough();
    let settled = false;
    let output = '';
    let stderr = '';

    const fail = error => {
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        responseBody.destroy(error);
      }
    };
    const abort = () => {
      child.kill('SIGTERM');
      fail(new DOMException('The operation was aborted', 'AbortError'));
    };
    if (init.signal?.aborted) return abort();
    init.signal?.addEventListener('abort', abort, { once: true });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      let newline;
      while ((newline = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); }
        catch (error) { fail(new Error(`Native fetch worker returned invalid data: ${error.message}`)); continue; }
        if (event.type === 'headers' && !settled) {
          settled = true;
          resolve(new Response(Readable.toWeb(responseBody), {
            status: event.status,
            statusText: event.statusText,
            headers: event.headers,
          }));
        } else if (event.type === 'data') {
          responseBody.write(Buffer.from(event.data, 'base64'));
        } else if (event.type === 'end') {
          responseBody.end();
        } else if (event.type === 'error') {
          const error = new Error(event.error || 'Native fetch worker failed');
          if (event.code) error.code = event.code;
          fail(error);
        }
      }
    });
    child.on('error', fail);
    child.on('exit', code => {
      init.signal?.removeEventListener('abort', abort);
      if (code && !settled) fail(new Error(`Native fetch worker exited with code ${code}${stderr ? `: ${stderr}` : ''}`));
      else if (!settled) fail(new Error('Native fetch worker exited before returning headers'));
    });
    child.stdin.end(JSON.stringify({
      url: url.toString(),
      method: init.method || source?.method || 'GET',
      headers: Object.fromEntries(headers.entries()),
      body: body == null ? null : Buffer.from(body).toString('base64'),
      redirect: init.redirect || source?.redirect || 'follow',
    }));
  });
}

export function runtimeFetch(input, init) {
  return typeof WebAssembly === 'undefined'
    ? nativeHttpsFetch(input, init)
    : globalThis.fetch(input, init);
}
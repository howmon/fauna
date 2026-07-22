const http = require('node:http');
const https = require('node:https');

process.stdout.on('error', error => {
  if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') process.exit(0);
  throw error;
});

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ type: 'error', error: error.message })}\n`);
    return;
  }

  const run = (target, redirects = 0) => {
    const url = new URL(target);
    const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!transport) {
      process.stdout.write(`${JSON.stringify({ type: 'error', error: `Unsupported protocol: ${url.protocol}` })}\n`);
      return;
    }
    const request = transport.request(url, {
      method: payload.method || 'GET',
      headers: payload.headers || {},
    }, response => {
      const location = response.headers.location;
      if (location && payload.redirect !== 'manual' && [301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 5) {
          process.stdout.write(`${JSON.stringify({ type: 'error', error: 'Too many redirects' })}\n`);
          return;
        }
        run(new URL(location, url).toString(), redirects + 1);
        return;
      }
    process.stdout.write(`${JSON.stringify({
      type: 'headers',
      status: response.statusCode || 500,
      statusText: response.statusMessage || '',
      headers: response.headers,
    })}\n`);
    response.on('data', chunk => {
      process.stdout.write(`${JSON.stringify({ type: 'data', data: chunk.toString('base64') })}\n`);
    });
    response.on('end', () => process.stdout.write(`${JSON.stringify({ type: 'end' })}\n`));
    });
    request.on('error', error => {
      process.stdout.write(`${JSON.stringify({ type: 'error', error: error.message, code: error.code })}\n`);
    });
    if (payload.body) request.end(Buffer.from(payload.body, 'base64'));
    else request.end();
  };
  run(payload.url);
});
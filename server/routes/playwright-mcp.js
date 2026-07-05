// Playwright MCP client routes (status, start, call) plus internal client
// management. Extracted from server.js. The factory returns `callTool`,
// `reset`, and `prewarm` so other parts of the server (chat handler,
// startup pre-warm IIFE) can drive the same client.

import path from 'path';
import fs from 'fs';
import { findNodeBinary } from '../lib/find-node-binary.js';

export function registerPlaywrightMcpRoutes(app, {
  express,
  require: _require,
  isWin,
}) {
  let _playwrightMcpClient = null;
  let _playwrightMcpClientPromise = null;
  let _playwrightMcpInstalled = null;
  let _playwrightMcpCallQueue = Promise.resolve();
  let _playwrightMcpLastLaunch = null;
  let _playwrightMcpLastStderr = '';

  async function _getPlaywrightMcpClient() {
    if (_playwrightMcpClient) return _playwrightMcpClient;
    if (_playwrightMcpClientPromise) return _playwrightMcpClientPromise;

    _playwrightMcpClientPromise = (async () => {
    // Spawn @playwright/mcp as a subprocess and connect via MCP SDK stdio transport
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    let cliPath = path.join(path.dirname(_require.resolve('@playwright/mcp')), 'cli.js');
    if (cliPath.includes('app.asar')) {
      const unpackedCliPath = cliPath.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpackedCliPath)) cliPath = unpackedCliPath;
    }
    const nodeBin = findNodeBinary() || process.execPath;
    const spawnEnv = { ...process.env };
    spawnEnv.PATH = isWin
      ? (spawnEnv.PATH || '')
      : `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${spawnEnv.PATH || ''}`;
    if (process.versions?.electron && nodeBin === process.execPath) {
      spawnEnv.ELECTRON_RUN_AS_NODE = '1';
    }
    _playwrightMcpLastStderr = '';
    _playwrightMcpLastLaunch = { nodeBin, cliPath, cwd: path.dirname(cliPath) };
    const transport = new StdioClientTransport({
      command: nodeBin,
      args: [cliPath],
      env: spawnEnv,
      cwd: path.dirname(cliPath),
      stderr: 'pipe',
    });
    transport.stderr?.on('data', chunk => {
      _playwrightMcpLastStderr = (_playwrightMcpLastStderr + chunk.toString()).slice(-4000);
    });
    const client = new Client({ name: 'fauna-playwright', version: '1.0.0' });
    await client.connect(transport);
    _playwrightMcpClient = client;
    // Clean up on close
    client.onclose = () => { _playwrightMcpClient = null; _playwrightMcpClientPromise = null; };
    return client;
    })();

    try {
      return await _playwrightMcpClientPromise;
    } catch (e) {
      _playwrightMcpClient = null;
      _playwrightMcpClientPromise = null;
      throw e;
    }
  }

  function _formatPlaywrightMcpError(e) {
    const parts = [e.message || String(e)];
    if (_playwrightMcpLastStderr) parts.push('stderr: ' + _playwrightMcpLastStderr.trim());
    if (_playwrightMcpLastLaunch) parts.push('launch: ' + JSON.stringify(_playwrightMcpLastLaunch));
    return parts.join('\n');
  }

  async function _callPlaywrightMcpTool(tool, args = {}) {
    const run = async () => {
      const client = await _getPlaywrightMcpClient();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000);
      try {
        return await client.callTool({ name: tool, arguments: args }, undefined, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    };

    const queued = _playwrightMcpCallQueue.catch(() => {}).then(run);
    _playwrightMcpCallQueue = queued.then(() => {}, () => {});
    return queued;
  }

  app.get('/api/playwright-mcp/status', async (req, res) => {
    if (_playwrightMcpInstalled === null) {
      try { await import('@playwright/mcp'); _playwrightMcpInstalled = true; } catch (_) { _playwrightMcpInstalled = false; }
    }
    res.json({
      installed: _playwrightMcpInstalled,
      running:   !!_playwrightMcpClient,
      // Browser MCP card endpoints — mirror what faunaMCP-main exposes
      // (the bundled browser-server, auto-spawned by custom-mcp bridge,
      // listens on WS 3340 for the Chrome/Edge extension and on HTTP 3341
      // as a Streamable HTTP MCP endpoint at /mcp).
      endpoint: {
        wsUrl:    'ws://localhost:3340',
        wsPort:   3340,
        httpUrl:  'http://localhost:3341/mcp',
        httpPort: 3341,
      },
    });
  });

  // Pre-warm the Playwright MCP client (no-op if already running)
  app.post('/api/playwright-mcp/start', async (req, res) => {
    if (_playwrightMcpInstalled === null) {
      try { await import('@playwright/mcp'); _playwrightMcpInstalled = true; } catch (_) { _playwrightMcpInstalled = false; }
    }
    if (!_playwrightMcpInstalled) return res.json({ ok: false, error: 'not-installed' });
    try {
      await _getPlaywrightMcpClient();
      res.json({ ok: true, running: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.post('/api/playwright-mcp/call', express.json({ limit: '4mb' }), async (req, res) => {
    const { tool, args = {} } = req.body || {};
    if (!tool) return res.status(400).json({ error: 'tool required' });

    // Try up to 2 attempts — auto-reconnect if first attempt fails with connection error
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await _callPlaywrightMcpTool(tool, args);
        const content = Array.isArray(result?.content) ? result.content : [{ type: 'text', text: JSON.stringify(result) }];
        return res.json({ ok: true, content });
      } catch (e) {
        // Reset stale client so next attempt spawns a fresh subprocess
        _playwrightMcpClient = null;
        _playwrightMcpClientPromise = null;
        if (attempt === 0 && /closed|disconnect|EPIPE|EOF/i.test(e.message)) {
          console.log('[playwright-mcp] connection lost, retrying…');
          continue;
        }
        // Application-level failure (often a transient disconnect after the
        // machine slept). Return 200 with ok:false — the caller already
        // handles the ok flag, and this avoids a red 500 in the console.
        return res.json({ ok: false, error: _formatPlaywrightMcpError(e) });
      }
    }
  });

  return {
    callTool: _callPlaywrightMcpTool,
    reset: () => { _playwrightMcpClient = null; _playwrightMcpClientPromise = null; },
    status: () => ({
      installed: _playwrightMcpInstalled,
      running: !!_playwrightMcpClient,
      endpoint: {
        wsUrl: 'ws://localhost:3340',
        wsPort: 3340,
        httpUrl: 'http://localhost:3341/mcp',
        httpPort: 3341,
      },
    }),
    prewarm: async () => {
      try {
        await import('@playwright/mcp');
        _playwrightMcpInstalled = true;
        await _getPlaywrightMcpClient();
      } catch (_) { /* swallow — prewarm is best-effort */ }
    },
  };
}

// Browser extension bridge.
//
// Owns:
//   - the WebSocketServer mounted at /ext on the main HTTP server (port 3737)
//   - a secondary WS endpoint on port 3340 for the legacy FaunaBrowserMCP extension
//   - in-memory maps of connected ext clients, pending RPC commands, SSE event clients
//   - the cached "browsers connected via FaunaMCP relay" list (populated by the
//     custom-mcp auto-detect poll via `setRelayBrowsers()`)
//
// Exposes a factory so the few cross-module reads (FaunaMCP connection state,
// custom-mcp client list for /api/faunamcp/status) can be injected as plain
// getters without circular imports. The /api/faunamcp/status route stays in
// server.js for now since it touches figmaState + customMcpClients — it will
// move with the custom-mcp bridge in a later slice.
import { WebSocketServer } from 'ws';

export function createExtBridge({ getFaunaMcpState }) {
  let extWss = null;
  let extNextClientId = 1;
  const extClients = new Map();
  const extPendingCommands = new Map();
  const extEventClients = new Set();

  // Per-client rate-limit on /api/ext/command. A misbehaving caller (or a
  // tool loop bug) could otherwise drive an extension at unbounded rate.
  // We use a rolling 1-second window per clientId|tabId|origin key.
  const RATE_WINDOW_MS = 1000;
  const RATE_MAX = 20; // 20 commands/sec/key
  const _extRate = new Map(); // key -> [timestamps]
  function _checkRate(key) {
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    let arr = _extRate.get(key);
    if (!arr) { arr = []; _extRate.set(key, arr); }
    while (arr.length && arr[0] < cutoff) arr.shift();
    if (arr.length >= RATE_MAX) return false;
    arr.push(now);
    return true;
  }
  let faunaMcpRelayBrowsers = [];  // [{id, browser, version, connectedAt, activeTab}]

  function extBrowserName(userAgent = '') {
    if (/Edg\//.test(userAgent)) return 'Edge';
    if (/OPR\//.test(userAgent)) return 'Opera';
    if (/Firefox\//.test(userAgent)) return 'Firefox';
    if (/Chrome\//.test(userAgent)) return 'Chrome';
    if (/Safari\//.test(userAgent)) return 'Safari';
    return 'Browser';
  }

  function statusList() {
    const direct = Array.from(extClients.values()).map(client => ({
      id: client.id,
      browser: client.browser,
      version: client.version,
      connectedAt: client.connectedAt,
      activeTab: client.activeTab || null,
    }));
    const { connected: relayConnected, connectedAt: relayConnectedAt } = getFaunaMcpState?.() || {};
    if (relayConnected) {
      const directIds = new Set(direct.map(c => c.id));
      for (const b of faunaMcpRelayBrowsers) {
        if (!directIds.has(b.id)) direct.push(b);
      }
      if (!faunaMcpRelayBrowsers.length && !direct.some(c => c.id === 'faunamcp')) {
        direct.push({ id: 'faunamcp', browser: 'FaunaMCP', version: null, connectedAt: relayConnectedAt, activeTab: null });
      }
    }
    return direct;
  }

  function sendSse(event, data = {}) {
    const payload = JSON.stringify(data);
    for (const res of Array.from(extEventClients)) {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${payload}\n\n`);
      } catch (_) {
        extEventClients.delete(res);
      }
    }
  }

  function broadcastStatus() {
    sendSse('message', { event: 'ext:status-changed', browsers: statusList() });
  }

  function handleMessage(client, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.type === 'ping') {
      try { client.ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
      return;
    }

    if (msg.type === 'ext:hello') {
      client.version = msg.version || client.version;
      client.userAgent = msg.userAgent || client.userAgent;
      client.browser = extBrowserName(client.userAgent);
      client.activeTab = msg.activeTab || client.activeTab || null;
      broadcastStatus();
      return;
    }

    if (msg.type === 'ext:bye') {
      // Graceful disconnect. Flag the client so close-handler emits a
      // 'bye' SSE instead of the generic status-changed broadcast and
      // closes the socket immediately.
      client.byeReason = msg.reason || 'client_requested';
      sendSse('message', {
        event: 'ext:bye',
        id: client.id,
        browser: client.browser,
        reason: client.byeReason,
      });
      try { client.ws.close(1000, 'bye'); } catch (_) {}
      return;
    }

    if (msg.type === 'result' && msg.id && extPendingCommands.has(msg.id)) {
      const pending = extPendingCommands.get(msg.id);
      extPendingCommands.delete(msg.id);
      clearTimeout(pending.timeoutId);
      pending.resolve(msg);
      return;
    }

    if (msg.type === 'event') {
      const eventMsg = { event: msg.event, data: msg.data || {}, browser: client.browser, id: client.id };
      if (msg.event === 'tab:activated' || msg.event === 'page:loaded') {
        client.activeTab = msg.data || client.activeTab;
        broadcastStatus();
      }
      sendSse('message', eventMsg);
    }
  }

  function attach(server) {
    if (extWss) return;
    extWss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
      if (pathname === '/api/teams-relay') return;
      if (pathname !== '/ext') { socket.destroy(); return; }
      extWss.handleUpgrade(req, socket, head, ws => extWss.emit('connection', ws, req));
    });

    const relay3340 = new WebSocketServer({ port: 3340 });
    relay3340.on('connection', (ws, req) => extWss.emit('connection', ws, req));
    relay3340.on('error', () => { /* port already in use — relay running separately, ignore */ });

    extWss.on('connection', (ws, req) => {
      const id = 'ext-' + extNextClientId++;
      const userAgent = req.headers['user-agent'] || '';
      const client = {
        id, ws, userAgent,
        browser: extBrowserName(userAgent),
        version: '',
        connectedAt: new Date().toISOString(),
        activeTab: null,
      };
      extClients.set(id, client);
      broadcastStatus();

      ws.on('message', raw => handleMessage(client, raw));
      ws.on('close', () => {
        extClients.delete(id);
        // Reject any pending commands tied to this client (by id OR by ws ref,
        // in case the client reconnected with a fresh id leaving the old
        // socket's pending calls orphaned).
        for (const [cmdId, pending] of Array.from(extPendingCommands.entries())) {
          if (pending.clientId === id || pending.ws === ws) {
            extPendingCommands.delete(cmdId);
            clearTimeout(pending.timeoutId);
            try { pending.reject(new Error('Browser extension disconnected')); } catch (_) {}
          }
        }
        broadcastStatus();
      });
    });
  }

  function openDirectExtClients() {
    return Array.from(extClients.values()).filter(client => client.ws.readyState === 1);
  }

  function isRelayExtClientId(clientId) {
    return clientId && (clientId === 'faunamcp' || clientId.startsWith('relay-'));
  }

  async function forwardExtCommandToRelay({ action, params = {}, tabId = null, clientId = null, timeout = 30000 }) {
    const body = isRelayExtClientId(clientId) && clientId.startsWith('relay-')
      ? JSON.stringify({ id: clientId, action, params, tabId: tabId ?? null, timeout })
      : JSON.stringify({ action, params, tabId: tabId ?? null, timeout });
    const endpoint = isRelayExtClientId(clientId) && clientId.startsWith('relay-')
      ? '/ext-command-by-id'
      : '/ext-command';
    const r = await fetch(`http://localhost:3341${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(Math.max(1000, Math.min(Number(timeout) || 30000, 120000)) + 5000),
    });
    const data = await r.json();
    return { status: r.status, data };
  }

  function register(app) {
    app.get('/api/ext/status', (_req, res) => {
      res.json({ ok: true, browsers: statusList() });
    });

    app.get('/api/ext/events', (req, res) => {
      const _o = req.headers.origin;
      if (_o && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(_o)) {
        res.setHeader('Access-Control-Allow-Origin', _o);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      extEventClients.add(res);
      res.write(`data: ${JSON.stringify({ event: 'ext:status-changed', browsers: statusList() })}\n\n`);
      req.on('close', () => extEventClients.delete(res));
    });

    app.post('/api/ext/command', async (req, res) => {
      // Origin guard: this endpoint can drive the user's browser remotely, so
      // reject cross-origin requests. The Fauna UI is same-origin (no Origin
      // header on fetch), the browser extension uses chrome-extension://,
      // and Electron app pages may use file:// / app://. Anything else
      // (e.g. a malicious web page hitting localhost:3737) is rejected.
      const origin = req.headers.origin || '';
      if (origin) {
        const port = req.socket?.localPort || 3737;
        const allowed = (
          origin === `http://localhost:${port}` ||
          origin === `http://127.0.0.1:${port}` ||
          origin.startsWith('chrome-extension://') ||
          origin.startsWith('moz-extension://') ||
          origin.startsWith('safari-web-extension://') ||
          origin === 'app://-' ||
          origin === 'null'
        );
        if (!allowed) {
          return res.status(403).json({ ok: false, error: 'origin not allowed' });
        }
      }

      const { action, params = {}, tabId, browser, clientId } = req.body || {};
      if (!action) return res.status(400).json({ ok: false, error: 'action required' });

      // Per-client rate limit (20 cmds/sec). Returns 429 with Retry-After.
      const rateKey = (clientId || browser || origin || req.ip || 'anon') + '|' + (tabId ?? '*');
      if (!_checkRate(rateKey)) {
        res.setHeader('Retry-After', '1');
        return res.status(429).json({ ok: false, error: 'ext command rate limit exceeded' });
      }

      if (isRelayExtClientId(clientId)) {
        try {
          const { status, data } = await forwardExtCommandToRelay({ action, params, tabId, clientId, timeout: req.body?.timeout || 30000 });
          return res.status(status).json(data);
        } catch (e) {
          return res.json({ ok: false, error: e.message || 'Browser extension not connected' });
        }
      }

      const clients = openDirectExtClients();
      const { connected: relayConnected } = getFaunaMcpState?.() || {};
      if (!clients.length) {
        if (relayConnected) {
          try {
            const { status, data } = await forwardExtCommandToRelay({ action, params, tabId, timeout: req.body?.timeout || 30000 });
            return res.status(status).json(data);
          } catch (e) {
            return res.json({ ok: false, error: e.message || 'Browser extension not connected' });
          }
        }
        if (action === 'tab:list') {
          return res.json({ ok: false, error: 'Browser extension not connected', tabs: [] });
        }
        return res.json({ ok: false, error: 'Browser extension not connected' });
      }

      const client = clientId
        ? clients.find(c => c.id === clientId) || clients[0]
        : tabId
          ? clients.find(c => c.activeTab && c.activeTab.id === tabId) || clients[0]
          : browser
            ? clients.find(c => c.browser === browser) || clients[0]
            : clients[0];
      const id = 'cmd-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      // Cap caller-supplied timeout at 30s. The previous 120s cap meant a
      // single hung extension could block downstream tasks for two minutes.
      const timeoutMs = Math.max(1000, Math.min(Number(req.body.timeout) || 30000, 30000));

      try {
        const result = await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            extPendingCommands.delete(id);
            reject(new Error('Browser extension command timed out'));
          }, timeoutMs);
          extPendingCommands.set(id, { resolve, reject, timeoutId, clientId: client.id, ws: client.ws });
          client.ws.send(JSON.stringify({ type: 'cmd', id, action, params, tabId }));
        });
        // Cap oversized string fields in the result so a misbehaving
        // extension cannot blow the agent context window. 200KB per field
        // is well above any reasonable DOM excerpt but well below process
        // memory pressure; chat.js applies its own 40KB cap downstream.
        const EXT_FIELD_CAP = 200_000;
        const capped = result && typeof result === 'object' ? { ...result } : result;
        if (capped && typeof capped === 'object') {
          for (const k of Object.keys(capped)) {
            const v = capped[k];
            if (typeof v === 'string' && v.length > EXT_FIELD_CAP) {
              capped[k] = v.slice(0, EXT_FIELD_CAP) +
                `\n\n[truncated: ${v.length - EXT_FIELD_CAP} more chars]`;
            }
          }
        }
        res.json({ ok: true, ...capped });
      } catch (e) {
        // Return 200 with ok:false so the client can react without the
        // browser logging a noisy "Failed to load resource" 500. The
        // /api/ext/snapshot endpoint already uses this pattern.
        res.json({ ok: false, error: e.message });
      }
    });

    app.post('/api/ext/snapshot', async (req, res) => {
      const { full = false, tabId, browser, clientId } = req.body || {};
      const action = full ? 'snapshot-full' : 'snapshot';
      if (isRelayExtClientId(clientId)) {
        try {
          const { status, data } = await forwardExtCommandToRelay({ action, params: { full }, tabId, clientId, timeout: req.body?.timeout || 30000 });
          return res.status(status).json(data);
        } catch (e) {
          return res.status(503).json({ ok: false, error: e.message });
        }
      }

      const clients = openDirectExtClients();
      const { connected: relayConnected } = getFaunaMcpState?.() || {};
      if (!clients.length) {
        if (relayConnected) {
          try {
            const { status, data } = await forwardExtCommandToRelay({ action, params: { full }, tabId, timeout: req.body?.timeout || 30000 });
            return res.status(status).json(data);
          } catch (e) {
            return res.status(503).json({ ok: false, error: e.message });
          }
        }
        return res.status(503).json({ ok: false, error: 'Browser extension not connected' });
      }
      const client = clientId
        ? clients.find(c => c.id === clientId) || clients[0]
        : tabId
          ? clients.find(c => c.activeTab && c.activeTab.id === tabId) || clients[0]
          : browser
            ? clients.find(c => c.browser === browser) || clients[0]
            : clients[0];
      const id = 'cmd-' + Date.now() + '-' + Math.random().toString(36).slice(2);

      try {
        const result = await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            extPendingCommands.delete(id);
            reject(new Error('Screenshot timed out'));
          }, 30000);
          extPendingCommands.set(id, { resolve, reject, timeoutId, clientId: client.id, ws: client.ws });
          client.ws.send(JSON.stringify({ type: 'cmd', id, action, params: { full }, tabId }));
        });
        res.json({ ok: true, ...result });
      } catch (e) {
        // Return 200 + ok:false so the renderer doesn't log a red 500 for
        // recoverable conditions (extension timed out, content script
        // threw, tab navigated away mid-snapshot). Matches the pattern
        // documented above for the sibling endpoint and prevents the
        // "POST /api/ext/snapshot 500" devtools noise during normal use.
        res.json({ ok: false, error: e.message });
      }
    });
  }

  return {
    register,
    attach,
    statusList,
    broadcastStatus,
    sendSse,
    setRelayBrowsers(arr) { faunaMcpRelayBrowsers = Array.isArray(arr) ? arr : []; },
  };
}

// Custom MCP server bridge.
//
// Owns:
//   - persisted list of user-configured MCP servers (HTTP or stdio)
//   - HttpMcpClient instances + spawned stdio child processes
//   - the FaunaMCP relay auto-detect poll (probes localhost:3341 every 10s)
//   - bundled fallback browser-server child (spawned when FaunaMCP relay missing)
//
// External surface:
//   register(app)    — mounts /api/custom-mcp-servers* and /api/faunamcp/status
//   startAutoDetect() / cleanup()
//   getRelayState()  — { connected, connectedAt } (read by ext bridge)
//   getTools()       — flat list of OpenAI-shaped tool defs from running HTTP servers
//   callTool(name, args)
//
// Dependencies injected so we don't reach back into server.js:
//   - faunaConfigDir
//   - extBridge (broadcastStatus, setRelayBrowsers)
//   - getFigmaConnected — for /api/faunamcp/status's figmaRelayAvailable
//   - bundledBrowserServerPath, findNodeBinary — for the fallback browser server
import fs from 'fs';
import path from 'path';
import { exec as _exec, spawn } from 'child_process';
import { findNodeBinary } from '../lib/find-node-binary.js';
import {
  listCredentials,
  createCredential,
  updateCredential,
  resolveCredential,
} from '../../credentials-store.js';

class HttpMcpClient {
  constructor(url, extraHeaders = {}) {
    this.url = url;
    this.extraHeaders = extraHeaders || {};
    this.sessionId = null;
    this.toolsCache = null;
  }

  _headers(sessionId) {
    const base = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) base['mcp-session-id'] = sessionId;
    return { ...base, ...this.extraHeaders };
  }

  async _parseSSE(response) {
    const text = await response.text();
    const lines = text.split('\n');
    const events = [];
    let currentEvent = { event: null, data: '' };

    for (const line of lines) {
      if (line.startsWith('event:')) {
        if (currentEvent.data) events.push(currentEvent);
        currentEvent = { event: line.slice(6).trim(), data: '' };
      } else if (line.startsWith('data:')) {
        currentEvent.data += line.slice(5).trim();
      } else if (line === '' && currentEvent.data) {
        events.push(currentEvent);
        currentEvent = { event: null, data: '' };
      }
    }
    if (currentEvent.data) events.push(currentEvent);

    const msgEvent = events.find(e => e.event === 'message' || e.event === 'endpoint');
    if (!msgEvent) throw new Error('No message event in SSE response');

    return JSON.parse(msgEvent.data);
  }

  async init() {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'fauna-custom-mcp', version: '1.0' }
      }
    });
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: this._headers(),
      body
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`Failed to initialize: ${resp.status} ${text}`);
    }
    const sid = resp.headers.get('mcp-session-id');
    if (!sid) throw new Error('No session ID returned from MCP server');
    this.sessionId = sid;

    const init = await this._parseSSE(resp);
    if (init.error) throw new Error(init.error.message || 'Initialize failed');

    const toolsResp = await this._post({
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: Date.now()
    });
    if (toolsResp.error) throw new Error(toolsResp.error.message);
    this.toolsCache = (toolsResp.result?.tools || []).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} }
      }
    }));
  }

  async _post(body) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: this._headers(this.sessionId),
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`MCP request failed: ${resp.status} ${text}`);
    }
    return this._parseSSE(resp);
  }

  async getTools() {
    if (!this.toolsCache) await this.init();
    return this.toolsCache;
  }

  async callTool(name, args = {}) {
    if (!this.sessionId) await this.init();
    const r = await this._post({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id: Date.now()
    });
    if (r.error) throw new Error(r.error.message);
    const content = r.result?.content || [];
    return content.map(c => c.text || JSON.stringify(c)).join('\n');
  }

  reset() {
    this.sessionId = null;
    this.toolsCache = null;
  }
}

export function createCustomMcpBridge({
  faunaConfigDir,
  extBridge,
  getFigmaConnected = () => false,
  bundledBrowserServerPath = null,
}) {
  const CUSTOM_MCP_FILE = path.join(faunaConfigDir, 'custom-mcp-servers.json');
  const customMcpClients = new Map();   // serverId → HttpMcpClient
  const customMcpProcesses = new Map(); // serverId → { process, logs }

  let autoDetectPollTimer = null;
  let faunaMcpBrowserConnected = false;
  let faunaMcpConnectedAt = null;
  let bundledBrowserServerProc = null;

  function _normalizeServerRecord(server) {
    const s = { ...(server || {}) };
    if (typeof s.running !== 'boolean') s.running = false;
    if (typeof s.enabled !== 'boolean') s.enabled = true;

    if (!s.lifecycle || typeof s.lifecycle !== 'object') s.lifecycle = {};
    if (!s.lifecycle.configuredAt) s.lifecycle.configuredAt = new Date().toISOString();

    if (!s.auth || typeof s.auth !== 'object') s.auth = {};
    if (!s.auth.credentialId && s.oauthCredentialId) s.auth.credentialId = s.oauthCredentialId;
    if (typeof s.auth.authorized !== 'boolean') s.auth.authorized = false;

    return s;
  }

  function _oauthCredentialName(serverId) {
    return `mcp-oauth-${serverId}`;
  }

  function _findCredentialIdByName(name) {
    try {
      const found = listCredentials().find(c => c.name === name);
      return found ? found.id : null;
    } catch (_) {
      return null;
    }
  }

  function _getServerToken(server) {
    const credId = server?.auth?.credentialId || server?.oauthCredentialId;
    if (!credId) return '';
    try {
      const resolved = resolveCredential(credId);
      return String(
        resolved?.data?.accessToken ||
        resolved?.data?.token ||
        ''
      ).trim();
    } catch (_) {
      return '';
    }
  }

  function _oauthStatus(server) {
    const hasTemplateToken = typeof server?.authHeader === 'string' && /\{\{\s*token\s*\}\}/i.test(server.authHeader);
    const requiresAuth = !!(server?.oauthAuthUrl || hasTemplateToken || server?.auth?.credentialId || server?.oauthCredentialId);
    const token = _getServerToken(server);
    return {
      requiresAuth,
      authorized: requiresAuth ? !!token : true,
      hasCredential: !!token,
    };
  }

  function _resolveHttpServerDefinition(server) {
    if (!server.enabled) throw new Error('Server is disabled');

    const token = _getServerToken(server);
    const status = _oauthStatus(server);
    const headers = {};

    if (server.authHeader) {
      let value = String(server.authHeader).trim();
      if (/\{\{\s*token\s*\}\}/i.test(value)) {
        if (!token) throw new Error('Authentication required: sign in first to provide token');
        value = value.replace(/\{\{\s*token\s*\}\}/ig, token);
      }
      if (/^authorization\s*:/i.test(value)) {
        value = value.replace(/^authorization\s*:\s*/i, '');
      }
      if (value) headers.Authorization = value;
    } else if (token) {
      headers.Authorization = 'Bearer ' + token;
    }

    if (status.requiresAuth && !status.authorized) {
      throw new Error('Authentication required: no OAuth token configured');
    }

    return { url: server.url, headers, authStatus: status };
  }

  function readCustomMcpServers() {
    if (!fs.existsSync(CUSTOM_MCP_FILE)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(CUSTOM_MCP_FILE, 'utf8'));
      const list = Array.isArray(raw) ? raw : [];
      const normalized = list.map(_normalizeServerRecord);
      if (JSON.stringify(list) !== JSON.stringify(normalized)) writeCustomMcpServers(normalized);
      return normalized;
    } catch (_) {
      return [];
    }
  }

  function writeCustomMcpServers(servers) {
    fs.mkdirSync(path.dirname(CUSTOM_MCP_FILE), { recursive: true });
    fs.writeFileSync(CUSTOM_MCP_FILE, JSON.stringify(servers, null, 2));
  }

  async function probeBrowserMcp() {
    try {
      const resp = await fetch('http://localhost:3341/health', { method: 'GET', signal: AbortSignal.timeout(2000) });
      return resp.ok;
    } catch (_) {
      return false;
    }
  }

  async function autoDetectBrowserMcp() {
    const servers = readCustomMcpServers();

    // Legacy cleanup: this server used to be auto-created on startup.
    const legacyIdx = servers.findIndex(s => s.id === 'fauna-browser-mcp-auto' || s.autoDetected === true);
    if (legacyIdx !== -1) {
      const legacy = servers[legacyIdx];
      if (customMcpClients.has(legacy.id)) {
        customMcpClients.get(legacy.id).reset();
        customMcpClients.delete(legacy.id);
      }
      if (customMcpProcesses.has(legacy.id)) {
        try { customMcpProcesses.get(legacy.id).process.kill('SIGTERM'); } catch (_) {}
        customMcpProcesses.delete(legacy.id);
      }
      servers.splice(legacyIdx, 1);
      writeCustomMcpServers(servers);
    }

    const available = await probeBrowserMcp();

    const wasConnected = faunaMcpBrowserConnected;
    faunaMcpBrowserConnected = available;
    if (available && !faunaMcpConnectedAt) faunaMcpConnectedAt = new Date().toISOString();
    if (!available) faunaMcpConnectedAt = null;

    if (available !== wasConnected) {
      extBridge.broadcastStatus();
    }

    if (!available) {
      extBridge.setRelayBrowsers([]);
      if (!bundledBrowserServerProc && bundledBrowserServerPath && fs.existsSync(bundledBrowserServerPath)) {
        // Race guard: re-probe :3341 immediately before spawning. The 10s
        // poll interval can miss a FaunaMCP launch that happened seconds
        // ago; without this second check Fauna's bundled child would call
        // killPortOwner(3340, 3341) and SIGKILL FaunaMCP's relay.
        const stillUnavailable = !(await probeBrowserMcp());
        if (!stillUnavailable) {
          faunaMcpBrowserConnected = true;
          if (!faunaMcpConnectedAt) faunaMcpConnectedAt = new Date().toISOString();
          extBridge.broadcastStatus();
          return;
        }
        try {
          const nodeBin = findNodeBinary() || process.execPath;
          if (nodeBin) {
            bundledBrowserServerProc = spawn(nodeBin, [bundledBrowserServerPath], {
              cwd: path.dirname(bundledBrowserServerPath),
              stdio: 'ignore',
              detached: false,
              env: { ...process.env }
            });
            bundledBrowserServerProc.on('exit', () => { bundledBrowserServerProc = null; });
            console.log('[custom-mcp] Started bundled browser server as fallback');
          }
        } catch (e) {
          console.error('[custom-mcp] Failed to start bundled browser server:', e.message);
        }
      }
      return;
    }

    try {
      const statusResp = await fetch('http://localhost:3341/ext-status', { signal: AbortSignal.timeout(2000) });
      if (statusResp.ok) {
        const statusData = await statusResp.json();
        extBridge.setRelayBrowsers((statusData.browsers || []).map(b => ({
          id: b.id,
          browser: b.browser,
          version: b.version || null,
          connectedAt: b.connectedAt || faunaMcpConnectedAt,
          activeTab: b.activeTab || null,
        })));
      }
    } catch (_) {}
  }

  function startAutoDetect() {
    autoDetectBrowserMcp().catch(() => {});
    autoDetectPollTimer = setInterval(() => {
      autoDetectBrowserMcp().catch(() => {});
    }, 10000);
  }

  function stopAutoDetect() {
    if (autoDetectPollTimer) {
      clearInterval(autoDetectPollTimer);
      autoDetectPollTimer = null;
    }
    if (bundledBrowserServerProc) {
      try { bundledBrowserServerProc.kill(); } catch (_) {}
      bundledBrowserServerProc = null;
    }
  }

  function cleanup() {
    stopAutoDetect();
    for (const [, proc] of customMcpProcesses) {
      try { proc.process.kill('SIGTERM'); } catch (_) {}
    }
    customMcpProcesses.clear();
    customMcpClients.clear();
  }

  async function getTools() {
    const servers = readCustomMcpServers();
    const tools = [];
    for (const server of servers.filter(s => s.running && s.transport === 'http')) {
      const client = customMcpClients.get(server.id);
      if (client) {
        try {
          const serverTools = await client.getTools();
          tools.push(...serverTools);
        } catch (e) {
          console.error(`[custom-mcp] Failed to get tools from ${server.name}:`, e.message);
        }
      }
    }
    return tools;
  }

  async function callTool(toolName, args) {
    const servers = readCustomMcpServers().filter(s => s.running && s.transport === 'http');
    for (const server of servers) {
      const client = customMcpClients.get(server.id);
      if (!client) continue;
      try {
        const tools = await client.getTools();
        if (tools.some(t => t.function.name === toolName)) {
          return await client.callTool(toolName, args);
        }
      } catch (e) {
        console.error(`[custom-mcp] Error calling ${toolName} on ${server.name}:`, e.message);
      }
    }
    throw new Error(`Tool ${toolName} not found in any running custom MCP server`);
  }

  function register(app) {
    app.get('/api/custom-mcp-servers', (req, res) => {
      const servers = readCustomMcpServers().map(s => ({
        ...s,
        auth: {
          ...(s.auth || {}),
          ..._oauthStatus(s),
        },
      }));
      res.json(servers);
    });

    app.post('/api/custom-mcp-servers', (req, res) => {
      const { name, transport, command, args, env, envPassthrough, url } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!transport) return res.status(400).json({ error: 'transport required' });
      if (transport === 'stdio' && !command) return res.status(400).json({ error: 'command required for stdio transport' });
      if (transport === 'http' && !url) return res.status(400).json({ error: 'url required for http transport' });

      const servers = readCustomMcpServers();
      const newServer = {
        id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        transport,
        command: command || null,
        args: args || [],
        env: env || {},
        envPassthrough: envPassthrough || [],
        url: url || null,
        running: false,
        enabled: true,
        lifecycle: {
          configuredAt: new Date().toISOString(),
        },
        auth: {
          authorized: false,
        },
      };
      servers.push(newServer);
      writeCustomMcpServers(servers);
      res.status(201).json(newServer);
    });

    app.put('/api/custom-mcp-servers/:id', (req, res) => {
      const servers = readCustomMcpServers();
      const idx = servers.findIndex(s => s.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Server not found' });

      const allowedKeys = [
        'name', 'transport', 'command', 'args', 'env', 'envPassthrough',
        'url', 'cwd', 'authHeader', 'oauthAuthUrl', 'enabled'
      ];
      const patch = {};
      for (const k of allowedKeys) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) patch[k] = req.body[k];
      }
      const updated = _normalizeServerRecord({ ...servers[idx], ...patch, id: servers[idx].id });
      servers[idx] = updated;
      writeCustomMcpServers(servers);
      res.json(updated);
    });

    app.delete('/api/custom-mcp-servers/:id', (req, res) => {
      const servers = readCustomMcpServers();
      const server = servers.find(s => s.id === req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found' });

      if (customMcpClients.has(server.id)) {
        customMcpClients.get(server.id).reset();
        customMcpClients.delete(server.id);
      }
      if (customMcpProcesses.has(server.id)) {
        try { customMcpProcesses.get(server.id).process.kill('SIGTERM'); } catch (_) {}
        customMcpProcesses.delete(server.id);
      }

      const next = servers.filter(s => s.id !== req.params.id);
      writeCustomMcpServers(next);
      res.json({ ok: true });
    });

    app.post('/api/custom-mcp-servers/:id/start', async (req, res) => {
      const servers = readCustomMcpServers();
      const server = servers.find(s => s.id === req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found' });
      if (!server.enabled) return res.status(409).json({ error: 'Server is disabled' });

      if (server.transport === 'http') {
        try {
          const resolved = _resolveHttpServerDefinition(server);
          const client = new HttpMcpClient(resolved.url, resolved.headers);
          await client.getTools();
          customMcpClients.set(server.id, client);
          server.running = true;
          server.auth = { ...(server.auth || {}), ...resolved.authStatus, lastResolvedAt: new Date().toISOString() };
          server.lifecycle = { ...(server.lifecycle || {}), lastResolvedAt: new Date().toISOString(), lastStartedAt: new Date().toISOString() };
          writeCustomMcpServers(servers);
          res.json({ ok: true, transport: 'http' });
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      } else if (server.transport === 'stdio') {
        try {
          if (!server.enabled) return res.status(409).json({ error: 'Server is disabled' });
          const env = { ...process.env, ...server.env };
          for (const key of server.envPassthrough || []) {
            if (process.env[key]) env[key] = process.env[key];
          }

          const proc = _exec(
            `${server.command} ${(server.args || []).join(' ')}`,
            { env, maxBuffer: 10 * 1024 * 1024 }
          );

          const logs = [];
          proc.stdout?.on('data', d => {
            const msg = d.toString();
            logs.push({ t: Date.now(), s: 'stdout', m: msg });
            if (logs.length > 200) logs.shift();
          });
          proc.stderr?.on('data', d => {
            const msg = d.toString();
            logs.push({ t: Date.now(), s: 'stderr', m: msg });
            if (logs.length > 200) logs.shift();
          });
          proc.on('exit', code => {
            logs.push({ t: Date.now(), s: 'info', m: `Process exited with code ${code}` });
            customMcpProcesses.delete(server.id);
            const srvs = readCustomMcpServers();
            const srv = srvs.find(s => s.id === server.id);
            if (srv) {
              srv.running = false;
              writeCustomMcpServers(srvs);
            }
          });

          customMcpProcesses.set(server.id, { process: proc, logs });
          server.running = true;
          server.lifecycle = { ...(server.lifecycle || {}), lastResolvedAt: new Date().toISOString(), lastStartedAt: new Date().toISOString() };
          writeCustomMcpServers(servers);
          res.json({ ok: true, pid: proc.pid, transport: 'stdio' });
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      } else {
        res.status(400).json({ error: 'Unknown transport' });
      }
    });

    app.post('/api/custom-mcp-servers/:id/stop', (req, res) => {
      const servers = readCustomMcpServers();
      const server = servers.find(s => s.id === req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found' });

      if (customMcpClients.has(server.id)) {
        customMcpClients.get(server.id).reset();
        customMcpClients.delete(server.id);
      }
      if (customMcpProcesses.has(server.id)) {
        try { customMcpProcesses.get(server.id).process.kill('SIGTERM'); } catch (_) {}
        customMcpProcesses.delete(server.id);
      }

      server.running = false;
      writeCustomMcpServers(servers);
      res.json({ ok: true });
    });

    app.get('/api/custom-mcp-servers/:id/logs', (req, res) => {
      const proc = customMcpProcesses.get(req.params.id);
      res.json({ logs: proc?.logs || [] });
    });

    app.get('/api/custom-mcp-servers/:id/oauth/status', (req, res) => {
      const server = readCustomMcpServers().find(s => s.id === req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found' });
      const status = _oauthStatus(server);
      res.json({
        authorized: status.authorized,
        requiresAuth: status.requiresAuth,
        hasCredential: status.hasCredential,
      });
    });

    app.post('/api/custom-mcp-servers/:id/oauth/token', (req, res) => {
      const accessToken = String(req.body?.accessToken || '').trim();
      if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

      const servers = readCustomMcpServers();
      const server = servers.find(s => s.id === req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found' });
      if (server.transport !== 'http') return res.status(400).json({ error: 'OAuth token is only supported for HTTP servers' });

      try {
        const name = _oauthCredentialName(server.id);
        const existingId = server?.auth?.credentialId || server?.oauthCredentialId || _findCredentialIdByName(name);
        let credId = existingId;

        if (existingId) {
          updateCredential(existingId, { type: 'oauth2', data: { accessToken } });
        } else {
          const created = createCredential({ name, type: 'oauth2', data: { accessToken } });
          credId = created.id;
        }

        server.auth = {
          ...(server.auth || {}),
          credentialId: credId,
          authorized: true,
          lastResolvedAt: new Date().toISOString(),
        };
        server.oauthCredentialId = credId;
        writeCustomMcpServers(servers);

        if (customMcpClients.has(server.id)) {
          customMcpClients.get(server.id).reset();
          customMcpClients.delete(server.id);
          server.running = false;
          writeCustomMcpServers(servers);
        }

        res.json({ ok: true, authorized: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/custom-mcp-servers/:id/refresh', async (req, res) => {
      const server = readCustomMcpServers().find(s => s.id === req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found' });
      if (server.transport !== 'http') return res.status(400).json({ error: 'Only HTTP servers can be refreshed' });

      const client = customMcpClients.get(server.id);
      if (!client) return res.status(400).json({ error: 'Server not running' });

      try {
        client.reset();
        const tools = await client.getTools();
        res.json({ ok: true, toolCount: tools.length });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // FaunaMCP relay status — owned here because it inspects the
    // fauna-browser-mcp-auto HTTP client + Figma relay state.
    app.get('/api/faunamcp/status', async (_req, res) => {
      let connected = false;
      let toolCount = null;
      const url = 'http://localhost:3341';
      let figmaRelayAvailable = false;
      let appInstalled = false;

      try {
        const healthResp = await fetch('http://localhost:3341/health', {
          method: 'GET',
          signal: AbortSignal.timeout(2000)
        });
        if (healthResp.ok) {
          connected = true;
          try {
            const data = await healthResp.json();
            if (data.toolCount != null) toolCount = data.toolCount;
          } catch (_) {}
        }
      } catch (_) {}

      figmaRelayAvailable = !!getFigmaConnected();

      try {
        const mcpDir = new URL('../../faunaMCP-main', import.meta.url).pathname;
        appInstalled = fs.existsSync(mcpDir);
      } catch (_) {}

      if (connected && toolCount == null) {
        const servers = readCustomMcpServers();
        const autoEntry = servers.find(s => s.id === 'fauna-browser-mcp-auto');
        const client = autoEntry ? customMcpClients.get(autoEntry.id) : null;
        if (client) {
          try {
            const tools = await client.getTools();
            toolCount = tools.length;
          } catch (_) {}
        }
      }

      res.json({
        connected,
        url: connected ? url : undefined,
        toolCount,
        figmaRelayAvailable,
        install: { appInstalled }
      });
    });
  }

  return {
    register,
    startAutoDetect,
    stopAutoDetect,
    cleanup,
    getRelayState: () => ({ connected: faunaMcpBrowserConnected, connectedAt: faunaMcpConnectedAt }),
    getTools,
    callTool,
  };
}

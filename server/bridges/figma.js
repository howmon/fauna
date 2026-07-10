// server/bridges/figma.js
//
// Figma bridge — owns the WS relay (port 3335) connection to the Figma plugin,
// the local CopilotMCP server child process (spawned from relay/server/index.js
// or the bundled equivalent in packaged builds), the Figma Dev Mode MCP HTTP
// client (port 3845), plugin install helpers, and the figma-rules persistence
// layer.
//
// Factory: createFigmaBridge(deps) → bridge
//
// Deps (all required unless noted):
//   - configDir: absolute path used for figma-rules.json and figma-plugin install dir
//   - bundledMcpServerPath: candidate path inside the packaged Electron app for the relay server
//   - devMcpServerPath: candidate path used during `node server.js` dev runs
//   - defaultMcpPath: legacy ~/FigmaExtensions/CopilotMCP/server/index.js fallback
//   - bundledPluginPath: extraResources path in packaged builds
//   - devPluginPath: assets/figma-plugin path used during dev
//   - readSavedConfig: () → cfg  (used to pick up user-configured mcpServerPath override)
//   - findNodeBinary: () → string|null  (passed in because it scans PATH using server.js helpers)
//   - isWin: process.platform === 'win32'
//
// Bridge exposes:
//   - register(app): mounts all /api/figma/* and /api/figma-mcp/* routes
//   - start(): auto-start MCP child + connect WS (called once from the server boot)
//   - cleanup(): kill MCP child + close WS + clear pending requests
//   - getState(): { connected, fileInfo, activeSystem }
//   - isConnected(): shortcut for getState().connected
//   - listFiles(): array of currently connected Figma files
//   - getMcpTools(): proxy → FigmaMCPClient.getTools()
//   - callMcpTool(name, args): proxy → FigmaMCPClient.callTool()
//   - resetMcp(): clears the Dev-Mode MCP session/tools cache
//   - log(msg, level): figmaLog — broadcasts progress to the plugin
//   - executeToolDef: the always-on figma_execute tool definition (for chat
//     tool-list assembly when Dev-Mode MCP is unreachable)

import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { WebSocket as WS } from 'ws';
import { findNodeBinary } from '../lib/find-node-binary.js';

export function createFigmaBridge({
  configDir,
  bundledMcpServerPath,
  devMcpServerPath,
  defaultMcpPath,
  bundledPluginPath,
  devPluginPath,
  readSavedConfig,
  isWin = process.platform === 'win32',
}) {
  // ── Constants ───────────────────────────────────────────────────────────
  const FIGMA_WS_URL     = 'ws://localhost:3335';
  const FIGMA_RULES_FILE = path.join(configDir, 'figma-rules.json');
  const FIGMA_MCP_URL    = 'http://127.0.0.1:3845/mcp';
  const PLUGIN_INSTALL_DIR = path.join(configDir, 'figma-plugin');

  function _sanitizeUserMcpPath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    const p = path.resolve(rawPath);
    // User-configured overrides must stay inside HOME for safety.
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (!p.endsWith('.js') || !p.startsWith(home)) return null;
    return p;
  }

  function _mcpPathCandidates() {
    const cfg = readSavedConfig();
    const userPath = _sanitizeUserMcpPath(cfg.mcpServerPath);
    const candidates = [];
    if (userPath) candidates.push(userPath);
    if (bundledMcpServerPath) candidates.push(bundledMcpServerPath);
    if (devMcpServerPath) candidates.push(devMcpServerPath);
    if (defaultMcpPath) candidates.push(defaultMcpPath);
    return [...new Set(candidates.filter(Boolean))];
  }

  // ── MCP server process management ─────────────────────────────────────
  let mcpProcess   = null;
  let mcpLogs      = [];       // last 200 stderr lines
  let mcpAutoStart = true;     // start with the app by default

  function getMcpServerPath() {
    const candidates = _mcpPathCandidates();
    const existing = candidates.find(p => fs.existsSync(p));
    return existing || candidates[0] || defaultMcpPath;
  }

  function isMcpRunning() {
    return mcpProcess !== null && mcpProcess.exitCode === null;
  }

  function startMcpServer() {
    if (isMcpRunning()) return { ok: true, already: true };

    const serverPath = getMcpServerPath();
    if (!fs.existsSync(serverPath)) {
      return {
        ok: false,
        error: `MCP server not found at: ${serverPath}`,
        candidates: _mcpPathCandidates(),
      };
    }

    const nodeBin = findNodeBinary();
    if (!nodeBin) return { ok: false, error: isWin
      ? 'Node.js binary not found. Install Node.js from nodejs.org or via winget/scoop.'
      : 'Node.js binary not found. Install Node.js via Homebrew.' };

    mcpLogs = [];
    const serverDir = path.dirname(serverPath);

    const mcpEnvPATH = isWin
      ? (process.env.PATH || '')
      : `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`;

    mcpProcess = spawn(nodeBin, [serverPath], {
      cwd: serverDir,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PATH: mcpEnvPATH }
    });

    mcpProcess.stderr.on('data', chunk => {
      const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        mcpLogs.push({ t: Date.now(), msg: line });
        if (mcpLogs.length > 200) mcpLogs.shift();
      }
    });

    mcpProcess.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      mcpLogs.push({ t: Date.now(), msg: `[App] MCP server exited (${reason})` });
      mcpProcess = null;
      // Force figma state to disconnected — WS will reconnect when relay returns
      figmaState.connected = false;
      figmaState.fileInfo  = null;
    });

    mcpProcess.on('error', err => {
      mcpLogs.push({ t: Date.now(), msg: `[App] Failed to start: ${err.message}` });
      mcpProcess = null;
    });

    // Once spawned, attempt to (re)connect the WS controller
    setTimeout(() => {
      if (figmaState.pendingReconnect) clearTimeout(figmaState.pendingReconnect);
      figmaConnect();
    }, 500);

    return { ok: true, pid: mcpProcess.pid, serverPath };
  }

  function stopMcpServer() {
    if (!isMcpRunning()) return { ok: true, already: true };
    mcpProcess.kill('SIGTERM');
    // Force-kill after 3s if it hasn't exited
    setTimeout(() => { if (isMcpRunning()) mcpProcess.kill('SIGKILL'); }, 3000);
    return { ok: true };
  }

  // ── WS bridge fields ────────────────────────────────────────────────────
  let figmaWs      = null;
  const figmaState = { connected: false, fileInfo: null, activeSystem: null, pendingReconnect: null };
  const figmaFiles   = new Map(); // fileKey → { fileName, fileKey, currentPage, currentPageId, timestamp }
  const figmaPending = new Map(); // id → { resolve, reject, timer }

  function readFigmaRules() {
    try { return JSON.parse(fs.readFileSync(FIGMA_RULES_FILE, 'utf8')); }
    catch (_) { return []; }
  }
  function writeFigmaRules(rules) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(FIGMA_RULES_FILE, JSON.stringify(rules, null, 2));
  }

  function figmaConnect() {
    if (figmaWs && figmaWs.readyState < 2) return; // already open or connecting
    try {
      figmaWs = new WS(FIGMA_WS_URL);

      figmaWs.on('open', () => {
        figmaState.connected = true;
        figmaState.pendingReconnect = null;
        figmaWs.send(JSON.stringify({ type: 'client-hello', clientName: 'Copilot Chat App' }));
        console.log('[Figma] Controller connected to relay');
      });

      figmaWs.on('message', raw => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

        if (msg.type === 'FILE_INFO') {
          figmaState.fileInfo = { fileName: msg.fileName, fileKey: msg.fileKey, currentPage: msg.currentPage, currentPageId: msg.currentPageId };
          if (msg.fileKey) {
            figmaFiles.set(msg.fileKey, { fileName: msg.fileName, fileKey: msg.fileKey, currentPage: msg.currentPage, currentPageId: msg.currentPageId, timestamp: Date.now() });
          }
        }
        if (msg.type === 'plugin-disconnected' && msg.fileKey) {
          figmaFiles.delete(msg.fileKey);
        }
        if (msg.type === 'active-system') {
          figmaState.activeSystem = { id: msg.id, name: msg.name };
        }
        if (msg.id && figmaPending.has(msg.id)) {
          const { resolve, timer } = figmaPending.get(msg.id);
          clearTimeout(timer); figmaPending.delete(msg.id); resolve(msg);
        }
      });

      figmaWs.on('close', () => {
        figmaState.connected = false;
        figmaState.fileInfo  = null;
        figmaFiles.clear();
        for (const [id, { reject, timer }] of figmaPending) {
          clearTimeout(timer);
          figmaPending.delete(id);
          reject(new Error('Figma relay disconnected — please reconnect the plugin'));
        }
        console.log('[Figma] Relay disconnected — retrying in 5 s');
        figmaState.pendingReconnect = setTimeout(figmaConnect, 5000);
      });

      figmaWs.on('error', () => {
        // Suppress — handled in close
      });

      // Heartbeat: ping every 20 s so dead TCP connections are detected quickly
      const pingInterval = setInterval(() => {
        if (!figmaWs || figmaWs.readyState !== 1) { clearInterval(pingInterval); return; }
        try { figmaWs.ping(); } catch (_) {}
      }, 20000);
      figmaWs.once('close', () => clearInterval(pingInterval));
    } catch (e) {
      console.log('[Figma] WS module not available:', e.message);
    }
  }

  function figmaLog(message, level = 'info') {
    if (figmaWs && figmaWs.readyState === 1) {
      try { figmaWs.send(JSON.stringify({ type: 'progress-log', message, level })); } catch (_) {}
    }
  }

  function figmaSend(command, timeoutMs = 30000, targetFileKey = null) {
    return new Promise((resolve, reject) => {
      if (!figmaWs || figmaWs.readyState !== 1) {
        return reject(new Error(
          figmaState.pendingReconnect
            ? 'Figma relay is reconnecting — please try again in a moment'
            : 'Not connected to Figma relay — ensure the CopilotMCP plugin is open in Figma'
        ));
      }
      const id    = `ctrl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => { figmaPending.delete(id); reject(new Error('Figma execution timed out — the operation may have been too large or the plugin became unresponsive')); }, timeoutMs);
      figmaPending.set(id, { resolve, reject, timer });
      const payload = { ...command, id };
      if (targetFileKey) payload.fileKey = targetFileKey;
      figmaWs.send(JSON.stringify(payload));
    });
  }

  // ── Figma Dev Mode MCP Client ───────────────────────────────────────────
  class FigmaMCPClient {
    constructor() { this.sessionId = null; this.toolsCache = null; }

    async _post(body, timeoutMs = 30000) {
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      const res = await fetch(FIGMA_MCP_URL, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!this.sessionId) this.sessionId = res.headers.get('mcp-session-id');
      const text = await res.text();
      let jsonStr = null;
      for (const block of text.split(/\n\n+/).filter(Boolean)) {
        const lines = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
        if (lines.length > 0) jsonStr = lines.join('\n');
      }
      if (!jsonStr) jsonStr = text;
      return JSON.parse(jsonStr);
    }

    async init() {
      const r = await this._post({ jsonrpc: '2.0', method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {},
          clientInfo: { name: 'CopilotChat', version: '1.0.0' } }, id: 1 });
      return r.result;
    }

    static get FIGMA_EXECUTE_TOOL() {
      return {
        type: 'function',
        function: {
          name: 'figma_execute',
          description: 'Execute Figma Plugin API JavaScript code to CREATE, MODIFY, or DELETE nodes in the open Figma file. Use this instead of the REST API — no PAT required. The code runs inside the Figma plugin context and has full access to the figma object (figma.currentPage, figma.createFrame, figma.createText, etc). IMPORTANT: figma.getNodeById() returns null when the ID does not exist in the current file — ALWAYS null-check before accessing properties (e.g. `var node = figma.getNodeById(id); if (!node) return "Node not found"; ...`). When accessing .componentProperties or .componentPropertyDefinitions on any node, always wrap in try/catch (e.g. `let props; try { props = node.componentProperties || {}; } catch(_) { props = {}; }`) to avoid "Component set for node has existing errors" on broken components. DELETING PAGES: never call page.remove() directly — Figma throws "Removing this node is not allowed" when you try to remove figma.currentPage or the last remaining page. Use the pre-injected helper deletePagesWhere(predicate) for bulk deletes (e.g. `return await deletePagesWhere(p => p.name.endsWith("DoNotUse"))`) or safeRemovePage(page) for a single page; both switch the active page off any doomed page first and refuse to delete the only page. When multiple Figma files are open, use the fileKey parameter to target a specific file.',
          parameters: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Valid Figma Plugin API JavaScript to execute. Must be synchronous or use async/await. Return a value with `return` to get output.' },
              fileKey: { type: 'string', description: 'Optional Figma file key to target. When omitted, targets the most recently active file. Use this when multiple Figma files are open to avoid cross-document mixups.' }
            },
            required: ['code']
          }
        }
      };
    }

    async getTools() {
      if (this.toolsCache) return this.toolsCache;
      try {
        if (!this.sessionId) await this.init();
        const r = await this._post({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 2 });
        this.toolsCache = (r.result?.tools || []).map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } }
        }));
        this.toolsCache = this.toolsCache.filter(t => t.function.name !== 'figma_execute');
      } catch (_) {
        this.toolsCache = [];
      }
      this.toolsCache.push(FigmaMCPClient.FIGMA_EXECUTE_TOOL);
      return this.toolsCache;
    }

    async callTool(name, args) {
      if (name === 'figma_execute') {
        let code = args.code;
        const targetFileKey = args.fileKey || null;
        let result = await figmaSend({ type: 'execute-code', code }, 30000, targetFileKey);

        if (result.error && result.error.includes('unloaded font')) {
          const fontCalls = [];
          const re = /figma\.loadFontAsync\(\s*\{[^}]+\}\s*\)/g;
          let m;
          const seen = new Set();
          while ((m = re.exec(result.error)) !== null) {
            const call = 'await ' + m[0] + '.catch(()=>{});';
            if (!seen.has(call)) { seen.add(call); fontCalls.push(call); }
          }
          if (fontCalls.length) {
            const wrappedCode = '// auto-load missing fonts\n' + fontCalls.join('\n') + '\n\n' + code;
            result = await figmaSend({ type: 'execute-code', code: wrappedCode }, 30000, targetFileKey);
          }
        }

        if (result.error) throw new Error(result.error);
        return typeof result.result !== 'undefined' ? JSON.stringify(result.result) : 'Done';
      }
      if (!this.sessionId) await this.init();
      const timeoutMs = /screenshot/i.test(name) ? 15000 : 30000;
      const r = await this._post({ jsonrpc: '2.0', method: 'tools/call',
        params: { name, arguments: args }, id: Date.now() }, timeoutMs);
      if (r.error) throw new Error(r.error.message);
      const content = r.result?.content || [];
      return content.map(c => c.text || JSON.stringify(c)).join('\n');
    }

    reset() { this.sessionId = null; this.toolsCache = null; }
  }

  const figmaMCP = new FigmaMCPClient();

  // ── Plugin install helpers ──────────────────────────────────────────────
  function getBundledPluginDir() {
    if (bundledPluginPath && fs.existsSync(bundledPluginPath)) return bundledPluginPath;
    return devPluginPath;
  }

  // ── Routes ──────────────────────────────────────────────────────────────
  function register(app) {
    // MCP relay process control
    app.get('/api/figma/mcp-status', (_req, res) => {
      res.json({
        running: isMcpRunning(),
        pid:     mcpProcess?.pid ?? null,
        path:    getMcpServerPath(),
        logs:    mcpLogs.slice(-50),
      });
    });

    app.post('/api/figma/mcp-start', (_req, res) => {
      const result = startMcpServer();
      res.status(result.ok ? 200 : 500).json(result);
    });

    app.post('/api/figma/mcp-stop', (_req, res) => {
      const result = stopMcpServer();
      res.json(result);
    });

    app.get('/api/figma/mcp-logs', (req, res) => {
      const since = parseInt(req.query.since) || 0;
      res.json(mcpLogs.filter(l => l.t > since));
    });

    // Figma Dev Mode MCP (port 3845)
    app.get('/api/figma-mcp/status', async (_req, res) => {
      try {
        const tools = await figmaMCP.getTools();
        res.json({ ok: true, connected: true, toolCount: tools.length, tools: tools.map(t => t.function.name) });
      } catch (e) {
        res.json({ ok: false, connected: false, error: e.message, tools: [] });
      }
    });

    app.post('/api/figma-mcp/call', async (req, res) => {
      const { name, arguments: args = {} } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      try {
        const result = await figmaMCP.callTool(name, args);
        res.json({ ok: true, result });
      } catch (e) {
        figmaMCP.reset();
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // Plugin install
    app.get('/api/figma/plugin-info', (_req, res) => {
      const installed = fs.existsSync(path.join(PLUGIN_INSTALL_DIR, 'manifest.json'));
      res.json({
        installed,
        installDir:   installed ? PLUGIN_INSTALL_DIR : null,
        bundledDir:   getBundledPluginDir(),
      });
    });

    app.post('/api/figma/plugin-install', (_req, res) => {
      try {
        const src = getBundledPluginDir();
        if (!fs.existsSync(src)) return res.status(404).json({ error: 'Bundled plugin not found' });

        fs.mkdirSync(PLUGIN_INSTALL_DIR, { recursive: true });
        for (const file of ['manifest.json', 'code.js', 'ui.html']) {
          fs.copyFileSync(path.join(src, file), path.join(PLUGIN_INSTALL_DIR, file));
        }
        res.json({ ok: true, installDir: PLUGIN_INSTALL_DIR });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/figma/plugin-download', (_req, res) => {
      try {
        const src = getBundledPluginDir();
        if (!fs.existsSync(src)) return res.status(404).json({ error: 'Bundled plugin not found' });

        let chosenDir;
        if (process.platform === 'darwin') {
          try {
            chosenDir = execSync(
              `osascript -e 'set f to choose folder with prompt "Choose where to save the Figma plugin"' -e 'POSIX path of f'`,
              { encoding: 'utf8', timeout: 60000 }
            ).trim();
          } catch (_) {
            return res.json({ ok: false, cancelled: true });
          }
        } else {
          try {
            chosenDir = execSync(
              `powershell -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose where to save the Figma plugin'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { throw 'cancelled' }"`,
              { encoding: 'utf8', timeout: 60000 }
            ).trim();
          } catch (_) {
            return res.json({ ok: false, cancelled: true });
          }
        }
        if (!chosenDir) return res.json({ ok: false, cancelled: true });

        const destDir = path.join(chosenDir, 'CopilotFigmaMCPPlugin');
        fs.mkdirSync(destDir, { recursive: true });
        for (const file of fs.readdirSync(src)) {
          fs.copyFileSync(path.join(src, file), path.join(destDir, file));
        }
        res.json({ ok: true, downloadDir: destDir });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Figma API endpoints
    app.get('/api/figma/status', (_req, res) => {
      const figmaConnected = figmaState.connected && !!figmaState.fileInfo;
      res.json({
        relayConnected: figmaState.connected,
        figmaConnected,
        fileInfo:      figmaState.fileInfo,
        connectedFiles: [...figmaFiles.values()],
        activeSystem:  figmaState.activeSystem,
        mcpRunning:    isMcpRunning(),
        mcpPid:        mcpProcess?.pid ?? null,
        endpoint: {
          wsUrl:   FIGMA_WS_URL,
          wsPort:  3335,
          httpPort: 3336,
        },
      });
    });

    app.post('/api/figma/connect', (_req, res) => {
      if (figmaState.pendingReconnect) clearTimeout(figmaState.pendingReconnect);
      figmaConnect();
      res.json({ ok: true });
    });

    app.post('/api/figma/execute', async (req, res) => {
      const { code, timeout, fileKey } = req.body;
      if (!code) return res.status(400).json({ error: 'code required' });
      try {
        const result = await figmaSend({ type: 'execute-code', code }, timeout || 15000, fileKey || null);
        res.json({ ok: true, result: result.result, error: result.error });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // Figma Rules
    app.get('/api/figma/rules', (_req, res) => {
      res.json(readFigmaRules());
    });

    app.post('/api/figma/rules', (req, res) => {
      const { text, enabled = true } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
      const rules = readFigmaRules();
      const rule  = { id: Date.now().toString(), text: text.trim(), enabled };
      rules.push(rule);
      writeFigmaRules(rules);
      res.json(rule);
    });

    app.put('/api/figma/rules/:id', (req, res) => {
      const rules = readFigmaRules();
      const idx   = rules.findIndex(r => r.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
      rules[idx]  = { ...rules[idx], ...req.body, id: rules[idx].id };
      writeFigmaRules(rules);
      res.json(rules[idx]);
    });

    app.delete('/api/figma/rules/:id', (req, res) => {
      const rules = readFigmaRules();
      const next  = rules.filter(r => r.id !== req.params.id);
      writeFigmaRules(next);
      res.json({ ok: true });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────
  function start() {
    if (mcpAutoStart) {
      const started = startMcpServer();
      if (!started.ok) {
        console.log('[Figma] Local MCP auto-start skipped:', started.error || 'unknown reason');
        figmaConnect();
      }
    } else {
      figmaConnect();
    }
  }

  function cleanup() {
    try { stopMcpServer(); } catch (_) {}
    try {
      if (figmaState.pendingReconnect) clearTimeout(figmaState.pendingReconnect);
      figmaState.pendingReconnect = null;
    } catch (_) {}
    try { if (figmaWs && figmaWs.readyState <= 1) figmaWs.close(); } catch (_) {}
    figmaWs = null;
    figmaState.connected = false;
    figmaState.fileInfo = null;
    figmaFiles.clear();
    for (const [id, { reject, timer }] of figmaPending) {
      clearTimeout(timer);
      figmaPending.delete(id);
      try { reject(new Error('shutting down')); } catch (_) {}
    }
  }

  return {
    register,
    start,
    cleanup,
    getState: () => ({
      connected: figmaState.connected,
      fileInfo: figmaState.fileInfo,
      activeSystem: figmaState.activeSystem,
    }),
    isConnected: () => figmaState.connected,
    listFiles: () => [...figmaFiles.values()],
    getMcpTools: () => figmaMCP.getTools(),
    callMcpTool: (name, args) => figmaMCP.callTool(name, args),
    resetMcp: () => figmaMCP.reset(),
    log: figmaLog,
    get executeToolDef() { return FigmaMCPClient.FIGMA_EXECUTE_TOOL; },
  };
}

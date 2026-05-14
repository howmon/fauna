/**
 * Copilot Chat — backend server
 * Streams GitHub Copilot responses via SSE, serves the chat UI, fetches URLs.
 */

import express    from 'express';
import OpenAI     from 'openai';
import { execSync, exec as _exec, execFile as _execFile, spawn } from 'child_process';
import crypto     from 'crypto';
import path       from 'path';
import os         from 'os';
import fs         from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { checkFilePath, checkNetworkAccess, checkShellCommand, getSandboxedEnv, getResourceLimits, audit, getAuditLog } from './agent-sandbox.js';
import { getAgentTools, startAgentMCPServers, stopAgentMCPServers, executeBuiltInTool, executeCustomTool } from './agent-tools.js';
import { scanAgent, formatScanReport } from './agent-scanner.js';
import { createTask, getTask, getAllTasks, updateTask, deleteTask, startScheduler, stopScheduler } from './task-manager.js';
import { runTask, pauseTask, stopTask, steerTask, isTaskRunning, subscribe } from './task-runner.js';
import {
  createProject, getProject, getAllProjects, updateProject, deleteProject,
  touchProject, linkConversation, linkTask,
  addSource, removeSource, syncSource, listFiles, readSourceFile, resolveSourceFilePath,
  addContext, updateContext, removeContext, contextFromArtifact,
  getProjectSystemContext, buildContextPayload,
} from './project-manager.js';
import { loadInstructionFiles, _safeReadInstructionFile, _isPathInside, _realPathOrResolve, INSTRUCTION_FILE_LIMIT, INSTRUCTION_TOTAL_LIMIT } from './lib/instruction-files.js';
import {
  remember as factsRemember, recall as factsRecall, forget as factsForget,
  listFacts, getFact, runDecay, formatForSystemPrompt as factsForSystemPrompt,
  exportFacts, importFacts, getStats as factsGetStats,
} from './memory-store.js';
import { SELF_TOOL_DEFS, executeSelfTool, isSelfTool } from './self-tools.js';
import {
  getSettings as hbGetSettings, updateSettings as hbUpdateSettings,
  getLog as hbGetLog, clearLog as hbClearLog,
  runHeartbeat, startHeartbeat, stopHeartbeat,
} from './heartbeat.js';
import {
  createWorkflow, getWorkflow, getAllWorkflows, updateWorkflow, deleteWorkflow,
  getHistory as wfGetHistory, runWorkflow, startWorkflowTimer, stopWorkflowTimer, parseSchedule,
} from './workflow-manager.js';
import {
  isCommandSafe, addAutoAllow, getAutoAllowList, removeAutoAllow, clearAutoAllow,
  checkCommandPermission, explainCommand,
} from './permission-guard.js';
import { ToolGuardContext, formatToolLabel, getToolCategory } from './tool-guard.js';
import {
  getTeamsSettings, updateTeamsSettings, startTeamsBridge, stopTeamsBridge, testConnection as teamsTestConnection,
} from './teams-bridge.js';
import QRCode     from 'qrcode';
import { marked }  from 'marked';

// Electron APIs — available when server runs inside the Electron main process.
// Gracefully degrade if run standalone (e.g. during testing).
const _require = createRequire(import.meta.url);
let systemPreferences, desktopCapturer, powerSaveBlocker, _ElectronBrowserWindow, _electronApp, _electronShell;
try {
  ({ systemPreferences, desktopCapturer, powerSaveBlocker,
     BrowserWindow: _ElectronBrowserWindow,
     app: _electronApp,
     shell: _electronShell } = _require('electron'));
} catch (_) {}

// Power-save blocker — keeps screen/CPU awake while any chat request is active.
let _psBlockerId = null;
let _psActiveCount = 0;
function _psAcquire() {
  _psActiveCount++;
  if (_psActiveCount === 1 && powerSaveBlocker && _psBlockerId === null) {
    _psBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  }
}
function _psRelease() {
  _psActiveCount = Math.max(0, _psActiveCount - 1);
  if (_psActiveCount === 0 && powerSaveBlocker && _psBlockerId !== null) {
    try { powerSaveBlocker.stop(_psBlockerId); } catch (_) {}
    _psBlockerId = null;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app    = express();
const PORT   = 3737;
const IS_WIN = process.platform === 'win32';
const PATH_SEP = IS_WIN ? ';' : ':';
const FAUNA_CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const CONVERSATIONS_FILE = path.join(FAUNA_CONFIG_DIR, 'conversations.json');

// Module-level AI caller — set during startServer(), used by permission guard etc.
let internalAICaller = async () => '';
// Track the model currently in use for conversations so features inherit it
let _activeModel = 'gpt-4.1';

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// Browser extension bridge. The extension connects to ws://localhost:3737/ext;
// the UI polls these HTTP/SSE endpoints for connection state and pushed events.
let extWss = null;
let extNextClientId = 1;
const extClients = new Map();
const extPendingCommands = new Map();
const extEventClients = new Set();

function extBrowserName(userAgent = '') {
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/OPR\//.test(userAgent)) return 'Opera';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  if (/Chrome\//.test(userAgent)) return 'Chrome';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return 'Browser';
}

// Cache of browsers connected to the FaunaMCP relay (populated by polling /ext-status)
let faunaMcpRelayBrowsers = [];  // [{id, browser, version, connectedAt, activeTab}]

function extStatusList() {
  const direct = Array.from(extClients.values()).map(client => ({
    id: client.id,
    browser: client.browser,
    version: client.version,
    connectedAt: client.connectedAt,
    activeTab: client.activeTab || null,
  }));
  // Include browsers connected to FaunaMCP relay (suppressing duplicates by id)
  if (faunaMcpBrowserConnected) {
    const directIds = new Set(direct.map(c => c.id));
    for (const b of faunaMcpRelayBrowsers) {
      if (!directIds.has(b.id)) direct.push(b);
    }
    // Fallback: if relay has no extensions, show a generic FaunaMCP entry
    if (!faunaMcpRelayBrowsers.length && !direct.some(c => c.id === 'faunamcp')) {
      direct.push({ id: 'faunamcp', browser: 'FaunaMCP', version: null, connectedAt: faunaMcpConnectedAt, activeTab: null });
    }
  }
  return direct;
}

function sendExtSse(event, data = {}) {
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

function broadcastExtStatus() {
  sendExtSse('message', { event: 'ext:status-changed', browsers: extStatusList() });
}

function handleExtMessage(client, raw) {
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
    broadcastExtStatus();
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
      broadcastExtStatus();
    }
    sendExtSse('message', eventMsg);
  }
}

function attachExtBridge(server) {
  if (extWss) return;
  extWss = new WebSocketServer({ noServer: true });

  // Accept connections at /ext on the main server (Fauna Browser Bridge extension)
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
    if (pathname !== '/ext') { socket.destroy(); return; }
    extWss.handleUpgrade(req, socket, head, ws => extWss.emit('connection', ws, req));
  });

  // Also accept connections on port 3340 (FaunaBrowserMCP / faunaMCP-main extension)
  // Silently skip if port is already in use by a standalone relay.
  const relay3340 = new WebSocketServer({ port: 3340 });
  relay3340.on('connection', (ws, req) => extWss.emit('connection', ws, req));
  relay3340.on('error', () => { /* port already in use — relay running separately, ignore */ });

  extWss.on('connection', (ws, req) => {
    const id = 'ext-' + extNextClientId++;
    const userAgent = req.headers['user-agent'] || '';
    const client = {
      id,
      ws,
      userAgent,
      browser: extBrowserName(userAgent),
      version: '',
      connectedAt: new Date().toISOString(),
      activeTab: null,
    };
    extClients.set(id, client);
    broadcastExtStatus();

    ws.on('message', raw => handleExtMessage(client, raw));
    ws.on('close', () => {
      extClients.delete(id);
      for (const [cmdId, pending] of Array.from(extPendingCommands.entries())) {
        if (pending.clientId === id) {
          extPendingCommands.delete(cmdId);
          clearTimeout(pending.timeoutId);
          pending.reject(new Error('Browser extension disconnected'));
        }
      }
      broadcastExtStatus();
    });
  });
}

app.get('/api/ext/status', (_req, res) => {
  res.json({ ok: true, browsers: extStatusList() });
});

// FaunaMCP relay status — checks if FaunaBrowserMCP is reachable
app.get('/api/faunamcp/status', async (_req, res) => {
  let connected = false;
  let toolCount = null;
  let url = 'http://localhost:3341';
  let figmaRelayAvailable = false;
  let appInstalled = false;

  // Check if FaunaMCP HTTP server is reachable
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

  // Check if Figma relay (port 3335) is reachable — use the existing figmaState
  figmaRelayAvailable = figmaState.connected;

  // Check if the faunaMCP-main app is installed (look for the directory)
  try {
    const mcpDir = new URL('./faunaMCP-main', import.meta.url).pathname;
    appInstalled = fs.existsSync(mcpDir);
  } catch (_) {}

  // Count tools from the auto-detected custom MCP server if registered
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

app.get('/api/ext/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  extEventClients.add(res);
  res.write(`data: ${JSON.stringify({ event: 'ext:status-changed', browsers: extStatusList() })}\n\n`);
  req.on('close', () => extEventClients.delete(res));
});

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

app.post('/api/ext/command', async (req, res) => {
  const { action, params = {}, tabId, browser, clientId } = req.body || {};
  if (!action) return res.status(400).json({ ok: false, error: 'action required' });

  // Route FaunaMCP relay IDs (relay-*) or generic 'faunamcp' to the FaunaMCP relay server
  if (isRelayExtClientId(clientId)) {
    try {
      const { status, data } = await forwardExtCommandToRelay({ action, params, tabId, clientId, timeout: req.body?.timeout || 30000 });
      return res.status(status).json(data);
    } catch (e) {
      return res.status(503).json({ ok: false, error: e.message });
    }
  }

  const clients = openDirectExtClients();
  if (!clients.length) {
    if (faunaMcpBrowserConnected) {
      try {
        const { status, data } = await forwardExtCommandToRelay({ action, params, tabId, timeout: req.body?.timeout || 30000 });
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
  const timeoutMs = Math.max(1000, Math.min(Number(req.body.timeout) || 30000, 120000));

  try {
    const result = await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        extPendingCommands.delete(id);
        reject(new Error('Browser extension command timed out'));
      }, timeoutMs);
      extPendingCommands.set(id, { resolve, reject, timeoutId, clientId: client.id });
      client.ws.send(JSON.stringify({ type: 'cmd', id, action, params, tabId }));
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
  if (!clients.length) {
    if (faunaMcpBrowserConnected) {
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
      extPendingCommands.set(id, { resolve, reject, timeoutId, clientId: client.id });
      client.ws.send(JSON.stringify({ type: 'cmd', id, action, params: { full }, tabId }));
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/runs', (_req, res) => {
  res.json([]);
});

// ── Server-side conversation sync ────────────────────────────────────────
// The renderer keeps localStorage as the primary UI cache, but also mirrors
// conversations here so CLI/mobile/build resets can hydrate them back.

function readServerConversations() {
  try {
    const data = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function writeServerConversations(conversations) {
  fs.mkdirSync(FAUNA_CONFIG_DIR, { recursive: true });
  const tmp = CONVERSATIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Array.isArray(conversations) ? conversations : [], null, 2));
  fs.renameSync(tmp, CONVERSATIONS_FILE);
}

app.get('/api/conversations', (req, res) => {
  const full = req.query.full === '1' || req.query.full === 'true';
  const conversations = readServerConversations()
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  if (full) return res.json(conversations);
  res.json(conversations.map(conv => ({
    id: conv.id,
    title: conv.title,
    model: conv.model,
    projectId: conv.projectId,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
  })));
});

app.get('/api/conversations/:id', (req, res) => {
  const conv = readServerConversations().find(c => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  res.json(conv);
});

app.put('/api/conversations/:id', (req, res) => {
  const conversations = readServerConversations();
  const idx = conversations.findIndex(c => c.id === req.params.id);
  const conv = { ...(req.body || {}), id: req.params.id, updatedAt: req.body?.updatedAt || Date.now() };
  if (!conv.createdAt) conv.createdAt = Date.now();
  if (idx >= 0) conversations[idx] = { ...conversations[idx], ...conv };
  else conversations.push(conv);
  writeServerConversations(conversations);
  res.json({ ok: true, conversation: conv });
});

app.delete('/api/conversations/:id', (req, res) => {
  const conversations = readServerConversations();
  const next = conversations.filter(c => c.id !== req.params.id);
  writeServerConversations(next);
  res.json({ ok: true, deleted: conversations.length - next.length });
});

// Generate AI conversation title from messages
app.post('/api/conversation-title', async (req, res) => {
  try {
    const { messages = [], model: reqModel } = req.body;
    if (!messages.length) return res.status(400).json({ error: 'No messages provided' });

    const client = getCopilotClient();
    const TITLE_MODEL = reqModel || 'gpt-4.1';
    const systemPrompt = 'You are a helpful assistant that generates short, descriptive titles for conversations. Generate a concise title (3-6 words) that captures the main topic. Return ONLY the title, no quotes, no explanation.';

    const titleMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Generate a short title for this conversation:\n\n' + messages.map(m => `${m.role}: ${m.content}`).join('\n\n') }
    ];

    const completion = await client.chat.completions.create({
      model: TITLE_MODEL,
      messages: titleMessages,
      max_tokens: 50,
      temperature: 0.7
    });

    const title = (completion.choices[0]?.message?.content || 'New conversation').trim();
    res.json({ title });
  } catch (err) {
    console.error('[conversation-title] Error:', err.message);
    // Fall back to a locally-derived title rather than returning 500, so the
    // conversation title always updates even when the API is unavailable.
    try {
      const { messages = [] } = req.body;
      const firstUser = messages.find(m => m.role === 'user');
      const raw = (firstUser && firstUser.content) ? firstUser.content.trim() : '';
      const fallback = raw
        ? raw.replace(/\s+/g, ' ').slice(0, 60).replace(/[^a-zA-Z0-9 ,.'!?-]/g, '').trim() || 'New conversation'
        : 'New conversation';
      res.json({ title: fallback });
    } catch (_) {
      res.json({ title: 'New conversation' });
    }
  }
});

// ── Automations / tasks API ──────────────────────────────────────────────

function taskWithRuntime(task) {
  if (!task) return task;
  return { ...task, _running: isTaskRunning(task.id) };
}

function sendTaskEvent(res, evt) {
  res.write(`data: ${JSON.stringify(evt)}\n\n`);
}

app.get('/api/tasks', (_req, res) => {
  res.json(getAllTasks().map(taskWithRuntime));
});

app.post('/api/tasks', (req, res) => {
  try {
    const task = createTask(req.body || {});
    res.status(201).json(taskWithRuntime(task));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/tasks/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  sendTaskEvent(res, { event: 'ready' });
  const unsubscribe = subscribe('*', evt => sendTaskEvent(res, evt));
  req.on('close', unsubscribe);
});

app.get('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(taskWithRuntime(task));
});

app.put('/api/tasks/:id', (req, res) => {
  const task = updateTask(req.params.id, req.body || {});
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(taskWithRuntime(task));
});

app.delete('/api/tasks/:id', (req, res) => {
  if (isTaskRunning(req.params.id)) stopTask(req.params.id);
  const ok = deleteTask(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Task not found' });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/run', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  runTask(req.params.id, req.body || {}).catch(e => console.error('[tasks] run failed:', e.message));
  res.json({ ok: true, runId: req.params.id });
});

app.post('/api/tasks/:id/pause', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (isTaskRunning(req.params.id)) pauseTask(req.params.id);
  else updateTask(req.params.id, { status: 'paused', _historyEvent: 'paused', _historyDetail: 'manual' });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/resume', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const status = task.schedule?.type === 'manual' ? 'pending' : 'scheduled';
  res.json(taskWithRuntime(updateTask(req.params.id, { status, _historyEvent: 'resumed', _historyDetail: 'manual' })));
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (isTaskRunning(req.params.id)) stopTask(req.params.id);
  else updateTask(req.params.id, { status: 'paused', _historyEvent: 'stopped', _historyDetail: 'manual' });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/steer', (req, res) => {
  const ok = steerTask(req.params.id, req.body?.message || '');
  if (!ok) return res.status(409).json({ error: 'Task is not running' });
  res.json({ ok: true });
});

// ── Projects ──────────────────────────────────────────────────────────────

app.get('/api/projects', (_req, res) => {
  res.json(getAllProjects());
});

app.post('/api/projects', (req, res) => {
  try { res.status(201).json(createProject(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/projects/:id', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  res.json(p);
});

app.put('/api/projects/:id', (req, res) => {
  const p = updateProject(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: 'Project not found' });
  res.json(p);
});

app.patch('/api/projects/:id', (req, res) => {
  const p = updateProject(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: 'Project not found' });
  res.json(p);
});

// PATCH /api/projects/:id/design — update design-specific metadata
app.patch('/api/projects/:id/design', (req, res) => {
  const patch = req.body || {};
  const p = updateProject(req.params.id, { design: patch });
  if (!p) return res.status(404).json({ error: 'Project not found' });
  res.json(p);
});

app.delete('/api/projects/:id', (req, res) => {
  const ok = deleteProject(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

app.post('/api/projects/:id/touch', (req, res) => {
  touchProject(req.params.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/conversations', (req, res) => {
  const ok = linkConversation(req.params.id, req.body?.convId);
  if (!ok) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

app.post('/api/projects/:id/tasks', (req, res) => {
  const ok = linkTask(req.params.id, req.body?.taskId);
  if (!ok) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

// ── Sources ───────────────────────────────────────────────────────────────

app.post('/api/projects/:id/sources', (req, res) => {
  try { res.status(201).json(addSource(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/projects/:id/sources/:srcId', (req, res) => {
  const ok = removeSource(req.params.id, req.params.srcId);
  if (!ok) return res.status(404).json({ error: 'Source not found' });
  res.json({ ok: true });
});

app.post('/api/projects/:id/sources/:srcId/sync', async (req, res) => {
  try {
    const src = await syncSource(req.params.id, req.params.srcId);
    res.json(src);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/projects/:id/sources/:srcId/files', (req, res) => {
  try {
    const entries = listFiles(req.params.id, req.params.srcId, req.query.path || '');
    res.json(entries);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/projects/:id/sources/:srcId/file', (req, res) => {
  try {
    const result = readSourceFile(req.params.id, req.params.srcId, req.query.path || '');
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Write file back into a local source
app.put('/api/projects/:id/sources/:srcId/file', (req, res) => {
  try {
    const { fullPath } = resolveSourceFilePath(req.params.id, req.params.srcId, req.query.path || '');
    fs.writeFileSync(fullPath, req.body?.content ?? '', 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Stream raw bytes for binary files (images, PDFs, video, audio, etc.)
app.get('/api/projects/:id/sources/:srcId/raw', (req, res) => {
  try {
    const { fullPath, mime, size } = resolveSourceFilePath(req.params.id, req.params.srcId, req.query.path || '');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(fullPath).pipe(res);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── Contexts ──────────────────────────────────────────────────────────────

app.get('/api/projects/:id/contexts', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  res.json(p.contexts || []);
});

app.post('/api/projects/:id/contexts', (req, res) => {
  try { res.status(201).json(addContext(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/projects/:id/contexts/:ctxId', (req, res) => {
  const ctx = updateContext(req.params.id, req.params.ctxId, req.body || {});
  if (!ctx) return res.status(404).json({ error: 'Context not found' });
  res.json(ctx);
});

app.patch('/api/projects/:id/contexts/:ctxId', (req, res) => {
  const ctx = updateContext(req.params.id, req.params.ctxId, req.body || {});
  if (!ctx) return res.status(404).json({ error: 'Context not found' });
  res.json(ctx);
});

app.delete('/api/projects/:id/contexts/:ctxId', (req, res) => {
  const ok = removeContext(req.params.id, req.params.ctxId);
  if (!ok) return res.status(404).json({ error: 'Context not found' });
  res.json({ ok: true });
});

app.post('/api/projects/:id/contexts/from-artifact', (req, res) => {
  try { res.status(201).json(contextFromArtifact(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Upload a file as a context entry (multipart)
app.post('/api/projects/:id/contexts/from-file', (req, res) => {
  // Multer-free: raw body already parsed by express json/urlencoded, or a
  // base64 payload sent via JSON {name, content, mime}
  try {
    const { name, content, mime } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    const ctx = addContext(req.params.id, {
      type: 'file', name: name || 'Uploaded file',
      content: typeof content === 'string' ? content : Buffer.from(content).toString('utf8'),
      path: mime || null,
    });
    res.status(201).json(ctx);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Store: auth/me ────────────────────────────────────────────────────────
app.get('/api/store/auth/me', (req, res) => {
  storeProxy(req, res, 'GET', '/auth/me');
});

// ── Provider API key management ───────────────────────────────────────────
// Keys stored in FAUNA_CONFIG_DIR/provider-keys.json (plain-text, local-only)
const PROVIDER_KEYS_FILE = path.join(FAUNA_CONFIG_DIR, 'provider-keys.json');
const KNOWN_PROVIDERS = [
  { id: 'openai',    name: 'OpenAI',    placeholder: 'sk-…'     },
  { id: 'anthropic', name: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'google',    name: 'Google',    placeholder: 'AIza…'    },
];

function readProviderKeys() {
  try { return JSON.parse(fs.readFileSync(PROVIDER_KEYS_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeProviderKeys(keys) {
  fs.mkdirSync(FAUNA_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PROVIDER_KEYS_FILE, JSON.stringify(keys, null, 2));
}
function keyPreview(k) { return k ? k.slice(0, 4) + '…' + k.slice(-4) : ''; }

app.get('/api/providers', (_req, res) => {
  const stored = readProviderKeys();
  res.json({
    providers: KNOWN_PROVIDERS.map(p => ({
      id: p.id, name: p.name,
      configured: !!stored[p.id],
      preview: stored[p.id] ? keyPreview(stored[p.id]) : null,
    })),
  });
});

app.post('/api/providers/:provider/key', (req, res) => {
  const { provider } = req.params;
  const key = (req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'key required' });
  if (!KNOWN_PROVIDERS.find(p => p.id === provider)) return res.status(404).json({ error: 'Unknown provider' });
  const keys = readProviderKeys();
  keys[provider] = key;
  writeProviderKeys(keys);
  res.json({ ok: true, preview: keyPreview(key) });
});

app.delete('/api/providers/:provider/key', (req, res) => {
  const keys = readProviderKeys();
  delete keys[req.params.provider];
  writeProviderKeys(keys);
  res.json({ ok: true });
});

// ── Mobile pairing ────────────────────────────────────────────────────────
const MOBILE_TOKEN_FILE = path.join(FAUNA_CONFIG_DIR, 'mobile-token.json');

function getMobilePairData() {
  let token;
  try { token = JSON.parse(fs.readFileSync(MOBILE_TOKEN_FILE, 'utf8')).token; } catch (_) {}
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(FAUNA_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(MOBILE_TOKEN_FILE, JSON.stringify({ token }));
  }
  const PORT_NUM = 3737;
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(ifaces)) {
    for (const addr of (iface || [])) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  const primary = ips[0] || '127.0.0.1';
  const primaryQr = `fauna://pair?host=${primary}&port=${PORT_NUM}&token=${token}`;
  return { token, ips, port: PORT_NUM, hostname: os.hostname(), primaryQr, qrImage: null, tunnelUrl: null };
}

app.get('/api/mobile/pair', async (_req, res) => {
  try {
    const data = getMobilePairData();
    // Generate QR code as data URL so it works offline in Electron
    data.qrImage = await QRCode.toDataURL(data.primaryQr, { width: 200, margin: 2 });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mobile/pair/reset', (_req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(FAUNA_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(MOBILE_TOKEN_FILE, JSON.stringify({ token }));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── System info — used by mobile verifyConnection() ──────────────────────
// Validates X-Fauna-Token against the stored mobile token.
app.get('/api/system', (req, res) => {
  let storedToken;
  try { storedToken = JSON.parse(fs.readFileSync(MOBILE_TOKEN_FILE, 'utf8')).token; } catch (_) {}
  const provided = (req.headers['x-fauna-token'] || '').trim();
  if (!storedToken || !provided || provided !== storedToken) {
    return res.status(401).json({ error: 'Invalid or missing token' });
  }
  res.json({ ok: true, hostname: os.hostname() });
});

// ── Tunnel (stub — no external tunnel dependency) ─────────────────────────
app.post('/api/tunnel/start', (_req, res) => {
  res.status(501).json({ ok: false, error: 'Remote tunnel not configured' });
});
app.post('/api/tunnel/stop', (_req, res) => {
  res.json({ ok: true });
});

// ── Enterprise auth (stub — enterprise-auth.js not wired) ────────────────
app.get('/api/enterprise-auth/status', (_req, res) => {
  res.json({ configured: false, signedIn: false, pendingDeviceCode: null });
});
app.post('/api/enterprise-auth/sign-in', (_req, res) => {
  res.status(501).json({ ok: false, error: 'Enterprise auth not configured' });
});
app.post('/api/enterprise-auth/sign-out', (_req, res) => {
  res.json({ ok: true });
});

// ── WorkIQ (stub — workiq-integration.js not wired) ──────────────────────
app.get('/api/workiq/status', (_req, res) => {
  res.json({ connected: false, available: false });
});
app.post('/api/workiq/connect', (_req, res) => {
  res.status(501).json({ ok: false, error: 'WorkIQ not configured' });
});
app.post('/api/workiq/sign-out', (_req, res) => {
  res.json({ ok: true });
});

// ── Fauna self-update ─────────────────────────────────────────────────────
let _faunaUpdateJob = null;

const FAUNA_REPO_OWNER = 'howmon';
const FAUNA_REPO_NAME  = 'fauna';
const FAUNA_APP_DIR    = __dirname;

function _faunaLog(msg) {
  if (!_faunaUpdateJob) return;
  _faunaUpdateJob.logs = _faunaUpdateJob.logs || [];
  _faunaUpdateJob.logs.push({ message: msg, ts: Date.now() });
  _faunaUpdateJob.message = msg;
}

function _faunaIsPackaged() {
  return !!(_electronApp && _electronApp.isPackaged);
}

function _faunaGitSha() {
  // 1. Try live git (works in dev / git-clone installs)
  try {
    return execSync('git rev-parse HEAD', { cwd: FAUNA_APP_DIR, encoding: 'utf8' }).trim();
  } catch (_) {}
  // 2. Fall back to build-time SHA embedded in build-info.json (packaged app)
  try {
    const info = JSON.parse(fs.readFileSync(path.join(FAUNA_APP_DIR, 'build-info.json'), 'utf8'));
    if (info && info.sha) return info.sha;
  } catch (_) {}
  return null;
}

async function _faunaFetchRemoteSha() {
  // Use GitHub API — no auth needed for public repos
  const https = await import('https');
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${FAUNA_REPO_OWNER}/${FAUNA_REPO_NAME}/commits/HEAD`;
    const opts = { headers: { 'User-Agent': 'Fauna-App/1.0', 'Accept': 'application/vnd.github.sha' } };
    https.get(url, opts, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        if (r.statusCode === 200) resolve(body.trim());
        else reject(new Error(`GitHub API ${r.statusCode}: ${body.slice(0, 120)}`));
      });
    }).on('error', reject);
  });
}

app.get('/api/fauna/update-status', (_req, res) => {
  res.json({ job: _faunaUpdateJob || { phase: 'idle', updateAvailable: false } });
});

app.post('/api/fauna/check-update', async (_req, res) => {
  _faunaUpdateJob = { phase: 'checking', checking: true, running: false, logs: [] };
  _faunaLog('Reading local git SHA…');
  try {
    const currentSha = _faunaGitSha();
    if (!currentSha) throw new Error('Not a git repository — cannot check for updates');
    _faunaLog(`Local SHA: ${currentSha.slice(0, 12)}`);
    _faunaLog('Fetching latest SHA from GitHub…');
    const latestSha = await _faunaFetchRemoteSha();
    _faunaLog(`Remote SHA: ${latestSha.slice(0, 12)}`);
    const updateAvailable = latestSha !== currentSha;
    _faunaUpdateJob = {
      phase: updateAvailable ? 'available' : 'current',
      checking: false, running: false,
      updateAvailable,
      currentSha, latestSha,
      logs: _faunaUpdateJob.logs,
      message: updateAvailable ? `Update available (${latestSha.slice(0,7)})` : 'Already up to date',
    };
  } catch (err) {
    _faunaUpdateJob = {
      phase: 'error', checking: false, running: false, updateAvailable: false,
      error: err.message, logs: (_faunaUpdateJob && _faunaUpdateJob.logs) || [],
    };
    _faunaLog(`Error: ${err.message}`);
  }
  res.json({ job: _faunaUpdateJob });
});

app.post('/api/fauna/install-update', express.json(), async (req, res) => {
  if (_faunaUpdateJob && _faunaUpdateJob.running) {
    return res.status(409).json({ error: 'Update already in progress' });
  }

  console.log('[fauna-update] Install triggered. App dir:', FAUNA_APP_DIR);
  console.log('[fauna-update] Is packaged:', _faunaIsPackaged());
  
  // Check if we can do git-based updates (requires .git folder)
  const hasGitRepo = fs.existsSync(path.join(FAUNA_APP_DIR, '.git'));
  console.log('[fauna-update] .git exists in app dir:', hasGitRepo);
  
  // In a packaged app without git repo, open the releases page instead
  if (_faunaIsPackaged() && !hasGitRepo) {
    const releasesUrl = `https://github.com/${FAUNA_REPO_OWNER}/${FAUNA_REPO_NAME}/releases`;
    console.log('[fauna-update] Opening releases page:', releasesUrl);
    console.log('[fauna-update] _electronShell available:', !!_electronShell);
    
    if (_electronShell) {
      _electronShell.openExternal(releasesUrl);
      console.log('[fauna-update] openExternal called');
    } else {
      console.log('[fauna-update] WARNING: _electronShell not available, cannot open browser');
    }
    
    _faunaUpdateJob = {
      phase: 'complete', running: false, updateAvailable: false,
      message: 'Opened GitHub releases page in browser — download and install the new version.',
      logs: [{ message: `Opened ${releasesUrl}` }],
    };
    return res.json({ job: _faunaUpdateJob });
  }
  
  // If no git repo exists at all, we can't update
  if (!hasGitRepo) {
    console.log('[fauna-update] No git repo found, cannot update');
    return res.status(400).json({ 
      error: 'No git repository found. Please install from GitHub releases or clone the repository.'
    });
  }

  _faunaUpdateJob = { phase: 'starting', running: true, logs: [], updateAvailable: false };
  res.json({ job: _faunaUpdateJob });   // respond immediately; client polls /update-status

  const { promisify } = await import('util');
  const execP = promisify(_exec);

  async function phase(name, cmd) {
    _faunaUpdateJob.phase = name;
    _faunaLog(`[${name}] ${cmd}`);
    const { stdout, stderr } = await execP(cmd, { cwd: FAUNA_APP_DIR, env: { ...process.env } });
    if (stdout) stdout.trim().split('\n').forEach(l => _faunaLog(l));
    if (stderr) stderr.trim().split('\n').forEach(l => _faunaLog(l));
  }

  (async () => {
    try {
      await phase('download',      'git fetch origin');
      await phase('extract',       'git reset --hard origin/HEAD');
      await phase('dependencies',  'npm install --prefer-offline');
      _faunaUpdateJob.phase    = 'complete';
      _faunaUpdateJob.running  = false;
      _faunaUpdateJob.message  = 'Update complete — restart Fauna to apply changes';
      _faunaLog('Done. Restart the app to use the new version.');
    } catch (err) {
      _faunaUpdateJob.phase   = 'error';
      _faunaUpdateJob.running = false;
      _faunaUpdateJob.error   = err.message;
      _faunaLog(`Install failed: ${err.message}`);
    }
  })();
});

// ── Markdown → PDF ───────────────────────────────────────────────────────
app.post('/api/markdown-to-pdf', express.json({ limit: '10mb' }), async (req, res) => {
  const { markdown, outputPath, pageSize = 'A4', landscape = false } = req.body || {};
  if (!markdown) return res.status(400).json({ error: 'markdown is required' });
  if (!outputPath) return res.status(400).json({ error: 'outputPath is required' });
  if (!_ElectronBrowserWindow) return res.status(503).json({ error: 'PDF generation only available inside Electron' });

  // Pre-process mermaid blocks so marked doesn't swallow them or truncate the document.
  // marked treats unclosed/unknown fences as raw code, causing everything after to not render.
  let mdClean = markdown;
  const mermaidSections = [];
  // 1. Complete mermaid blocks (with closing ```)
  mdClean = mdClean.replace(/```mermaid\n([\s\S]*?)```/g, (_m, code) => {
    const i = mermaidSections.length;
    mermaidSections.push(code.trim());
    return `\`\`\`\nmermaid diagram (section ${i + 1})\n\`\`\``;
  });
  // 2. Unclosed mermaid block at end (shouldn't happen for complete files, but be safe)
  mdClean = mdClean.replace(/```mermaid\n([\s\S]*)$/, (_m, code) => {
    const i = mermaidSections.length;
    mermaidSections.push(code.trim());
    return `\`\`\`\nmermaid diagram (section ${i + 1})\n\`\`\``;
  });

  const htmlBody = marked(mdClean);
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#1a1a1a;max-width:800px;margin:40px auto;padding:0 40px}
h1,h2,h3,h4{margin-top:1.4em;margin-bottom:.4em}h1{font-size:2em;border-bottom:2px solid #e0e0e0;padding-bottom:.3em}h2{font-size:1.5em;border-bottom:1px solid #e8e8e8;padding-bottom:.2em}
code{background:#f5f5f5;padding:2px 5px;border-radius:3px;font-size:.9em}
pre{background:#f5f5f5;padding:14px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f0f0f0}
blockquote{border-left:4px solid #ccc;margin:0;padding:0 1em;color:#666}
</style></head><body>${htmlBody}</body></html>`;

  let win;
  try {
    win = new _ElectronBrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml));
    // Small settle wait so the renderer paints before capture
    await new Promise(r => setTimeout(r, 200));
    const pdfBuffer = await win.webContents.printToPDF({
      pageSize,
      landscape,
      printBackground: true,
      margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 },
    });
    const absPath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, pdfBuffer);
    res.json({ ok: true, path: absPath, bytes: pdfBuffer.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { win && win.destroy(); } catch (_) {}
  }
});

// ── Token resolution ──────────────────────────────────────────────────────
// Electron runs with a stripped PATH so `gh` may not be found.
// Resolution order:
//   1. GH_TOKEN / GITHUB_TOKEN env var
//   2. macOS Keychain via /usr/bin/security (macOS only)
//   3. gh binary — searched in common install locations
//   4. ~/.config/gh/hosts.yml oauth_token field (non-keychain fallback)

function findGhBinary() {
  const candidates = IS_WIN ? [
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'GitHub CLI', 'gh.exe'),
    path.join(os.homedir(), 'scoop', 'shims', 'gh.exe'),
  ] : [
    '/opt/homebrew/bin/gh',        // Apple Silicon Homebrew
    '/usr/local/bin/gh',           // Intel Homebrew
    '/usr/bin/gh',
    '/snap/bin/gh',
  ];
  // Also try PATH entries
  const binName = IS_WIN ? 'gh.exe' : 'gh';
  const pathDirs = (process.env.PATH || '').split(PATH_SEP);
  for (const dir of pathDirs) candidates.push(path.join(dir, binName));

  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {}
  }
  return null;
}

function readTokenFromKeychain() {
  if (IS_WIN) return null;  // macOS Keychain not available on Windows
  // gh stores tokens as base64 in the macOS Keychain under service "gh:github.com"
  // /usr/bin/security is always available even in Electron's stripped PATH
  try {
    const raw = execSync(
      '/usr/bin/security find-generic-password -s "gh:github.com" -w',
      { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }
    ).trim();
    // gh encodes tokens as "go-keyring-base64:<base64>"
    if (raw.startsWith('go-keyring-base64:')) {
      return Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf8').trim();
    }
    return raw;
  } catch (_) { return null; }
}

function readTokenFromConfig() {
  // Fallback: parse ~/.config/gh/hosts.yml for oauth_token
  try {
    const yml = fs.readFileSync(path.join(os.homedir(), '.config', 'gh', 'hosts.yml'), 'utf8');
    const match = yml.match(/oauth_token:\s*(\S+)/);
    return match ? match[1].trim() : null;
  } catch (_) { return null; }
}

// ── PAT config file ───────────────────────────────────────────────────────

const CONFIG_DIR   = path.join(os.homedir(), '.config', 'copilot-chat');
const CONFIG_FILE  = path.join(CONFIG_DIR, 'config.json');
const RECOVERY_DIR = path.join(os.homedir(), '.copilotchat-recovery');

function readSavedConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function writeSavedConfig(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

function getGhToken() {
  // 0. User-saved PAT (highest priority — explicitly set by user in UI)
  const cfg = readSavedConfig();
  if (cfg.pat && cfg.pat.trim()) return cfg.pat.trim();

  // 1. Env vars
  if (process.env.GH_TOKEN)     return process.env.GH_TOKEN.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();

  // 2. macOS Keychain (most reliable in Electron)
  const keychainToken = readTokenFromKeychain();
  if (keychainToken) return keychainToken;

  // 3. gh binary (fallback, may fail in Electron .app)
  const gh = findGhBinary();
  if (gh) {
    try {
      return execSync(`"${gh}" auth token`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    } catch (_) {}
  }

  // 4. Config file oauth_token
  const cfgToken = readTokenFromConfig();
  if (cfgToken) return cfgToken;

  throw new Error('GitHub token not found. Run: gh auth login');
}

function getCopilotClient() {
  const token = getGhToken();
  return new OpenAI({
    baseURL: 'https://api.githubcopilot.com',
    apiKey:  token,
    defaultHeaders: {
      'Editor-Version':        'vscode/1.85.0',
      'Copilot-Integration-Id': 'vscode-chat'
    }
  });
}

const FALLBACK_MODELS = [
  { id: 'claude-sonnet-4.6',     name: 'Claude Sonnet 4.6',     vendor: 'Anthropic', fast: false },
  { id: 'claude-sonnet-4.5',     name: 'Claude Sonnet 4.5',     vendor: 'Anthropic', fast: false },
  { id: 'claude-sonnet-4',       name: 'Claude Sonnet 4',       vendor: 'Anthropic', fast: false },
  { id: 'claude-haiku-4.5',      name: 'Claude Haiku 4.5',      vendor: 'Anthropic', fast: true  },
  { id: 'claude-opus-4.6',       name: 'Claude Opus 4.6',       vendor: 'Anthropic', fast: false },
  { id: 'claude-opus-4.6-1m',    name: 'Claude Opus 4.6 1M',    vendor: 'Anthropic', fast: false },
  { id: 'claude-opus-4.5',       name: 'Claude Opus 4.5',       vendor: 'Anthropic', fast: false },
  { id: 'gpt-4.1',               name: 'GPT-4.1',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-4.1-mini',          name: 'GPT-4.1 mini',          vendor: 'OpenAI',    fast: true  },
  { id: 'gpt-5-mini',            name: 'GPT-5 mini',            vendor: 'OpenAI',    fast: true  },
  { id: 'gpt-5.1',               name: 'GPT-5.1',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-5.2',               name: 'GPT-5.2',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-5.4',               name: 'GPT-5.4',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-5.4-mini',          name: 'GPT-5.4 mini',          vendor: 'OpenAI',    fast: true  },
  { id: 'gpt-4o',                name: 'GPT-4o',                vendor: 'OpenAI',    fast: false },
  { id: 'o3-mini',               name: 'o3-mini',               vendor: 'OpenAI',    fast: false },
  { id: 'minimax-m2.5',          name: 'Minimax M2.5',          vendor: 'Minimax',   fast: true  },
  { id: 'gemini-3.1-pro-preview',name: 'Gemini 3.1 Pro Preview',vendor: 'Google',    fast: false },
  { id: 'gemini-3-flash-preview',name: 'Gemini 3 Flash Preview',vendor: 'Google',    fast: true  },
  { id: 'gemini-2.5-pro',        name: 'Gemini 2.5 Pro',        vendor: 'Google',    fast: false },
  { id: 'gemini-2.0-flash',      name: 'Gemini 2.0 Flash',      vendor: 'Google',    fast: true  },
];

// ── Auth check ────────────────────────────────────────────────────────────

app.get('/api/auth', (req, res) => {
  try {
    const token   = getGhToken();
    const cfg     = readSavedConfig();
    const source  = cfg.pat ? 'pat' : (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) ? 'env' : 'keychain';
    const preview = token ? token.slice(0, 4) + '…' + token.slice(-4) : '?';
    res.json({ authenticated: true, preview, source });
  } catch (e) {
    res.json({ authenticated: false, error: e.message });
  }
});

// ── PAT management ────────────────────────────────────────────────────────

app.post('/api/token', (req, res) => {
  const { pat } = req.body;
  if (!pat || !pat.trim()) return res.status(400).json({ error: 'PAT required' });

  // Basic sanity: GitHub tokens start with ghp_, gho_, github_pat_, or are classic 40-char hex
  const trimmed = pat.trim();
  const looksValid = /^(ghp_|gho_|github_pat_|ghs_|ghr_)/.test(trimmed) || /^[a-f0-9]{40}$/i.test(trimmed);
  if (!looksValid) {
    return res.status(400).json({ error: 'This doesn\'t look like a valid GitHub token (should start with ghp_, gho_, or github_pat_)' });
  }

  const cfg = readSavedConfig();
  cfg.pat = trimmed;
  writeSavedConfig(cfg);
  res.json({ ok: true, preview: trimmed.slice(0, 4) + '…' + trimmed.slice(-4) });
});

app.delete('/api/token', (req, res) => {
  const cfg = readSavedConfig();
  delete cfg.pat;
  writeSavedConfig(cfg);
  res.json({ ok: true });
});

app.get('/api/token', (req, res) => {
  const cfg = readSavedConfig();
  if (cfg.pat) {
    const t = cfg.pat;
    res.json({ hasPat: true, preview: t.slice(0, 4) + '…' + t.slice(-4) });
  } else {
    res.json({ hasPat: false });
  }
});

// ── Model list ────────────────────────────────────────────────────────────

app.get('/api/models', async (req, res) => {
  try {
    const client   = getCopilotClient();
    const response = await client.models.list();
    // Only expose models that match our known-working list or are clearly chat models
    const apiIds  = new Set((response.data || []).map(m => m.id));
    // Return known models that are actually available, plus any new ones from API
    const known   = FALLBACK_MODELS.filter(m => apiIds.has(m.id));
    // Add any API models not in fallback list that look like chat-completions models
    // Exclude: embeddings, whisper, tts, dall-e, codex, internal routers, dated snapshots, non-chat
    const EXCLUDE_RE = /embed|whisper|tts|dall|codex|goldeneye|accounts\/|routers\/|realtime|audio|search|computer-use|\d{4}[-_]\d{2}[-_]\d{2}|^\d{4}-/i;
    const extra   = (response.data || [])
      .filter(m => {
        if (FALLBACK_MODELS.find(f => f.id === m.id)) return false;
        if (EXCLUDE_RE.test(m.id)) return false;
        // Must look like a known model family
        if (!/^(gpt|claude|gemini|o[1-9]|minimax|deepseek|phi|llama|mistral)/i.test(m.id)) return false;
        return true;
      })
      .map(m => ({
        id:     m.id,
        name:   m.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        vendor: m.id.includes('claude') ? 'Anthropic' : m.id.includes('gemini') ? 'Google' : 'OpenAI',
        fast:   m.id.includes('mini') || m.id.includes('haiku') || m.id.includes('flash')
      }));
    const models = [...known, ...extra];
    res.json({ models: models.length ? models : FALLBACK_MODELS });
  } catch (e) {
    res.json({ models: FALLBACK_MODELS });
  }
});

// ── Figma layout knowledge ───────────────────────────────────────────────
// Injected into the system prompt when Figma MCP is enabled.

// ── Gen-UI catalog prompt ────────────────────────────────────────────────
// Injected server-side so all clients (desktop + mobile) can generate gen-ui.
const GEN_UI_CATALOG_PROMPT = `
## Output format decision — artifact pane vs inline gen-ui vs plain text

Use this decision table every time you produce structured or visual output. Pick **exactly one** format.

### Use \`\`\`artifact:<type>:<title>\`\`\` (artifact pane) when:
- The output is a **file or document** the user will save, copy, or reuse (code, HTML, Markdown, JSON, CSV)
- The output is **long** (more than ~40 lines of content)
- The user's request contains words like *create*, *write*, *generate*, *build*, *draft* referencing a file or doc
- The output is runnable/executable (shell script, HTML page, full component)
- Artifact types: \`html\`, \`markdown\`, \`json\`, \`csv\`, \`code\`, \`text\`, \`files\`, \`summary\`

### Use a \`\`\`gen-ui\`\`\` block (inline in chat) when:
- The output is a **snapshot** of current data: metrics, status, comparison, leaderboard
- The output is a **compact interactive widget**: tabs, toggle, progress tracker, key-value list
- The user asked for a *dashboard*, *scorecard*, *summary card*, *checklist*, or *status overview*
- The content is **ephemeral** — not something the user needs to save or edit
- The output would be ≤ 30 logical elements and primarily visual/structured rather than prose

### Use **plain Markdown prose** when:
- The answer is conversational, explanatory, or a list of bullet points
- No special formatting would add clarity
- Never wrap plain explanations in gen-ui or artifact blocks

### Priority rule
Artifact > gen-ui > prose. If in doubt between artifact and gen-ui, ask: *would the user want to copy or save this later?* If yes → artifact. If it's just a visual aid for this moment → gen-ui.

---

## Generative UI (gen-ui inline blocks)
Render interactive UI components inline using a \`gen-ui\` code block containing a valid JSON flat spec.

**Spec shape:** \`{ "root": "id", "elements": { "id": { "type", "props", "children": [] } }, "state": {} }\`

### Available components
| Type | Key props | Notes |
|------|-----------|-------|
| \`Card\` | \`title\`, \`description\` | Container with optional header |
| \`Stack\` | \`direction\` ("vertical"/"horizontal"), \`gap\`, \`align\`, \`justify\`, \`wrap\` | Flex layout |
| \`Grid\` | \`columns\` (number), \`gap\` | CSS grid layout |
| \`Heading\` | \`text\`, \`level\` (1–6) | Heading element |
| \`Text\` | \`text\`, \`muted\`, \`strong\`, \`small\`, \`code\` | Paragraph |
| \`Badge\` | \`label\`, \`variant\` ("default"/"success"/"warning"/"error"/"info") | Colored badge |
| \`Stat\` | \`value\`, \`label\`, \`format\` ("currency"/"percent"/"number"), \`trend\` | Metric display |
| \`Alert\` | \`title\`, \`message\`, \`variant\` ("info"/"success"/"warning"/"error") | Callout banner |
| \`Button\` | \`label\`, \`variant\` ("default"/"primary"/"danger"), \`action\`, \`actionParams\`, \`icon\`, \`disabled\` | Clickable button |
| \`Divider\` | \`label\` (optional) | Horizontal rule |
| \`KeyValue\` | \`key\`, \`value\` | Label: value row |
| \`Table\` | \`columns\` (strings or \`{header,width,align}\`), \`rows\` (2-D array) | Data table |
| \`List\` | \`items\` (strings or \`{label,description}\`), \`ordered\` | Bullet/numbered list |
| \`Progress\` | \`value\` (0–100), \`label\`, \`variant\` | Progress bar |
| \`Code\` | \`code\`, \`language\` | Syntax-highlighted snippet |
| \`Image\` | \`src\`, \`alt\`, \`width\`, \`height\` | Image from a URL or data URI |
| \`SVG\` | \`markup\` (raw SVG string), \`width\`, \`height\`, \`viewBox\` | Inline SVG — pass the full \`<svg>…</svg>\` as \`markup\`. Use this to render icons, logos, diagrams, or any vector graphic the AI generates. Scripts and event handlers are sanitized automatically. |

### Actions (Button.action)
\`setState\` · \`toggle_visible\` · \`copy_text\`

### Dynamic props
- \`{ "$state": "/path" }\` — read state value
- \`{ "$template": "Hello \${/name}!" }\` — string interpolation

### Example — dashboard card
\`\`\`gen-ui
{
  "root": "card",
  "elements": {
    "card": { "type": "Card", "props": { "title": "Q1 Metrics" }, "children": ["grid"] },
    "grid": { "type": "Grid", "props": { "columns": 3, "gap": 12 }, "children": ["s1","s2","s3"] },
    "s1": { "type": "Stat", "props": { "value": "128400", "label": "Revenue", "format": "currency", "trend": 12 }, "children": [] },
    "s2": { "type": "Stat", "props": { "value": "94", "label": "NPS", "format": "number", "trend": -2 }, "children": [] },
    "s3": { "type": "Stat", "props": { "value": "73", "label": "CSAT", "format": "percent", "trend": 5 }, "children": [] }
  }
}
\`\`\`
`.trim();

// ── Browser panel + app building context ────────────────────────────────
// Always injected so the AI knows how to use the built-in browser.
const BROWSER_BUILD_CONTEXT = `
## Built-in Browser Panel

You have a built-in browser panel that runs inside the app. You can control it using \`\`\`browser-action code blocks.

### Available browser actions:
- **navigate** — \`{"action":"navigate","url":"..."}\` — load a URL
- **extract** — \`{"action":"extract"}\` — get page text + links
- **eval** — \`{"action":"eval","js":"..."}\` — run JS in the page
- **click** — \`{"action":"click","selector":"..."}\` — click an element
- **type** — \`{"action":"type","selector":"...","value":"..."}\` — type into an input
- **wait** — \`{"action":"wait","ms":1500}\` — wait N milliseconds
- **new-tab** — \`{"action":"new-tab","url":"..."}\` — open a new browser tab (optionally with URL)
- **switch-tab** — \`{"action":"switch-tab","index":0}\` — switch to tab by 0-based index
- **close-tab** — \`{"action":"close-tab","index":0}\` — close a tab
- **list-tabs** — \`{"action":"list-tabs"}\` — list all open tabs
- **extract-all** — \`{"action":"extract-all"}\` — extract text from ALL tabs
- **console-logs** — \`{"action":"console-logs"}\` — read console errors/warnings/logs from the active tab
- **console-logs (filtered)** — \`{"action":"console-logs","level":"error"}\` — only errors
- **clear-console** — \`{"action":"clear-console"}\` — clear captured console logs

### Dev Server + Browser Debugging Workflow
When building a web app for the user, follow this workflow:
1. **Install ALL dependencies in one complete command** — never truncate \`npm install\`. Write the full package.json first, then run \`npm install\`.
2. **Start dev server in background** — use \`&\` or run it as a background process, then wait a moment
3. **Open in browser** — navigate to \`http://localhost:PORT\` in a new tab. Console errors/warnings from localhost pages are **automatically included** in the page extract — check them!
4. **Fix and iterate** — if there are errors, fix the code, navigate again or use console-logs to recheck
5. **Only report success after verifying** — don't tell the user it works until you've seen the page load without errors

### Critical Rules:
- **ZERO NARRATION before actions.** NEVER write text before a browser-action, browser-ext-action, or shell command block. No "Let me...", "I'll...", "I need to...", "Let me search...", "Let me use...", "I'll try...". Just emit the action block with nothing before it. This is the #1 rule — violating it wastes the user's time.
- **NEVER truncate shell commands or code blocks**. Write them fully in one go. Never stop mid-line or say "let me continue".
- **Batch browser actions** when possible. If you need to do multiple actions (e.g. eval + extract), emit them all in one fenced block as JSONL (one JSON object per line) instead of separate blocks.
- **Be silent DURING browser action sequences**. When you receive auto-fed browser results and need to do more actions, respond ONLY with the next action block — no commentary. But when you're DONE (no more actions needed), give the user a brief summary of what you accomplished and any relevant findings.
- **ALWAYS write complete files**. When creating a file, write ALL of it in one code block. Never split a file across multiple blocks.
- **ALWAYS write complete package.json** before running npm install — don't rely on incremental installs.
- **Use console-logs to debug** — after loading a page, check for errors before telling the user it's done.
- **If your output was cut off**, you will be automatically asked to continue. Just pick up exactly where you left off.
- The browser keeps login sessions across pages (cookies persist). No need to re-authenticate.
- Each conversation has its own browser tabs — they don't interfere with other conversations.
`;

// ── Browser Extension (Fauna Web Extension) context ─────────────────────────
// Injected dynamically when at least one browser extension is connected.
// Documents the browser-ext-action code block syntax so the AI knows how to
// control the user's real Chrome/Edge/Firefox browser via the extension.
function buildBrowserExtContext() {
  const connected = extStatusList();
  if (!connected.length) return '';
  const browserNames = [...new Set(connected.map(b => b.browser).filter(Boolean))];
  const browserLabel = browserNames.length ? browserNames.join(' and ') : 'browser';
  return `
## Fauna Web Extension — Controlling the User's Real ${browserLabel}

The user has the Fauna browser extension connected in their **real ${browserLabel}** (${connected.length} connection${connected.length > 1 ? 's' : ''}). You can control that browser directly using \`\`\`browser-ext-action code blocks.

**Use \`browser-ext-action\` (extension) instead of \`browser-action\` (built-in panel) when the user:**
- Wants to interact with their existing open tabs and real browser session
- Is already logged into sites you need to access
- Wants to scrape, automate, or control pages in their real browser
- Asks you to "use the extension", "use my browser", or mentions tabs/windows they have open

### Available browser-ext-action commands:

#### Page interaction
- **navigate** — \`{"action":"navigate","url":"..."}\` — navigate to a URL (auto-extracts after)
- **extract** — \`{"action":"extract"}\` — extract page text + links from active tab
- **extract-forms** — \`{"action":"extract-forms"}\` — extract all form fields with selectors
- **fill** — \`{"action":"fill","fields":[{"selector":"...","value":"..."}]}\` — fill form fields
- **click** — \`{"action":"click","selector":"..."}\` — click an element (auto-extracts after)
- **type** — \`{"action":"type","selector":"...","value":"..."}\` — type into an input (auto-extracts after)
- **hover** — \`{"action":"hover","selector":"..."}\` — hover over an element
- **scroll** — \`{"action":"scroll","selector":"...","direction":"down","amount":300}\` — scroll the page
- **drag** — \`{"action":"drag","from":"selector","to":"selector"}\` — drag and drop
- **select** — \`{"action":"select","selector":"...","value":"..."}\` — select an option
- **keyboard** — \`{"action":"keyboard","key":"Enter"}\` — press a keyboard key
- **wait** — \`{"action":"wait","ms":1500}\` — wait N milliseconds
- **eval** — \`{"action":"eval","js":"document.title"}\` — run JS in the real page, result fed to AI

#### Screenshots
- **snapshot** — \`{"action":"snapshot"}\` — screenshot the visible area (image injected into AI)
- **snapshot-full** — \`{"action":"snapshot-full"}\` — full-page screenshot

#### Tab management
- **tab:list** — \`{"action":"tab:list"}\` — list all open tabs (id, title, url, active)
- **tab:new** — \`{"action":"tab:new","url":"..."}\` — open a new tab
- **tab:switch** — \`{"action":"tab:switch","tabId":123}\` — switch to a tab by id (use tab:list first)
- **tab:close** — \`{"action":"tab:close","tabId":123}\` — close a tab
- **tab:info** — \`{"action":"tab:info"}\` — get info (url, title) of the active tab

### Rules for browser-ext-action:
- **ZERO NARRATION before action blocks** — emit the block immediately with no preamble.
- **Results are auto-fed back** — after navigate, click, type, scroll etc. the page state is automatically extracted and sent back to you. Wait for it before acting further.
- **Batch sequential actions** as JSONL (one JSON per line in a single block).
- **To target a specific tab**: use \`tab:list\` first to get the tab id, then pass \`"tabId": <id>\` in subsequent actions.
- **selector tips**: use CSS selectors; for forms prefer \`extract-forms\` first to get exact selectors.
- **snapshot** is useful when text extraction misses visual layout — request one to see the page.
`.trim();
}

// ── Context summarization endpoint ───────────────────────────────────────────
app.post('/api/summarize', async (req, res) => {
  const { messages = [], model = 'claude-sonnet-4.6' } = req.body;
  if (!messages.length) return res.json({ summary: '' });
  try {
    const client = getCopilotClient();
    const prompt = [
      { role: 'system', content:
        'You are a concise task-state summarizer. ' +
        'Given a conversation, produce a compact summary (max 400 words) covering:\n' +
        '1. The original task/goal\n' +
        '2. What has already been completed (files created, commands run, results)\n' +
        '3. Current state and any pending steps\n' +
        '4. Key facts discovered (paths, errors, findings)\n' +
        'Write in past tense. Be specific — include file paths, command names, and exact results. ' +
        'Omit greetings, filler, and markdown formatting.'
      },
      ...messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content.slice(0, 3000)
          : (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 3000)
      })),
      { role: 'user', content: 'Summarize the conversation above as a compact task-state note.' }
    ];
    const sumParams = { model, messages: prompt, stream: false };
    if (/^(o[1-9]|gpt-5)/.test(model)) { sumParams.max_completion_tokens = 600; }
    else { sumParams.max_tokens = 600; }
    const resp = await client.chat.completions.create(sumParams);
    const summary = resp.choices[0]?.message?.content?.trim() || '';
    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/chat', async (req, res) => {
  _psAcquire();
  res.on('finish', _psRelease);
  res.on('close',  _psRelease);
  const { messages = [], model = 'claude-sonnet-4.6', systemPrompt = '', useFigmaMCP = false, contextSummary = '',
          thinkingBudget = 'high', maxContextTurns = 20, agentName = null,
          projectId = null, projectContextIds = null, isDelegation = false } = req.body;

  // Track the active conversation model so heartbeat/workflows/teams use the same one
  _activeModel = model;

  res.writeHead(200, {
    'Content-Type':    'text/event-stream',
    'Cache-Control':   'no-cache',
    'Connection':      'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': 'http://localhost:3737'
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const client = getCopilotClient();
    const allMessages = [];

    // Build project context from active project (name, root, sources, pinned/enabled contexts)
    let projectCtx = '';
    if (projectId) {
      projectCtx = projectContextIds && projectContextIds.length
        ? buildContextPayload(projectId, projectContextIds)
        : getProjectSystemContext(projectId);
    }

    // Build system prompt — append project context, facts memory, context summary and browser context
    // For delegation (sub-agent) calls, skip heavy shared context to reduce token cost
    const factsCtx = isDelegation ? '' : factsForSystemPrompt(20);
    // Inject connected Figma file info so AI can target the right document
    let figmaFilesCtx = '';
    if (useFigmaMCP && figmaFiles.size > 0) {
      const entries = [...figmaFiles.values()].map(f => `- "${f.fileName}" (fileKey: ${f.fileKey}, page: ${f.currentPage})`).join('\n');
      figmaFilesCtx = `\n## Connected Figma Documents\nThe following Figma documents are currently open with the plugin running:\n${entries}\nWhen using figma_execute, pass the fileKey parameter to target a specific document. If omitted, the most recently active document is used.\nIMPORTANT: Dev Mode MCP tools (get_screenshot, get_design_context, get_metadata, etc.) always operate on whichever file is currently focused in Figma — they do NOT accept a fileKey parameter. If you need to read from or screenshot a specific file, use figma_execute with the fileKey parameter instead.`;
    }
    const fullSystem = [
      systemPrompt.trim(),
      isDelegation ? '' : projectCtx,
      factsCtx,
      isDelegation ? '' : BROWSER_BUILD_CONTEXT,
      isDelegation ? '' : buildBrowserExtContext(),
      isDelegation ? '' : GEN_UI_CATALOG_PROMPT,
      contextSummary ? `\n## Task Context (auto-summarized from earlier conversation)\n${contextSummary}` : '',
      figmaFilesCtx
    ].filter(Boolean).join('\n');
    if (fullSystem) allMessages.push({ role: 'system', content: fullSystem });

    // ── Context trimming ──────────────────────────────────────────────────
    // Target: ~60k chars of conversation history (well inside 128k context window)
    const MAX_HISTORY_CHARS = 200000;
    const MAX_MSG_CHARS     = 40000; // cap any single message (shell outputs can be huge)
    const TURN_LIMIT        = maxContextTurns >= 100 ? Infinity : maxContextTurns;

    // 1. Strip old image payloads and cap oversized messages
    const stripped = messages.map((m, i) => {
      let content = m.content;

      // Strip image bytes from non-latest vision messages
      if (Array.isArray(content) && i < messages.length - 1) {
        const textOnly = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        content = textOnly + '\n[screenshot attached earlier — not repeated]';
      }

      // Cap very long text messages (e.g. large shell outputs fed back as context)
      if (typeof content === 'string' && content.length > MAX_MSG_CHARS) {
        content = content.slice(0, MAX_MSG_CHARS) + `\n…[truncated — ${content.length - MAX_MSG_CHARS} chars omitted]`;
      }

      return { ...m, content };
    });

    // 2. Always keep first msg + as many recent msgs as fit within token budget
    const first = stripped[0];
    const rest  = stripped.slice(1);
    const recent = [];
    let charCount = (typeof first?.content === 'string' ? first.content.length : 500);
    for (let i = rest.length - 1; i >= 0; i--) {
      if (recent.length >= TURN_LIMIT) break;
      const len = typeof rest[i].content === 'string' ? rest[i].content.length : 500;
      if (charCount + len > MAX_HISTORY_CHARS) break;
      recent.unshift(rest[i]);
      charCount += len;
    }
    const trimmed = first ? [first, ...recent] : recent;
    allMessages.push(...trimmed);
    console.log(`[chat] context: ${trimmed.length}/${messages.length} msgs, ~${charCount} chars (sys: ${systemPrompt.length}ch)`);

    // Fetch Figma MCP tools and inject layout knowledge if requested
    let mcpTools;
    if (useFigmaMCP) {
      try { mcpTools = await figmaMCP.getTools(); } catch (_) {
        // Fallback: always expose figma_execute even when port-3845 is unavailable
        mcpTools = [FigmaMCPClient.FIGMA_EXECUTE_TOOL];
      }
    }

    // Load agent tools if an agent is active
    let agentToolHandlers = null; // Map<name, executeFn>
    if (agentName) {
      const safeAgentName = agentName.replace(/[^a-zA-Z0-9_-]/g, '');
      const agentDir = path.join(AGENTS_DIR, safeAgentName);
      const manifestPath = path.join(agentDir, 'agent.json');
      let manifest = null;

      // Try to load installed agent manifest
      if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
      }

      // For built-in agents, use the permissions from the request body
      const permissions = manifest?.permissions || req.body.agentPermissions || {};
      const effectiveManifest = manifest || { name: safeAgentName, permissions };

      const { definitions: agentToolDefs, handlers } = getAgentTools(
        fs.existsSync(agentDir) ? agentDir : null,
        effectiveManifest,
        safeAgentName
      );
      agentToolHandlers = handlers;

      // Merge agent tools with MCP tools
      const allTools = [...(mcpTools || []), ...agentToolDefs];
      if (allTools.length) mcpTools = allTools;

      // Start any MCP servers the agent requires
      if (effectiveManifest.permissions?.mcp?.length) {
        try { await startAgentMCPServers(effectiveManifest, safeAgentName); } catch (_) {}
      }

      console.log(`[chat] Agent "${safeAgentName}" active — ${agentToolDefs.length} tools registered`);
    }

    // ── Self-tools — LLM-callable tools (memory, models, settings, etc.) ──
    const selfToolContext = {
      getModels: () => FALLBACK_MODELS,
      getSettings: () => ({
        model,
        thinkingBudget,
        maxContextTurns,
        figmaMCPEnabled: useFigmaMCP,
        factsCount: factsGetStats().total,
      }),
      sendToRenderer: (channel, data) => {
        try {
          const wins = _ElectronBrowserWindow?.getAllWindows?.() || [];
          for (const w of wins) w.webContents?.send?.(channel, data);
        } catch (_) {}
      },
      sendNotification: (title, body) => {
        try {
          const { Notification: ElectronNotification } = _require('electron');
          new ElectronNotification({ title, body }).show();
        } catch (_) {
          console.log(`[notification] ${title}: ${body}`);
        }
      },
    };
    mcpTools = [...(mcpTools || []), ...SELF_TOOL_DEFS];

    // Agentic loop — re-runs if model calls tools (max 12 iterations)
    let continueLoop = true;
    let toolCallCount = 0;
    let continueCount = 0; // track auto-continue on length finish
    const MAX_TOOL_CALLS = 50;
    const MAX_CONTINUES = 6; // max auto-continue attempts for truncated output
    const MAX_RESULT_CHARS = 40000; // prevent context overflow from large tool responses
    const toolCallsSeen = new Map(); // deduplicate identical calls

    // ── Tool guard — pre-call checks, category limits, browser discipline ──
    const toolGuard = new ToolGuardContext({
      send,
      onPermissionRequest: async (toolName, args, info) => {
        // For now, send SSE event and auto-allow (Phase 2 will add interactive prompt)
        send({ type: 'tool_permission_request', name: toolName, args, label: info.label, category: info.category });
        return 'allow';
      },
    });

    while (continueLoop) {
      if (res.writableEnded) break;

      // o-series and gpt-5+ models require max_completion_tokens instead of max_tokens
      const useCompletionTokens = /^(o[1-9]|gpt-5)/.test(model);
      const params = { model, messages: allMessages, stream: true };
      // Claude models support much larger outputs — use 32K to avoid truncating artifacts
      const defaultMaxTokens = model.includes('claude') ? 32768 : 16384;
      if (useCompletionTokens) { params.max_completion_tokens = defaultMaxTokens; }
      else { params.max_tokens = defaultMaxTokens; }

      // Thinking budget — Claude models use `thinking`, o-series use `reasoning_effort`
      if (thinkingBudget !== 'off') {
        const budgetTokens = { low: 1024, medium: 5000, high: 10000, max: 32000 }[thinkingBudget] || 10000;
        if (model.includes('claude')) {
          params.thinking = { type: 'enabled', budget_tokens: budgetTokens };
          const minTokens = budgetTokens + 4000;
          if (useCompletionTokens) { params.max_completion_tokens = Math.max(params.max_completion_tokens, minTokens); }
          else { params.max_tokens = Math.max(params.max_tokens, minTokens); }
        } else if (/^o[1-9]/.test(model)) {
          params.reasoning_effort = thinkingBudget === 'max' ? 'high' : thinkingBudget === 'low' ? 'low' : 'medium';
        }
      }

      if (mcpTools?.length) params.tools = mcpTools;
      params.stream_options = { include_usage: true };

      let stream;
      try {
        stream = await client.chat.completions.create(params);
      } catch (apiErr) {
        // Auto-recover: if max_tokens is unsupported, switch to max_completion_tokens
        if (apiErr.message?.includes('max_tokens') && params.max_tokens) {
          params.max_completion_tokens = params.max_tokens;
          delete params.max_tokens;
          stream = await client.chat.completions.create(params);
        } else {
          throw apiErr;
        }
      }

      const pendingCalls = [];
      let finishReason = null;
      let assistantText = '';
      let streamUsage = null;

      let reasoningText  = '';
      let reasoningStart = null;

      for await (const chunk of stream) {
        if (res.writableEnded) { continueLoop = false; break; }
        if (chunk.usage) streamUsage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
        if (!delta) continue;

        // ── Claude extended thinking blocks ────────────────────────────────
        // Anthropic returns thinking as content array items with type='thinking'
        if (Array.isArray(delta.content)) {
          for (const block of delta.content) {
            if (block.type === 'thinking' && block.thinking) {
              if (reasoningStart === null) reasoningStart = Date.now();
              reasoningText += block.thinking;
              send({ type: 'reasoning', text: block.thinking, accumulated: reasoningText });
            } else if (block.type === 'text' && block.text) {
              assistantText += block.text;
              send({ type: 'content', content: block.text });
            }
          }
        }

        // ── Standard text delta ────────────────────────────────────────────
        if (typeof delta.content === 'string' && delta.content) {
          assistantText += delta.content;
          send({ type: 'content', content: delta.content });
        }

        // ── o-series reasoning summary delta ──────────────────────────────
        if (delta.reasoning_content) {
          if (reasoningStart === null) reasoningStart = Date.now();
          reasoningText += delta.reasoning_content;
          send({ type: 'reasoning', text: delta.reasoning_content, accumulated: reasoningText });
        }

        // ── Tool call accumulation ─────────────────────────────────────────
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!pendingCalls[i]) pendingCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) pendingCalls[i].id += tc.id;
            if (tc.function?.name) pendingCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) pendingCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }

      if (finishReason === 'tool_calls' && pendingCalls.length > 0) {
        const calls = pendingCalls.filter(tc => tc && tc.function?.name);
        if (!calls.length) { send({ type: 'done', finish_reason: finishReason }); continueLoop = false; break; }
        allMessages.push({ role: 'assistant', tool_calls: calls });
        for (const tc of calls) {
          const toolName = tc.function.name;
          const callKey  = toolName + '|' + tc.function.arguments;
          toolCallCount++;

          // Hard stop: too many tool calls (legacy global limit as safety net)
          if (toolCallCount > MAX_TOOL_CALLS) {
            allMessages.push({ role: 'tool', tool_call_id: tc.id, content: 'Tool call limit reached (' + MAX_TOOL_CALLS + '). Summarize what you have done so far and tell the user to continue the task in a follow-up message if needed.' });
            continue;
          }

          // Deduplicate: same tool + same args already called
          if (toolCallsSeen.has(callKey)) {
            allMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolCallsSeen.get(callKey) });
            continue;
          }

          // ── Pre-tool-call guard ─────────────────────────────────────────
          const args = JSON.parse(tc.function.arguments || '{}');
          const guardResult = await toolGuard.check(toolName, args);

          if (guardResult.action === 'deny') {
            allMessages.push({ role: 'tool', tool_call_id: tc.id, content: guardResult.reason });
            continue;
          }

          // inject_snapshot: force a browser snapshot before the blind action
          if (guardResult.action === 'inject_snapshot') {
            send({ type: 'tool_call', name: 'browser_snapshot', label: 'Taking browser snapshot (auto)' });
            try {
              let snapClient = await _getPlaywrightMcpClient();
              let snapResult;
              try {
                snapResult = await snapClient.callTool({ name: 'browser_snapshot', arguments: {} });
              } catch (connErr) {
                // Auto-reconnect once if the subprocess died
                if (/closed|disconnect|EPIPE|EOF/i.test(connErr.message)) {
                  _playwrightMcpClient = null;
                  snapClient = await _getPlaywrightMcpClient();
                  snapResult = await snapClient.callTool({ name: 'browser_snapshot', arguments: {} });
                } else { throw connErr; }
              }
              const snapContent = Array.isArray(snapResult?.content)
                ? snapResult.content.map(c => c.text || '').join('\n')
                : JSON.stringify(snapResult);
              // Insert snapshot as a separate tool message so the model sees it
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: '[Auto-snapshot before ' + toolName + ']\n' + snapContent.slice(0, MAX_RESULT_CHARS) });
              toolGuard.resetBrowserRate();
              // The original tool call is consumed — model will re-decide after seeing the snapshot
              continue;
            } catch (snapErr) {
              // Snapshot failed — allow the original action to proceed
              console.log('[tool-guard] auto-snapshot failed:', snapErr.message);
            }
          }

          // Send human-readable tool status to the client
          const toolLabel = formatToolLabel(toolName, args);
          send({ type: 'tool_call', name: toolName, label: toolLabel });

          try {
            let result;

            // Route to self-tools first (memory, models, settings, etc.)
            if (isSelfTool(toolName)) {
              result = executeSelfTool(toolName, args, selfToolContext);
            }
            // Route to agent tool handler if available, otherwise Figma MCP
            else if (agentToolHandlers?.has(toolName)) {
              console.log(`[chat] Agent tool: ${toolName}`);
              result = await agentToolHandlers.get(toolName)(args);
            } else {
              figmaLog('🔧 ' + toolName + (toolName === 'figma_execute' ? ': ' + (args.code || '').slice(0, 80).replace(/\n/g,' ') + '…' : ''), 'cmd');
              result = await figmaMCP.callTool(toolName, args);
              figmaLog('✓ ' + toolName + ' done', 'ok');
            }

            // Truncate oversized results (screenshots, large contexts)
            if (typeof result === 'string' && result.length > MAX_RESULT_CHARS) {
              result = result.slice(0, MAX_RESULT_CHARS) + `\n\n[Truncated — ${result.length} chars total]`;
            }
            toolCallsSeen.set(callKey, result);
            allMessages.push({ role: 'tool', tool_call_id: tc.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
          } catch (e) {
            allMessages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${e.message}` });
            figmaLog('✗ ' + toolName + ': ' + e.message, 'err');
          }
        }
        if (continueLoop) { /* loop continues to get next AI response */ }
        else { send({ type: 'done', finish_reason: 'tool_limit' }); }
      } else if (finishReason === 'length' && continueCount < MAX_CONTINUES) {
        // Model hit token limit mid-output — auto-continue so the response finishes seamlessly
        continueCount++;
        console.log('[chat] finish_reason=length — auto-continuing (' + assistantText.length + ' chars so far, attempt ' + continueCount + '/' + MAX_CONTINUES + ')');
        allMessages.push({ role: 'assistant', content: assistantText });
        allMessages.push({ role: 'user', content: 'Your previous response was cut off mid-output. Continue EXACTLY where you left off — do NOT repeat anything already written. Do NOT narrate or explain, just output the remaining content.' });
        // keep continueLoop = true
      } else {
        // If tools were called but no text was produced, prompt a summary so the user sees something
        if (toolCallCount > 0 && !assistantText.trim() && continueCount < MAX_CONTINUES) {
          continueCount++;
          console.log('[chat] tool calls completed but no text output — prompting summary');
          allMessages.push({ role: 'assistant', content: '' });
          allMessages.push({ role: 'user', content: '[System: Your tool calls completed but you produced no visible response. Briefly summarize what you did for the user.]' });
          // keep continueLoop = true
        } else {
          send({ type: 'done', finish_reason: finishReason, usage: streamUsage || null,
            reasoning: reasoningText ? { text: reasoningText, durationSeconds: reasoningStart ? Math.round((Date.now() - reasoningStart) / 1000) : null } : null
          });
          continueLoop = false;
        }
      }
    }
  } catch (err) {
    send({ type: 'error', error: err.message });
  }

  if (!res.writableEnded) res.end();
});

// ── Git Repo Discovery ────────────────────────────────────────────────────
// Find recently-used git repos on the system (for slash commands in a chat-first app)
app.get('/api/git/repos', (req, res) => {
  const home = os.homedir();
  // Search common dev directories for git repos (max depth 3, fast scan)
  const searchDirs = ['', '/Projects', '/Developer', '/repos', '/src', '/code', '/work', '/Documents', '/Desktop'].map(d => home + d);
  const repos = [];
  const seen = new Set();
  for (const base of searchDirs) {
    if (!fs.existsSync(base)) continue;
    try {
      // Depth 1: direct children with .git
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(base, e.name);
        if (seen.has(full)) continue;
        const gitDir = path.join(full, '.git');
        if (fs.existsSync(gitDir)) {
          seen.add(full);
          let branch = '';
          try { branch = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim().replace('ref: refs/heads/', ''); } catch (_) {}
          let mtime = 0;
          try { mtime = fs.statSync(gitDir).mtimeMs; } catch (_) {}
          repos.push({ path: full, name: e.name, branch, mtime });
        }
        // Depth 2: grandchildren
        try {
          const sub = fs.readdirSync(full, { withFileTypes: true });
          for (const s of sub) {
            if (!s.isDirectory() || s.name.startsWith('.') || s.name === 'node_modules') continue;
            const sfull = path.join(full, s.name);
            if (seen.has(sfull)) continue;
            if (fs.existsSync(path.join(sfull, '.git'))) {
              seen.add(sfull);
              let sbranch = '';
              try { sbranch = fs.readFileSync(path.join(sfull, '.git', 'HEAD'), 'utf8').trim().replace('ref: refs/heads/', ''); } catch (_) {}
              let smtime = 0;
              try { smtime = fs.statSync(path.join(sfull, '.git')).mtimeMs; } catch (_) {}
              repos.push({ path: sfull, name: s.name, branch: sbranch, mtime: smtime });
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  // Sort by most recently modified .git dir
  repos.sort((a, b) => b.mtime - a.mtime);
  res.json({ repos: repos.slice(0, 30) });
});

// ── Git Smart Commit (Feature A) ──────────────────────────────────────────
// Detects repo convention, generates message from diff, commits.
app.post('/api/git/commit', async (req, res) => {
  const { cwd, amend = false, stageAll = false } = req.body;
  const workDir = cwd || os.homedir();
  const run = (cmd) => new Promise((resolve, reject) => {
    _exec(cmd, { cwd: workDir, env: { ...process.env, PATH: AUGMENTED_PATH }, timeout: 30000, maxBuffer: 5 * 1024 * 1024, shell: SHELL_BIN },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', exitCode: err?.code ?? 0 }));
  });

  try {
    // 1. Check status
    const status = await run('git status --porcelain');
    if (!status.stdout.trim() && !amend) return res.json({ ok: false, error: 'Nothing to commit — working tree clean.' });

    // 2. Stage if needed
    const staged = await run('git diff --cached --name-only');
    if (!staged.stdout.trim()) {
      if (stageAll || !staged.stdout.trim()) await run('git add -A');
      const recheck = await run('git diff --cached --name-only');
      if (!recheck.stdout.trim()) return res.json({ ok: false, error: 'No changes to commit after staging.' });
    }

    // 3. Detect convention from recent commits
    const recentLog = await run('git log --oneline -20 2>/dev/null');
    const userLog = await run('git log --oneline --author="$(git config user.name)" -10 2>/dev/null');

    // 4. Get diff
    const diffStat = await run('git diff --cached --stat');
    const diff = await run('git diff --cached');
    const diffText = diff.stdout.slice(0, 8000); // cap for LLM context

    // 5. Generate commit message via LLM
    const client = getCopilotClient();
    const conventionHint = detectCommitConvention(recentLog.stdout);
    const genMessages = [
      { role: 'system', content: `You are an expert at writing concise, meaningful git commit messages. Analyse the diff and write a commit message following the repository's convention.\n\nConvention detected: ${conventionHint}\n\nRules:\n- Subject line ≤ 72 chars, follow the convention\n- Optional body explains WHY, not a file-by-file inventory\n- Reference issue/ticket numbers from branch names when visible\n- Output ONLY the commit message (subject + optional body separated by blank line). No markdown, no fencing, no explanation.` },
      { role: 'user', content: `Recent commits:\n${recentLog.stdout.slice(0, 1500)}\n\nUser commits:\n${userLog.stdout.slice(0, 1000)}\n\nDiff stat:\n${diffStat.stdout}\n\nDiff:\n${diffText}` }
    ];
    const completion = await client.chat.completions.create({ model: 'gpt-4.1-mini', messages: genMessages, max_tokens: 300, stream: false });
    let commitMsg = (completion.choices[0]?.message?.content || '').trim();
    if (!commitMsg) return res.json({ ok: false, error: 'LLM returned empty commit message.' });

    // Clean quotes if wrapped
    if (commitMsg.startsWith('"') && commitMsg.endsWith('"')) commitMsg = commitMsg.slice(1, -1);

    // 6. Commit
    const msgParts = commitMsg.split(/\n\n/);
    const subject = msgParts[0];
    const body = msgParts.slice(1).join('\n\n');
    let commitCmd = `git commit -m ${JSON.stringify(subject)}`;
    if (body) commitCmd += ` -m ${JSON.stringify(body)}`;
    if (amend) commitCmd += ' --amend';
    const commitResult = await run(commitCmd);

    // 7. Verify
    const verify = await run('git log --oneline -1');
    res.json({
      ok: commitResult.ok,
      message: commitMsg,
      commitHash: verify.stdout.trim().split(' ')[0],
      output: commitResult.stdout + commitResult.stderr,
      convention: conventionHint,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function detectCommitConvention(logOutput) {
  const lines = (logOutput || '').split('\n').filter(Boolean);
  const conventional = lines.filter(l => /^[a-f0-9]+ (feat|fix|chore|docs|style|refactor|test|perf|ci|build|revert)(\(.+\))?:/.test(l));
  if (conventional.length > lines.length * 0.4) return 'Conventional Commits (type(scope): subject)';
  const gitmoji = lines.filter(l => /^[a-f0-9]+ [\u{1F300}-\u{1FAD6}:]/u.test(l));
  if (gitmoji.length > lines.length * 0.3) return 'Gitmoji';
  const ticketed = lines.filter(l => /^[a-f0-9]+ \[?[A-Z]+-\d+\]?/.test(l));
  if (ticketed.length > lines.length * 0.3) return 'Ticket-prefixed (e.g. PROJ-123)';
  return 'Free-form (imperative mood, capitalize first word)';
}

// ── Git Branch Name Generation (Feature G) ────────────────────────────────
app.post('/api/git/branch-name', async (req, res) => {
  const { description, cwd } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });
  try {
    const client = getCopilotClient();
    const completion = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'You are an expert in crafting pithy branch names for Git repos. Given a task description, reply with ONLY a brief branch name (8-50 chars, lowercase, alphanumeric + hyphens only). No quotes, no explanation.' },
        { role: 'user', content: description }
      ],
      max_tokens: 60,
      stream: false,
    });
    let name = (completion.choices[0]?.message?.content || '').trim().replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
    if (name.length < 4) name = 'feature-' + name;
    if (name.length > 50) name = name.slice(0, 50);

    // Optionally create the branch
    if (req.body.create && cwd) {
      const result = await new Promise((resolve) => {
        _exec(`git checkout -b ${name}`, { cwd, env: { ...process.env, PATH: AUGMENTED_PATH }, shell: SHELL_BIN },
          (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr }));
      });
      return res.json({ ok: result.ok, name, created: result.ok, output: result.stdout + result.stderr });
    }

    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Workspace Discovery (Feature C) ──────────────────────────────────────
// Scans a directory and returns project context (build commands, architecture, etc.)
// Core instruction-file helpers live in lib/instruction-files.js (imported above).

app.post('/api/workspace/discover', async (req, res) => {
  const { cwd, includeInterop = true } = req.body;
  const workDir = cwd || os.homedir();
  const run = (cmd) => new Promise((resolve) => {
    _exec(cmd, { cwd: workDir, env: { ...process.env, PATH: AUGMENTED_PATH }, timeout: 15000, maxBuffer: 2 * 1024 * 1024, shell: SHELL_BIN },
      (err, stdout) => resolve(stdout?.trim() || ''));
  });

  try {
    const context = {};

    // Detect project type
    const files = await run('ls -1A 2>/dev/null | head -100');
    const fileList = files.split('\n');

    // Package managers / build systems
    if (fileList.includes('package.json')) {
      try {
        const pkg = JSON.parse(await run('cat package.json'));
        context.type = 'node';
        context.name = pkg.name;
        context.scripts = pkg.scripts || {};
        context.dependencies = Object.keys(pkg.dependencies || {}).length;
        context.devDependencies = Object.keys(pkg.devDependencies || {}).length;
        context.packageManager = pkg.packageManager || (fileList.includes('yarn.lock') ? 'yarn' : fileList.includes('pnpm-lock.yaml') ? 'pnpm' : 'npm');
      } catch (_) {}
    }
    if (fileList.includes('Cargo.toml')) context.type = 'rust';
    if (fileList.includes('go.mod')) context.type = 'go';
    if (fileList.includes('pyproject.toml') || fileList.includes('setup.py') || fileList.includes('requirements.txt')) context.type = 'python';
    if (fileList.includes('Makefile')) context.hasMakefile = true;
    if (fileList.includes('Dockerfile') || fileList.includes('docker-compose.yml')) context.hasDocker = true;
    if (fileList.includes('.github')) context.hasGitHub = true;

    // Git info
    const branch = await run('git rev-parse --abbrev-ref HEAD 2>/dev/null');
    if (branch) {
      context.git = { branch };
      context.git.remote = await run('git remote get-url origin 2>/dev/null');
      context.git.status = await run('git status --short 2>/dev/null');
      const commitCount = await run('git rev-list --count HEAD 2>/dev/null');
      context.git.commits = parseInt(commitCount) || 0;
    }

    // Existing conventions files
    const conventionFiles = [];
    for (const f of ['.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md', 'ARCHITECTURE.md']) {
      const exists = await run(`test -f "${f}" && echo 1 || echo 0`);
      if (exists === '1') conventionFiles.push(f);
    }
    context.conventionFiles = conventionFiles;
    context.instructionFiles = await loadInstructionFiles(workDir, run, { includeInterop, altConfigDir: CONFIG_DIR });

    // README excerpt
    const readme = await run('head -50 README.md 2>/dev/null');
    if (readme) context.readme = readme.slice(0, 2000);

    // Directory structure (top level)
    const tree = await run('find . -maxdepth 2 -type d -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/__pycache__/*" -not -path "*/.next/*" 2>/dev/null | sort | head -60');
    context.structure = tree;

    // Test framework detection
    if (context.type === 'node' && context.scripts) {
      const testScript = context.scripts.test || '';
      if (testScript.includes('jest')) context.testFramework = 'jest';
      else if (testScript.includes('vitest')) context.testFramework = 'vitest';
      else if (testScript.includes('mocha')) context.testFramework = 'mocha';
      else if (testScript.includes('playwright')) context.testFramework = 'playwright';
    }

    // Generate summary prompt for system injection
    const summary = generateWorkspaceSummary(context);
    context.summary = summary;

    res.json({ ok: true, context });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function generateWorkspaceSummary(ctx) {
  const parts = [];
  if (ctx.name) parts.push(`Project: ${ctx.name}`);
  if (ctx.type) parts.push(`Type: ${ctx.type}`);
  if (ctx.packageManager) parts.push(`Package manager: ${ctx.packageManager}`);
  if (ctx.git) {
    parts.push(`Git: branch=${ctx.git.branch}, ${ctx.git.commits} commits`);
    if (ctx.git.remote) parts.push(`Remote: ${ctx.git.remote}`);
    if (ctx.git.status) parts.push(`Uncommitted changes:\n${ctx.git.status}`);
  }
  if (ctx.scripts) {
    const important = ['dev', 'start', 'build', 'test', 'lint', 'format', 'deploy'];
    const found = important.filter(k => ctx.scripts[k]);
    if (found.length) parts.push(`Scripts: ${found.map(k => `${k}="${ctx.scripts[k]}"`).join(', ')}`);
  }
  if (ctx.testFramework) parts.push(`Test framework: ${ctx.testFramework}`);
  if (ctx.hasMakefile) parts.push('Has Makefile');
  if (ctx.hasDocker) parts.push('Has Docker config');
  if (ctx.conventionFiles.length) parts.push(`Convention files: ${ctx.conventionFiles.join(', ')}`);
  if (ctx.instructionFiles?.length) {
    parts.push(`Instruction files loaded: ${ctx.instructionFiles.map(f => f.path + (f.truncated ? ' (truncated)' : '')).join(', ')}`);
  }
  return parts.join('\n');
}

app.post('/api/chat/debug-prompt', (req, res) => {
  const { systemPrompt = '', contextSummary = '', clientContext = 'app', noTools = false, promptLayers } = req.body || {};

  // ── Layer-inspection mode (called by /debug-prompt slash command) ──────
  // Client sends an array of named prompt layers; we return a per-layer
  // breakdown with char counts, truncation flags, and final order so users
  // can verify which instruction files were included without calling the model.
  if (Array.isArray(promptLayers)) {
    const layers = promptLayers.map((l, i) => ({
      order: i + 1,
      name: l.name || `layer-${i + 1}`,
      source: l.source || l.name || '',
      chars: (l.content || '').length,
      truncated: l.truncated || false,
      included: (l.content || '').length > 0,
    }));
    const totalChars = layers.reduce((sum, l) => sum + l.chars, 0);
    return res.json({ ok: true, mode: 'layers', layers, totalChars });
  }

  // ── Legacy single-system-prompt mode ──────────────────────────────────
  const isCLI = clientContext === 'cli';
  const cliHint = isCLI ? `\n\n## Output Format
You are running in a terminal CLI. Respond in plain, readable text. Do NOT use markdown headers (###), horizontal rules (---), or emojis. Use plain bullet points (- or *) only when a list genuinely helps. Be concise and direct. Never emit browser-action or browser-ext-action code blocks — those do not work in the terminal.` : '';
  const sections = [
    { name: 'client system prompt', content: systemPrompt.trim() + cliHint },
    { name: 'browser build context', content: noTools || isCLI ? '' : BROWSER_BUILD_CONTEXT },
    { name: 'task context summary', content: contextSummary ? `\n## Task Context (auto-summarized from earlier conversation)\n${contextSummary}` : '' },
  ].filter(s => s.content);
  const fullSystem = sections.map(s => s.content).join('\n');
  res.json({
    ok: true,
    mode: 'legacy',
    sections: sections.map(s => ({ name: s.name, chars: s.content.length })),
    chars: fullSystem.length,
    systemPrompt: fullSystem,
  });
});

// ── File Filter / Indexing (Feature E) ────────────────────────────────────
// Returns whether a file should be indexed/read (excludes binaries, junk, etc.)
const EXCLUDED_EXTENSIONS = new Set([
  'jpg','jpeg','jpe','png','gif','bmp','tif','tiff','tga','ico','icns','xpm','webp','svg','eps',
  'heif','heic','raw','arw','cr2','cr3','nef','nrw','orf','raf','rw2','rwl','pef','srw','x3f',
  'erf','kdc','3fr','mef','mrw','iiq','gpr','dng',
  'mp4','m4v','mkv','webm','mov','avi','wmv','flv',
  'mp3','wav','m4a','flac','ogg','wma','weba','aac','pcm',
  '7z','bz2','gz','tgz','rar','tar','xz','zip','vsix','iso','img','pkg',
  'woff','woff2','otf','ttf','eot',
  'obj','fbx','stl','3ds','dae','blend','ply','glb','gltf','max','c4d','ma','mb','pcd',
  'pdf','ai','ps','indd','doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','rtf',
  'psd','pbix',
  'exe','db','db-wal','db-shm','sqlite','parquet','bin','dat','data','hex',
  'cache','sum','hash','wasm','pdb','idb','sym','coverage','testlog',
  'pack','lock','log','trace','tlog','snap','msi','deb',
  'vsidx','suo','xcuserstate','download','map','tsbuildinfo','jsbundle',
  'dll','dylib','so','a','o','lib','out','elf','nupkg','winmd',
  'pyc','pkl','pickle','pyd','rlib','rmeta','dill',
  'jar','class','ear','war','apk','dex','phar',
  'pfx','p12','pem','crt','cer','key','priv','jks','keystore','csr',
]);

const EXCLUDED_DIRS = new Set([
  'node_modules', 'bower_components', '.git', '.svn', '.hg', '.yarn',
  'dist', 'out', 'build', '.next', '.nuxt', '.turbo', '.parcel-cache',
  '__pycache__', 'venv', '.venv', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
  'Pods', '.gradle', '.terraform', '.nyc_output',
  '.vscode-test', '.cache',
]);

const EXCLUDED_FILES = new Set([
  '.ds_store', 'thumbs.db', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);

const MAX_INDEXABLE_SIZE = 1.5 * 1024 * 1024; // 1.5 MB

function shouldIndexFile(filePath, statSize) {
  const base = path.basename(filePath).toLowerCase();
  if (EXCLUDED_FILES.has(base)) return false;
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  if (EXCLUDED_EXTENSIONS.has(ext)) return false;
  const parts = filePath.toLowerCase().split(path.sep);
  if (parts.some(p => EXCLUDED_DIRS.has(p))) return false;
  if (statSize !== undefined && statSize > MAX_INDEXABLE_SIZE) return false;
  return true;
}

app.post('/api/file-filter', (req, res) => {
  const { files } = req.body;
  if (!Array.isArray(files)) return res.status(400).json({ error: 'files array required' });
  const results = files.map(f => ({
    path: f.path || f,
    indexable: shouldIndexFile(f.path || f, f.size),
  }));
  res.json({ results });
});

// ── URL content fetcher ───────────────────────────────────────────────────

// Block SSRF: reject private/loopback/link-local IPs and non-http(s) schemes
function validateExternalUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch (_) { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http/https URLs allowed');
  const host = parsed.hostname.toLowerCase();
  const blocked = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'];
  if (blocked.includes(host)) throw new Error('Access to localhost is blocked');
  // Block private/link-local ranges by first octet
  if (/^(10|172\.(1[6-9]|2\d|3[01])|192\.168|169\.254)\./.test(host)) throw new Error('Access to private networks is blocked');
  return parsed.href;
}

app.post('/api/fetch-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const safeUrl = validateExternalUrl(url);
    const response = await fetch(safeUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CopilotChat/1.0)' },
      signal:  AbortSignal.timeout(12000),
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    let content, title = url;

    if (contentType.includes('application/json')) {
      const json = await response.json();
      content = JSON.stringify(json, null, 2);
      title   = `JSON from ${new URL(url).hostname}`;
    } else {
      const html = await response.text();
      // Extract title
      title   = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || url).trim().replace(/[<>"'`]/g, '');
      // Strip scripts, styles, nav, footer then HTML tags
      content = html
        .replace(/<script[\s\S]*?<\/script>/gi,   '')
        .replace(/<style[\s\S]*?<\/style>/gi,      '')
        .replace(/<nav[\s\S]*?<\/nav>/gi,          '')
        .replace(/<footer[\s\S]*?<\/footer>/gi,    '')
        .replace(/<header[\s\S]*?<\/header>/gi,    '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 20000);
    }

    res.json({ url, title, content, chars: content.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Browser (Playwright) — full JS-rendered page browsing ─────────────────
// Uses the installed Google Chrome to load pages with full JS execution,
// bypassing anti-bot measures that block simple fetch requests.
// Inspired by github.com/ntegrals/openbrowser (MIT).

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EDGE_PATH   = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const BROWSER_PATH = fs.existsSync(EDGE_PATH) ? EDGE_PATH : CHROME_PATH;
const EDGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.3856.62';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.153 Safari/537.36';
const BROWSE_UA = fs.existsSync(EDGE_PATH) ? EDGE_UA : CHROME_UA;
let _browserInstance = null;
let _browsePage = null;          // persistent reusable page (keeps cookies/session)
let _playwrightAvailable = null; // null = unchecked, true/false after first attempt
const _shellProcs = new Map();   // killId → ChildProcess (for user-initiated cancel)

async function getBrowser() {
  // If we already know playwright isn't available, fail fast
  if (_playwrightAvailable === false) throw new Error('playwright-core not available in this environment');

  // Reset stale/crashed instances
  if (_browserInstance) {
    try {
      if (!_browserInstance.isConnected()) _browserInstance = null;
    } catch { _browserInstance = null; }
  }

  if (_browserInstance) return _browserInstance;

  // Try puppeteer-extra + stealth first (best bot-detection bypass)
  try {
    const puppeteerExtra = _require('puppeteer-extra');
    const StealthPlugin   = _require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    // Use the real Edge user data dir so Akamai sees an established browser session with cookies/history
    const edgeUserDataDir = ISEDGE
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge')
      : null;
    const launchOpts = {
      executablePath: BROWSER_PATH,
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--window-size=1280,900',
        '--window-position=-2000,-2000',
        '--lang=en-US,en',
        '--profile-directory=Default',
      ],
    };
    if (edgeUserDataDir) launchOpts.userDataDir = edgeUserDataDir;
    _browserInstance = await puppeteerExtra.launch(launchOpts);
    _browserInstance._isPuppeteer = true;  // flag for browse endpoint
    _playwrightAvailable = true;
    return _browserInstance;
  } catch (pErr) {
    _browserInstance = null;
    // Fall through to playwright-core
  }

  try {
    const pw = await import('playwright-core');
    const chromium = pw.chromium || pw.default?.chromium;
    if (!chromium) throw new Error('playwright-core loaded but chromium not found — check module exports');
    _browserInstance = await chromium.launch({
      executablePath: BROWSER_PATH,
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--window-size=1280,900',
        '--window-position=-2000,-2000',
        '--lang=en-US,en',
        '--disable-web-security',
      ],
    });
    _playwrightAvailable = true;
    return _browserInstance;
  } catch (err) {
    _browserInstance = null;
    if (err.message.includes('playwright-core') || err.message.includes('Cannot find module')) {
      _playwrightAvailable = false;
    }
    throw err;
  }
}

const ISEDGE = fs.existsSync(EDGE_PATH);
const SEC_CH_UA = ISEDGE
  ? '"Microsoft Edge";v="146", "Chromium";v="146", "Not/A)Brand";v="24"'
  : '"Google Chrome";v="146", "Chromium";v="146", "Not/A)Brand";v="24"';

// Returns a persistent page that reuses cookies/session across browse calls.
async function getBrowsePage() {
  // Check if existing page is still usable
  if (_browsePage) {
    try {
      await _browsePage.evaluate(() => true);
      return _browsePage;
    } catch {
      _browsePage = null;
    }
  }

  const browser = await getBrowser();
  const isPuppeteer = !!browser._isPuppeteer;

  let page;
  if (isPuppeteer) {
    page = await browser.newPage();
    await page.setUserAgent(BROWSE_UA);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    });
  } else {
    const context = await browser.newContext({
      userAgent: BROWSE_UA,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': SEC_CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
      },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    page = await context.newPage();
  }

  _browsePage = page;
  return page;
}

const _warmedDomains = new Set(); // domains we've already visited the homepage for

async function navigateWithWarmup(page, url) {
  const origin = new URL(url).origin;
  const targetPath = new URL(url).pathname;
  const isHomepage = targetPath === '/' || targetPath === '';

  // If navigating to a deep page on a domain we haven't warmed up, visit homepage first
  if (!isHomepage && !_warmedDomains.has(origin)) {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    // Brief pause to let Akamai set session cookies
    await new Promise(r => setTimeout(r, 1500));
    _warmedDomains.add(origin);
  }

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!_warmedDomains.has(origin)) _warmedDomains.add(origin);
}

function htmlToMarkdown(html, baseUrl) {
  try {
    const TurndownService = _require('turndown');
    const td = new TurndownService({
      headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced'
    });
    td.remove(['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'svg', 'iframe']);
    // Make relative URLs absolute
    if (baseUrl) {
      html = html.replace(/href="([^"]+)"/g, (m, href) => {
        try { return `href="${new URL(href, baseUrl).href}"`; } catch { return m; }
      });
    }
    return td.turndown(html);
  } catch {
    // Fallback: strip tags
    return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
}

// Simple curl-based fallback when Playwright isn't available
async function fetchUrlFallback(url, maxChars = 12000) {
  return new Promise((resolve, reject) => {
    _execFile('curl', ['-sL', '--max-time', '15', '-A', BROWSE_UA, '--', url],
      { maxBuffer: 5 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const html = stdout || '';
        const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
        const content = htmlToMarkdown(html, url);
        resolve({ url, title, content: content.slice(0, maxChars), chars: content.length, fallback: true });
      }
    );
  });
}

app.get('/api/browse-check', async (req, res) => {
  const chromePath = BROWSER_PATH;
  const chromeExists = fs.existsSync(chromePath);
  let playwrightOk = false;
  let playwrightError = null;
  try {
    const pw = await import('playwright-core');
    playwrightOk = !!(pw.chromium || pw.default?.chromium);
  } catch (e) {
    playwrightError = e.message;
  }
  res.json({ chromeExists, chromeExePath: chromePath, playwrightOk, playwrightError });
});

app.post('/api/browse', async (req, res) => {
  const { url, action = 'extract', selector, text, waitFor, maxChars = 12000 } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  let page;
  try {
    page = await getBrowsePage();

    // Navigate with homepage warm-up for domains that use referrer-based bot protection
    await navigateWithWarmup(page, url);

    // Detect challenge page (Akamai "Powered and protected", Cloudflare "Just a moment")
    const isChallenge = async () => {
      const title = await page.title().catch(() => '');
      const body  = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '').catch(() => '');
      return title === '' || /access denied|just a moment|checking your browser|powered and protected|enable javascript/i.test(title + ' ' + body);
    };

    // If we landed on a challenge, wait for real content to appear (poll title + handle reloads)
    if (await isChallenge()) {
      await page.waitForFunction(
        () => {
          const t = document.title;
          if (!t) return false;
          return !/access denied|just a moment|checking your browser|powered and protected/i.test(t);
        },
        { timeout: 25000 }
      ).catch(() => {});
    }
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}

    if (waitFor) {
      try { await page.waitForSelector(waitFor, { timeout: 8000 }); } catch {}
    }

    let result = {};

    if (action === 'extract' || action === 'navigate') {
      const title   = await page.title();
      const pageUrl = page.url();
      const html    = await page.content();
      const md      = htmlToMarkdown(html, pageUrl);
      const stillBlocked = await isChallenge();
      result = { url: pageUrl, title, content: md.slice(0, maxChars), chars: md.length };
      if (stillBlocked) result.blocked = true;

    } else if (action === 'screenshot') {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      result = { url: page.url(), screenshot: buf.toString('base64'), mime: 'image/jpeg' };

    } else if (action === 'click') {
      await page.click(selector || text, { timeout: 5000 });
      const html = await page.content();
      result = { url: page.url(), content: htmlToMarkdown(html, page.url()).slice(0, maxChars) };

    } else if (action === 'type') {
      await page.fill(selector, text);
      result = { ok: true };

    } else if (action === 'eval') {
      const evalResult = await page.evaluate(text);
      result = { result: JSON.stringify(evalResult) };
    }

    try { await page.close(); } catch {}
    res.json(result);
  } catch (err) {
    if (page) { try { await page.close(); } catch {} }
    // Playwright failed — try curl fallback for extract actions
    if ((action === 'extract' || action === 'navigate') && _playwrightAvailable !== false) {
      try {
        const fallback = await fetchUrlFallback(url, maxChars);
        return res.json(fallback);
      } catch { /* fall through to error */ }
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Figma bridge ──────────────────────────────────────────────────────────
// Connects as a "controller" to the CopilotMCP WS relay at port 3335.
// When the Figma plugin (CopilotMCP/CopilotChat plugin in Figma desktop) is open,
// this bridge can execute arbitrary Figma Plugin API code and query design state.

const FIGMA_WS_URL     = 'ws://localhost:3335';
const FIGMA_RULES_FILE = path.join(CONFIG_DIR, 'figma-rules.json');
const DEFAULT_MCP_PATH = path.join(os.homedir(), 'FigmaExtensions', 'CopilotMCP', 'server', 'index.js');

// ── MCP server process management ────────────────────────────────────────

let mcpProcess    = null;
let mcpLogs       = [];       // last 200 stderr lines
let mcpAutoStart  = true;     // start with the app by default

function findNodeBinary() {
  const candidates = IS_WIN ? [
    'C:\\Program Files\\nodejs\\node.exe',
    path.join(os.homedir(), 'AppData', 'Roaming', 'nvm', 'current', 'node.exe'),
    path.join(os.homedir(), 'scoop', 'shims', 'node.exe'),
  ] : [
    '/opt/homebrew/bin/node',   // Apple Silicon Homebrew
    '/usr/local/bin/node',      // Intel Homebrew
    '/opt/homebrew/opt/node/bin/node',
    '/usr/bin/node',
    '/usr/local/bin/node',
  ];
  const binName = IS_WIN ? 'node.exe' : 'node';
  const pathDirs = (process.env.PATH || '').split(PATH_SEP);
  for (const dir of pathDirs) candidates.push(path.join(dir, binName));
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {}
  }
  return null;
}

function getMcpServerPath() {
  const cfg = readSavedConfig();
  const p = path.resolve(cfg.mcpServerPath || DEFAULT_MCP_PATH);
  // Only allow .js files under the user's home directory
  if (!p.endsWith('.js') || !p.startsWith(os.homedir())) {
    return DEFAULT_MCP_PATH;
  }
  return p;
}

function isMcpRunning() {
  return mcpProcess !== null && mcpProcess.exitCode === null;
}

function startMcpServer() {
  if (isMcpRunning()) return { ok: true, already: true };

  const serverPath = getMcpServerPath();
  if (!fs.existsSync(serverPath)) {
    return { ok: false, error: `MCP server not found at: ${serverPath}` };
  }

  const nodeBin = findNodeBinary();
  if (!nodeBin) return { ok: false, error: IS_WIN
    ? 'Node.js binary not found. Install Node.js from nodejs.org or via winget/scoop.'
    : 'Node.js binary not found. Install Node.js via Homebrew.' };

  mcpLogs = [];
  const serverDir = path.dirname(serverPath);

  const mcpEnvPATH = IS_WIN
    ? (process.env.PATH || '')
    : `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`;

  mcpProcess = spawn(nodeBin, [serverPath], {
    cwd: serverDir,
    stdio: ['ignore', 'ignore', 'pipe'],  // stdin/stdout ignored; capture stderr for logs
    env: { ...process.env, PATH: mcpEnvPATH }
  });

  mcpProcess.stderr.on('data', chunk => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      mcpLogs.push({ t: Date.now(), msg: line });
      if (mcpLogs.length > 200) mcpLogs.shift();
    }
  });

  mcpProcess.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    mcpLogs.push({ t: Date.now(), msg: `[App] MCP server exited (${reason})` });
    mcpProcess = null;
    // Auto-reconnect WS after brief delay (process may restart)
    figmaState.connected = false;
    figmaState.fileInfo  = null;
  });

  mcpProcess.on('error', err => {
    mcpLogs.push({ t: Date.now(), msg: `[App] Failed to start: ${err.message}` });
    mcpProcess = null;
  });

  // Reconnect WS bridge after server has had time to start
  setTimeout(() => {
    if (figmaState.pendingReconnect) clearTimeout(figmaState.pendingReconnect);
    figmaConnect();
  }, 1200);

  return { ok: true };
}

function stopMcpServer() {
  if (!isMcpRunning()) return { ok: true, already: true };
  mcpProcess.kill('SIGTERM');
  // Force-kill after 3 s if it hasn't exited
  setTimeout(() => { if (isMcpRunning()) mcpProcess.kill('SIGKILL'); }, 3000);
  return { ok: true };
}

// ── MCP server endpoints ──────────────────────────────────────────────────

app.get('/api/figma/mcp-status', (req, res) => {
  res.json({
    running: isMcpRunning(),
    pid:     mcpProcess?.pid ?? null,
    path:    getMcpServerPath(),
    logs:    mcpLogs.slice(-50),
  });
});

app.post('/api/figma/mcp-start', (req, res) => {
  const result = startMcpServer();
  res.json(result);
});

app.post('/api/figma/mcp-stop', (req, res) => {
  const result = stopMcpServer();
  res.json(result);
});

app.get('/api/figma/mcp-logs', (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  res.json(mcpLogs.filter(l => l.t > since));
});

// ── WS bridge fields ──────────────────────────────────────────────────────

let figmaWs      = null;
let figmaState   = { connected: false, fileInfo: null, activeSystem: null, pendingReconnect: null };
const figmaFiles   = new Map(); // fileKey → { fileName, fileKey, currentPage, currentPageId, timestamp }
const figmaPending = new Map(); // id → { resolve, reject, timer }

function readFigmaRules() {
  try { return JSON.parse(fs.readFileSync(FIGMA_RULES_FILE, 'utf8')); }
  catch (_) { return []; }
}
function writeFigmaRules(rules) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(FIGMA_RULES_FILE, JSON.stringify(rules, null, 2));
}

function figmaConnect() {
  if (figmaWs && figmaWs.readyState < 2) return; // already open or connecting
  try {
    const WS = _require('ws');
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
        // Track all connected Figma files
        if (msg.fileKey) {
          figmaFiles.set(msg.fileKey, { fileName: msg.fileName, fileKey: msg.fileKey, currentPage: msg.currentPage, currentPageId: msg.currentPageId, timestamp: Date.now() });
        }
      }
      // Plugin disconnected — remove from tracked files
      if (msg.type === 'plugin-disconnected' && msg.fileKey) {
        figmaFiles.delete(msg.fileKey);
      }
      if (msg.type === 'active-system') {
        figmaState.activeSystem = { id: msg.id, name: msg.name };
      }
      // Route execute-result back to waiting callers
      if (msg.id && figmaPending.has(msg.id)) {
        const { resolve, timer } = figmaPending.get(msg.id);
        clearTimeout(timer); figmaPending.delete(msg.id); resolve(msg);
      }
    });

    figmaWs.on('close', () => {
      figmaState.connected = false;
      figmaState.fileInfo  = null;
      figmaFiles.clear();
      // Immediately reject all in-flight requests so they don't hang for 30 s
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

// ── Figma progress logger ─────────────────────────────────────────────────
function figmaLog(message, level = 'info') {
  if (figmaWs && figmaWs.readyState === 1) {
    figmaWs.send(JSON.stringify({ type: 'progress-log', message, level }));
  }
}

// ── Figma Dev Mode MCP Client ─────────────────────────────────────────────
// Connects to Figma's built-in MCP server at http://127.0.0.1:3845/mcp
// Provides AI with design context, variables, screenshots, and more.

const FIGMA_MCP_URL = 'http://127.0.0.1:3845/mcp';

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
    // SSE: join all data: lines from the last event block
    // Multiple data: lines in one event are continuations (joined with \n)
    // Multiple events are separated by blank lines — we want the last one with JSON-RPC result
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

  // figma_execute is always available — independent of port-3845 (Figma Dev Mode MCP)
  static get FIGMA_EXECUTE_TOOL() {
    return {
      type: 'function',
      function: {
        name: 'figma_execute',
        description: 'Execute Figma Plugin API JavaScript code to CREATE, MODIFY, or DELETE nodes in the open Figma file. Use this instead of the REST API — no PAT required. The code runs inside the Figma plugin context and has full access to the figma object (figma.currentPage, figma.createFrame, figma.createText, etc). IMPORTANT: figma.getNodeById() returns null when the ID does not exist in the current file — ALWAYS null-check before accessing properties (e.g. `var node = figma.getNodeById(id); if (!node) return "Node not found"; ...`). When accessing .componentProperties or .componentPropertyDefinitions on any node, always wrap in try/catch (e.g. `let props; try { props = node.componentProperties || {}; } catch(_) { props = {}; }`) to avoid "Component set for node has existing errors" on broken components. When multiple Figma files are open, use the fileKey parameter to target a specific file.',
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
    // Always include figma_execute even if the Figma Dev Mode MCP (port 3845) is unreachable
    if (this.toolsCache) return this.toolsCache;
    try {
      if (!this.sessionId) await this.init();
      const r = await this._post({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 2 });
      this.toolsCache = (r.result?.tools || []).map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } }
      }));
      // Remove any figma_execute the remote server may have to avoid duplicates
      this.toolsCache = this.toolsCache.filter(t => t.function.name !== 'figma_execute');
    } catch (_) {
      // Port-3845 unavailable — serve figma_execute on its own
      this.toolsCache = [];
    }
    this.toolsCache.push(FigmaMCPClient.FIGMA_EXECUTE_TOOL);
    return this.toolsCache;
  }

  async callTool(name, args) {
    // figma_execute is a local tool — route through the port-3335 plugin relay
    if (name === 'figma_execute') {
      let code = args.code;
      const targetFileKey = args.fileKey || null;
      let result = await figmaSend({ type: 'execute-code', code }, 30000, targetFileKey);

      // Auto-recover from unloaded font errors: parse the fonts out of the error,
      // prepend loadFontAsync calls, and retry once.
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
    // Use shorter timeout for screenshot-type calls that tend to hang when targeting wrong file
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

app.get('/api/figma-mcp/status', async (req, res) => {
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

// ── Custom MCP Servers ─────────────────────────────────────────────────────
// Support for user-configured custom MCP servers (HTTP or stdio transport)

const CUSTOM_MCP_FILE = path.join(FAUNA_CONFIG_DIR, 'custom-mcp-servers.json');
const customMcpClients = new Map(); // serverId → HttpMcpClient instance
const customMcpProcesses = new Map(); // serverId → { process, logs }

class HttpMcpClient {
  constructor(url) {
    this.url = url;
    this.sessionId = null;
    this.toolsCache = null;
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
    
    // Find the message event with JSON data
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
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`Failed to initialize: ${resp.status} ${text}`);
    }
    const sid = resp.headers.get('mcp-session-id');
    if (!sid) throw new Error('No session ID returned from MCP server');
    this.sessionId = sid;
    
    // Parse SSE response
    const init = await this._parseSSE(resp);
    if (init.error) throw new Error(init.error.message || 'Initialize failed');
    
    // Request tools list
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
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': this.sessionId,
        'Accept': 'application/json, text/event-stream'
      },
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

function readCustomMcpServers() {
  if (!fs.existsSync(CUSTOM_MCP_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CUSTOM_MCP_FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

function writeCustomMcpServers(servers) {
  fs.mkdirSync(path.dirname(CUSTOM_MCP_FILE), { recursive: true });
  fs.writeFileSync(CUSTOM_MCP_FILE, JSON.stringify(servers, null, 2));
}

function addCustomMcpLog(serverId, severity, message) {
  const proc = customMcpProcesses.get(serverId);
  if (proc) {
    proc.logs.push({ t: Date.now(), s: severity, m: message });
    if (proc.logs.length > 200) proc.logs = proc.logs.slice(-200);
  }
}

// Auto-detection logic - checks for browser MCP at localhost:3341
let autoDetectPollTimer = null;
let faunaMcpBrowserConnected = false;  // true when FaunaMCP standalone is reachable
let faunaMcpConnectedAt = null;        // ISO timestamp when first detected
let bundledBrowserServerProc = null;   // spawned fallback process

async function probeBrowserMcp() {
  try {
    const resp = await fetch('http://localhost:3341/health', {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    });
    return resp.ok;
  } catch (_) {
    return false;
  }
}

async function autoDetectBrowserMcp() {
  const servers = readCustomMcpServers();
  const existing = servers.find(s => s.url === 'http://localhost:3341/mcp' || s.id === 'fauna-browser-mcp-auto');
  
  const available = await probeBrowserMcp();

  // Update the SSE-visible connected flag
  const wasConnected = faunaMcpBrowserConnected;
  faunaMcpBrowserConnected = available;
  if (available && !faunaMcpConnectedAt) faunaMcpConnectedAt = new Date().toISOString();
  if (!available) faunaMcpConnectedAt = null;

  // Broadcast a status-changed SSE when the connection state changes
  if (available !== wasConnected) {
    broadcastExtStatus();
  }

  if (!available) {
    faunaMcpRelayBrowsers = [];
    // Try to start the bundled browser server if not already running
    if (!bundledBrowserServerProc) {
      const bundledServer = path.join(__dirname, 'faunaMCP-main', 'browser-server', 'index.js');
      if (fs.existsSync(bundledServer)) {
        try {
          const nodeBin = findNodeBinary ? findNodeBinary() : process.execPath;
          if (nodeBin) {
            bundledBrowserServerProc = spawn(nodeBin, [bundledServer], {
              cwd: path.dirname(bundledServer),
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
    }
    return;
  }

  // Refresh the FaunaMCP relay browser list
  try {
    const statusResp = await fetch('http://localhost:3341/ext-status', { signal: AbortSignal.timeout(2000) });
    if (statusResp.ok) {
      const statusData = await statusResp.json();
      faunaMcpRelayBrowsers = (statusData.browsers || []).map(b => ({
        id: b.id,
        browser: b.browser,
        version: b.version || null,
        connectedAt: b.connectedAt || faunaMcpConnectedAt,
        activeTab: b.activeTab || null,
      }));
    }
  } catch (_) {}

  if (existing) return; // Already registered

  // Auto-add it
  const newServer = {
    id: 'fauna-browser-mcp-auto',
    name: 'Browser MCP (FaunaMCP)',
    transport: 'http',
    url: 'http://localhost:3341/mcp',
    autoDetected: true,
    running: false
  };
  servers.push(newServer);
  writeCustomMcpServers(servers);
  console.log('[custom-mcp] Auto-detected browser MCP at localhost:3341');
  
  // Auto-start it
  try {
    const client = new HttpMcpClient(newServer.url);
    await client.getTools();
    customMcpClients.set(newServer.id, client);
    newServer.running = true;
    writeCustomMcpServers(servers);
    console.log('[custom-mcp] Browser MCP auto-started');
  } catch (e) {
    console.error('[custom-mcp] Failed to auto-start browser MCP:', e.message);
  }
}

function startCustomMcpAutoDetection() {
  // Initial check
  autoDetectBrowserMcp().catch(() => {});
  
  // Poll every 10 seconds
  autoDetectPollTimer = setInterval(() => {
    autoDetectBrowserMcp().catch(() => {});
  }, 10000);
}

function stopCustomMcpAutoDetection() {
  if (autoDetectPollTimer) {
    clearInterval(autoDetectPollTimer);
    autoDetectPollTimer = null;
  }
  if (bundledBrowserServerProc) {
    try { bundledBrowserServerProc.kill(); } catch (_) {}
    bundledBrowserServerProc = null;
  }
}

// API routes for custom MCP servers

app.get('/api/custom-mcp-servers', (req, res) => {
  const servers = readCustomMcpServers();
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
    running: false
  };
  servers.push(newServer);
  writeCustomMcpServers(servers);
  res.status(201).json(newServer);
});

app.put('/api/custom-mcp-servers/:id', (req, res) => {
  const servers = readCustomMcpServers();
  const idx = servers.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Server not found' });
  
  const updated = { ...servers[idx], ...req.body, id: servers[idx].id };
  servers[idx] = updated;
  writeCustomMcpServers(servers);
  res.json(updated);
});

app.delete('/api/custom-mcp-servers/:id', (req, res) => {
  const servers = readCustomMcpServers();
  const server = servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  
  // Stop if running
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
  
  if (server.transport === 'http') {
    try {
      const client = new HttpMcpClient(server.url);
      await client.getTools();
      customMcpClients.set(server.id, client);
      server.running = true;
      writeCustomMcpServers(servers);
      res.json({ ok: true, transport: 'http' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else if (server.transport === 'stdio') {
    try {
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
  // Placeholder for OAuth status - not implemented yet
  res.json({ authorized: false });
});

app.post('/api/custom-mcp-servers/:id/refresh', async (req, res) => {
  // Refresh HTTP tools for an HTTP server
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

// Expose custom MCP tools to chat (integrate with agent tools)
async function getCustomMcpTools() {
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

async function callCustomMcpTool(toolName, args) {
  // Find which server has this tool
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

// Start trying to connect immediately when the server starts
// Also auto-start the MCP server if it's not already running
setTimeout(() => {
  if (mcpAutoStart) startMcpServer();
  else figmaConnect();
  // Start custom MCP auto-detection
  startCustomMcpAutoDetection();
  // Pre-warm Playwright MCP if available so it shows READY immediately
  (async () => {
    try {
      await import('@playwright/mcp');
      _playwrightMcpInstalled = true;
      await _getPlaywrightMcpClient();
      console.log('[playwright-mcp] pre-warmed on startup');
    } catch (_) {}
  })();
}, 500);  // slight delay so the main server is fully up first

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

app.post('/api/open-folder', async (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  try {
    const { shell } = _require('electron');
    await shell.openPath(folderPath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Window controls (Windows custom title bar) ───────────────────────────
app.post('/api/window/:action', (req, res) => {
  try {
    const { BrowserWindow } = _require('electron');
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) return res.status(404).json({ error: 'No window' });
    switch (req.params.action) {
      case 'minimize': win.minimize(); break;
      case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
      case 'close':    win.close(); break;
      default: return res.status(400).json({ error: 'Unknown action' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



const PLUGIN_INSTALL_DIR = path.join(CONFIG_DIR, 'figma-plugin');

function getBundledPluginDir() {
  // In packaged Electron app, extraResources land at process.resourcesPath/figma-plugin
  // In dev (node server.js), fall back to the local assets folder
  const packed = path.join(process.resourcesPath || '', 'figma-plugin');
  if (fs.existsSync(packed)) return packed;
  return path.join(__dirname, 'assets', 'figma-plugin');
}

app.get('/api/figma/plugin-info', (req, res) => {
  const installed = fs.existsSync(path.join(PLUGIN_INSTALL_DIR, 'manifest.json'));
  res.json({
    installed,
    installDir:   installed ? PLUGIN_INSTALL_DIR : null,
    bundledDir:   getBundledPluginDir(),
  });
});

app.post('/api/figma/plugin-install', (req, res) => {
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

app.post('/api/figma/plugin-download', (req, res) => {
  try {
    const src = getBundledPluginDir();
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Bundled plugin not found' });

    // Use osascript on macOS or PowerShell on Windows to open a folder picker
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
      // Windows fallback
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

// ── Figma API endpoints ───────────────────────────────────────────────────

app.get('/api/figma/status', (req, res) => {
  const figmaConnected = figmaState.connected && !!figmaState.fileInfo;
  res.json({
    relayConnected: figmaState.connected,
    figmaConnected,
    fileInfo:      figmaState.fileInfo,
    connectedFiles: [...figmaFiles.values()],
    activeSystem:  figmaState.activeSystem,
    mcpRunning:    isMcpRunning(),
    mcpPid:        mcpProcess?.pid ?? null,
  });
});

app.post('/api/figma/connect', (req, res) => {
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

// ── Figma Rules endpoints ─────────────────────────────────────────────────

app.get('/api/figma/rules', (req, res) => {
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
  const rules  = readFigmaRules();
  const idx    = rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  rules[idx]   = { ...rules[idx], ...req.body, id: rules[idx].id };
  writeFigmaRules(rules);
  res.json(rules[idx]);
});

app.delete('/api/figma/rules/:id', (req, res) => {
  const rules = readFigmaRules();
  const next  = rules.filter(r => r.id !== req.params.id);
  writeFigmaRules(next);
  res.json({ ok: true });
});

// ── Shell execution ───────────────────────────────────────────────────────
// Runs arbitrary shell commands and returns stdout/stderr/exit code.
// On macOS/Linux, PATH is augmented with Homebrew and common locations.
// On Windows, PowerShell is used as the default shell.

const AUGMENTED_PATH = IS_WIN
  ? (process.env.PATH || '')
  : [
      '/opt/homebrew/bin', '/opt/homebrew/sbin',
      '/usr/local/bin', '/usr/local/sbin',
      '/usr/bin', '/usr/sbin', '/bin', '/sbin',
      process.env.PATH || ''
    ].join(':');

const SHELL_BIN = IS_WIN ? 'powershell.exe' : '/bin/zsh';

// ── Permission decision endpoint (from inline chat prompt) ────────────────
app.post('/api/shell-permission', async (req, res) => {
  const { command, decision } = req.body;
  if (!command || !decision) return res.status(400).json({ error: 'command and decision required' });
  if (decision === 'auto-allow') {
    const firstWord = command.trim().split(/\s/)[0];
    addAutoAllow(firstWord);
  }
  res.json({ ok: true });
});

app.post('/api/shell-exec', async (req, res) => {
  const { command, cwd, killId, stream, bypassPermissions } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });

  // Permission guard — check if command is safe or requires approval
  if (!bypassPermissions && !isCommandSafe(command)) {
    // Get explanation and return it to the frontend for inline prompting
    let explanation = '';
    if (internalAICaller) {
      try { explanation = await explainCommand(command, internalAICaller); } catch (_) {}
    }
    return res.json({ permissionRequired: true, command, explanation });
  }

  const workDir = cwd || os.homedir();
  const env = {
    ...process.env,
    PATH: AUGMENTED_PATH,
    HOME: os.homedir(),
    USER: os.userInfo().username,
    ...(IS_WIN ? {} : { SHELL: '/bin/zsh', TERM: 'xterm-256color' }),
  };

  // Streaming mode - send SSE events as output arrives
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const child = spawn(SHELL_BIN, IS_WIN ? ['-Command', command] : ['-c', command], {
      cwd: workDir,
      env,
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        res.write(`data: ${JSON.stringify({ type: 'stdout', text })}\n\n`);
      });
    }
    
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        res.write(`data: ${JSON.stringify({ type: 'stderr', text })}\n\n`);
      });
    }
    
    child.on('exit', (code) => {
      if (killId) _shellProcs.delete(killId);
      res.write(`data: ${JSON.stringify({ type: 'exit', exitCode: code || 0 })}\n\n`);
      res.end();
    });
    
    child.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    });
    
    if (killId) _shellProcs.set(killId, child);
    return;
  }

  // Non-streaming mode - wait for completion and return JSON
  const child = _exec(command, { cwd: workDir, env, timeout: 300000, maxBuffer: 10 * 1024 * 1024, shell: SHELL_BIN },
    (err, stdout, stderr) => {
      if (killId) _shellProcs.delete(killId);
      if (err?.killed && !stdout && !stderr) {
        return res.json({ ok: false, exitCode: 130, stdout: '', stderr: 'Process killed by user', command, cwd: workDir, killed: true });
      }
      res.json({
        ok:       !err || err.killed === false && (err.code === 0 || stdout),
        exitCode: err?.code ?? 0,
        stdout:   stdout || '',
        stderr:   stderr || '',
        command,
        cwd: workDir,
      });
    }
  );
  if (killId) _shellProcs.set(killId, child);
});

app.post('/api/shell-kill', (req, res) => {
  const { killId } = req.body;
  if (!killId) return res.status(400).json({ error: 'killId required' });
  const child = _shellProcs.get(killId);
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    _shellProcs.delete(killId);
    res.json({ ok: true });
  } else {
    res.json({ ok: false, error: 'process not found or already done' });
  }
});

// ── Write file (no shell / no truncation) ─────────────────────────────────
// VS Code lesson: bypass shell entirely — put content in the HTTP body (20 MB limit).
// Use this instead of shell heredocs which truncate at ~16 KB.
// POST { path, content, encoding? }          → write content string to path
// POST { path, fromFile }                    → copy fromFile to path (avoids JSON quoting)
// Resolve a file path: absolute → as-is, ~/... → home expansion, relative → homedir join
function resolvePath(filePath, cwd) {
  let resolved;
  if (filePath.startsWith('/')) resolved = filePath;
  else if (filePath.startsWith('~/')) resolved = filePath.replace(/^~/, os.homedir());
  else if (cwd) resolved = path.join(cwd.replace(/^~/, os.homedir()), filePath);
  else resolved = path.join(os.homedir(), filePath);
  // Normalise to prevent directory traversal via embedded ../ segments
  resolved = path.resolve(resolved);
  const home = os.homedir();
  if (!resolved.startsWith(home) && !resolved.startsWith('/tmp')) {
    throw new Error('Path outside allowed directories');
  }
  return resolved;
}

function getMutationContext(body = {}) {
  const agentName = body.agentName;
  if (!agentName) return null;
  const manifest = getAgentManifest(agentName);
  return {
    agentName,
    permissions: manifest?.permissions || body.permissions || {},
  };
}

function assertWriteAllowed(absPath, context) {
  if (!context) return;
  const writeCheck = checkFilePath(absPath, 'write', context.permissions, context.agentName);
  if (!writeCheck.allowed) {
    const err = new Error(writeCheck.reason);
    err.statusCode = 403;
    err.blocked = true;
    throw err;
  }
}

function atomicWriteFile(absPath, content, encoding = 'utf8') {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = absPath + '.~tmp' + process.pid;
  try {
    fs.writeFileSync(tmp, content, encoding);
    fs.renameSync(tmp, absPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function sendMutationError(res, e) {
  const status = e.statusCode || (e.blocked ? 403 : 500);
  res.status(status).json({ ok: false, error: e.message, blocked: !!e.blocked });
}

// ── AutoRecovery — Word-style checkpoint before every destructive write ───
// Saves the current version to ~/.copilotchat-recovery/<mirrored-path>/<ts>.bak
// Keeps the 20 most-recent checkpoints per file; never throws (best-effort).
function checkpointFile(abs) {
  if (!fs.existsSync(abs)) return null;
  try {
    // Mirror the absolute path inside RECOVERY_DIR so each file has its own dir
    const rel       = abs.replace(/^[/\\]/, '').replace(/\\/g, '/');
    const mirrorDir = path.join(RECOVERY_DIR, rel);
    fs.mkdirSync(mirrorDir, { recursive: true });
    const ts   = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const dest = path.join(mirrorDir, ts + '.bak');
    fs.copyFileSync(abs, dest);
    // Prune: keep only the 20 most-recent checkpoints
    const all = fs.readdirSync(mirrorDir).filter(f => f.endsWith('.bak')).sort();
    if (all.length > 20) {
      for (const old of all.slice(0, all.length - 20)) {
        try { fs.unlinkSync(path.join(mirrorDir, old)); } catch (_) {}
      }
    }
    return dest;
  } catch (_) {
    return null; // checkpoint failure must never break the actual write
  }
}

app.post('/api/write-file', (req, res) => {
  const { path: filePath, content, fromFile, encoding, cwd } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const context = getMutationContext(req.body);
    const abs = resolvePath(filePath, cwd);
    assertWriteAllowed(abs, context);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fromFile) {
      fs.copyFileSync(fromFile, abs);
      const bytes = fs.statSync(abs).size;
      res.json({ ok: true, path: abs, bytes, sandboxed: !!context });
    } else {
      if (content === undefined) return res.status(400).json({ error: 'content or fromFile required' });
      // Checkpoint the existing file before overwriting (AutoRecovery)
      checkpointFile(abs);
      atomicWriteFile(abs, content, encoding || 'utf8');
      res.json({ ok: true, path: abs, bytes: Buffer.byteLength(content, encoding || 'utf8'), sandboxed: !!context });
    }
  } catch (e) {
    sendMutationError(res, e);
  }
});

// ── Stream-write large files — bypasses the JSON body limit entirely ───────
// PUT /api/write-file-stream?path=<encoded>&cwd=<encoded>
// Body: raw file bytes (any content-type). Writes atomically via tmp+rename.
app.put('/api/write-file-stream', (req, res) => {
  const filePath = req.query.path;
  const cwd      = req.query.cwd;
  if (!filePath) return res.status(400).json({ error: 'path query param required' });
  try {
    const context = getMutationContext(req.query);
    const abs = resolvePath(filePath, cwd);
    assertWriteAllowed(abs, context);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.~tmp' + process.pid;
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => {
      try {
        fs.renameSync(tmp, abs);
        res.json({ ok: true, path: abs, bytes: fs.statSync(abs).size });
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        res.status(500).json({ error: e.message });
      }
    });
    out.on('error', e => { try { fs.unlinkSync(tmp); } catch (_) {} res.status(500).json({ error: e.message }); });
    req.on('error', e => { try { fs.unlinkSync(tmp); } catch (_) {} res.status(500).json({ error: e.message }); });
  } catch (e) {
    sendMutationError(res, e);
  }
});

// ── Append to file ────────────────────────────────────────────────────────
// POST { path, content, encoding?, cwd? } → { ok, path, bytes }
app.post('/api/append-file', (req, res) => {
  const { path: filePath, content, encoding, cwd } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  if (content === undefined) return res.status(400).json({ error: 'content required' });
  try {
    const context = getMutationContext(req.body);
    const abs = resolvePath(filePath, cwd);
    assertWriteAllowed(abs, context);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, content, encoding || 'utf8');
    const bytes = fs.statSync(abs).size;
    res.json({ ok: true, path: abs, bytes, sandboxed: !!context });
  } catch (e) {
    sendMutationError(res, e);
  }
});

// ── Replace string in file ────────────────────────────────────────────────
// POST { path, old_string, new_string, cwd? } → { ok, path, bytes }
app.post('/api/replace-string', (req, res) => {
  const { path: filePath, old_string, new_string, cwd } = req.body;
  if (!filePath)        return res.status(400).json({ error: 'path required' });
  if (old_string == null) return res.status(400).json({ error: 'old_string required' });
  try {
    const context = getMutationContext(req.body);
    const abs      = resolvePath(filePath, cwd);
    assertWriteAllowed(abs, context);
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: 'File not found: ' + abs, path: abs });
    }
    const original = fs.readFileSync(abs, 'utf8');
    if (!original.includes(old_string)) {
      return res.status(422).json({ error: 'old_string not found in file', path: abs });
    }
    // Checkpoint before modifying (AutoRecovery)
    checkpointFile(abs);
    // Replace only the FIRST occurrence (like VS Code)
    const idx     = original.indexOf(old_string);
    const updated = original.slice(0, idx) + (new_string ?? '') + original.slice(idx + old_string.length);
    atomicWriteFile(abs, updated, 'utf8');
    res.json({ ok: true, path: abs, bytes: Buffer.byteLength(updated), sandboxed: !!context });
  } catch (e) {
    sendMutationError(res, e);
  }
});

// ── Apply patch (VS Code apply_patch format) ──────────────────────────────
// POST { patch, cwd? } → { ok, results: [{path, op, bytes?}] }
//
// Format:
//   *** Begin Patch
//   *** Add File: /path       → create new file (lines prefixed with +)
//   *** Update File: /path    → patch existing file
//   *** Move to: /newpath     → optional rename (follows Update File header)
//   @@ [optional context]    → hunk start
//    context line             → space prefix = unchanged context
//   -old line                 → dash prefix = remove
//   +new line                 → plus prefix = add
//   *** Delete File: /path    → remove file
//   *** End Patch
app.post('/api/apply-patch', (req, res) => {
  const { patch, cwd } = req.body;
  if (!patch) return res.status(400).json({ error: 'patch required' });
  try {
    const context = getMutationContext(req.body);
    const results = _applyPatch(patch, cwd, context);
    res.json({ ok: true, results, sandboxed: !!context });
  } catch (e) {
    res.status(e.statusCode || 422).json({ ok: false, error: e.message, blocked: !!e.blocked });
  }
});

app.post('/api/apply-patch/check', (req, res) => {
  const { patch, cwd } = req.body;
  if (!patch) return res.status(400).json({ error: 'patch required' });
  try {
    const context = getMutationContext(req.body);
    const plan = _buildPatchPlan(patch, cwd, context);
    res.json({ ok: true, results: _summarizePatchPlan(plan), sandboxed: !!context });
  } catch (e) {
    res.status(e.statusCode || 422).json({ ok: false, error: e.message, blocked: !!e.blocked });
  }
});

function _isFileOp(line) {
  return /^\*\*\* (Add File|Delete File|Update File|End Patch)/.test(line.trim());
}

function _applyHunk(fileContent, hunkLines) {
  const searchLines  = [];
  const replaceLines = [];

  for (const line of hunkLines) {
    if (line === '*** End of File') continue;
    if (line.length === 0) continue;
    const prefix = line[0];
    const text   = line.slice(1);
    if (prefix === ' ')      { searchLines.push(text);  replaceLines.push(text); }
    else if (prefix === '-') { searchLines.push(text); }
    else if (prefix === '+') { replaceLines.push(text); }
  }

  if (searchLines.length === 0 && replaceLines.length === 0) return fileContent;

  const searchStr  = searchLines.join('\n');
  const replaceStr = replaceLines.join('\n');

  if (fileContent.includes(searchStr)) {
    const idx = fileContent.indexOf(searchStr);
    return fileContent.slice(0, idx) + replaceStr + fileContent.slice(idx + searchStr.length);
  }
  // Try CRLF variant
  const searchCRLF = searchLines.join('\r\n');
  if (fileContent.includes(searchCRLF)) {
    const idx = fileContent.indexOf(searchCRLF);
    return fileContent.slice(0, idx) + replaceStr + fileContent.slice(idx + searchCRLF.length);
  }
  throw new Error('Hunk context not found in file:\n' + JSON.stringify(searchStr.slice(0, 200)));
}

function _summarizePatchPlan(plan) {
  return plan.map(op => ({ path: op.path, from: op.from, op: op.op, bytes: op.bytes }));
}

function _buildPatchPlan(patchText, cwd, context) {
  const lines   = patchText.split('\n');
  const plan = [];
  let i = 0;

  while (i < lines.length && !lines[i].trim().startsWith('*** Begin Patch')) i++;
  if (i >= lines.length) throw new Error('"*** Begin Patch" not found');
  i++;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('*** End Patch')) break;

    if (line.startsWith('*** Add File: ')) {
      const filePath = resolvePath(line.slice('*** Add File: '.length).trim(), cwd);
      assertWriteAllowed(filePath, context);
      if (fs.existsSync(filePath)) throw new Error('Add File target already exists: ' + filePath);
      i++;
      const contentLines = [];
      while (i < lines.length && !_isFileOp(lines[i])) {
        const l = lines[i];
        if (l.startsWith('+'))      contentLines.push(l.slice(1));
        else if (l.startsWith(' ')) contentLines.push(l.slice(1));
        i++;
      }
      const body = contentLines.join('\n');
      plan.push({ path: filePath, op: 'add', content: body, bytes: Buffer.byteLength(body) });

    } else if (line.startsWith('*** Delete File: ')) {
      const filePath = resolvePath(line.slice('*** Delete File: '.length).trim(), cwd);
      assertWriteAllowed(filePath, context);
      if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);
      plan.push({ path: filePath, op: 'delete' });
      i++;

    } else if (line.startsWith('*** Update File: ')) {
      const origPath = resolvePath(line.slice('*** Update File: '.length).trim(), cwd);
      assertWriteAllowed(origPath, context);
      i++;
      let newPath = null;
      if (i < lines.length && lines[i].trim().startsWith('*** Move to: ')) {
        newPath = resolvePath(lines[i].trim().slice('*** Move to: '.length).trim(), cwd);
        assertWriteAllowed(newPath, context);
        i++;
      }

      let fileContent = fs.readFileSync(origPath, 'utf8');

      while (i < lines.length && !_isFileOp(lines[i])) {
        if (lines[i].trim().startsWith('@@')) {
          i++;
          const hunkLines = [];
          while (i < lines.length && !lines[i].trim().startsWith('@@') && !_isFileOp(lines[i])) {
            hunkLines.push(lines[i]);
            i++;
          }
          fileContent = _applyHunk(fileContent, hunkLines);
        } else {
          i++;
        }
      }

      const dest = newPath || origPath;
      plan.push({ path: dest, from: newPath ? origPath : undefined, op: newPath ? 'move' : 'update', content: fileContent, bytes: Buffer.byteLength(fileContent) });

    } else {
      i++;
    }
  }
  return plan;
}

function _commitPatchPlan(plan) {
  const checkpoints = new Set();
  for (const op of plan) {
    if (op.from && !checkpoints.has(op.from)) { checkpointFile(op.from); checkpoints.add(op.from); }
    if (op.op !== 'add' && !checkpoints.has(op.path)) { checkpointFile(op.path); checkpoints.add(op.path); }

    if (op.op === 'delete') {
      fs.unlinkSync(op.path);
    } else {
      atomicWriteFile(op.path, op.content, 'utf8');
      if (op.from) { try { fs.unlinkSync(op.from); } catch (_) {} }
    }
  }
  return _summarizePatchPlan(plan);
}

function _applyPatch(patchText, cwd, context) {
  return _commitPatchPlan(_buildPatchPlan(patchText, cwd, context));
}

// ── AutoRecovery endpoints ───────────────────────────────────────────────
// GET  /api/checkpoints?path=...        → list checkpoints for a file
// POST /api/restore-checkpoint { checkpoint, target?, cwd? }  → restore one
// DELETE /api/checkpoints?path=...      → clear all checkpoints for a file

app.get('/api/checkpoints', (req, res) => {
  const filePath = req.query.path;
  const cwd      = req.query.cwd;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const abs       = resolvePath(filePath, cwd);
    const rel       = abs.replace(/^[/\\]/, '').replace(/\\/g, '/');
    const mirrorDir = path.join(RECOVERY_DIR, rel);
    if (!fs.existsSync(mirrorDir)) return res.json({ checkpoints: [], target: abs });
    const files = fs.readdirSync(mirrorDir)
      .filter(f => f.endsWith('.bak'))
      .sort().reverse()
      .map(f => {
        const cp = path.join(mirrorDir, f);
        let size = 0;
        try { size = fs.statSync(cp).size; } catch (_) {}
        // Convert filename back to ISO timestamp for display
        const ts = f.replace('.bak', '').replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/, '$1-$2-$3T$4:$5:$6');
        return { name: f, path: cp, timestamp: ts, size };
      });
    res.json({ checkpoints: files, target: abs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/checkpoints', (req, res) => {
  const filePath = req.query.path;
  const cwd      = req.query.cwd;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const abs       = resolvePath(filePath, cwd);
    const rel       = abs.replace(/^[/\\]/, '').replace(/\\/g, '/');
    const mirrorDir = path.join(RECOVERY_DIR, rel);
    let deleted = 0;
    if (fs.existsSync(mirrorDir)) {
      for (const f of fs.readdirSync(mirrorDir).filter(f => f.endsWith('.bak'))) {
        try { fs.unlinkSync(path.join(mirrorDir, f)); deleted++; } catch (_) {}
      }
    }
    res.json({ ok: true, deleted, target: abs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/restore-checkpoint', (req, res) => {
  const { checkpoint, target, cwd } = req.body;
  if (!checkpoint) return res.status(400).json({ error: 'checkpoint path required' });
  try {
    let dest;
    if (target) {
      dest = resolvePath(target, cwd);
    } else {
      // Infer original path from mirror structure
      const rel = path.relative(RECOVERY_DIR, path.dirname(checkpoint));
      dest = IS_WIN ? rel : '/' + rel.replace(/\\/g, '/');
    }
    // Checkpoint the current version before overwriting (so restore itself is undoable)
    checkpointFile(dest);
    fs.copyFileSync(checkpoint, dest);
    res.json({ ok: true, restored: checkpoint, to: dest, size: fs.statSync(dest).size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Read file ──────────────────────────────────────────────────────────────
// POST { path, encoding? } → { ok, path, content, bytes }
app.post('/api/read-file', (req, res) => {
  const { path: filePath, encoding } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(os.homedir(), filePath);
    const content = fs.readFileSync(abs, encoding || 'utf8');
    res.json({ ok: true, path: abs, content, bytes: Buffer.byteLength(content, encoding || 'utf8') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Read image as base64 (for vision/screenshot) ──────────────────────────
// Resizes to max 1280px wide JPEG (75% quality) to keep payload under API limits.
app.get('/api/read-image', (req, res) => {
  const filePath = req.query.path;
  const maxWidth = parseInt(req.query.maxWidth || '1280', 10);
  if (!filePath) return res.status(400).json({ error: 'path required' });

  const tmpPath = `/tmp/copilot_vision_${Date.now()}.jpg`;
  _exec(
    `sips -s format jpeg -s formatOptions 70 --resampleWidth ${maxWidth} ${JSON.stringify(filePath)} --out ${JSON.stringify(tmpPath)}`,
    (err) => {
      const srcPath = err ? filePath : tmpPath;
      const mime = err ? 'image/png' : 'image/jpeg';
      try {
        const data = fs.readFileSync(srcPath);
        if (!err) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
        res.json({ base64: data.toString('base64'), mime, size: data.length });
      } catch (e) {
        res.status(404).json({ error: e.message });
      }
    }
  );
});

// ── Agent System ──────────────────────────────────────────────────────────

// Primary agents dir: ~/.config/fauna/agents (matches documented path in capabilities.js)
const AGENTS_DIR = path.join(FAUNA_CONFIG_DIR, 'agents');
fs.mkdirSync(AGENTS_DIR, { recursive: true });
// Legacy agents dir: ~/.config/copilot-chat/agents (kept for backward compatibility)
const LEGACY_AGENTS_DIR = path.join(CONFIG_DIR, 'agents');

// Project-local agents folder (version-controlled alongside the app source)
const LOCAL_AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'agents');

function* iterAgentDirs() {
  const seen = new Set();
  // Primary: ~/.config/fauna/agents
  // Legacy: ~/.config/copilot-chat/agents (read-only fallback)
  // Local: bundled app agents
  for (const [dir, src] of [[AGENTS_DIR, 'user'], [LEGACY_AGENTS_DIR, 'user'], [LOCAL_AGENTS_DIR, 'local']]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (seen.has(name)) continue; // primary dir takes precedence
      seen.add(name);
      yield { name, agentDir: path.join(dir, name), source: src };
    }
  }
}

// List all installed agents
app.get('/api/agents', (req, res) => {
  try {
    const agents = [];
    const seen = new Set();
    for (const { name, agentDir, source } of iterAgentDirs()) {
      if (seen.has(name)) continue; // user dir takes precedence over local
      const manifestPath = path.join(agentDir, 'agent.json');
      if (!fs.statSync(agentDir).isDirectory()) continue;
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        // Skip sub-agents (they live inside a parent's agents/ folder)
        if (manifest._parentAgent) continue;
        seen.add(name);
        manifest._dir = agentDir;
        manifest._source = source;
        // Load system prompt if referenced
        if (manifest.systemPromptFile) {
          const promptPath = path.join(agentDir, manifest.systemPromptFile);
          if (fs.existsSync(promptPath)) {
            manifest.systemPrompt = fs.readFileSync(promptPath, 'utf8');
          }
        }
        // Load meta
        const metaPath = path.join(agentDir, '.meta.json');
        if (fs.existsSync(metaPath)) {
          try { manifest._meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
        }
        // Load learnings journal (consolidated patterns only — not full log)
        const learningsPath = path.join(agentDir, 'learnings.md');
        if (fs.existsSync(learningsPath)) {
          const raw = fs.readFileSync(learningsPath, 'utf8');
          const pEnd = raw.indexOf('\n---\n');
          manifest._learnings = pEnd !== -1 ? raw.slice(0, pEnd).trim() : '';
        }
        // Load sub-agents — from manifest.agents array or auto-discover agents/ subdirectory
        let subRefs = manifest.agents && Array.isArray(manifest.agents) ? manifest.agents : null;
        if (!subRefs) {
          const agentsSubDir = path.join(agentDir, 'agents');
          if (fs.existsSync(agentsSubDir) && fs.statSync(agentsSubDir).isDirectory()) {
            subRefs = fs.readdirSync(agentsSubDir).filter(d => fs.existsSync(path.join(agentsSubDir, d, 'agent.json'))).map(d => 'agents/' + d);
          }
        }
        if (subRefs && subRefs.length) {
          manifest._subAgents = [];
          // Load optional shared.md to append to every sub-agent prompt
          const sharedPromptPath = path.join(agentDir, 'shared.md');
          const sharedPrompt = fs.existsSync(sharedPromptPath)
            ? '\n\n---\n## Shared Infrastructure\n\n' + fs.readFileSync(sharedPromptPath, 'utf8')
            : '';
          for (const subRef of subRefs) {
            const subDir = path.join(agentDir, subRef);
            const subManifestPath = path.join(subDir, 'agent.json');
            if (fs.existsSync(subManifestPath)) {
              try {
                const sub = JSON.parse(fs.readFileSync(subManifestPath, 'utf8'));
                sub._dir = subDir;
                // Load sub-agent system prompt and append shared infrastructure
                const subPromptPath = path.join(subDir, 'system-prompt.md');
                if (fs.existsSync(subPromptPath)) {
                  sub.systemPrompt = fs.readFileSync(subPromptPath, 'utf8') + sharedPrompt;
                }
                manifest._subAgents.push(sub);
              } catch (_) {}
            }
          }
        }
        agents.push(manifest);
      } catch (_) { /* skip invalid manifests */ }
    }
    res.json({ agents });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// Get a single agent's manifest
app.get('/api/agents/:name', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  const manifestPath = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.systemPromptFile) {
      const promptPath = path.join(agentDir, manifest.systemPromptFile);
      if (fs.existsSync(promptPath)) {
        manifest.systemPrompt = fs.readFileSync(promptPath, 'utf8');
      }
    }
    // Load learnings journal (consolidated patterns only)
    const learningsPath = path.join(agentDir, 'learnings.md');
    if (fs.existsSync(learningsPath)) {
      const raw = fs.readFileSync(learningsPath, 'utf8');
      const pEnd = raw.indexOf('\n---\n');
      manifest._learnings = pEnd !== -1 ? raw.slice(0, pEnd).trim() : '';
    }
    // Load sub-agents — from manifest.agents array or auto-discover agents/ subdirectory
    let subRefs = manifest.agents && Array.isArray(manifest.agents) ? manifest.agents : null;
    if (!subRefs) {
      const agentsSubDir = path.join(agentDir, 'agents');
      if (fs.existsSync(agentsSubDir) && fs.statSync(agentsSubDir).isDirectory()) {
        subRefs = fs.readdirSync(agentsSubDir).filter(d => fs.existsSync(path.join(agentsSubDir, d, 'agent.json'))).map(d => 'agents/' + d);
      }
    }
    if (subRefs && subRefs.length) {
      manifest._subAgents = [];
      // Expose shared.md content for the builder editor
      const sharedPath = path.join(agentDir, 'shared.md');
      if (fs.existsSync(sharedPath)) manifest._shared = fs.readFileSync(sharedPath, 'utf8');
      for (const subRef of subRefs) {
        const subDir = path.join(agentDir, subRef);
        const subManifestPath = path.join(subDir, 'agent.json');
        if (fs.existsSync(subManifestPath)) {
          try {
            const sub = JSON.parse(fs.readFileSync(subManifestPath, 'utf8'));
            const subPromptPath = path.join(subDir, 'system-prompt.md');
            if (fs.existsSync(subPromptPath)) {
              sub.systemPrompt = fs.readFileSync(subPromptPath, 'utf8');
            }
            manifest._subAgents.push(sub);
          } catch (_) {}
        }
      }
    }
    res.json(manifest);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read agent' });
  }
});

// Update an agent's system prompt (writes both system-prompt.md and agent.json atomically)
app.post('/api/agents/:name/update-prompt', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  const manifestPath = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });
  const { systemPrompt } = req.body || {};
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    return res.status(400).json({ error: 'systemPrompt string required' });
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.systemPrompt = systemPrompt;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(agentDir, 'system-prompt.md'), systemPrompt);
    res.json({ ok: true, name, bytes: systemPrompt.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update prompt: ' + e.message });
  }
});

// Agent learnings journal — append or read learnings.md
app.get('/api/agents/:name/learnings', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const lPath = path.join(agentDir, 'learnings.md');
  const content = fs.existsSync(lPath) ? fs.readFileSync(lPath, 'utf8') : '';
  res.json({ name, learnings: content });
});

app.post('/api/agents/:name/learnings', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const { entry, consolidatedPatterns } = req.body || {};
  if (!entry && !consolidatedPatterns) {
    return res.status(400).json({ error: 'Provide "entry" (append) and/or "consolidatedPatterns" (replace top section)' });
  }
  try {
    const lPath = path.join(agentDir, 'learnings.md');
    let content = fs.existsSync(lPath) ? fs.readFileSync(lPath, 'utf8') : '';

    // If consolidatedPatterns provided, replace/create the top patterns section
    if (consolidatedPatterns) {
      const patternsBlock = '## Consolidated Patterns\n\n' + consolidatedPatterns.trim() + '\n\n---\n\n';
      const marker = '## Consolidated Patterns';
      const divider = '---\n\n';
      const idx = content.indexOf(marker);
      if (idx !== -1) {
        // Replace existing patterns section (up to the first ---)
        const endIdx = content.indexOf(divider, idx);
        const cutEnd = endIdx !== -1 ? endIdx + divider.length : content.indexOf('\n## Session Log', idx);
        content = patternsBlock + (cutEnd !== -1 ? content.slice(cutEnd) : '');
      } else {
        content = patternsBlock + content;
      }
    }

    // Append new entry to the session log
    if (entry) {
      const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const logEntry = '\n### ' + timestamp + '\n' + entry.trim() + '\n';
      if (!content.includes('## Session Log')) {
        content += '## Session Log\n';
      }
      content += logEntry;
    }

    fs.writeFileSync(lPath, content);
    res.json({ ok: true, name, bytes: content.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update learnings: ' + e.message });
  }
});

// Import agent from uploaded zip
app.post('/api/agents/import', express.raw({ type: 'application/zip', limit: '10mb' }), async (req, res) => {
  const tmp = path.join(os.tmpdir(), 'agent-import-' + Date.now());
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const zipPath = path.join(tmp, 'agent.zip');
    fs.writeFileSync(zipPath, req.body);
    // Extract using unzip (available on macOS and most Linux)
    execSync(`unzip -o -q "${zipPath}" -d "${tmp}/extracted"`, { timeout: 30000 });
    const extracted = path.join(tmp, 'extracted');
    // Find agent.json (may be in root or one level deep)
    let agentRoot = extracted;
    if (!fs.existsSync(path.join(extracted, 'agent.json'))) {
      const dirs = fs.readdirSync(extracted).filter(d => fs.statSync(path.join(extracted, d)).isDirectory());
      for (const d of dirs) {
        if (fs.existsSync(path.join(extracted, d, 'agent.json'))) { agentRoot = path.join(extracted, d); break; }
      }
    }
    if (!fs.existsSync(path.join(agentRoot, 'agent.json'))) {
      return res.status(400).json({ error: 'No agent.json found in archive' });
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(agentRoot, 'agent.json'), 'utf8'));
    const agentName = (manifest.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!agentName) return res.status(400).json({ error: 'Agent name is required in agent.json' });

    // Check uniqueness
    if (BUILTIN_AGENT_NAMES.includes(agentName.toLowerCase())) {
      return res.status(409).json({ error: 'Cannot import an agent with a built-in name: ' + agentName });
    }
    const destDir = path.join(AGENTS_DIR, agentName);
    const force = req.query.force === '1';
    if (fs.existsSync(path.join(destDir, 'agent.json')) && !force) {
      return res.status(409).json({ error: 'An agent named "' + agentName + '" already exists. Delete it first or rename the import.' });
    }
    // Preserve .meta.json across forced re-imports
    let savedMeta = null;
    if (force && fs.existsSync(path.join(destDir, '.meta.json'))) {
      try { savedMeta = fs.readFileSync(path.join(destDir, '.meta.json')); } catch (_) {}
    }
    if (force && fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.mkdirSync(destDir, { recursive: true });
    const copyRecursive = (src, dst) => {
      for (const item of fs.readdirSync(src)) {
        const s = path.join(src, item);
        const d = path.join(dst, item);
        if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyRecursive(s, d); }
        else fs.copyFileSync(s, d);
      }
    };
    copyRecursive(agentRoot, destDir);
    // Restore preserved .meta.json
    if (savedMeta) {
      try { fs.writeFileSync(path.join(destDir, '.meta.json'), savedMeta); } catch (_) {}
    }
    res.json({ ok: true, name: agentName, displayName: manifest.displayName || agentName });
  } catch (e) {
    res.status(500).json({ error: 'Failed to import agent' });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

// Delete an installed agent
app.delete('/api/agents/:name', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  try {
    fs.rmSync(agentDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

// ── Agent Meta (checksum, sandbox mode, install info) ─────────────────────

// ── Agent Custom Icon ─────────────────────────────────────────────────────

app.post('/api/agents/:name/icon', express.raw({ type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], limit: '2mb' }), (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  try {
    fs.writeFileSync(path.join(agentDir, 'icon.png'), req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save icon' });
  }
});

app.get('/api/agents/:name/icon', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const iconPath = path.join(AGENTS_DIR, name, 'icon.png');
  if (!fs.existsSync(iconPath)) return res.status(404).send('No custom icon');
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(fs.readFileSync(iconPath));
});

app.get('/api/agents/:name/meta', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const metaPath = path.join(AGENTS_DIR, name, '.meta.json');
  if (!fs.existsSync(metaPath)) return res.json({});
  try {
    res.json(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
  } catch (_) { res.json({}); }
});

app.post('/api/agents/:name/meta', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const metaPath = path.join(agentDir, '.meta.json');
  try {
    let existing = {};
    if (fs.existsSync(metaPath)) {
      existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
    const updated = Object.assign(existing, req.body);
    fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2));
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Failed to save meta' });
  }
});

// ── Agent Test Cases ──────────────────────────────────────────────────────

app.get('/api/agents/:name/tests', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const testsPath = path.join(AGENTS_DIR, name, 'tests', 'test-cases.json');
  if (!fs.existsSync(testsPath)) return res.json({ testCases: [] });
  try {
    const cases = JSON.parse(fs.readFileSync(testsPath, 'utf8'));
    res.json({ testCases: Array.isArray(cases) ? cases : [] });
  } catch (_) { res.json({ testCases: [] }); }
});

// Generate a conversation summary for agent context handoff
app.post('/api/chat-summary', async (req, res) => {
  const { messages } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });
  try {
    const client = getCopilotClient();
    const response = await client.chat.completions.create({
      model: 'claude-sonnet-4.6',
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'Summarise the following conversation in 3-5 concise sentences, capturing the key topics, decisions, and any pending questions. Be factual and brief.' },
        { role: 'user', content: typeof messages === 'string' ? messages : JSON.stringify(messages) }
      ]
    });
    const summary = response.choices?.[0]?.message?.content || '';
    res.json({ summary });
  } catch (e) {
    res.json({ summary: '' });
  }
});

// ── Multi-agent composition planner ────────────────────────────────────────
// Given a task and a list of agents, determine which agent handles which sub-task.
app.post('/api/composition/plan', async (req, res) => {
  const { task, agents, conversationContext } = req.body;
  if (!task || !agents || !agents.length) return res.status(400).json({ error: 'task and agents required' });

  const agentDescriptions = agents.map(a =>
    `- **${a.displayName}** (\`${a.name}\`): ${a.description || 'No description'}` +
    (a.systemPrompt ? `\n  Capabilities: ${a.systemPrompt.substring(0, 300)}` : '')
  ).join('\n');

  try {
    const client = getCopilotClient();
    const response = await client.chat.completions.create({
      model: 'claude-sonnet-4.6',
      max_tokens: 1500,
      messages: [
        { role: 'system', content: `You are a task planner for a multi-agent system. Given a user task and a list of available agents with their capabilities, create an execution plan that assigns specific sub-tasks to each agent based on their strengths.

Rules:
- Every agent in the list MUST be assigned a sub-task (they were all explicitly selected by the user)
- Sub-tasks should be complementary, not overlapping
- Each agent should focus on what they're best at
- If agents have sequential dependencies (e.g. design first, then documentation), specify the order
- Be specific about what each agent should do

Respond in this exact JSON format:
{
  "plan": [
    { "agent": "agent-name", "task": "specific instructions for this agent", "order": 1 },
    { "agent": "agent-name", "task": "specific instructions for this agent", "order": 2 }
  ],
  "reasoning": "brief explanation of why tasks were divided this way",
  "mode": "sequential"
}

The "order" field determines execution sequence. Agents with the same order number run in parallel.
The "mode" should be "sequential" when later agents depend on earlier agents' output, or "parallel" when they can work independently.` },
        { role: 'user', content: `## Task\n${task}\n\n## Available Agents\n${agentDescriptions}${conversationContext ? '\n\n## Conversation Context\n' + conversationContext : ''}` }
      ]
    });

    const raw = response.choices?.[0]?.message?.content || '{}';
    // Extract JSON from potential markdown code blocks
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    const plan = JSON.parse(jsonMatch[1].trim());
    res.json(plan);
  } catch (e) {
    // Fallback: simple sequential split
    const fallbackPlan = {
      plan: agents.map((a, i) => ({ agent: a.name, task: task, order: i + 1 })),
      reasoning: 'Fallback: running agents sequentially on the full task',
      mode: 'sequential'
    };
    res.json(fallbackPlan);
  }
});

// Execute a single agent tool (for testing / manual invocation)
app.post('/api/agents/:name/tool/:tool', async (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const toolName = req.params.tool;
  const args = req.body.args || {};

  const agentDir = path.join(AGENTS_DIR, agentName);
  const manifestPath = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { handlers } = getAgentTools(agentDir, manifest, agentName);

    if (!handlers.has(toolName)) {
      return res.status(404).json({ error: 'Tool "' + toolName + '" not found for agent "' + agentName + '"' });
    }

    const result = await handlers.get(toolName)(args);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List tools available for an agent
app.get('/api/agents/:name/tools', (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, agentName);
  const manifestPath = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { definitions } = getAgentTools(agentDir, manifest, agentName);
    res.json({ tools: definitions.map(d => ({ name: d.function.name, description: d.function.description, parameters: d.function.parameters })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start/stop MCP servers for an agent
app.post('/api/agents/:name/mcp/start', async (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const manifestPath = path.join(AGENTS_DIR, agentName, 'agent.json');
  if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const result = await startAgentMCPServers(manifest, agentName);
    res.json({ ok: true, servers: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/mcp/stop', (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  stopAgentMCPServers(agentName);
  res.json({ ok: true });
});

// Run vulnerability scan on an installed agent
app.post('/api/agents/:name/scan', (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, agentName);
  if (!fs.existsSync(path.join(agentDir, 'agent.json'))) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  try {
    const report = scanAgent(agentDir);
    // Cache the report
    const reportPath = path.join(agentDir, '.scan-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: 'Scan failed: ' + e.message });
  }
});

// Get cached scan report
app.get('/api/agents/:name/scan-report', (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const reportPath = path.join(AGENTS_DIR, agentName, '.scan-report.json');
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ error: 'No scan report found. Run POST /api/agents/:name/scan first.' });
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read scan report' });
  }
});

// Get formatted scan report as markdown
app.get('/api/agents/:name/scan-report/markdown', (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const reportPath = path.join(AGENTS_DIR, agentName, '.scan-report.json');
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ error: 'No scan report found' });
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const markdown = formatScanReport(report);
    res.type('text/markdown').send(markdown);
  } catch (e) {
    res.status(500).json({ error: 'Failed to format scan report' });
  }
});

// Scan a zip archive before import (pre-publish check)
app.post('/api/agents/scan-zip', express.raw({ type: 'application/zip', limit: '10mb' }), (req, res) => {
  const tmp = path.join(os.tmpdir(), 'agent-scan-' + Date.now());
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const zipPath = path.join(tmp, 'agent.zip');
    fs.writeFileSync(zipPath, req.body);
    execSync(`unzip -o -q "${zipPath}" -d "${tmp}/extracted"`, { timeout: 30000 });
    const extracted = path.join(tmp, 'extracted');
    // Find agent root
    let agentRoot = extracted;
    if (!fs.existsSync(path.join(extracted, 'agent.json'))) {
      const dirs = fs.readdirSync(extracted).filter(d => fs.statSync(path.join(extracted, d)).isDirectory());
      for (const d of dirs) {
        if (fs.existsSync(path.join(extracted, d, 'agent.json'))) { agentRoot = path.join(extracted, d); break; }
      }
    }
    if (!fs.existsSync(path.join(agentRoot, 'agent.json'))) {
      return res.status(400).json({ error: 'No agent.json found in archive' });
    }
    const report = scanAgent(agentRoot);
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: 'Scan failed: ' + e.message });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Agent Builder Endpoints ──────────────────────────────────────────────

// AI-generate agent config from a natural language description
app.post('/api/agent-builder/generate', async (req, res) => {
  const { description, model: reqModel } = req.body;
  if (!description || !description.trim()) return res.status(400).json({ error: 'description required' });
  // Use the model the client is currently using, fall back to gpt-4.1 which is reliably available
  const model = reqModel || 'gpt-4.1';
  try {
    const client = getCopilotClient();
    const response = await client.chat.completions.create({
      model: model,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: `You are an AI agent builder assistant. Given a user's description of what kind of agent they want, generate a complete agent configuration as a JSON object. Return ONLY valid JSON with no markdown fencing or extra text.

The JSON must have these fields:
- "displayName": string (human-friendly name, 2-4 words)
- "name": string (lowercase slug with hyphens, e.g. "code-reviewer")
- "description": string (1-2 sentence description)
- "category": one of "productivity","development","design","research","writing","data","other"
- "icon": one of "ti-robot","ti-code","ti-search","ti-pencil","ti-vector-triangle","ti-database","ti-chart-bar","ti-terminal-2","ti-world-www","ti-shield-check","ti-brain","ti-bolt","ti-bug","ti-git-merge","ti-palette","ti-mail","ti-file-analytics","ti-api","ti-cpu","ti-cloud","ti-package","ti-wand"
- "orchestrator": boolean — set true if the agent's purpose involves coordinating multiple specialized sub-agents (e.g. "generate a report using 3 agents", "multi-step pipeline", "spec writer with sections"). Set false for single-purpose agents.
- "systemPrompt": string (detailed system prompt). For orchestrators: 100-200 words, dispatch-only — must output ONLY [DELEGATE:agents/sub-agent-name]task[/DELEGATE] blocks, describe inputs to resolve, and list the sub-agents in a dispatch table. For pipelines where step N depends on step N-1, emit ONE block at a time — the system loops automatically, returning results before the next delegation. For parallel work, emit all blocks at once. For regular agents: 200-800 words defining role, capabilities, workflow, output format.
- "shared": string — only for orchestrators (empty string otherwise). Shared infrastructure prompt appended to every sub-agent automatically. Put common facts, APIs, component keys, helpers, or conventions here so sub-agents don't repeat them.
- "subAgents": array — only for orchestrators (empty array otherwise). Each sub-agent has:
  - "name": string (lowercase slug, e.g. "section-overview")
  - "displayName": string (human-friendly, e.g. "Overview Section")
  - "description": string (one sentence)
  - "icon": string (ti-* icon from the list above)
  - "systemPrompt": string (focused prompt for this sub-agent's specific responsibility, 100-300 words. It receives shared context automatically — don't repeat shared infrastructure here. In sequential mode, sub-agents automatically receive prior agents' results as context.)
- "permissions": object with:
  - "shell": boolean
  - "browser": boolean
  - "figma": boolean
  - "fileRead": array of FOLDER paths the agent may read from (e.g. ["~/Documents"]). All files inside the folder are accessible. Use [] for no read access.
  - "fileWrite": array of FOLDER paths the agent may write to (e.g. ["~/Output"]). All files inside the folder can be created or overwritten. Use [] for no write access.
  - "network": { "allowedDomains": string[], "blockAll": boolean }
- "tools": array of custom tool objects (0-3 relevant tools; omit for orchestrators). Each tool has:
  - "name": string (snake_case)
  - "description": string
  - "parameters": JSON Schema object ({ "type": "object", "properties": { ... } })
  - "code": string (JavaScript module.exports async function. Receives (args, context). context has: context.fetch(url), context.readFile(path), context.writeFile(path, content), context.store)
- "testCases": array of 2-4 test cases. Each has:
  - "input": string (a user message to test)
  - "expectedOutput": string (a substring that should appear in the response)

ORCHESTRATOR EXAMPLE — if the user asks for a "report writer with a research agent and a writing agent":
{
  "orchestrator": true,
  "systemPrompt": "You coordinate report generation. Resolve the topic, then output ONLY [DELEGATE:] blocks.\\n\\n## Dispatch\\n[DELEGATE:agents/researcher]Research the topic and return key facts, sources, and a summary[/DELEGATE]\\n[DELEGATE:agents/writer]Write a polished report from the research findings[/DELEGATE]",
  "shared": "Output reports in Markdown. Use headers ##, bullet points, and concise language.",
  "subAgents": [
    { "name": "researcher", "displayName": "Researcher", "icon": "ti-search", "description": "Finds and summarizes facts on a topic.", "systemPrompt": "You research a given topic and return structured findings: key facts, sources, and a short summary." },
    { "name": "writer", "displayName": "Writer", "icon": "ti-pencil", "description": "Writes the final report from research.", "systemPrompt": "You receive research findings and write a polished report. Prior agent results are in your context." }
  ],
  "tools": []
}

Set permissions conservatively — only enable what the agent truly needs.` },
        { role: 'user', content: description.trim() }
      ]
    });
    const text = response.choices?.[0]?.message?.content || '';
    // Extract JSON from response (strip markdown fences if present)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Failed to generate valid agent config' });
    const config = JSON.parse(jsonMatch[0]);
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: 'Generation failed: ' + e.message });
  }
});

// Test a system prompt by sending a test message through the model
app.post('/api/agent-builder/test-prompt', async (req, res) => {
  const { systemPrompt, testMessage } = req.body;
  if (!systemPrompt || !testMessage) return res.status(400).json({ error: 'systemPrompt and testMessage required' });
  try {
    const client = getCopilotClient();
    const response = await client.chat.completions.create({
      model: 'claude-sonnet-4.6',
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: testMessage }
      ]
    });
    const text = response.choices?.[0]?.message?.content || '';
    res.json({ response: text });
  } catch (e) {
    res.status(500).json({ error: 'Test failed: ' + e.message });
  }
});

// Test a custom tool in sandbox
app.post('/api/agent-builder/test-tool', async (req, res) => {
  const { tool, args } = req.body;
  if (!tool || !tool.code) return res.status(400).json({ error: 'tool with code required' });
  try {
    const vm = await import('vm');
    const sandbox = {
      module: { exports: null },
      exports: {},
      console: { log: () => {}, error: () => {}, warn: () => {} },
      setTimeout: () => {},
      clearTimeout: () => {},
    };
    const ctx = vm.default ? vm.default.createContext(sandbox) : vm.createContext(sandbox);
    const script = new (vm.default ? vm.default.Script : vm.Script)(tool.code, { timeout: 5000 });
    script.runInContext(ctx);
    const fn = sandbox.module.exports || sandbox.exports.default;
    if (typeof fn !== 'function') return res.status(400).json({ error: 'Tool code must export a function via module.exports' });

    // Create a minimal tool context
    const toolContext = {
      fetch: () => Promise.resolve({ ok: true, json: () => ({ mock: true }), text: () => 'mock response' }),
      readFile: () => Promise.resolve('(sandbox: file read disabled in test mode)'),
      writeFile: () => Promise.resolve(),
      store: {}
    };
    const result = await Promise.resolve(fn(args || {}, toolContext));
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: 'Tool test failed: ' + e.message });
  }
});

// Scan agent data from builder (not yet saved to disk)
app.post('/api/agent-builder/scan', (req, res) => {
  const data = req.body;
  if (!data || !data.name) return res.status(400).json({ error: 'Agent data required' });

  // Write to a temp directory, scan, then clean up
  const tmp = path.join(os.tmpdir(), 'agent-builder-scan-' + Date.now());
  try {
    fs.mkdirSync(tmp, { recursive: true });

    // Write agent.json
    const manifest = {
      name: data.name,
      displayName: data.displayName || data.name,
      description: data.description || '',
      version: '1.0',
      category: data.category || 'other',
      icon: data.icon || 'ti-robot',
      permissions: data.permissions || {}
    };
    fs.writeFileSync(path.join(tmp, 'agent.json'), JSON.stringify(manifest, null, 2));

    // Write system prompt
    if (data.systemPrompt) {
      fs.writeFileSync(path.join(tmp, 'system-prompt.md'), data.systemPrompt);
    }

    // Write tools
    if (data.tools && data.tools.length) {
      const toolsDir = path.join(tmp, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      for (const tool of data.tools) {
        const toolFile = path.join(toolsDir, (tool.name || 'tool') + '.js');
        fs.writeFileSync(toolFile, tool.code || '');
      }
    }

    // Write test cases for scan
    if (data.testCases && data.testCases.length) {
      const testsDir = path.join(tmp, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'test-cases.json'), JSON.stringify(data.testCases, null, 2));
    }

    // Write auto-generated README
    const readmeContent = '# ' + (data.displayName || data.name) + '\n\n' +
      (data.description || '') + '\n\n' +
      '## Permissions\n\n' +
      (data.permissions ? Object.entries(data.permissions).filter(([k,v]) => v && k !== 'network' && k !== 'fileRead' && k !== 'fileWrite').map(([k]) => '- ' + k).join('\n') : 'None') + '\n';
    fs.writeFileSync(path.join(tmp, 'README.md'), readmeContent);

    const report = scanAgent(tmp);
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: 'Scan failed: ' + e.message });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

// Audit a system prompt against a quality rubric and suggest improvements
app.post('/api/agent-builder/rubric-audit', async (req, res) => {
  const { systemPrompt, displayName, description, model: reqModel } = req.body;
  if (!systemPrompt || !systemPrompt.trim()) return res.status(400).json({ error: 'systemPrompt required' });

  const auditSystemMsg = `You are an expert AI prompt quality auditor. Evaluate the given agent system prompt against these quality criteria and return ONLY valid JSON with no markdown fencing.

Return a JSON object with:
- "summary": string — one or two sentence overall assessment. Include approximate token savings if the improved prompt is shorter (e.g. "~320 tokens saved").
- "findings": array of issues found (empty array if the prompt passes all checks). Each finding has:
  - "id": short snake_case identifier (e.g. "missing_role", "vague_output_format", "verbose_phrasing")
  - "label": short human-readable label (5-8 words)
  - "detail": one or two sentences explaining the issue and how to fix it
  - "severity": "high" | "medium" | "low"
- "tokenEstimate": { "original": number, "improved": number } — rough token counts (chars/4) for original vs improved prompt
- "improvedPrompt": string — a COMPLETE rewritten version of the system prompt that addresses all findings. You MUST include the ENTIRE prompt text — never truncate, abbreviate, or use placeholders like "[...rest of prompt...]". Actively compress verbose phrasing: use imperative voice, terse bullets, remove filler words, collapse redundant sentences — while keeping every behavioral instruction intact. Omit this field (or set to null) only if there are no findings.

Quality criteria to check:
1. Role clarity (high) — Is the agent's role and purpose clearly defined up front?
2. Instruction specificity (high) — Are instructions specific enough to guide behavior, or are they vague?
3. Output format (medium) — Does the prompt specify expected output format when relevant?
4. Safety & scope limits (medium) — Does the prompt define what the agent should NOT do?
5. Edge case handling (low) — Are common edge cases or failure modes addressed?
6. Conciseness (low) — Is the prompt free of repetitive or contradictory content?
7. Tone & persona consistency (low) — Is the agent persona consistent throughout?
8. Token efficiency (medium) — Is the prompt unnecessarily verbose? Flag wordy phrasing, redundant restatements, over-explained obvious points, or filler sentences that inflate token count without adding behavioral clarity. The improved prompt should preserve 100% of the original intent while using significantly fewer tokens. Prefer terse bullet points, imperative voice, and compressed phrasing over full prose paragraphs.`;

  const userMsg = `Agent name: ${displayName || 'Unnamed'}\nDescription: ${description || 'N/A'}\nOriginal token estimate: ~${Math.ceil(systemPrompt.trim().length / 4)}\n\nSystem prompt:\n${systemPrompt.trim()}`;
  const messages = [{ role: 'system', content: auditSystemMsg }, { role: 'user', content: userMsg }];

  // Try with user's current model first, then fallback models
  const modelsToTry = [reqModel, 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'].filter(Boolean);
  const client = getCopilotClient();
  let lastError = null;

  for (const model of modelsToTry) {
    try {
      console.log('[rubric-audit] trying model:', model);
      const response = await client.chat.completions.create({
        model,
        max_tokens: 16384,
        stream: false,
        messages
      });
      const text = response.choices?.[0]?.message?.content || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        lastError = new Error('Failed to parse audit response from ' + model);
        continue;
      }
      const audit = JSON.parse(jsonMatch[0]);
      return res.json(audit);
    } catch (e) {
      console.warn('[rubric-audit] model', model, 'failed:', e.message);
      lastError = e;
    }
  }
  res.status(500).json({ error: 'Rubric audit failed: ' + (lastError?.message || 'all models failed') });
});

// Suggest decomposing a large agent into orchestrator + sub-agents
app.post('/api/agent-builder/decompose', async (req, res) => {
  const { systemPrompt, displayName, description, name: agentName, permissions, icon, category, model: reqModel } = req.body;
  if (!systemPrompt || !systemPrompt.trim()) return res.status(400).json({ error: 'systemPrompt required' });

  const tokenEst = Math.ceil(systemPrompt.trim().length / 4);
  if (tokenEst < 4000) return res.json({ recommend: false, reason: 'Prompt is under 4000 tokens — no split needed.' });

  const decomposeMsg = `You are an expert agent architect. The user has a single agent with a very large system prompt (~${tokenEst} tokens). Your job is to decompose it into an orchestrator agent with specialized sub-agents.

Return ONLY valid JSON with no markdown fencing. The JSON object must have:
- "recommend": true
- "reason": string — 1-2 sentences explaining why splitting helps (faster responses, lower per-call token cost, better separation of concerns)
- "orchestrator": object with:
  - "displayName": string
  - "name": string (slug)
  - "description": string
  - "systemPrompt": string — short dispatch-only prompt (100-200 words). Must use [DELEGATE:agents/NAME]task description[/DELEGATE] syntax for each sub-agent. For parallel work, emit all blocks at once. For pipelines where step N needs step N-1 output, emit ONE block at a time — the system loops automatically, returning results before requesting the next delegation.
- "shared": string — common context/facts/conventions shared across all sub-agents (extract anything repeated or universally needed). This is automatically appended to every sub-agent's prompt.
- "subAgents": array of 2-5 sub-agents, each with:
  - "name": string (slug)
  - "displayName": string (2-4 words)
  - "description": string (1 sentence)
  - "icon": one of "ti-robot","ti-code","ti-search","ti-pencil","ti-vector-triangle","ti-database","ti-chart-bar","ti-terminal-2","ti-world-www","ti-shield-check","ti-brain","ti-bolt","ti-bug","ti-palette","ti-wand"
  - "systemPrompt": string (focused, 100-400 words — the sub-agent's specific responsibility only, no shared context)
- "tokenEstimate": { "original": number, "perCallMax": number } — original = total tokens of the monolithic prompt, perCallMax = max tokens any single sub-agent + shared + orchestrator would consume in one call

Rules:
- Split along natural responsibility boundaries (e.g. research vs writing, planning vs execution, different domains)
- The shared section should contain facts/context that 2+ sub-agents need — don't duplicate across sub-agents
- Each sub-agent prompt should be self-contained for its responsibility (it gets shared context automatically)
- Preserve 100% of the original prompt's behavioral intent — nothing should be lost in the split
- The orchestrator prompt should be a pure dispatcher — it decides which sub-agent(s) to invoke based on the user's request
- In sequential mode each sub-agent automatically receives prior agents' results as context — sub-agent prompts can reference "prior agent results" without you wiring it manually
- The orchestrator systemPrompt MUST include a dispatch table showing which sub-agent handles which responsibility, using the format: [DELEGATE:agents/name]task[/DELEGATE]`;

  const userMsg = `Agent: ${displayName || agentName || 'Unnamed'}\nDescription: ${description || 'N/A'}\n\nFull system prompt (${tokenEst} tokens):\n${systemPrompt.trim()}`;
  const messages = [{ role: 'system', content: decomposeMsg }, { role: 'user', content: userMsg }];

  const modelsToTry = [reqModel, 'gpt-4.1', 'claude-sonnet-4.6'].filter(Boolean);
  const client = getCopilotClient();
  let lastError = null;

  for (const model of modelsToTry) {
    try {
      console.log('[decompose] trying model:', model);
      const response = await client.chat.completions.create({ model, max_tokens: 16384, stream: false, messages });
      const text = response.choices?.[0]?.message?.content || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { lastError = new Error('Failed to parse from ' + model); continue; }
      const result = JSON.parse(jsonMatch[0]);
      // Carry forward original agent metadata
      result._originalMeta = { permissions: permissions || {}, icon: icon || 'ti-robot', category: category || 'other' };
      return res.json(result);
    } catch (e) {
      console.warn('[decompose] model', model, 'failed:', e.message);
      lastError = e;
    }
  }
  res.status(500).json({ error: 'Decomposition failed: ' + (lastError?.message || 'all models failed') });
});

// Save agent from builder
const BUILTIN_AGENT_NAMES = ['research', 'coder', 'writer', 'designer'];

app.post('/api/agent-builder/save', (req, res) => {
  const data = req.body;
  if (!data || !data.name) return res.status(400).json({ error: 'Agent name required' });
  const agentName = data.name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!agentName) return res.status(400).json({ error: 'Invalid agent name' });

  // Check uniqueness: reject built-in names, reject duplicate on new agents
  if (BUILTIN_AGENT_NAMES.includes(agentName.toLowerCase())) {
    return res.status(409).json({ error: 'Cannot use a built-in agent name: ' + agentName });
  }
  const isNew = !data._editing;
  const agentDir = path.join(AGENTS_DIR, agentName);
  if (isNew && fs.existsSync(path.join(agentDir, 'agent.json'))) {
    return res.status(409).json({ error: 'An agent named "' + agentName + '" already exists. Edit it instead or choose a different name.' });
  }
  try {
    fs.mkdirSync(agentDir, { recursive: true });

    // Auto-increment version on re-save (simple: 1.0 → 2.0 → 3.0)
    let version = '1.0';
    const existingManifestPath = path.join(agentDir, 'agent.json');
    if (!isNew && fs.existsSync(existingManifestPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(existingManifestPath, 'utf8'));
        if (existing.version) {
          const major = parseInt(existing.version) || 1;
          version = (major + 1) + '.0';
        }
      } catch (_) {}
    }

    // Write agent.json
    const manifest = {
      name: agentName,
      displayName: data.displayName || agentName,
      description: data.description || '',
      version: version,
      category: data.category || 'other',
      icon: data.icon || 'ti-robot',
      orchestrator: data.orchestrator || false,
      permissions: data.permissions || {},
      systemPrompt: data.systemPrompt || ''
    };
    // Include sub-agent references in manifest
    if (data.agents && Array.isArray(data.agents) && data.agents.length) {
      manifest.agents = data.agents; // e.g. ['agents/overview', 'agents/usage']
    }
    // Compute checksum of the manifest for version tracking
    const manifestJson = JSON.stringify(manifest, null, 2);
    const checksum = crypto.createHash('sha256').update(manifestJson).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(agentDir, 'agent.json'), manifestJson);

    // Write system prompt
    if (data.systemPrompt) {
      fs.writeFileSync(path.join(agentDir, 'system-prompt.md'), data.systemPrompt);
    }

    // Write shared sub-agent infrastructure
    if (data.shared && data.shared.trim()) {
      fs.writeFileSync(path.join(agentDir, 'shared.md'), data.shared);
    } else if (fs.existsSync(path.join(agentDir, 'shared.md')) && data.shared === '') {
      fs.unlinkSync(path.join(agentDir, 'shared.md'));
    }

    // Write sub-agents
    if (data.subAgents && Array.isArray(data.subAgents)) {
      const subAgentsDir = path.join(agentDir, 'agents');
      fs.mkdirSync(subAgentsDir, { recursive: true });
      for (const sub of data.subAgents) {
        const subName = (sub.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!subName) continue;
        const subDir = path.join(subAgentsDir, subName);
        fs.mkdirSync(subDir, { recursive: true });
        const subManifest = {
          name: subName,
          displayName: sub.displayName || subName,
          description: sub.description || '',
          icon: sub.icon || 'ti-robot',
          category: sub.category || manifest.category,
          permissions: sub.permissions || {},
          systemPrompt: sub.systemPrompt || '',
          _parentAgent: agentName
        };
        fs.writeFileSync(path.join(subDir, 'agent.json'), JSON.stringify(subManifest, null, 2));
        if (sub.systemPrompt) {
          fs.writeFileSync(path.join(subDir, 'system-prompt.md'), sub.systemPrompt);
        }
        // Sub-agent tools
        if (sub.tools && sub.tools.length) {
          const subToolsDir = path.join(subDir, 'tools');
          fs.mkdirSync(subToolsDir, { recursive: true });
          for (const tool of sub.tools) {
            const safeTool = (tool.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '');
            fs.writeFileSync(path.join(subToolsDir, safeTool + '.json'), JSON.stringify({ name: tool.name, description: tool.description || '', parameters: tool.parameters || {} }, null, 2));
            fs.writeFileSync(path.join(subToolsDir, safeTool + '.js'), tool.code || '');
          }
        }
      }
    }

    // Write tools
    if (data.tools && data.tools.length) {
      const toolsDir = path.join(agentDir, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      for (const tool of data.tools) {
        const safeName = (tool.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '');
        const toolManifest = {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} }
        };
        fs.writeFileSync(path.join(toolsDir, safeName + '.json'), JSON.stringify(toolManifest, null, 2));
        fs.writeFileSync(path.join(toolsDir, safeName + '.js'), tool.code || '');
      }
    }

    // Write test cases
    if (data.testCases && data.testCases.length) {
      const testsDir = path.join(agentDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'test-cases.json'), JSON.stringify(data.testCases, null, 2));
    }

    // Write auto-generated README
    const readmeLines = ['# ' + (manifest.displayName || agentName), '', manifest.description || '', ''];
    if (data.systemPrompt) readmeLines.push('## System Prompt', '', 'This agent has a custom system prompt defining its behavior.', '');
    if (data.tools && data.tools.length) readmeLines.push('## Tools', '', ...data.tools.map(t => '- **' + t.name + '**: ' + (t.description || 'No description')), '');
    fs.writeFileSync(path.join(agentDir, 'README.md'), readmeLines.join('\n'));

    res.json({ ok: true, name: agentName, displayName: manifest.displayName, version: version, checksum: checksum });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save agent: ' + e.message });
  }
});

// Export agent as .zip
app.post('/api/agent-builder/export', async (req, res) => {
  const data = req.body;
  if (!data || !data.name) return res.status(400).json({ error: 'Agent name required' });
  const agentName = data.name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!agentName) return res.status(400).json({ error: 'Invalid agent name' });

  const tmp = path.join(os.tmpdir(), 'agent-export-' + Date.now());
  const agentTmp = path.join(tmp, agentName);
  try {
    fs.mkdirSync(agentTmp, { recursive: true });

    // Write manifest
    const manifest = {
      name: agentName,
      displayName: data.displayName || agentName,
      description: data.description || '',
      version: '1.0',
      category: data.category || 'other',
      icon: data.icon || 'ti-robot',
      orchestrator: data.orchestrator || false,
      permissions: data.permissions || {},
      systemPrompt: data.systemPrompt || ''
    };
    if (data.agents && Array.isArray(data.agents) && data.agents.length) {
      manifest.agents = data.agents;
    }
    fs.writeFileSync(path.join(agentTmp, 'agent.json'), JSON.stringify(manifest, null, 2));

    if (data.systemPrompt) {
      fs.writeFileSync(path.join(agentTmp, 'system-prompt.md'), data.systemPrompt);
    }

    // Bundle sub-agents from disk if they exist
    const subAgentsSrc = path.join(AGENTS_DIR, agentName, 'agents');
    if (fs.existsSync(subAgentsSrc) && fs.statSync(subAgentsSrc).isDirectory()) {
      const subAgentsTmp = path.join(agentTmp, 'agents');
      fs.mkdirSync(subAgentsTmp, { recursive: true });
      const copyRecursiveExport = (src, dst) => {
        for (const item of fs.readdirSync(src)) {
          const s = path.join(src, item);
          const d = path.join(dst, item);
          if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyRecursiveExport(s, d); }
          else fs.copyFileSync(s, d);
        }
      };
      copyRecursiveExport(subAgentsSrc, subAgentsTmp);
    }

    if (data.tools && data.tools.length) {
      const toolsDir = path.join(agentTmp, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      for (const tool of data.tools) {
        const safeName = (tool.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '');
        fs.writeFileSync(path.join(toolsDir, safeName + '.json'), JSON.stringify({ name: tool.name, description: tool.description || '', parameters: tool.parameters || {} }, null, 2));
        fs.writeFileSync(path.join(toolsDir, safeName + '.js'), tool.code || '');
      }
    }

    if (data.testCases && data.testCases.length) {
      const testsDir = path.join(agentTmp, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'test-cases.json'), JSON.stringify(data.testCases, null, 2));
    }

    // Create zip
    const zipPath = path.join(tmp, agentName + '.zip');
    execSync(`cd "${tmp}" && zip -r "${zipPath}" "${agentName}"`, { timeout: 30000 });

    const zipData = fs.readFileSync(zipPath);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${agentName}.zip"`
    });
    res.send(zipData);
  } catch (e) {
    res.status(500).json({ error: 'Export failed: ' + e.message });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Agent Store Proxy Endpoints ───────────────────────────────────────────
// Proxy requests to the store backend. The backend URL is configurable.

const STORE_BACKEND_URL = process.env.AGENT_STORE_URL || 'https://agentstore.pointlabel.com/api';

async function storeProxy(req, res, method, backendPath, body) {
  const url = STORE_BACKEND_URL + backendPath;
  const headers = { 'Accept': 'application/json' };
  if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];

  const opts = { method, headers };
  if (body instanceof Buffer || body instanceof Uint8Array) {
    // Multipart forwards
    headers['Content-Type'] = req.headers['content-type'];
    opts.body = body;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  try {
    const upstream = await fetch(url, opts);
    const ct = upstream.headers.get('content-type') || '';
    const status = upstream.status;
    if (status >= 400) {
      console.error('[storeProxy] %s %s → %d', method, backendPath, status);
    }
    if (ct.includes('json')) {
      const data = await upstream.json();
      return res.status(status).json(data);
    }
    // Binary (zip download)
    const buf = Buffer.from(await upstream.arrayBuffer());
    for (const h of ['content-type', 'content-disposition']) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    return res.status(status).send(buf);
  } catch (e) {
    res.status(502).json({ error: 'Store backend unavailable: ' + e.message });
  }
}

// Browse / search
app.get('/api/store/agents', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  storeProxy(req, res, 'GET', '/agents' + (qs ? '?' + qs : ''));
});

// Proxy zip download (streams directly from backend) — must be before :slug catch-all
app.get('/api/store/agents/:slug/zip', async (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
  try {
    const token = req.headers.authorization || '';
    const zipRes = await fetch(STORE_BACKEND_URL + '/agents/' + slug + '/download', {
      method: 'POST',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(token ? { 'Authorization': token } : {})
      },
      body: ''
    });
    if (!zipRes.ok) {
      const text = await zipRes.text();
      return res.status(zipRes.status).json({ error: 'Download failed: ' + text });
    }
    const buf = Buffer.from(await zipRes.arrayBuffer());
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="' + slug + '.zip"');
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'Zip proxy failed: ' + e.message });
  }
});

// Install
app.post('/api/store/agents/:slug/install', (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
  storeProxy(req, res, 'POST', '/agents/' + slug + '/download');
});

// Agent detail — try local installed agent first, fall back to store proxy
app.get('/api/store/agents/:slug', async (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');

  // Try to serve from locally-installed agent (avoids store round-trip)
  const localAgentDir = path.join(AGENTS_DIR, slug);
  const localManifest = path.join(localAgentDir, 'agent.json');
  if (fs.existsSync(localManifest)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(localManifest, 'utf8'));
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(localAgentDir, '.meta.json'), 'utf8')); } catch (_) {}
      return res.json({
        slug: manifest.name || slug,
        name: manifest.name || slug,
        displayName: manifest.displayName || manifest.name || slug,
        description: manifest.description || '',
        category: manifest.category || 'general',
        icon: manifest.icon || 'ti-robot',
        version: manifest.version || meta.storeVersion || '1.0',
        scanScore: manifest.scanScore ?? 90,
        author: manifest.author || meta.installedBy || '',
        installedAt: meta.installedAt || null,
        permissions: manifest.permissions || {},
        _source: 'local',
      });
    } catch (_) {}
  }

  storeProxy(req, res, 'GET', '/agents/' + slug);
});

// Agent ownership check — skip store call if agent isn't installed from store
app.get('/api/store/agents/:slug/ownership', (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
  // If no store token, no point checking
  if (!req.headers.authorization) return res.json({ owned: false, isAdmin: false });
  storeProxy(req, res, 'GET', '/agents/' + slug + '/ownership');
});

// Update agent metadata (owner or admin only)
app.put('/api/store/agents/:slug', express.json(), (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
  storeProxy(req, res, 'PUT', '/agents/' + slug, req.body);
});

// Categories
app.get('/api/store/categories', (req, res) => {
  storeProxy(req, res, 'GET', '/categories');
});

// Publish (receive multipart, forward as base64 JSON to avoid WAF blocking)
app.post('/api/store/publish', (req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      const raw = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';

      // Parse multipart to extract the file and fields
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) {
        return res.status(400).json({ error: 'Missing multipart boundary' });
      }

      const { fields, fileBuffer, fileName } = parseMultipart(raw, boundary);
      if (!fileBuffer) {
        return res.status(400).json({ error: 'No agent file found in upload' });
      }

      // Convert to base64 JSON payload
      const jsonBody = {
        agentData: fileBuffer.toString('base64'),
        fileName: fileName || 'agent.zip',
        scanScore: fields.scanScore ? parseInt(fields.scanScore, 10) : 0,
        changelog: fields.changelog || '',
      };

      console.log('[store-publish] forwarding %d bytes as base64 JSON, has-auth: %s',
        fileBuffer.length, !!req.headers['authorization']);
      storeProxy(req, res, 'POST', '/agents', jsonBody);
    } catch (e) {
      console.error('[store-publish] parse error:', e.message);
      res.status(500).json({ error: 'Failed to process upload: ' + e.message });
    }
  });
});

// Simple multipart parser — extracts first file and text fields
function parseMultipart(buffer, boundary) {
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf(sep, start);
    if (idx === -1) break;
    if (start > 0) parts.push(buffer.slice(start, idx));
    start = idx + sep.length;
    // Skip \r\n after boundary
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
  }

  const fields = {};
  let fileBuffer = null;
  let fileName = null;

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerStr = part.slice(0, headerEnd).toString('utf-8');
    const body = part.slice(headerEnd + 4);
    // Trim trailing \r\n
    const trimmed = (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a)
      ? body.slice(0, body.length - 2)
      : body;

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const fileMatch = headerStr.match(/filename="([^"]+)"/);
    if (!nameMatch) continue;

    if (fileMatch) {
      fileBuffer = trimmed;
      fileName = fileMatch[1];
    } else {
      fields[nameMatch[1]] = trimmed.toString('utf-8');
    }
  }

  return { fields, fileBuffer, fileName };
}

// Auth
app.post('/api/store/auth/login', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/auth/login', req.body);
});
app.post('/api/store/auth/register', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/auth/register', req.body);
});

// Developer dashboard — user's published agents
app.get('/api/store/dashboard/agents', (req, res) => {
  storeProxy(req, res, 'GET', '/dashboard/agents');
});

// ── Admin review routes (reviewer+) ──────────────────────────────────────
app.get('/api/store/admin/agents', (req, res) => {
  var qs = req.query.status ? '?status=' + encodeURIComponent(req.query.status) : '';
  storeProxy(req, res, 'GET', '/admin/agents' + qs);
});
app.get('/api/store/admin/agents/:id', (req, res) => {
  storeProxy(req, res, 'GET', '/admin/agents/' + req.params.id);
});
app.post('/api/store/admin/agents/:id/approve', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/approve', req.body);
});
app.post('/api/store/admin/agents/:id/reject', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/reject', req.body);
});
app.post('/api/store/admin/agents/:id/request-changes', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/request-changes', req.body);
});
app.post('/api/store/admin/agents/:id/unpublish', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/unpublish', req.body);
});
app.post('/api/store/admin/agents/:id/deprecate', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/deprecate', req.body);
});
app.delete('/api/store/admin/agents/:id', express.json(), (req, res) => {
  storeProxy(req, res, 'DELETE', '/admin/agents/' + req.params.id, req.body);
});

// ── Notification routes ──────────────────────────────────────────────────
app.get('/api/store/notifications', (req, res) => {
  storeProxy(req, res, 'GET', '/notifications');
});
app.get('/api/store/notifications/unread-count', (req, res) => {
  storeProxy(req, res, 'GET', '/notifications/unread-count');
});
app.post('/api/store/notifications/:id/read', (req, res) => {
  storeProxy(req, res, 'POST', '/notifications/' + req.params.id + '/read');
});
app.post('/api/store/notifications/read-all', (req, res) => {
  storeProxy(req, res, 'POST', '/notifications/read-all');
});

// ── Agent Sandbox Endpoints ───────────────────────────────────────────────
// These endpoints proxy the standard shell-exec, write-file, and fetch-url
// through the sandbox layer, enforcing the active agent's permissions.

// Helper: look up an agent manifest by name
function getAgentManifest(name) {
  if (!name) return null;
  const agentDir = path.join(AGENTS_DIR, name.replace(/[^a-zA-Z0-9_-]/g, ''));
  const manifestPath = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(manifestPath)) return null;
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { return null; }
}

// Sandboxed shell execution
app.post('/api/agent/shell-exec', (req, res) => {
  const { command, cwd, agentName } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (!agentName) return res.status(400).json({ error: 'agentName required' });

  // Look up permissions — check installed agents, fall back to built-in names
  const manifest = getAgentManifest(agentName);
  const permissions = manifest?.permissions || req.body.permissions || {};

  // Check shell permission
  const shellCheck = checkShellCommand(command, permissions, agentName);
  if (!shellCheck.allowed) {
    return res.status(403).json({ ok: false, error: shellCheck.reason, blocked: true });
  }

  // Run with sandboxed environment
  const workDir = cwd || os.homedir();
  const env = getSandboxedEnv(permissions);
  const limits = manifest ? getResourceLimits(manifest) : { timeout: 300000 };

  const child = _exec(command, {
    cwd: workDir, env, timeout: limits.timeout,
    maxBuffer: 10 * 1024 * 1024, shell: IS_WIN ? 'powershell.exe' : '/bin/zsh'
  }, (err, stdout, stderr) => {
    res.json({
      ok:       !err || (stdout && err?.code === 0),
      exitCode: err?.code ?? 0,
      stdout:   stdout || '',
      stderr:   stderr || '',
      command, cwd: workDir,
      sandboxed: true,
    });
  });
});

// Sandboxed file write
app.post('/api/agent/write-file', (req, res) => {
  const { filePath: fp, content, agentName, cwd } = req.body;
  if (!fp || content == null) return res.status(400).json({ error: 'filePath and content required' });
  if (!agentName) return res.status(400).json({ error: 'agentName required' });

  const manifest = getAgentManifest(agentName);
  const permissions = manifest?.permissions || req.body.permissions || {};

  let absPath;
  try { absPath = resolvePath(fp, cwd); } catch (e) {
    return res.status(403).json({ ok: false, error: e.message, blocked: true });
  }

  const writeCheck = checkFilePath(absPath, 'write', permissions, agentName);
  if (!writeCheck.allowed) {
    return res.status(403).json({ ok: false, error: writeCheck.reason, blocked: true });
  }

  try {
    checkpointFile(absPath);
    atomicWriteFile(absPath, content, 'utf8');
    audit(agentName, 'file-write', absPath, true);
    res.json({ ok: true, path: absPath, sandboxed: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sandboxed file read
app.post('/api/agent/read-file', (req, res) => {
  const { filePath: fp, agentName } = req.body;
  if (!fp) return res.status(400).json({ error: 'filePath required' });
  if (!agentName) return res.status(400).json({ error: 'agentName required' });

  const manifest = getAgentManifest(agentName);
  const permissions = manifest?.permissions || req.body.permissions || {};

  let absPath;
  try { absPath = resolvePath(fp); } catch (e) {
    return res.status(403).json({ ok: false, error: e.message, blocked: true });
  }

  const readCheck = checkFilePath(absPath, 'read', permissions, agentName);
  if (!readCheck.allowed) {
    return res.status(403).json({ ok: false, error: readCheck.reason, blocked: true });
  }

  try {
    const content = fs.readFileSync(absPath, 'utf8');
    audit(agentName, 'file-read', absPath, true);
    res.json({ ok: true, content, path: absPath, sandboxed: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sandboxed URL fetch (proxy through domain allowlist)
app.post('/api/agent/fetch-url', async (req, res) => {
  const { url, agentName } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!agentName) return res.status(400).json({ error: 'agentName required' });

  const manifest = getAgentManifest(agentName);
  const permissions = manifest?.permissions || req.body.permissions || {};

  // Check network permission
  const netCheck = checkNetworkAccess(url, permissions, agentName);
  if (!netCheck.allowed) {
    return res.status(403).json({ ok: false, error: netCheck.reason, blocked: true });
  }

  // Also run the existing SSRF check
  try { validateExternalUrl(url); } catch (e) {
    return res.status(403).json({ ok: false, error: e.message, blocked: true });
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CopilotChat/1.0)' },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    const text = await response.text();
    res.json({ ok: true, content: text, status: response.status, sandboxed: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Audit log viewer
app.get('/api/agent/audit-log', (req, res) => {
  const agent = req.query.agent || null;
  const limit = parseInt(req.query.limit) || 100;
  res.json({ log: getAuditLog(agent, limit) });
});

// ── Desktop organizer ─────────────────────────────────────────────────────
// Categorises files on ~/Desktop and moves them into named subfolders.
// dryRun=true returns the plan without touching the filesystem.

const ORGANIZE_RULES = [
  { folder: 'Screenshots',       test: n => /^Screenshot\s/.test(n) && /\.(png|jpg|jpeg)$/i.test(n) },
  { folder: 'Screen Recordings', test: n => /\.(mov|mp4|mkv|webm)$/i.test(n) },
  { folder: 'Images',            test: n => /\.(png|jpg|jpeg|gif|webp|heic|svg|tiff|bmp)$/i.test(n) },
  { folder: 'Documents',         test: n => /\.(pdf|doc|docx|txt|pages|xls|xlsx|csv|ppt|pptx|numbers|key|rtf|md)$/i.test(n) },
  { folder: 'Archives',          test: n => /\.(zip|tar|gz|bz2|dmg|pkg|rar|7z)$/i.test(n) },
  { folder: 'Code',              test: n => /\.(js|ts|py|rb|sh|zsh|bash|json|html|css|swift|go|rs|cpp|c|h|java)$/i.test(n) },
];

app.post('/api/organize-desktop', (req, res) => {
  const dryRun  = req.body?.dryRun !== false; // default dry-run for safety
  const desktop = path.join(os.homedir(), 'Desktop');

  let entries;
  try { entries = fs.readdirSync(desktop); }
  catch (e) { return res.json({ ok: false, error: e.message }); }

  const moves    = [];  // { file, from, to, folder }
  const skipped  = [];  // dirs or unmatched

  for (const name of entries) {
    const fullPath = path.join(desktop, name);
    let stat;
    try { stat = fs.statSync(fullPath); } catch (_) { continue; }
    if (stat.isDirectory()) { skipped.push(name); continue; }

    const rule = ORGANIZE_RULES.find(r => r.test(name));
    if (rule) {
      moves.push({ file: name, from: fullPath, to: path.join(desktop, rule.folder, name), folder: rule.folder });
    } else {
      skipped.push(name);
    }
  }

  if (!dryRun) {
    const created = new Set();
    const done = [], errors = [];
    for (const m of moves) {
      try {
        const dir = path.dirname(m.to);
        if (!created.has(dir)) { fs.mkdirSync(dir, { recursive: true }); created.add(dir); }
        // Avoid overwriting: rename if destination exists
        let dest = m.to;
        if (fs.existsSync(dest)) {
          const ext  = path.extname(m.file);
          const base = path.basename(m.file, ext);
          dest = path.join(path.dirname(dest), `${base}_${Date.now()}${ext}`);
        }
        fs.renameSync(m.from, dest);
        done.push({ ...m, to: dest });
      } catch (e) {
        errors.push({ file: m.file, error: e.message });
      }
    }
    return res.json({ ok: true, dryRun: false, moved: done.length, done, errors, skipped });
  }

  res.json({ ok: true, dryRun: true, moves, skipped,
    summary: Object.entries(moves.reduce((acc, m) => {
      acc[m.folder] = (acc[m.folder] || 0) + 1; return acc;
    }, {})).map(([f, c]) => `${f} (${c})`).join(', ')
  });
});

// ── System context ────────────────────────────────────────────────────────
// Returns enough system info for the AI to build an accurate context prompt.

app.get('/api/system-context', (req, res) => {
  const { auth, screenRecording, accessibility, fullDiskAccess, automation } = (() => {
    const r = {};
    try { getGhToken(); r.auth = 'granted'; } catch (_) { r.auth = 'denied'; }
    if (IS_WIN) {
      r.screenRecording = 'not-applicable';
      r.accessibility   = 'not-applicable';
      r.fullDiskAccess  = 'not-applicable';
      r.automation      = 'not-applicable';
    } else {
      r.screenRecording = systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown';
      r.accessibility   = (systemPreferences?.isTrustedAccessibilityClient?.(false) === true) ? 'granted' : 'denied';
      r.fullDiskAccess  = checkFullDiskAccess();
      r.automation      = 'auto-prompted';
    }
    return r;
  })();

  // Collect installed agents (name + displayName only)
  const installedAgents = [];
  try {
    for (const entry of fs.readdirSync(AGENTS_DIR)) {
      const mp = path.join(AGENTS_DIR, entry, 'agent.json');
      if (fs.existsSync(mp)) {
        try {
          const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
          if (!m._parentAgent) installedAgents.push({ name: m.name || entry, displayName: m.displayName || m.name || entry });
        } catch (_) {}
      }
    }
  } catch (_) {}

  res.json({
    os:       IS_WIN ? 'Windows' : 'macOS',
    release:  os.release(),
    hostname: os.hostname(),
    user:     os.userInfo().username,
    home:     os.homedir(),
    desktop:  path.join(os.homedir(), 'Desktop'),
    cwd:      process.cwd(),
    shell:    SHELL_BIN,
    permissions: { auth, screenRecording, accessibility, fullDiskAccess, automation },
    installedAgents,
  });
});

// ── macOS Permissions check ───────────────────────────────────────────────

function checkFullDiskAccess() {
  if (IS_WIN) return 'not-applicable';  // macOS-only permission concept
  // Probe files that are always protected by Full Disk Access on macOS 10.15+
  const probes = [
    path.join(os.homedir(), 'Library', 'Safari', 'History.db'),
    path.join(os.homedir(), 'Library', 'Messages', 'chat.db'),
    '/Library/Application Support/com.apple.TCC/TCC.db',
  ];
  for (const p of probes) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return 'granted';
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return 'denied';
      // ENOENT = file doesn't exist but we had access — try next probe
    }
  }
  return 'not-determined';
}

app.get('/api/permissions', (req, res) => {
  const result = {};

  // GitHub auth
  try { getGhToken(); result.auth = 'granted'; }
  catch (_) { result.auth = 'denied'; }

  if (IS_WIN) {
    // macOS-only permissions do not exist on Windows — mark them so the UI hides them
    result.screenRecording = 'not-applicable';
    result.accessibility   = 'not-applicable';
    result.fullDiskAccess  = 'not-applicable';
    result.automation      = 'not-applicable';
  } else {
    // Screen Recording — Electron systemPreferences API
    result.screenRecording = systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown';

    // Accessibility — Electron systemPreferences API
    result.accessibility = (systemPreferences?.isTrustedAccessibilityClient?.(false) === true)
      ? 'granted' : 'denied';

    // Full Disk Access — file system probe
    result.fullDiskAccess = checkFullDiskAccess();

    // Automation — marked as auto-prompted (can't check without potentially prompting)
    result.automation = 'auto-prompted';
  }

  res.json(result);
});

// Trigger Screen Recording permission prompt via desktopCapturer
app.post('/api/permissions/request-screen', async (req, res) => {
  try {
    if (!desktopCapturer) throw new Error('desktopCapturer not available');
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    const status = systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown';
    res.json({ status });
  } catch (e) {
    res.json({ status: systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown', error: e.message });
  }
});

// ── Memory / Skill Categories ─────────────────────────────────────────────
// Structured as categories (tools) each containing skill groups.
// Shape: [ { id, name, icon, enabled, builtIn, groups: [{id, title, body, enabled}] } ]

const MEMORY_FILE = path.join(CONFIG_DIR, 'memory.json');
const PREFS_FILE  = path.join(CONFIG_DIR, 'preferences.json');

function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); }
  catch (_) { return { playbook: [], agentRules: [], systemPrompt: '' }; }
}
function savePrefs(patch) {
  const current = loadPrefs();
  fs.writeFileSync(PREFS_FILE, JSON.stringify({ ...current, ...patch }, null, 2));
}

function defaultFigmaGroups() {
  return [];
}

// Original built-in Figma spec groups (kept for reference / manual restore via Reset Built-in)
function _builtInFigmaGroupsRef() {
  return [
    { id: 'workflow',           title: 'Workflow — When User Asks to Create a Spec', body: 'When the user asks to create a design/component spec:\n1. **Resolve component instance first**: Before generating any spec, determine if you have a component key or node ID for the target component. Check if the user provided one, or if you can find it via `get_design_context`/`get_metadata`. **If the component instance is NOT available**, prompt the user: _"Please select the component in Figma (or provide the component key/node ID) so I can include live instances in the anatomy, variants, and examples sections."_ Do NOT proceed until the component reference is resolved.\n2. **If Figma MCP is enabled**: Ask the user whether they want the spec created **in Figma** or **as a markdown artifact**.\n3. **If Figma MCP is not enabled**: Generate the spec as a markdown artifact using the markdown format below.\n4. **ALWAYS use the `figma_execute` MCP tool** for Figma output — never use `figma-exec` fenced blocks for spec creation.', enabled: true },
    { id: 'build-sequence',     title: 'Figma Build Sequence', body: '1. **Create page**: `figma.createPage()` → set name → `figma.currentPage = page`\n2. **Splash card** at x=-1300: import splash key, set properties (Guidance Checklist#12857:0=false, Contact list#357:0=false, Resource list#357:1=false, Custom#10144:1=true), override text nodes ("Component name", description, kind label)\n3. **6 sections** side-by-side: each at x = index * 1300 (1200px + 100px gap)\n   - Root frame: 1200px wide, VERTICAL, primaryAxisSizingMode=AUTO, counterAxisSizingMode=FIXED, itemSpacing=0, fills=[white], cornerRadius=32\n   - GuidanceHeader instance: layoutAlign=STRETCH, find TEXT nodes named "Title" → [0]=number, [1]=title\n   - Page frame: 1200px, VERTICAL, itemSpacing=32, padding 64/88/64/88, fills=[#FAFAFA], layoutAlign=STRETCH\n   - Content blocks inside Page frame\n4. **Zoom to fit**: `figma.viewport.scrollAndZoomIntoView(allFrames)`', enabled: true },
    { id: 'instance-placement', title: 'Component Instance Placement', body: '### Anatomy (Overview section)\n1. Import the target component via `figma.importComponentByKeyAsync(componentKey)` and create an instance.\n2. Place the instance inside the Overview page frame, below the anatomy text descriptions.\n3. Add numbered annotation markers (small circles with numbers) positioned over each anatomy part.\n4. Cap width to 1024px: `if (inst.width > 1024) inst.rescale(1024 / inst.width)`\n\n### Variants (Overview section)\n1. Retrieve all variant properties from the component set.\n2. For each meaningful variant combination, create an instance and set its variant properties via `inst.setProperties({...})`.\n3. Label each instance with a text node showing the variant/config name.\n4. Arrange instances in a grid or vertical stack inside the Overview page frame.\n5. If variant properties are not discoverable, prompt the user.\n\n### Examples section\n1. For each example entry, create a component instance configured to match the described state/scenario.\n2. Set variant properties to reflect the example\'s state.\n3. Place the instance adjacent to or below the example\'s text description.\n4. If the component key is unavailable, prompt the user before generating this section.\n\n### Fallback: Prompting the User\nIf the component key, node ID, or variant information is not available:\n- **Do NOT skip** the instance — pause and ask the user.\n- Resume spec generation only after the component reference is resolved.', enabled: true },
    { id: 'font-loading',       title: 'Font Loading Helper', body: 'REQUIRED before setting .characters — use this exact helper:\n```js\nasync function loadFont(textNode) {\n    const fn = textNode.fontName;\n    try { await figma.loadFontAsync(fn); return; } catch(_) {}\n    const parts = fn.style.split(\' \');\n    if (parts.length >= 2) {\n        const reversed = { family: fn.family, style: parts.reverse().join(\' \') };\n        try { await figma.loadFontAsync(reversed); textNode.fontName = reversed; return; } catch(_) {}\n    }\n    const synonyms = {Demibold:\'Semibold\', Semibold:\'Demibold\', Medium:\'Regular\', Heavy:\'Bold\', Black:\'Bold\', ExtraBold:\'Bold\'};\n    for (const [from, to] of Object.entries(synonyms)) {\n        if (fn.style.includes(from)) {\n            const alt = { family: fn.family, style: fn.style.replace(from, to) };\n            try { await figma.loadFontAsync(alt); textNode.fontName = alt; return; } catch(_) {}\n        }\n    }\n    const s = fn.style.toLowerCase();\n    const w = s.includes(\'bold\') ? \'Bold\' : s.includes(\'semi\') || s.includes(\'demi\') ? \'Semibold\' : \'Regular\';\n    const fb = { family: \'Segoe UI\', style: w };\n    await figma.loadFontAsync(fb); textNode.fontName = fb;\n}\n```', enabled: true },
    { id: 'text-overrides',     title: 'Text Block Overrides', body: 'CRITICAL: No placeholder text may remain.\n- After creating ANY component instance, MUST find ALL text nodes and override them:\n  `const texts = inst.findAll(n => n.type === \'TEXT\');`\n- texts[0] = title, texts[1] = body — ALWAYS call `loadFont(texts[N])` then set `.characters`\n- If no title needed: `texts[0].characters = \'\'` and `inst.setProperties({\'Show title#10151:2\': false})`\n- If no body needed: `texts[1].characters = \'\'` and `inst.setProperties({\'Show body#10151:8\': false})`\n- Default placeholders like "Section title L", "Body text M", "Heading XXL" WILL show if you skip this', enabled: true },
    { id: 'component-blocks',   title: 'Component Instance Blocks', body: '- Import via `figma.importComponentByKeyAsync(component_key)`, call `.createInstance()`\n- Set `layoutAlign = \'CENTER\'`, set name if provided\n- Toggle boolean properties: `inst.setProperties({ \'PropertyName#id\': true/false })`\n- Cap width: `if (inst.width > 1024) inst.rescale(1024 / inst.width)`', enabled: true },
    { id: 'data-model',         title: 'Spec Data Model (6 Sections)', body: '### 1. Overview\n- `component_name`: string\n- `description`: 1-3 sentence description\n- `anatomy_parts`: list of `{number, name, description}`\n- `anatomy_instance`: **REQUIRED** — annotated live instance with numbered annotation markers\n- `variants`: list of variant/state names\n- `variant_instances`: **REQUIRED** — live instances for EVERY variant and configuration\n- `live_preview`: optional component instance reference\n\n### 2. Content\n- `guidance`: `{date_format, punctuation, heading_text, capitalization, overflow_menu_suggestions[], footer_button_suggestions[]}`\n- `examples`: list of `{context, annotations[], guidelines[], live_preview?}`\n\n### 3. Usage\n- `when_to_use`: list of strings\n- `when_not_to_use`: list of strings\n- `dos`: list of `{label, description}`\n- `donts`: list of `{label, description}`\n- `placement`: string\n\n### 4. Accessibility\n- `guidelines`: prose string\n- `keyboard_interactions`: list of `{key, action}`\n- `tab_order`: ordered list of tab stop strings\n- `narration_entries`: list of `{number, key, state, narrator_string}`\n\n### 5. Examples\n- `examples`: list of `{title, description, state, live_preview?}`\n- `example_instances`: **REQUIRED** — live component instance per example\n\n### 6. RAI (Responsible AI)\n- `citations_and_references`: string\n- `ai_disclaimer`: string\n- `principles`: list of `{name, description}`', enabled: true },
    { id: 'component-keys',     title: 'Component Keys (KEYS dict)', body: '- `header`: `c92557049724bf0d8726c1a34563ef7a3b5b6e70` — UTIL-GuidanceHeader\n- `text_xxl`: `b7aef3e443b5804c628d08afb00dc43d9cb871f8` — UTIL-GuidanceTextBlock Style=XXL\n- `text_l`: `3e8e9cfe13596cd04f09d8dce37d0fbfc8a63644` — UTIL-GuidanceTextBlock Style=L\n- `text_m`: `196ec978c2bbad76accfce02b7da49e531779de5` — UTIL-GuidanceTextBlock Style=M\n- `text_s`: `7ebd43d5387e9597987dfa86ac4306e76d4b468d` — UTIL-GuidanceTextBlock Style=S\n- `buffer`: `e6adb6c3061e04f438d8aacd23252882b3bda616` — Blocks / Buffer (divider)\n- `best_do_header`: `ec326f63f5ea0c33b6cf941857ef16e368484327` — Do header\n- `best_dont_header`: `8a1b46b982d9f69f3b564c0b68160db5cbd157c4` — Don\'t header\n- `best_do_bullet`: `afee6ebe1fd335e8a4380aa58b1de282abb794bc` — Do bullet\n- `best_dont_bullet`: `fb2df191ed6cd41418d85550e1a22a90a47f5562` — Don\'t bullet\n- `splash`: `076bea735b162eaa152d9df6b37b75ec2bed315b` — UTIL-GuidanceComponentSplash (cover card)\n- `footer`: `324a9470b9d637ed69401111ab277e01346d606a` — UTIL-GuidanceFooter', enabled: true },
    { id: 'design-tokens',      title: 'Design Token Variable Keys', body: '### Backgrounds\n- `bg1`: `4a08218e9cddb87bafa9b83f73e6ee40f5e15e3e` — Neutral/Background/1/Rest (#fff)\n- `bg2`: `0fa4c8c8fc13d3e98f827a96f25168a46cf5adc9` — Neutral/Background/2/Rest\n- `bg3`: `16a0b41baa19d91b71f810dbce608a7b86bde49f` — Neutral/Background/3/Rest\n- `bg4`: `97aa51374458940b6d7b66c1a8e91186e386bf15` — Neutral/Background/4/Rest\n### Foregrounds\n- `fg1`: `fbc35e3f43dd8dad7a0c8b48e7c547058ecc651c` — Neutral/Foreground/1 (#242424)\n- `fg2`: `42e6c2df6cd2a75d6aa36c4e56b3b38ea0d3f4c0` — Neutral/Foreground/2 (#424242)\n- `fg3`: `af92c07f44a2bcab9ee3d6d87c1fffc9a3fb0c35` — Neutral/Foreground/3 (#616161)\n### Spacing\n- `spacing_s`: `2cfecff21b7f4aa80cac71e6f13a1f79e6e3d85a` — 8px\n- `spacing_m`: `a15a3dae66bae06f1c0f7d5f88c02d8cca3adac0` — 12px\n- `spacing_l`: `d80ff8c9f6ad5e92c18f0c1a1b9d2aef9b736ef6` — 16px\n- `spacing_xxl`: `f55b0ced58de9daba5d5e66e0e3b85dc6deab53a` — 24px\n### Corner Radius\n- `corner_section`: `1cc316818f4f64417e936f0d49cc6288620a347f` — 12px', enabled: true },
    { id: 'font-presets',       title: 'Font Presets (TYPO dict)', body: '- `heading_large`: Segoe UI, 32px, 40px, Bold\n- `heading_medium`: Segoe UI, 24px, 32px, Semibold\n- `heading_small`: Segoe UI, 20px, 28px, Semibold\n- `subtitle`: Segoe UI, 16px, 22px, Semibold\n- `body1`: Segoe UI, 14px, 20px, Regular\n- `body1_strong`: Segoe UI, 14px, 20px, Semibold\n- `caption1`: Segoe UI, 12px, 16px, Regular\n- `caption2_strong`: Segoe UI, 10px, 14px, Semibold', enabled: true },
    { id: 'rendering-format',   title: 'Rendering Format (Figma & Markdown)', body: '### Figma Rendering\n- Each section is a 1200px-wide vertical auto-layout frame with rounded corners (32px)\n- Sections placed side-by-side with 100px gaps\n- Cover card (UTIL-GuidanceComponentSplash) placed at x=-1300\n- Each section has: UTIL-GuidanceHeader (number + title) → "Page" content frame (88px padding, 32px item spacing, #FAFAFA bg)\n- Content blocks use these component types: text_xxl, text_l, text_m, text_s, buffer (divider), do_header, dont_header, do_bullet, dont_bullet, component_instance\n- Section order: Overview → Usage → Examples → Accessibility → Content → RAI\n- Font loading: use `figma.loadFontAsync(textNode.fontName)` with fallback to reversed style names, then Segoe UI Bold/Semibold/Regular\n\n### Markdown Rendering\n```\n# ComponentName\n> Description\n\n## Anatomy (table: #, Part, Description)\n## Anatomy Instance (annotated live component)\n## Variants (bullet list + live instances)\n---\n# Content\n## Additional guidance\n## Examples of content\n---\n# Usage\n## When to use / When not to use\n## Do / Don\'t\n## Placement\n---\n# Accessibility\n## Accessibility guidelines\n## Keyboarding\n### Tab order\n## Narration\n---\n# Examples (title, description, live instance)\n---\n# RAI\n## Citations and references\n## AI disclaimer\n## RAI Principles\n```', enabled: true },
  ];
}

function defaultMemoryCategories() {
  return [];
}

// Migration: if saved data is flat array of groups (old format), wrap into category
function migrateMemoryData(data) {
  if (!Array.isArray(data) || data.length === 0) return defaultMemoryCategories();
  // Old format: [{id, title, body, enabled}] — no "groups" key on first element
  if (data[0] && !data[0].groups && data[0].body !== undefined) {
    return [{ id: 'figma-spec-design', name: 'Figma Spec Design', icon: 'brand-figma', enabled: true, builtIn: true, groups: data }];
  }
  return data;
}

function loadMemoryCategories() {
  try {
    const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    return migrateMemoryData(raw);
  } catch (_) {}
  return defaultMemoryCategories();
}

function saveMemoryCategories(categories) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(categories, null, 2));
}

// GET — return all categories
app.get('/api/memory', (req, res) => {
  res.json(loadMemoryCategories());
});

// ── Preferences (playbook + agent rules + system prompt) ──────────────────
app.get('/api/preferences', (req, res) => {
  res.json(loadPrefs());
});

app.put('/api/preferences', (req, res) => {
  const patch = req.body;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    return res.status(400).json({ error: 'Expected object' });
  savePrefs(patch);
  res.json({ ok: true });
});

// PUT — save all categories (full replace)
app.put('/api/memory', (req, res) => {
  const cats = req.body;
  if (!Array.isArray(cats)) return res.status(400).json({ error: 'Expected array of categories' });
  saveMemoryCategories(cats);
  res.json({ ok: true });
});

// POST — create a new category
app.post('/api/memory/category', (req, res) => {
  const { name, icon } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name required' });
  const cats = loadMemoryCategories();
  const id = 'cat-' + Date.now();
  const keywords = Array.isArray(req.body.keywords) ? req.body.keywords : [];
  const cat = { id, name: name.trim(), icon: icon || 'tools', enabled: true, builtIn: false, keywords, groups: [] };
  cats.push(cat);
  saveMemoryCategories(cats);
  res.json({ ok: true, category: cat });
});

// DELETE — delete a category by id
app.delete('/api/memory/category/:catId', (req, res) => {
  const cats = loadMemoryCategories();
  const idx = cats.findIndex(c => c.id === req.params.catId);
  if (idx === -1) return res.status(404).json({ error: 'Category not found' });
  cats.splice(idx, 1);
  saveMemoryCategories(cats);
  res.json({ ok: true });
});

// PATCH — update a category (name, icon, enabled) or a group within it
app.patch('/api/memory/category/:catId', (req, res) => {
  const cats = loadMemoryCategories();
  const cat = cats.find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const { name, icon, enabled, keywords } = req.body;
  if (name !== undefined) cat.name = name;
  if (icon !== undefined) cat.icon = icon;
  if (enabled !== undefined) cat.enabled = enabled;
  if (keywords !== undefined) cat.keywords = Array.isArray(keywords) ? keywords : [];
  saveMemoryCategories(cats);
  res.json({ ok: true, category: cat });
});

// POST — add a skill group to a category
app.post('/api/memory/category/:catId/group', (req, res) => {
  const cats = loadMemoryCategories();
  const cat = cats.find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const { title, body } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Group title required' });
  const group = { id: 'grp-' + Date.now(), title: title.trim(), body: body || '', enabled: true };
  cat.groups.push(group);
  saveMemoryCategories(cats);
  res.json({ ok: true, group });
});

// PATCH — update a group within a category
app.patch('/api/memory/category/:catId/group/:grpId', (req, res) => {
  const cats = loadMemoryCategories();
  const cat = cats.find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const grp = cat.groups.find(g => g.id === req.params.grpId);
  if (!grp) return res.status(404).json({ error: 'Group not found' });
  Object.assign(grp, req.body);
  saveMemoryCategories(cats);
  res.json({ ok: true, group: grp });
});

// DELETE — remove a group from a category
app.delete('/api/memory/category/:catId/group/:grpId', (req, res) => {
  const cats = loadMemoryCategories();
  const cat = cats.find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const idx = cat.groups.findIndex(g => g.id === req.params.grpId);
  if (idx === -1) return res.status(404).json({ error: 'Group not found' });
  cat.groups.splice(idx, 1);
  saveMemoryCategories(cats);
  res.json({ ok: true });
});

// POST — reset built-in categories to defaults (preserves user-created categories)
app.post('/api/memory/reset', (req, res) => {
  const cats = loadMemoryCategories();
  const defaults = defaultMemoryCategories();
  // Replace built-in categories with defaults, keep user-created ones
  const userCats = cats.filter(c => !c.builtIn);
  const result = [...defaults, ...userCats];
  saveMemoryCategories(result);
  res.json({ ok: true, categories: result, defaults });
});

// ── Structured Facts Memory ───────────────────────────────────────────────
// Individual facts the AI learns about the user, with decay and recall scoring.

app.get('/api/facts', (req, res) => {
  const category = req.query.category || null;
  res.json(listFacts(category));
});

app.get('/api/facts/stats', (req, res) => {
  res.json(factsGetStats());
});

app.post('/api/facts', (req, res) => {
  const { text, category } = req.body || {};
  const result = factsRemember(text, category);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/facts/recall', (req, res) => {
  const { keywords } = req.body || {};
  const results = factsRecall(keywords);
  res.json(results);
});

app.delete('/api/facts/:id', (req, res) => {
  const result = factsForget(req.params.id);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.post('/api/facts/decay', (req, res) => {
  const maxAgeDays = req.body?.maxAgeDays || undefined;
  const result = runDecay(maxAgeDays);
  res.json(result);
});

app.get('/api/facts/export', (req, res) => {
  res.json(exportFacts());
});

app.post('/api/facts/import', (req, res) => {
  const facts = req.body;
  if (!Array.isArray(facts)) return res.status(400).json({ error: 'Expected array of facts' });
  const result = importFacts(facts);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// ── Heartbeat Monitoring ──────────────────────────────────────────────────

app.get('/api/heartbeat/settings', (req, res) => {
  res.json(hbGetSettings());
});

app.put('/api/heartbeat/settings', (req, res) => {
  const settings = hbUpdateSettings(req.body);
  res.json(settings);
});

app.get('/api/heartbeat/log', (req, res) => {
  res.json(hbGetLog());
});

app.post('/api/heartbeat/clear-log', (req, res) => {
  hbClearLog();
  res.json({ ok: true });
});

app.post('/api/heartbeat/run-now', async (req, res) => {
  try {
    const result = await runHeartbeat(true);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Scheduled Workflows ───────────────────────────────────────────────────

app.get('/api/workflows', (req, res) => {
  res.json(getAllWorkflows());
});

app.post('/api/workflows', (req, res) => {
  const wf = createWorkflow(req.body);
  res.json(wf);
});

app.get('/api/workflows/:id', (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  res.json(wf);
});

app.put('/api/workflows/:id', (req, res) => {
  const wf = updateWorkflow(req.params.id, req.body);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  res.json(wf);
});

app.delete('/api/workflows/:id', (req, res) => {
  const ok = deleteWorkflow(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Workflow not found' });
  res.json({ ok: true });
});

app.post('/api/workflows/:id/run-now', async (req, res) => {
  try {
    const result = await runWorkflow(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/workflows/:id/history', (req, res) => {
  res.json(wfGetHistory(req.params.id));
});

app.post('/api/workflows/parse-schedule', (req, res) => {
  const { text } = req.body || {};
  res.json(parseSchedule(text));
});

// ── Permission Guard ──────────────────────────────────────────────────────

app.get('/api/permissions/auto-allow', (req, res) => {
  res.json(getAutoAllowList());
});

app.post('/api/permissions/auto-allow', (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });
  addAutoAllow(command);
  res.json({ ok: true });
});

app.delete('/api/permissions/auto-allow', (req, res) => {
  const { command } = req.body || {};
  if (command) removeAutoAllow(command);
  else clearAutoAllow();
  res.json({ ok: true });
});

app.post('/api/permissions/check', (req, res) => {
  const { command } = req.body || {};
  res.json({ safe: isCommandSafe(command) });
});

// ── Teams Self-Chat Bridge ────────────────────────────────────────────────

app.get('/api/teams/settings', (req, res) => {
  res.json(getTeamsSettings());
});

app.put('/api/teams/settings', (req, res) => {
  const settings = updateTeamsSettings(req.body);
  res.json(settings);
});

app.post('/api/teams/test', async (req, res) => {
  try {
    const result = await teamsTestConnection();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger Accessibility permission prompt
app.post('/api/permissions/request-accessibility', (req, res) => {
  try {
    const trusted = systemPreferences?.isTrustedAccessibilityClient?.(true); // true = show prompt
    res.json({ status: trusted ? 'granted' : 'denied' });
  } catch (e) {
    res.json({ status: 'denied', error: e.message });
  }
});

// ── Region capture ────────────────────────────────────────────────────────
app.post('/api/capture-region', async (req, res) => {
  try {
    if (!_ElectronBrowserWindow || !desktopCapturer) {
      return res.status(503).json({ error: 'Capture requires Electron' });
    }
    const { screen, ipcMain } = _require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const scaleFactor = primaryDisplay.scaleFactor;

    // Hide main window briefly
    const wins = _ElectronBrowserWindow.getAllWindows();
    const mainWin = wins.find(w => !w.isDestroyed() && w.getTitle() !== 'Region Capture');
    const wasVisible = mainWin?.isVisible();
    if (wasVisible) mainWin.hide();
    await new Promise(r => setTimeout(r, 200));

    // Full-screen capture
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: width * scaleFactor, height: height * scaleFactor },
    });
    if (!sources.length) {
      if (wasVisible) mainWin.show();
      return res.json({ cancelled: true, error: 'No screen source found' });
    }
    const fullScreenshot = sources[0].thumbnail;

    // Overlay for region selection
    const overlay = new _ElectronBrowserWindow({
      x: 0, y: 0, width, height,
      frame: false, transparent: true, alwaysOnTop: true,
      fullscreen: true, skipTaskbar: true, resizable: false, hasShadow: false,
      title: 'Region Capture',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    const overlayPath = path.join(__dirname, 'public', 'capture-overlay.html');
    await overlay.loadFile(overlayPath);
    overlay.webContents.send('set-screenshot', fullScreenshot.toDataURL());

    const captureResult = await new Promise((resolve) => {
      ipcMain.once('capture-region-result', (_event, rect) => {
        overlay.close();
        if (wasVisible) mainWin.show();
        if (!rect) return resolve({ cancelled: true });
        const cropRect = {
          x: Math.round(rect.x * scaleFactor),
          y: Math.round(rect.y * scaleFactor),
          width: Math.round(rect.width * scaleFactor),
          height: Math.round(rect.height * scaleFactor),
        };
        const cropped = fullScreenshot.crop(cropRect);
        const base64 = cropped.toDataURL().replace(/^data:image\/png;base64,/, '');
        resolve({ base64, width: rect.width, height: rect.height });
      });
      overlay.webContents.on('before-input-event', (_event, input) => {
        if (input.key === 'Escape') ipcMain.emit('capture-region-result', null, null);
      });
    });
    res.json(captureResult);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Shell stdin ───────────────────────────────────────────────────────────
// POST { killId, input } → writes input to a running streaming shell process
app.post('/api/shell-stdin', (req, res) => {
  const { killId, input } = req.body || {};
  if (!killId) return res.status(400).json({ error: 'killId required' });
  const child = _shellProcs.get(killId);
  if (!child) return res.status(404).json({ error: 'process not found' });
  try {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.write((input || '') + '\n');
      res.json({ ok: true });
    } else {
      res.status(409).json({ error: 'stdin not available for this process' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Preview-file existence check ──────────────────────────────────────────
// HEAD /api/preview-file?path=... → 200 if file exists, 404 if not
app.head('/api/preview-file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).end();
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(os.homedir(), filePath);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.status(200).end();
    } else {
      res.status(404).end();
    }
  } catch (_) {
    res.status(404).end();
  }
});

// ── Serve local media file (proxy for renderer — file:// is blocked by CSP) ──
// GET /api/serve-media?path=<abs-path> — streams file with Range support
app.get('/api/serve-media', (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath) return res.status(400).end();
  try {
    let abs = path.isAbsolute(rawPath) ? rawPath
              : rawPath.startsWith('~') ? path.join(os.homedir(), rawPath.slice(1))
              : path.join(os.homedir(), rawPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      // Fallback: macOS screen recordings use U+202F (narrow no-break space) before AM/PM.
      // If the exact path fails, scan the directory with whitespace-normalized comparison.
      const dir      = path.dirname(abs);
      const basename = path.basename(abs);
      const normalize = s => s.normalize('NFC').replace(/[\u00A0\u2009\u202F\u2007\u200A\uFEFF\u2060]/g, ' ');
      let resolved = null;
      try {
        const entries = fs.readdirSync(dir);
        const match   = entries.find(e => normalize(e) === normalize(basename));
        if (match) resolved = path.join(dir, match);
      } catch (_) {}
      if (!resolved) return res.status(404).end();
      abs = resolved;
    }

    const ext  = path.extname(abs).toLowerCase().slice(1);
    const mime = {
      mp4:'video/mp4', mov:'video/quicktime', webm:'video/webm', mkv:'video/x-matroska', avi:'video/x-msvideo',
      mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', aac:'audio/aac', m4a:'audio/mp4', flac:'audio/flac',
      png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml',
    }[ext] || 'application/octet-stream';

    const stat  = fs.statSync(abs);
    const total = stat.size;
    const range = req.headers.range;

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024 - 1, total - 1);
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${total}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   mime,
      });
      fs.createReadStream(abs, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': total, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(abs).pipe(res);
    }
  } catch (e) {
    res.status(500).end();
  }
});

// ── Pick-folder dialog ────────────────────────────────────────────────────
// POST {} → { ok, folderPath } — shows native folder picker (Electron only)
app.post('/api/pick-folder', async (req, res) => {
  try {
    const { dialog, BrowserWindow } = _require('electron');
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win || undefined, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.cancelled || !result.filePaths || !result.filePaths.length) {
      return res.json({ ok: false, cancelled: true });
    }
    res.json({ ok: true, folderPath: result.filePaths[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Open URL in default browser ───────────────────────────────────────────
// POST { url } → opens URL using Electron shell or macOS 'open'
app.post('/api/open-url', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  // Basic URL validation — only allow http/https
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Only http/https URLs allowed' });
  try {
    const { shell } = _require('electron');
    await shell.openExternal(url);
    res.json({ ok: true });
  } catch (_) {
    // Fallback for non-Electron (dev mode)
    try {
      const opener = IS_WIN ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      _exec(`${opener} ${JSON.stringify(url)}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
});

// ── Bundled binary path lookup ────────────────────────────────────────────
// GET /api/bundled-bin/:bin → { path } — resolves bundled MCP binary path
app.get('/api/bundled-bin/:bin', (req, res) => {
  const binName = req.params.bin;
  // Search in node_modules/.bin and common paths
  const candidates = [
    path.join(__dirname, 'node_modules', '.bin', binName),
    path.join(__dirname, 'node_modules', '.bin', binName + (IS_WIN ? '.cmd' : '')),
    path.join(process.resourcesPath || '', 'node_modules', '.bin', binName),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return res.json({ ok: true, path: c });
  }
  // Try resolving via which/where
  try {
    const found = execSync(`${IS_WIN ? 'where' : 'which'} ${binName} 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n')[0];
    if (found) return res.json({ ok: true, path: found });
  } catch (_) {}
  res.json({ ok: false, path: binName });
});

// ── RRule next occurrences ────────────────────────────────────────────────
// POST { rrule, count } → { occurrences: [ISO strings] }
app.post('/api/rrule/next', (req, res) => {
  const { rrule: rruleStr, count = 3 } = req.body || {};
  if (!rruleStr) return res.status(400).json({ error: 'rrule required' });
  try {
    // Minimal RRule parser for FREQ=DAILY/WEEKLY/MONTHLY + BYDAY/BYHOUR/BYMINUTE
    const occurrences = _computeRruleNext(rruleStr, Math.min(count, 20));
    res.json({ occurrences });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function _computeRruleNext(rruleStr, n) {
  const now = new Date();
  const pairs = {};
  // Strip RRULE: prefix
  const raw = rruleStr.replace(/^RRULE:/i, '');
  raw.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq !== -1) pairs[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  });
  const freq  = (pairs.FREQ || 'DAILY').toUpperCase();
  const interval = parseInt(pairs.INTERVAL || '1', 10) || 1;
  const byHour   = pairs.BYHOUR   ? parseInt(pairs.BYHOUR, 10)   : null;
  const byMin    = pairs.BYMINUTE ? parseInt(pairs.BYMINUTE, 10)  : null;
  const byDay    = pairs.BYDAY    ? pairs.BYDAY.split(',')        : null;
  const DAY_MAP  = { SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6 };

  const results = [];
  let cur = new Date(now);
  // Advance to next minute minimum
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1);
  if (byHour !== null) cur.setHours(byHour, byMin ?? 0, 0, 0);
  if (byMin !== null && byHour === null) cur.setMinutes(byMin, 0, 0);

  let tries = 0;
  while (results.length < n && tries < 10000) {
    tries++;
    const day = cur.getDay(); // 0=Sun
    let match = true;
    if (byDay) {
      const dayNames = byDay.map(d => d.replace(/^[-+]?\d*/, '').toUpperCase());
      const dayNums  = dayNames.map(d => DAY_MAP[d] ?? -1);
      if (!dayNums.includes(day)) match = false;
    }
    if (match && cur > now) {
      results.push(cur.toISOString());
      cur = new Date(cur);
    }
    // Advance
    if (freq === 'MINUTELY') {
      cur.setMinutes(cur.getMinutes() + interval);
    } else if (freq === 'HOURLY') {
      cur.setHours(cur.getHours() + interval);
      if (byMin !== null) cur.setMinutes(byMin, 0, 0);
    } else if (freq === 'DAILY') {
      cur.setDate(cur.getDate() + interval);
      if (byHour !== null) cur.setHours(byHour, byMin ?? 0, 0, 0);
    } else if (freq === 'WEEKLY') {
      cur.setDate(cur.getDate() + 1);
      if (byHour !== null) cur.setHours(byHour, byMin ?? 0, 0, 0);
    } else if (freq === 'MONTHLY') {
      const dom = parseInt(pairs.BYMONTHDAY || String(now.getDate()), 10);
      cur.setMonth(cur.getMonth() + interval, dom);
      if (byHour !== null) cur.setHours(byHour, byMin ?? 0, 0, 0);
    } else {
      // Unknown — advance by day
      cur.setDate(cur.getDate() + 1);
    }
  }
  return results;
}

// ── Design catalog: directions, skills, systems ───────────────────────────
// GET /api/design/directions → { directions: [{id, name, description, palette}] }
app.get('/api/design/directions', (req, res) => {
  res.json({
    directions: [
      { id: 'minimal',   name: 'Minimal',   description: 'Clean, white space-heavy, monochromatic', palette: ['#ffffff','#f5f5f5','#111111','#555555'] },
      { id: 'bold',      name: 'Bold',      description: 'High contrast, vivid accent colors, strong typography', palette: ['#0d0d0d','#ff3b30','#007aff','#f5f5f5'] },
      { id: 'warm',      name: 'Warm',      description: 'Earthy tones, editorial, warm neutrals', palette: ['#fdf6ec','#d4a574','#8b5e3c','#2c1810'] },
      { id: 'dark',      name: 'Dark',      description: 'Dark mode first, neon accents, techy', palette: ['#0a0a0f','#1a1a2e','#7c5cff','#00d4aa'] },
      { id: 'pastel',    name: 'Pastel',    description: 'Soft colors, rounded, playful', palette: ['#fce4ec','#e8f5e9','#e3f2fd','#fff9c4'] },
      { id: 'corporate', name: 'Corporate', description: 'Professional, trustworthy, structured', palette: ['#003087','#0066cc','#ffffff','#e8ecf0'] },
    ],
  });
});

// GET /api/design/skills → { skills: [{id, name, description}] }
app.get('/api/design/skills', (req, res) => {
  const skillsDir = path.join(__dirname, 'public', 'design-skills');
  const skills = [];
  try {
    for (const dir of fs.readdirSync(skillsDir)) {
      const md = path.join(skillsDir, dir, 'SKILL.md');
      if (!fs.existsSync(md)) continue;
      const src = fs.readFileSync(md, 'utf8');
      const title = (src.match(/^#\s+(.+)/m) || [])[1] || dir;
      const desc  = (src.match(/^(?!#)[^\n]{10,}/m) || [])[0] || '';
      skills.push({ id: dir, name: title.trim(), description: desc.trim().slice(0, 160) });
    }
  } catch (_) {}
  res.json({ skills });
});

// GET /api/design/systems → { systems: [{id, name, description}] }
app.get('/api/design/systems', (req, res) => {
  const systemsDir = path.join(__dirname, 'public', 'design-systems');
  const systems = [];
  try {
    for (const dir of fs.readdirSync(systemsDir)) {
      const md = path.join(systemsDir, dir, 'DESIGN.md');
      if (!fs.existsSync(md)) continue;
      const src = fs.readFileSync(md, 'utf8');
      const title = (src.match(/^#\s+(.+)/m) || [])[1] || dir;
      const desc  = (src.match(/^(?!#)[^\n]{10,}/m) || [])[0] || '';
      systems.push({ id: dir, name: title.trim(), description: desc.trim().slice(0, 160) });
    }
  } catch (_) {}
  res.json({ systems });
});

// ── Whisper voice transcription ───────────────────────────────────────────
// Model lives at ~/.config/fauna/whisper/ggml-base.en.bin (downloaded on first use)
const WHISPER_MODEL_DIR  = path.join(FAUNA_CONFIG_DIR, 'whisper');
const WHISPER_MODEL_FILE = path.join(WHISPER_MODEL_DIR, 'ggml-base.en.bin');
const WHISPER_MODEL_URL  = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

app.get('/api/whisper-model-status', (_req, res) => {
  const ready = fs.existsSync(WHISPER_MODEL_FILE);
  const size  = ready ? (() => { try { return fs.statSync(WHISPER_MODEL_FILE).size; } catch (_) { return 0; } })() : 0;
  res.json({ ready, modelPath: WHISPER_MODEL_FILE, size });
});

// SSE endpoint — download model and stream progress
app.get('/api/whisper-model-download', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  function send(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

  if (fs.existsSync(WHISPER_MODEL_FILE)) {
    send({ pct: 100, ready: true });
    return res.end();
  }

  fs.mkdirSync(WHISPER_MODEL_DIR, { recursive: true });
  const tmpFile = WHISPER_MODEL_FILE + '.tmp';

  // Use curl for download — reliable progress on macOS
  const dl = spawn('curl', ['-L', '--progress-bar', '-o', tmpFile, WHISPER_MODEL_URL], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let lastPct = 0;
  dl.stderr.on('data', chunk => {
    const str = chunk.toString();
    const m = str.match(/(\d+(?:\.\d+)?)%/);
    if (m) {
      const pct = Math.round(parseFloat(m[1]));
      if (pct !== lastPct) { lastPct = pct; send({ pct }); }
    }
  });

  dl.on('close', code => {
    if (code === 0 && fs.existsSync(tmpFile)) {
      fs.renameSync(tmpFile, WHISPER_MODEL_FILE);
      send({ pct: 100, ready: true });
    } else {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      send({ error: 'Download failed (exit ' + code + ')' });
    }
    res.end();
  });

  req.on('close', () => { try { dl.kill(); } catch (_) {} });
});

// POST /api/transcribe — audio blob body → { ok, text }
// Uses nodejs-whisper (ships whisper.cpp binary in node_modules)
app.post('/api/transcribe', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
  if (!fs.existsSync(WHISPER_MODEL_FILE)) {
    return res.status(503).json({ ok: false, error: 'Whisper model not downloaded yet' });
  }
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ ok: false, error: 'Empty audio body' });
  }
  const ts     = Date.now();
  const ctHeader = req.headers['content-type'] || '';
  const ext = ctHeader.includes('ogg') ? 'ogg' : ctHeader.includes('mp4') ? 'mp4' : 'webm';
  const tmpIn  = path.join(os.tmpdir(), `fauna_voice_${ts}.${ext}`);
  const tmpWav = path.join(os.tmpdir(), `fauna_voice_${ts}.wav`);
  try {
    fs.writeFileSync(tmpIn, req.body);
    console.log('[transcribe] wrote', req.body.length, 'bytes to', tmpIn, '(content-type:', ctHeader, ')');
    // Verify webm magic bytes (first 4 bytes should be 0x1A45DFA3 for EBML)
    if (ext === 'webm' && req.body.length >= 4) {
      const magic = req.body.readUInt32BE(0);
      if (magic !== 0x1A45DFA3) {
        console.warn('[transcribe] WARNING: webm magic mismatch, got 0x' + magic.toString(16) + ' — may not be valid webm');
      }
    }
    // Prefer the bundled static ffmpeg (no system lib deps); fall back to PATH
    let ffmpegBin;
    {
      let staticPath = null;
      // Strategy 1: process.resourcesPath (most reliable in packed Electron)
      if (!staticPath && process.resourcesPath) {
        const p = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
        if (fs.existsSync(p)) staticPath = p;
      }
      // Strategy 2: require('ffmpeg-static') with asar path fix
      if (!staticPath) {
        try {
          const pkg = require('ffmpeg-static');
          if (pkg) {
            const fixed = pkg.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
            if (fs.existsSync(fixed)) staticPath = fixed;
          }
        } catch (_) {}
      }
      // Strategy 3: relative to __dirname (dev mode)
      if (!staticPath) {
        const p = path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg');
        if (fs.existsSync(p)) staticPath = p;
      }
      ffmpegBin = staticPath || 'ffmpeg';
      if (!staticPath) console.error('[transcribe] WARNING: ffmpeg-static not found, falling back to system ffmpeg');
      else console.log('[transcribe] using ffmpeg:', staticPath);
    }
    // Determine input format from Content-Type header
    const ct = req.headers['content-type'] || '';
    const inputFmt = ct.includes('ogg') ? 'ogg' : ct.includes('mp4') ? 'mp4' : 'webm';

    // Try ffmpeg conversion with multiple strategies
    const tryFfmpeg = (args, useStdin) => new Promise((resolve, reject) => {
      let rejected = false;
      const fail = (err) => { if (!rejected) { rejected = true; reject(err); } };
      let ffStderr = '';
      const ff = spawn(ffmpegBin, args, {
        stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: AUGMENTED_PATH },
      });
      if (useStdin) {
        ff.stdin.on('error', () => {}); // suppress EPIPE if ffmpeg closes stdin early
        ff.stdin.write(req.body);
        ff.stdin.end();
      }
      ff.stdout.on('data', () => {}); // drain stdout
      ff.stderr.on('data', chunk => { ffStderr += chunk.toString(); });
      ff.on('close', (code, signal) => {
        if (code === 0) return resolve();
        const detail = ffStderr.trim().split('\n').pop() || '';
        fail(new Error(`ffmpeg exit ${code ?? ('signal:' + signal)}: ${detail}`));
      });
      ff.on('error', err => fail(new Error('ffmpeg spawn error: ' + err.message)));
    });

    let ffOk = false;
    // Strategy 1: explicit input format from file
    try {
      await tryFfmpeg(['-y', '-loglevel', 'error', '-f', inputFmt, '-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', tmpWav], false);
      ffOk = true;
    } catch (e1) {
      console.warn('[transcribe] ffmpeg strategy 1 failed:', e1.message);
      // Strategy 2: let ffmpeg probe the file (no -f)
      try {
        await tryFfmpeg(['-y', '-loglevel', 'error', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', tmpWav], false);
        ffOk = true;
      } catch (e2) {
        console.warn('[transcribe] ffmpeg strategy 2 failed:', e2.message);
        // Strategy 3: pipe via stdin with explicit format
        try {
          await tryFfmpeg(['-y', '-loglevel', 'error', '-f', inputFmt, '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', tmpWav], true);
          ffOk = true;
        } catch (e3) {
          console.error('[transcribe] all ffmpeg strategies failed:', e3.message);
          throw new Error(`ffmpeg failed (exit 1). ${e3.message}`);
        }
      }
    }
    // Run whisper-cli directly (bypasses nodejs-whisper JS wrapper which breaks inside asar)
    let whisperBin = null;
    {
      const relBin = path.join('node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
      // Strategy 1: unpacked in Electron resources
      if (process.resourcesPath) {
        const p = path.join(process.resourcesPath, 'app.asar.unpacked', relBin);
        if (fs.existsSync(p)) whisperBin = p;
      }
      // Strategy 2: dev mode (__dirname)
      if (!whisperBin) {
        const p = path.join(__dirname, relBin);
        if (fs.existsSync(p)) whisperBin = p;
      }
      if (!whisperBin) throw new Error('whisper-cli binary not found');
    }
    const text = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const wp = spawn(whisperBin, [
        '-m', WHISPER_MODEL_FILE,
        '-f', tmpWav,
        '-l', 'en',
        '-otxt',
        '--no-prints',
      ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: AUGMENTED_PATH } });
      wp.stdout.on('data', d => { stdout += d.toString(); });
      wp.stderr.on('data', d => { stderr += d.toString(); });
      wp.on('close', code => {
        if (code !== 0) return reject(new Error(`whisper-cli exited ${code}: ${stderr.trim()}`));
        // whisper-cli with -otxt writes to <input>.txt
        const txtFile = tmpWav + '.txt';
        if (fs.existsSync(txtFile)) {
          const t = fs.readFileSync(txtFile, 'utf8').trim();
          try { fs.unlinkSync(txtFile); } catch (_) {}
          resolve(t);
        } else {
          resolve(stdout.trim());
        }
      });
      wp.on('error', err => reject(new Error('whisper-cli spawn error: ' + err.message)));
    });
    res.json({ ok: true, text });
  } catch (e) {
    const body = { ok: false, error: e.message };
    if (e.code) body.code = e.code;
    res.status(500).json(body);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    try { fs.unlinkSync(tmpWav); } catch (_) {}
  }
});

// SSE: repair broken system ffmpeg via brew reinstall
// GET /api/repair-ffmpeg → streams { line } then { done } or { error }
app.get('/api/repair-ffmpeg', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  // Locate brew
  const brewBin = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(p => fs.existsSync(p)) || 'brew';
  const proc = spawn(brewBin, ['reinstall', 'ffmpeg'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: AUGMENTED_PATH, HOMEBREW_NO_AUTO_UPDATE: '1' },
  });
  proc.stdout.on('data', chunk => chunk.toString().split('\n').filter(Boolean).forEach(l => send({ line: l })));
  proc.stderr.on('data', chunk => chunk.toString().split('\n').filter(Boolean).forEach(l => send({ line: l })));
  proc.on('close', code => {
    if (code === 0) send({ done: true });
    else send({ error: `brew reinstall ffmpeg exited ${code}` });
    res.end();
  });
  proc.on('error', err => { send({ error: err.message }); res.end(); });
  req.on('close', () => { try { proc.kill(); } catch (_) {} });
});

// ── Document extraction / write ────────────────────────────────────────────
// POST { path } → extract text from a docx/doc/rtf/odt file
app.post('/api/extract-document', async (req, res) => {
  const { path: docPath } = req.body || {};
  if (!docPath) return res.status(400).json({ error: 'path required' });
  const abs = path.isAbsolute(docPath) ? docPath : path.join(os.homedir(), docPath);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File not found' });
  const ext = path.extname(abs).toLowerCase().slice(1);
  try {
    let content = '';
    // Try pandoc first (most accurate for docx/odt)
    const pandocOut = path.join(os.tmpdir(), `fauna_doc_${Date.now()}.txt`);
    try {
      execSync(`pandoc -f ${ext === 'doc' ? 'doc' : 'docx'} -t plain -o ${JSON.stringify(pandocOut)} ${JSON.stringify(abs)} 2>/dev/null`, { timeout: 15000 });
      content = fs.readFileSync(pandocOut, 'utf8');
      try { fs.unlinkSync(pandocOut); } catch (_) {}
    } catch (_) {
      // Fallback: textutil (macOS only, supports doc/docx/rtf)
      try {
        const txtOut = abs.replace(/\.[^.]+$/, '') + '.txt';
        execSync(`textutil -convert txt -output ${JSON.stringify(txtOut)} ${JSON.stringify(abs)} 2>/dev/null`, { timeout: 15000 });
        if (fs.existsSync(txtOut)) { content = fs.readFileSync(txtOut, 'utf8'); try { fs.unlinkSync(txtOut); } catch (_) {} }
      } catch (_2) {
        // Last resort: strings
        try { content = execSync(`strings ${JSON.stringify(abs)} 2>/dev/null`, { encoding: 'utf8', timeout: 10000 }); } catch (_3) {}
      }
    }
    res.json({ ok: true, content, path: abs, editable: ['docx','odt'].includes(ext) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST { path, content } → write text content back to a document
app.post('/api/write-document-text', async (req, res) => {
  const { path: docPath, content } = req.body || {};
  if (!docPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
  const abs = path.isAbsolute(docPath) ? docPath : path.join(os.homedir(), docPath);
  try {
    // Try pandoc to convert plain text back to docx format
    const tmpTxt = path.join(os.tmpdir(), `fauna_doc_in_${Date.now()}.txt`);
    fs.writeFileSync(tmpTxt, content, 'utf8');
    const ext = path.extname(abs).toLowerCase().slice(1);
    try {
      execSync(`pandoc -f plain -t ${ext === 'odt' ? 'odt' : 'docx'} -o ${JSON.stringify(abs)} ${JSON.stringify(tmpTxt)} 2>/dev/null`, { timeout: 15000 });
    } catch (_) {
      // Fallback: just write as .txt alongside (the path stays the same)
      fs.writeFileSync(abs, content, 'utf8');
    }
    try { fs.unlinkSync(tmpTxt); } catch (_) {}
    res.json({ ok: true, path: abs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST { name, mime, base64 } → extract text from a base64-encoded attachment
app.post('/api/extract-attachment', async (req, res) => {
  const { name = 'file', mime = 'application/octet-stream', base64 } = req.body || {};
  if (!base64) return res.status(400).json({ error: 'base64 required' });
  const ext  = (name.split('.').pop() || '').toLowerCase();
  const buf  = Buffer.from(base64, 'base64');
  const tmp  = path.join(os.tmpdir(), `fauna_attach_${Date.now()}.${ext || 'bin'}`);
  try {
    fs.writeFileSync(tmp, buf);
    let text = '';
    if (['pdf'].includes(ext)) {
      text = execSync(`pdftotext ${JSON.stringify(tmp)} - 2>/dev/null`, { encoding: 'utf8', timeout: 15000 }).trim();
    } else if (['doc','docx','odt','rtf','pages'].includes(ext)) {
      try {
        text = execSync(`pandoc -t plain ${JSON.stringify(tmp)} 2>/dev/null`, { encoding: 'utf8', timeout: 15000 }).trim();
      } catch (_) {
        try { text = execSync(`textutil -convert txt -stdout ${JSON.stringify(tmp)} 2>/dev/null`, { encoding: 'utf8', timeout: 10000 }).trim(); } catch (_2) {}
      }
    } else if (['xls','xlsx','csv'].includes(ext)) {
      text = execSync(`strings ${JSON.stringify(tmp)} 2>/dev/null | head -200`, { encoding: 'utf8', timeout: 10000 }).trim();
    } else {
      // Generic: try as text
      text = buf.slice(0, 200000).toString('utf8');
    }
    res.json({ ok: true, text, name, mime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

// ── Browser extension install / download ──────────────────────────────────
const BROWSER_EXT_INSTALL_DIR = path.join(FAUNA_CONFIG_DIR, 'browser-extension');
const BROWSER_EXT_SRC_DIR     = path.join(__dirname, 'browser-extension');

function getBrowserExtSrcDir() {
  const packed = path.join(process.resourcesPath || '', 'browser-extension');
  if (fs.existsSync(packed)) return packed;
  return BROWSER_EXT_SRC_DIR;
}

app.get('/api/browser-ext/info', (req, res) => {
  const installed = fs.existsSync(path.join(BROWSER_EXT_INSTALL_DIR, 'manifest.json'));
  res.json({
    installed,
    installDir:  installed ? BROWSER_EXT_INSTALL_DIR : null,
    bundledDir:  getBrowserExtSrcDir(),
  });
});

app.post('/api/browser-ext/install', (req, res) => {
  try {
    const src = getBrowserExtSrcDir();
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Bundled extension not found' });
    fs.mkdirSync(BROWSER_EXT_INSTALL_DIR, { recursive: true });
    // Copy all files (shallow — no subdirectory icons handled separately)
    for (const file of fs.readdirSync(src)) {
      const s = path.join(src, file);
      const d = path.join(BROWSER_EXT_INSTALL_DIR, file);
      if (fs.statSync(s).isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        for (const sub of fs.readdirSync(s)) {
          fs.copyFileSync(path.join(s, sub), path.join(d, sub));
        }
      } else {
        fs.copyFileSync(s, d);
      }
    }
    res.json({ ok: true, installDir: BROWSER_EXT_INSTALL_DIR });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/browser-ext/download', async (req, res) => {
  try {
    const { dialog, BrowserWindow } = _require('electron');
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win || undefined, {
      title: 'Choose folder to save browser extension',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.cancelled || !result.filePaths || !result.filePaths.length) {
      return res.json({ ok: false, cancelled: true });
    }
    const dest = path.join(result.filePaths[0], 'fauna-browser-extension');
    const src  = getBrowserExtSrcDir();
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Bundled extension not found' });
    fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      const s = path.join(src, file);
      const d = path.join(dest, file);
      if (fs.statSync(s).isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        for (const sub of fs.readdirSync(s)) fs.copyFileSync(path.join(s, sub), path.join(d, sub));
      } else {
        fs.copyFileSync(s, d);
      }
    }
    res.json({ ok: true, downloadDir: dest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Playwright MCP status / call ──────────────────────────────────────────
let _playwrightMcpClient = null;
let _playwrightMcpInstalled = null;

async function _getPlaywrightMcpClient() {
  if (_playwrightMcpClient) return _playwrightMcpClient;
  // Spawn @playwright/mcp as a subprocess and connect via MCP SDK stdio transport
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const cliPath = path.join(path.dirname(_require.resolve('@playwright/mcp')), 'cli.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
  });
  const client = new Client({ name: 'fauna-playwright', version: '1.0.0' });
  await client.connect(transport);
  _playwrightMcpClient = client;
  // Clean up on close
  client.onclose = () => { _playwrightMcpClient = null; };
  return client;
}

app.get('/api/playwright-mcp/status', async (req, res) => {
  if (_playwrightMcpInstalled === null) {
    try { await import('@playwright/mcp'); _playwrightMcpInstalled = true; } catch (_) { _playwrightMcpInstalled = false; }
  }
  res.json({ installed: _playwrightMcpInstalled, running: !!_playwrightMcpClient });
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
      const client = await _getPlaywrightMcpClient();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000);
      let result;
      try {
        result = await client.callTool({ name: tool, arguments: args }, undefined, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      const content = Array.isArray(result?.content) ? result.content : [{ type: 'text', text: JSON.stringify(result) }];
      return res.json({ ok: true, content });
    } catch (e) {
      // Reset stale client so next attempt spawns a fresh subprocess
      _playwrightMcpClient = null;
      if (attempt === 0 && /closed|disconnect|EPIPE|EOF/i.test(e.message)) {
        console.log('[playwright-mcp] connection lost, retrying…');
        continue;
      }
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
});

// ── Project runs & terminals ──────────────────────────────────────────────
// In-memory stores (survive server restarts only via existing processes)
const _projectRuns     = new Map(); // runId → { runId, projectId, srcId, srcName, name, cmd, port, status, child, sseClients }
const _projectTerminals = new Map(); // termId → { termId, projectId, child, sseClients, buf }

function _runId() { return 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
function _termId() { return 'term-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }

// GET /api/projects/:id/runs → list of active run records
app.get('/api/projects/:id/runs', (req, res) => {
  const list = [];
  for (const r of _projectRuns.values()) {
    if (r.projectId === req.params.id) {
      list.push({ runId: r.runId, name: r.name, cmd: r.cmd, port: r.port, srcName: r.srcName, status: r.status });
    }
  }
  res.json(list);
});

// POST /api/projects/:id/sources/:srcId/run { cmd, name, port? } → { runId }
app.post('/api/projects/:id/sources/:srcId/run', (req, res) => {
  const { cmd, name, port } = req.body || {};
  if (!cmd) return res.status(400).json({ error: 'cmd required' });
  const proj = getProject(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const src = (proj.sources || []).find(s => s.id === req.params.srcId);
  const srcPath = src?.path || proj.rootPath || os.homedir();

  const runId = _runId();
  const env = { ...process.env, PATH: AUGMENTED_PATH, HOME: os.homedir() };
  const child = spawn(SHELL_BIN, ['-c', cmd], {
    cwd: srcPath || os.homedir(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const record = {
    runId, projectId: req.params.id, srcId: req.params.srcId,
    srcName: src?.name || req.params.srcId,
    name: name || cmd.split(' ')[0], cmd, port: port || null,
    status: 'starting', child, sseClients: new Set(), logBuf: [],
  };
  _projectRuns.set(runId, record);

  function _emit(line, statusUpdate) {
    record.logBuf.push(line);
    if (record.logBuf.length > 5000) record.logBuf.shift();
    const payload = JSON.stringify({ line, status: statusUpdate || undefined });
    for (const sse of record.sseClients) { try { sse.write(`data: ${payload}\n\n`); } catch (_) {} }
  }

  child.stdout.on('data', chunk => {
    // Detect port
    const text = chunk.toString();
    if (!record.port) {
      const m = text.match(/(?:localhost|127\.0\.0\.1|port)[:\s]+(\d{4,5})/i);
      if (m) { record.port = parseInt(m[1], 10); _emit('', undefined); }
    }
    for (const line of text.split('\n')) { if (line) _emit(line); }
    if (record.status === 'starting') { record.status = 'running'; _emit('', 'running'); }
  });
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    for (const line of text.split('\n')) { if (line) _emit(line); }
    if (record.status === 'starting') { record.status = 'running'; _emit('', 'running'); }
  });
  child.on('exit', (code) => {
    record.status = code === 0 ? 'stopped' : 'exited';
    record.child = null;
    _emit('', record.status);
  });
  child.on('error', (err) => {
    record.status = 'error';
    record.child = null;
    _emit('[Error: ' + err.message + ']', 'error');
  });

  res.json({ ok: true, runId });
});

// DELETE /api/projects/:id/runs/:runId → stop run
app.delete('/api/projects/:id/runs/:runId', (req, res) => {
  const record = _projectRuns.get(req.params.runId);
  if (!record) return res.status(404).json({ error: 'Run not found' });
  if (record.child) {
    try { record.child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { if (record.child) record.child.kill('SIGKILL'); } catch (_) {} }, 3000);
  }
  record.status = 'stopped';
  record.child  = null;
  _projectRuns.delete(req.params.runId);
  res.json({ ok: true });
});

// GET /api/projects/:id/runs/:runId/logs → SSE stream
app.get('/api/projects/:id/runs/:runId/logs', (req, res) => {
  const record = _projectRuns.get(req.params.runId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  if (!record) {
    res.write(`data: ${JSON.stringify({ line: '[Run not found]', status: 'error' })}\n\n`);
    return res.end();
  }
  // Replay buffered log
  for (const line of record.logBuf) {
    res.write(`data: ${JSON.stringify({ line })}\n\n`);
  }
  // Send current status
  res.write(`data: ${JSON.stringify({ status: record.status })}\n\n`);
  record.sseClients.add(res);
  req.on('close', () => { record.sseClients.delete(res); });
});

// GET /api/projects/:id/sources/:srcId/run-commands → detect runnable commands
app.get('/api/projects/:id/sources/:srcId/run-commands', (req, res) => {
  const proj = getProject(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const src = (proj.sources || []).find(s => s.id === req.params.srcId);
  const srcPath = src?.path || proj.rootPath || '';

  const commands = [];
  const stack    = [];

  if (!srcPath || !fs.existsSync(srcPath)) return res.json({ commands, stack });

  // Detect from package.json
  const pkgPath = path.join(srcPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};
      for (const s of ['dev', 'start', 'serve', 'preview']) {
        if (scripts[s]) commands.push({ label: `npm run ${s}`, cmd: `npm run ${s}`, detected: true });
      }
      // Detect tech stack
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next)    stack.push('Next.js');
      if (deps.react)   stack.push('React');
      if (deps.vue)     stack.push('Vue');
      if (deps.svelte)  stack.push('Svelte');
      if (deps.vite)    stack.push('Vite');
      if (deps.express || deps.fastify || deps.koa) stack.push('Node.js');
    } catch (_) {}
  }

  // Python
  for (const f of ['manage.py', 'app.py', 'main.py', 'run.py']) {
    if (fs.existsSync(path.join(srcPath, f))) {
      if (f === 'manage.py') { commands.push({ label: 'python manage.py runserver', cmd: 'python manage.py runserver', detected: true }); stack.push('Django'); }
      else { commands.push({ label: `python ${f}`, cmd: `python ${f}`, detected: true }); stack.push('Python'); }
      break;
    }
  }

  // Makefile
  if (fs.existsSync(path.join(srcPath, 'Makefile')) || fs.existsSync(path.join(srcPath, 'makefile'))) {
    commands.push({ label: 'make', cmd: 'make', detected: true });
  }

  // Docker Compose
  if (fs.existsSync(path.join(srcPath, 'docker-compose.yml')) || fs.existsSync(path.join(srcPath, 'docker-compose.yaml'))) {
    commands.push({ label: 'docker compose up', cmd: 'docker compose up', detected: true });
    stack.push('Docker');
  }

  // Go
  if (fs.existsSync(path.join(srcPath, 'go.mod'))) {
    commands.push({ label: 'go run .', cmd: 'go run .', detected: true });
    stack.push('Go');
  }

  // Cargo (Rust)
  if (fs.existsSync(path.join(srcPath, 'Cargo.toml'))) {
    commands.push({ label: 'cargo run', cmd: 'cargo run', detected: true });
    stack.push('Rust');
  }

  res.json({ commands: commands.slice(0, 8), stack });
});

// POST /api/projects/:id/terminal → create persistent terminal session → { termId }
app.post('/api/projects/:id/terminal', (req, res) => {
  const proj = getProject(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const cwd = proj.rootPath && fs.existsSync(proj.rootPath) ? proj.rootPath : os.homedir();

  const termId = _termId();
  const env = { ...process.env, PATH: AUGMENTED_PATH, HOME: os.homedir(), TERM: 'xterm-256color' };

  // Use an interactive login shell so PATH and rc files are sourced
  const child = spawn(SHELL_BIN, IS_WIN ? [] : ['-i', '-l'], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const session = { termId, projectId: req.params.id, child, sseClients: new Set(), buf: '' };
  _projectTerminals.set(termId, session);

  function _emit(out) {
    session.buf += out;
    if (session.buf.length > 200000) session.buf = session.buf.slice(-150000);
    const payload = JSON.stringify({ out });
    for (const sse of session.sseClients) { try { sse.write(`data: ${payload}\n\n`); } catch (_) {} }
  }

  child.stdout.on('data', chunk => _emit(chunk.toString()));
  child.stderr.on('data', chunk => _emit(chunk.toString()));
  child.on('exit', () => {
    _projectTerminals.delete(termId);
    const payload = JSON.stringify({ out: '\r\n[Shell exited]\r\n' });
    for (const sse of session.sseClients) { try { sse.write(`data: ${payload}\n\n`); sse.end(); } catch (_) {} }
  });
  child.on('error', err => {
    const payload = JSON.stringify({ out: `\r\n[Error: ${err.message}]\r\n` });
    for (const sse of session.sseClients) { try { sse.write(`data: ${payload}\n\n`); sse.end(); } catch (_) {} }
    _projectTerminals.delete(termId);
  });

  res.json({ ok: true, termId });
});

// DELETE /api/projects/:id/terminal/:termId → close terminal
app.delete('/api/projects/:id/terminal/:termId', (req, res) => {
  const session = _projectTerminals.get(req.params.termId);
  if (!session) return res.json({ ok: true, already: true });
  if (session.child) {
    try { session.child.kill('SIGHUP'); } catch (_) {}
    setTimeout(() => { try { if (session.child) session.child.kill('SIGKILL'); } catch (_) {} }, 2000);
  }
  for (const sse of session.sseClients) { try { sse.end(); } catch (_) {} }
  _projectTerminals.delete(req.params.termId);
  res.json({ ok: true });
});

// POST /api/projects/:id/terminal/:termId/input { data } → write to stdin
app.post('/api/projects/:id/terminal/:termId/input', express.json({ limit: '64kb' }), (req, res) => {
  const session = _projectTerminals.get(req.params.termId);
  if (!session) return res.status(404).json({ error: 'Terminal not found' });
  const data = req.body?.data ?? '';
  try {
    if (session.child && session.child.stdin && !session.child.stdin.destroyed) {
      session.child.stdin.write(data);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/projects/:id/terminal/:termId/output → SSE stream
app.get('/api/projects/:id/terminal/:termId/output', (req, res) => {
  const session = _projectTerminals.get(req.params.termId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  if (!session) {
    res.write(`data: ${JSON.stringify({ out: '[Terminal not found or closed]\r\n' })}\n\n`);
    return res.end();
  }
  // Send buffered output
  if (session.buf) res.write(`data: ${JSON.stringify({ out: session.buf })}\n\n`);
  session.sseClients.add(res);
  req.on('close', () => { session.sseClients.delete(res); });
});

// ── Start ─────────────────────────────────────────────────────────────────

export function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`\n  ✦ Copilot Chat  →  http://127.0.0.1:${port}\n`);
      resolve(server);
    });
    attachExtBridge(server);
    startScheduler(task => {
      runTask(task.id, { trigger: 'scheduler' }).catch(e => console.error('[tasks] scheduled run failed:', e.message));
    });
    // Run fact memory decay on startup (prune facts not accessed in 60 days)
    try { runDecay(); } catch (_) {}

    // Internal AI caller for heartbeat and workflows — defaults to active conversation model
    internalAICaller = async (prompt, model) => {
      const useModel = model || _activeModel || 'gpt-4.1';
      const client = getCopilotClient();
      const callModel = async (m) => {
        const resp = await client.chat.completions.create({
          model: m,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2000,
        });
        return resp.choices[0]?.message?.content?.trim() || '';
      };
      try {
        return await callModel(useModel);
      } catch (e) {
        // If model not supported, retry with fallback
        if (e.status === 400 && useModel !== _activeModel && _activeModel) {
          console.log(`[ai-caller] model "${useModel}" not supported, falling back to "${_activeModel}"`);
          return await callModel(_activeModel);
        }
        if (e.status === 400 && useModel !== 'gpt-4.1') {
          console.log(`[ai-caller] model "${useModel}" not supported, falling back to "gpt-4.1"`);
          return await callModel('gpt-4.1');
        }
        throw e;
      }
    };
    const internalNotifier = (title, body) => {
      try {
        const { Notification: ElectronNotification } = _require('electron');
        new ElectronNotification({ title, body }).show();
      } catch (_) {
        console.log(`[notification] ${title}: ${body}`);
      }
    };

    // Start heartbeat and workflow timers
    startHeartbeat(internalAICaller, internalNotifier);
    startWorkflowTimer(internalAICaller, internalNotifier);
    startTeamsBridge(internalAICaller, internalNotifier);
    server.on('error', reject);

    // Clean up MCP child process and Figma timers on exit
    function fullCleanup() {
      // Cancel the Figma reconnect loop so it can't keep the event loop alive
      if (figmaState.pendingReconnect) {
        clearTimeout(figmaState.pendingReconnect);
        figmaState.pendingReconnect = null;
      }
      // Close the WS connection
      if (figmaWs) {
        try { figmaWs.terminate(); } catch (_) {}
        figmaWs = null;
      }
      // Stop custom MCP auto-detection polling
      stopCustomMcpAutoDetection();
      // Kill all custom MCP processes
      for (const [id, proc] of customMcpProcesses) {
        try { proc.process.kill('SIGTERM'); } catch (_) {}
      }
      customMcpProcesses.clear();
      customMcpClients.clear();
      // Kill MCP child
      stopScheduler();
      if (isMcpRunning()) mcpProcess.kill('SIGKILL');
    }
    process.on('exit',    () => fullCleanup());
    process.on('SIGTERM', () => { fullCleanup(); process.exit(0); });
    process.on('SIGINT',  () => { fullCleanup(); process.exit(0); });
  });
}

export { app };

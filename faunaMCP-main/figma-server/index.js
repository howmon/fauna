/**
 * Figma Fauna MCP Server — multi-system edition
 *
 * Exposes MCP tools for:
 *   - Managing multiple design systems (register, list, switch, index tokens)
 *   - Creating / editing page layouts
 *   - Placing components from any registered system
 *   - Searching and applying design tokens
 *
 * Two servers run in one process:
 *   stdio  → MCP (any MCP-compatible client)
 *   :3335  → WebSocket relay to Figma plugin UI
 */

import { McpServer }                     from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }          from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest }           from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer }               from 'ws';
import { OpenAI }                        from 'openai';
import { execSync }                      from 'child_process';
import { z }                             from 'zod';
import { createServer }                  from 'http';
import { randomUUID }                    from 'crypto';
import fs                                from 'fs';
import path                              from 'path';
import https                             from 'https';
import { fileURLToPath }                 from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Design system registry ────────────────────────────────────────────────

const SYSTEMS_PATH = path.join(__dirname, 'systems.json');

function loadSystems() {
  return JSON.parse(fs.readFileSync(SYSTEMS_PATH, 'utf8'));
}
function saveSystems(data) {
  fs.writeFileSync(SYSTEMS_PATH, JSON.stringify(data, null, 2));
}

function getActiveSystem() {
  const cfg = loadSystems();
  return cfg.systems.find(s => s.id === cfg.activeSystem) || cfg.systems[0];
}

function loadComponentRegistry(system) {
  const p = path.join(__dirname, system.componentIndex);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadTokenRegistry(system) {
  const p = path.join(__dirname, system.tokenIndex);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Build flat component context string for AI (all active/specified systems)
const EXCLUDED_SETS = new Set(['DataGrid']);

function buildComponentContext(registry) {
  if (!registry) return '';
  return (registry.registry || [])
    .filter(item => !EXCLUDED_SETS.has(item.name))
    .map(item => {
      if (item.type === 'set') {
        const vLines = item.variants.map(v => `  variant | key:${v.key} | ${v.name}`).join('\n');
        return `SET | "${item.name}" | page:${item.page}\n${vLines}`;
      }
      return `COMPONENT | "${item.name}" | key:${item.key} | page:${item.page}`;
    }).join('\n');
}

// Search components across all loaded systems
function searchAllComponents(query, systemIds) {
  const cfg  = loadSystems();
  const syss = systemIds
    ? cfg.systems.filter(s => systemIds.includes(s.id))
    : cfg.systems;

  const q = query.toLowerCase();
  const results = [];

  for (const sys of syss) {
    const reg = loadComponentRegistry(sys);
    if (!reg) continue;
    for (const r of (reg.registry || [])) {
      if ((r.name || '').toLowerCase().includes(q) || (r.page || '').toLowerCase().includes(q)) {
        results.push({ system: sys.name, systemId: sys.id, type: r.type, name: r.name, key: r.key || null, page: r.page });
      }
    }
  }
  return results.slice(0, 30);
}

// Search tokens across a system's token registry
function searchTokens(query, system) {
  const reg = loadTokenRegistry(system);
  if (!reg) return [];
  const q = query.toLowerCase();
  const results = [];
  for (const col of (reg.collections || [])) {
    for (const tok of (col.tokens || [])) {
      if (tok.name.toLowerCase().includes(q) ||
          tok.type.toLowerCase().includes(q) ||
          (tok.scopes || []).some(s => s.toLowerCase().includes(q))) {
        results.push({
          name:       tok.name,
          key:        tok.key,
          type:       tok.type,
          collection: tok.collection,
          scopes:     tok.scopes,
          values:     tok.resolvedValues
        });
      }
    }
  }
  return results.slice(0, 25);
}

// ── GitHub Copilot token ──────────────────────────────────────────────────

function getCopilotToken() {
  return execSync('gh auth token', { encoding: 'utf8' }).trim();
}

// ── AI component resolution ───────────────────────────────────────────────

function buildSystemPrompt(activeSys) {
  const reg     = loadComponentRegistry(activeSys);
  const compCtx = buildComponentContext(reg);

  // Include token names if available
  const tokReg  = loadTokenRegistry(activeSys);
  let tokenCtx  = '';
  if (tokReg) {
    const colorTokens = [];
    for (const col of (tokReg.collections || [])) {
      for (const tok of (col.tokens || [])) {
        if (tok.type === 'COLOR') colorTokens.push(`${tok.name} | key:${tok.key}`);
      }
    }
    if (colorTokens.length) {
      tokenCtx = `\n\n## DESIGN TOKENS (${activeSys.name})\n` + colorTokens.slice(0, 80).join('\n');
    }
  }

  return `You are a Figma design assistant for the ${activeSys.name} design system.

When resolving requests, use ONLY components and tokens from the active design system unless the user specifies another.

PAGE LAYOUT FORMAT:
{
  "mode": "page",
  "layoutName": "...",
  "frameWidth": 1920, "frameHeight": 1080,
  "components": [
    { "key": "...", "name": "...", "section": "header|sidenav|nav|pageheader|content|drawer",
      "row": 0, "showSectionHeader": true, "sectionTitle": "...", "sectionDescription": "...",
      "flexDirection": "Row", "ratio": "1", "textOverrides": {} }
  ],
  "tokenOverrides": [
    { "layerName": "...", "property": "fill|cornerRadius|gap|padding", "tokenKey": "..." }
  ],
  "explanation": "..."
}

EDIT LAYOUT FORMAT:
{ "mode": "edit", "components": [...], "explanation": "..." }

COMPONENT PLACEMENT FORMAT:
{ "mode": "components", "components": [{ "key":"...", "name":"...", "x":100, "y":100 }], "explanation":"..." }

Respond with ONLY valid JSON — no markdown.

META-COMMANDS (for chat interface only):
- If user says "switch to X system" or "use X system" → { "action": "switch-system", "systemId": "X", "explanation": "Switched to X" }
- If user says "list systems" or "what systems" → { "action": "list-systems", "explanation": "..." }

## COMPONENT REGISTRY
${compCtx}${tokenCtx}`;
}

async function resolveWithAI(userMessage) {
  const activeSys = getActiveSystem();
  const token     = getCopilotToken();
  const client    = new OpenAI({
    baseURL: 'https://api.githubcopilot.com', apiKey: token,
    defaultHeaders: { 'Editor-Version': 'vscode/1.85.0', 'Copilot-Integration-Id': 'vscode-chat' }
  });

  const response = await client.chat.completions.create({
    model: 'claude-sonnet-4.6',
    messages: [
      { role: 'system', content: buildSystemPrompt(activeSys) },
      { role: 'user',   content: userMessage }
    ],
    temperature: 0.2, max_tokens: 3000
  });

  const raw   = response.choices[0].message.content;
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('No JSON in AI response');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return JSON.parse(raw.slice(start, i + 1)); }
  }
  throw new Error('Incomplete JSON in AI response');
}

// ── WebSocket relay ───────────────────────────────────────────────────────

const WS_PORT  = 3335;
const wss      = new WebSocketServer({ port: WS_PORT });
const clients  = new Map();   // fileKey → ClientConnection
const pending  = new Map();   // id → { resolve, reject, timer, fileKey }
let   activeFileKey = null;

function handleServerError(label, port, err) {
  if (err && err.code === 'EADDRINUSE') {
    process.stderr.write(`[MCP] ${label} port ${port} is already in use. Another FaunaMCP relay may already be running.\n`);
  } else {
    process.stderr.write(`[MCP] ${label} server failed on port ${port}: ${err && err.stack ? err.stack : err}\n`);
  }
  process.exit(1);
}

wss.on('listening', () => {
  process.stderr.write(`[MCP] WebSocket relay on ws://localhost:${WS_PORT}\n`);
  process.stderr.write(`[MCP] Active system: ${getActiveSystem().name}\n`);
});

wss.on('error', err => handleServerError('WebSocket', WS_PORT, err));

function createConnection(ws, isController = false) {
  return { ws, fileInfo: null, consoleLogs: [], selection: null, gracePeriodTimer: null, lastActivity: Date.now(), isController };
}

wss.on('connection', ws => {
  let fileKey = null;
  let conn    = null;
  let identifyTimer = setTimeout(() => {
    if (!fileKey) { process.stderr.write('[MCP] No FILE_INFO in 30 s — closing\n'); ws.close(); }
  }, 30000);

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    // ── FILE_INFO: plugin identifies itself ───────────────────────────────
    if (msg.type === 'FILE_INFO') {
      clearTimeout(identifyTimer);
      fileKey = msg.fileKey || ('file-' + Date.now());
      const existing = clients.get(fileKey);
      if (existing && existing.gracePeriodTimer) {
        clearTimeout(existing.gracePeriodTimer);
        conn = existing; conn.ws = ws; conn.gracePeriodTimer = null;
        process.stderr.write(`[MCP] "${msg.fileName}" reconnected within grace period\n`);
      } else {
        conn = createConnection(ws);
      }
      conn.fileInfo = { fileName: msg.fileName, fileKey, currentPage: msg.currentPage, currentPageId: msg.currentPageId };
      clients.set(fileKey, conn);
      activeFileKey = fileKey;
      process.stderr.write(`[MCP] Identified: "${msg.fileName}" [${fileKey}] (${clients.size} connected)\n`);
      // Notify all controller connections about the new Figma file
      for (const c of clients.values()) {
        if (c.isController && c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({ type: 'FILE_INFO', ...conn.fileInfo }));
        }
      }
      return;
    }

    // ── Controller connection (Fauna standalone app) ────────────────
    if (msg.type === 'client-hello') {
      clearTimeout(identifyTimer);
      const clientName = msg.clientName || 'Fauna App';
      fileKey = 'controller-' + clientName.replace(/\s+/g, '-').toLowerCase();
      const existing = clients.get(fileKey);
      if (existing && existing.gracePeriodTimer) {
        clearTimeout(existing.gracePeriodTimer);
        conn = existing; conn.ws = ws; conn.gracePeriodTimer = null;
        process.stderr.write(`[MCP] Controller "${clientName}" reconnected within grace period\n`);
      } else {
        conn = createConnection(ws, true); // isController = true
      }
      conn.fileInfo = { fileName: clientName, fileKey, currentPage: '', currentPageId: '' };
      clients.set(fileKey, conn);
      // Controllers do NOT become the activeFileKey — Figma plugins have priority
      process.stderr.write(`[MCP] Controller connected: "${conn.fileInfo.fileName}" [${fileKey}]\n`);
      // Send current state to controller
      const sys = getActiveSystem();
      ws.send(JSON.stringify({ type: 'active-system', id: sys.id, name: sys.name }));
      if (activeFileKey) {
        const activConn = clients.get(activeFileKey);
        if (activConn && activConn.fileInfo) ws.send(JSON.stringify({ type: 'FILE_INFO', ...activConn.fileInfo }));
      }
      return;
    }

    if (!conn) return;
    conn.lastActivity = Date.now();

    // ── Active-system request ─────────────────────────────────────────────
    if (msg.type === 'get-active-system') {
      const sys = getActiveSystem();
      ws.send(JSON.stringify({ type: 'active-system', id: sys.id, name: sys.name }));
      return;
    }

    // ── Console log → buffer (max 1000) ──────────────────────────────────
    if (msg.type === 'console-capture') {
      conn.consoleLogs.push({ level: msg.level, message: msg.message, timestamp: msg.timestamp || Date.now() });
      if (conn.consoleLogs.length > 1000) conn.consoleLogs.shift();
      return;
    }

    // ── Selection change → buffer ─────────────────────────────────────────
    if (msg.type === 'SELECTION_CHANGE') {
      conn.selection = { nodes: msg.nodes || [], page: msg.page || '', timestamp: msg.timestamp || Date.now() };
      return;
    }

    // ── Chat message ──────────────────────────────────────────────────────
    if (msg.type === 'chat-message') {
      const chatWs = ws;
      try {
        process.stderr.write(`[Chat] "${msg.message}"\n`);
        const ai = await resolveWithAI(msg.message);

        if (ai.action === 'switch-system' && ai.systemId) {
          const cfg = loadSystems();
          const sys = cfg.systems.find(s => s.id === ai.systemId);
          if (sys) { cfg.activeSystem = ai.systemId; saveSystems(cfg); chatWs.send(JSON.stringify({ type: 'active-system', id: sys.id, name: sys.name })); }
          chatWs.send(JSON.stringify({ type: 'chat-response', id: msg.id, success: true, explanation: ai.explanation || `Switched to ${ai.systemId}` }));
          return;
        }
        if (ai.action === 'list-systems') {
          const cfg = loadSystems();
          const lines = cfg.systems.map(s => `• ${s.name} [${s.id}]${s.id === cfg.activeSystem ? ' ← active' : ''}`).join('\n');
          chatWs.send(JSON.stringify({ type: 'chat-response', id: msg.id, success: true, explanation: lines }));
          return;
        }

        let cmdType = 'create-page-layout';
        if (ai.mode === 'edit')       cmdType = 'edit-layout';
        if (ai.mode === 'components') cmdType = 'place-components';

        const cmdId  = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const ctimer = setTimeout(() => {
          pending.delete(cmdId);
          chatWs.send(JSON.stringify({ type: 'chat-response', id: msg.id, success: false, error: 'Figma execution timeout' }));
        }, 90000);
        pending.set(cmdId, {
          resolve: result => {
            clearTimeout(ctimer);
            chatWs.send(JSON.stringify({ type: 'chat-response', id: msg.id, success: true, explanation: ai.explanation || 'Done',
              placed: result.placed ? result.placed.map(p => p.name || p) : [],
              errors: result.errors  ? result.errors.map(e => e.error  || e) : [] }));
          },
          reject: err => { clearTimeout(ctimer); chatWs.send(JSON.stringify({ type: 'chat-response', id: msg.id, success: false, error: err.message })); },
          timer: ctimer, fileKey
        });
        chatWs.send(JSON.stringify({ ...ai, type: cmdType, id: cmdId }));
      } catch (err) {
        chatWs.send(JSON.stringify({ type: 'chat-response', id: msg.id, success: false, error: err.message }));
      }
      return;
    }

    // ── Controller execute-code: forward to active Figma plugin ───────────
    if (msg.type === 'execute-code' && conn && conn.isController) {
      sendToFigma({ type: 'execute-code', code: msg.code }, 30000)
        .then(result => ws.send(JSON.stringify({ type: 'execute-result', id: msg.id, result: result.result, error: result.error })))
        .catch(err  => ws.send(JSON.stringify({ type: 'execute-result', id: msg.id, error: err.message })));
      return;
    }

    // ── Controller progress-log: broadcast to all Figma plugin clients ────
    if (msg.type === 'progress-log' && conn && conn.isController) {
      for (const c of clients.values()) {
        if (!c.isController && c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({ type: 'progress-log', message: msg.message, level: msg.level || 'info' }));
        }
      }
      return;
    }

    // ── Resolve a pending command result ──────────────────────────────────
    if (msg.id && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id);
      clearTimeout(timer); pending.delete(msg.id); resolve(msg);
    }
  });

  ws.on('close', () => {
    if (!fileKey || !conn) return;
    const name = conn.fileInfo ? conn.fileInfo.fileName : fileKey;
    process.stderr.write(`[MCP] "${name}" disconnected — 5 s grace period\n`);
    conn.gracePeriodTimer = setTimeout(() => {
      if (clients.get(fileKey) !== conn) return;
      clients.delete(fileKey);
      if (activeFileKey === fileKey) {
        activeFileKey = [...clients.keys()].find(k => {
          const c = clients.get(k);
          return !c.isController && c.ws.readyState === 1;
        }) || null;
      }
      for (const [id, req] of pending) {
        if (req.fileKey === fileKey) { clearTimeout(req.timer); pending.delete(id); req.reject(new Error(`"${name}" disconnected`)); }
      }
      process.stderr.write(`[MCP] "${name}" removed (${clients.size} remaining)\n`);
    }, 5000);
  });
});

// Send command to a specific file (or the active file) — 15 s default timeout
function sendToFigma(command, timeoutMs = 15000, targetFileKey = null) {
  return new Promise((resolve, reject) => {
    const key    = targetFileKey || activeFileKey;
    const client = key ? clients.get(key) : null;
    // Never route commands to controller connections — they are not Figma plugins
    const target = (client && !client.isController && client.ws.readyState === 1)
      ? client
      : [...clients.values()].find(c => !c.isController && c.ws.readyState === 1);
    if (!target) return reject(new Error('No Figma plugin connected — open Fauna or FaunaMCP in Figma'));
    const id    = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout after ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer, fileKey: target.fileInfo && target.fileInfo.fileKey });
    target.ws.send(JSON.stringify({ ...command, id }));
  });
}


// ── MCP Server ────────────────────────────────────────────────────────────
// registerTools registers all tools on a given McpServer instance.
// Called once for the stdio server and once per HTTP session — each needs
// its own McpServer because the SDK only allows one transport per instance.
function registerTools(mcp) {

// ── Design system tools ───────────────────────────────────────────────────

mcp.tool('list_design_systems',
  'List all registered design systems and which one is currently active',
  {},
  async () => {
    const cfg = loadSystems();
    const lines = cfg.systems.map(s => {
      const active = s.id === cfg.activeSystem ? ' ← ACTIVE' : '';
      const hasTokens = fs.existsSync(path.join(__dirname, s.tokenIndex)) ? '🎨 tokens indexed' : '⬜ tokens not indexed';
      const hasComps  = fs.existsSync(path.join(__dirname, s.componentIndex)) ? '✅ components' : '❌ no components';
      return `• ${s.name} [${s.id}]${active}\n  ${hasComps} | ${hasTokens}\n  File: ${s.figmaFileKey}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  }
);

mcp.tool('switch_active_system',
  'Switch the active design system used for component resolution and token application',
  { system_id: z.string().describe('System ID from list_design_systems') },
  async ({ system_id }) => {
    const cfg = loadSystems();
    const sys = cfg.systems.find(s => s.id === system_id);
    if (!sys) return { content: [{ type: 'text', text: `Unknown system "${system_id}". Valid: ${cfg.systems.map(s=>s.id).join(', ')}` }] };
    cfg.activeSystem = system_id;
    saveSystems(cfg);
    return { content: [{ type: 'text', text: `✅ Active system switched to "${sys.name}"` }] };
  }
);

mcp.tool('register_design_system',
  'Register a new design system. After registering, run index_tokens to index its tokens.',
  {
    id:           z.string().describe('Short identifier, e.g. "my-system"'),
    name:         z.string().describe('Display name, e.g. "My Design System"'),
    figma_file_key: z.string().describe('Figma file key (from the URL: figma.com/design/<KEY>/...)'),
    description:  z.string().optional().describe('Short description of the system'),
    component_index: z.string().optional().describe('Path to components JSON (default: components/<id>.json)')
  },
  async ({ id, name, figma_file_key, description, component_index }) => {
    const cfg = loadSystems();
    if (cfg.systems.find(s => s.id === id)) {
      return { content: [{ type: 'text', text: `System "${id}" already registered. Use a different ID.` }] };
    }
    cfg.systems.push({
      id, name,
      figmaFileKey:     figma_file_key,
      componentIndex:   component_index || `components/${id}.json`,
      tokenIndex:       `tokens/${id}.json`,
      description:      description || ''
    });
    saveSystems(cfg);
    return { content: [{ type: 'text', text: `✅ Registered "${name}" [${id}].\n\nNext steps:\n1. Run index_tokens to index tokens from the Figma file\n2. Point componentIndex to the components JSON (if you have one)` }] };
  }
);

mcp.tool('index_tokens',
  'Index design tokens (variables) from a design system\'s Figma file. Requires a Figma Personal Access Token.',
  {
    system_id:    z.string().describe('System ID to index'),
    figma_token:  z.string().describe('Figma Personal Access Token (from figma.com/developers/api#access-tokens)')
  },
  async ({ system_id, figma_token }) => {
    const cfg = loadSystems();
    const sys = cfg.systems.find(s => s.id === system_id);
    if (!sys) return { content: [{ type: 'text', text: `Unknown system "${system_id}"` }] };

    // Fetch variables from Figma REST API
    const rawData = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.figma.com',
        path: `/v1/files/${sys.figmaFileKey}/variables/local`,
        headers: { 'X-Figma-Token': figma_token }
      };
      https.get(options, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });

    if (rawData.status === 403 || rawData.err) {
      return { content: [{ type: 'text', text: `Figma API error: ${rawData.err || 'Invalid token or no access to file'}` }] };
    }

    const meta        = rawData.meta || {};
    const collections = meta.variableCollections || {};
    const variables   = meta.variables || {};

    const output = {
      system: sys.id, systemName: sys.name,
      figmaFileKey: sys.figmaFileKey,
      indexedAt: new Date().toISOString(),
      collections: []
    };

    for (const [colId, col] of Object.entries(collections)) {
      const modeMap = {};
      for (const mode of (col.modes || [])) modeMap[mode.modeId] = mode.name;

      const tokenList = [];
      for (const varId of (col.variableIds || [])) {
        const v = variables[varId];
        if (!v || v.remote) continue;
        const resolved = {};
        for (const [modeId, val] of Object.entries(v.valuesByMode || {})) {
          const modeName = modeMap[modeId] || modeId;
          resolved[modeName] = val.type === 'VARIABLE_ALIAS'
            ? { alias: (variables[val.id] || {}).name || val.id }
            : val;
        }
        tokenList.push({
          name: v.name, key: v.key, id: varId,
          type: v.resolvedType, collection: col.name, collectionId: colId,
          scopes: v.scopes || [], resolvedValues: resolved
        });
      }
      output.collections.push({ id: colId, name: col.name, modes: Object.values(modeMap), tokenCount: tokenList.length, tokens: tokenList });
    }

    const totalTokens = output.collections.reduce((n, c) => n + c.tokenCount, 0);
    const outPath = path.join(__dirname, sys.tokenIndex);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

    return { content: [{ type: 'text', text: `✅ Indexed ${output.collections.length} collections, ${totalTokens} tokens for "${sys.name}".\nSaved to ${sys.tokenIndex}` }] };
  }
);

// ── Component tools ───────────────────────────────────────────────────────

mcp.tool('figma_status', 'Check if Figma plugin is connected and which files are open', {},
  async () => {
    const active = getActiveSystem();
    if (clients.size === 0) {
      return { content: [{ type: 'text', text: `❌ No plugins connected | Active system: ${active.name}\nOpen Fauna or FaunaMCP plugin in Figma` }] };
    }
    const lines = [...clients.entries()].map(([key, c]) => {
      const info = c.fileInfo || {};
      const age  = Math.round((Date.now() - c.lastActivity) / 1000);
      return `• "${info.fileName || key}" — page: ${info.currentPage || '?'} — idle: ${age}s${key === activeFileKey ? ' ← ACTIVE' : ''}`;
    });
    return { content: [{ type: 'text', text: `✅ ${clients.size} plugin(s) connected | Active system: ${active.name}\n\n${lines.join('\n')}` }] };
  }
);

mcp.tool('figma_list_connected_files',
  'List all Figma files currently connected to the MCP server',
  {},
  async () => {
    if (clients.size === 0) return { content: [{ type: 'text', text: 'No files connected.' }] };
    const rows = [...clients.entries()].map(([key, c]) => ({
      fileKey: key, fileName: c.fileInfo?.fileName, currentPage: c.fileInfo?.currentPage,
      selectionCount: c.selection?.nodes?.length ?? 0,
      consoleLogCount: c.consoleLogs.length,
      isActive: key === activeFileKey
    }));
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  }
);

mcp.tool('figma_execute',
  'Execute arbitrary Figma Plugin API JavaScript in the plugin sandbox. Use this for any Figma operation not covered by other tools.',
  {
    code:       z.string().describe('JavaScript code to run. Has access to the full Figma Plugin API (figma.*, etc). Can be async (use await). Return a value to get output.'),
    timeout_ms: z.number().optional().describe('Execution timeout in ms (default 15000, max 30000)'),
    file_key:   z.string().optional().describe('Target a specific connected file (defaults to active file)')
  },
  async ({ code, timeout_ms, file_key }) => {
    const timeout = Math.min(timeout_ms || 15000, 30000);
    // Prepend font pre-loading + a loadFont helper so agents never hit
    // "unloaded font in appendChild" errors for common design-system fonts.
    const fontHelper = `
// Pre-load common Segoe Sans variants used by design system components
await Promise.allSettled([
  figma.loadFontAsync({ family: 'Segoe Sans', style: 'Regular' }),
  figma.loadFontAsync({ family: 'Segoe Sans', style: 'Text Regular' }),
  figma.loadFontAsync({ family: 'Segoe Sans', style: 'Bold' }),
  figma.loadFontAsync({ family: 'Segoe Sans', style: 'Semibold' }),
  figma.loadFontAsync({ family: 'Segoe Sans', style: 'Text Bold' }),
  figma.loadFontAsync({ family: 'Segoe Sans', style: 'Text Semibold' }),
  figma.loadFontAsync({ family: 'Segoe UI', style: 'Regular' }),
  figma.loadFontAsync({ family: 'Segoe UI', style: 'Bold' }),
  figma.loadFontAsync({ family: 'Segoe UI', style: 'Semibold' }),
]);
async function loadFont(textNode) {
  const fn = textNode.fontName;
  try { await figma.loadFontAsync(fn); return; } catch(_) {}
  const parts = fn.style.split(' ');
  if (parts.length >= 2) {
    const rev = { family: fn.family, style: parts.slice().reverse().join(' ') };
    try { await figma.loadFontAsync(rev); textNode.fontName = rev; return; } catch(_) {}
  }
  const synonyms = {Demibold:'Semibold',Semibold:'Demibold',Medium:'Regular',Heavy:'Bold',Black:'Bold',ExtraBold:'Bold'};
  for (const [from, to] of Object.entries(synonyms)) {
    if (fn.style.includes(from)) {
      const alt = { family: fn.family, style: fn.style.replace(from, to) };
      try { await figma.loadFontAsync(alt); textNode.fontName = alt; return; } catch(_) {}
    }
  }
  const s = fn.style.toLowerCase();
  const w = s.includes('bold') ? 'Bold' : (s.includes('semi') || s.includes('demi')) ? 'Semibold' : 'Regular';
  const fb = { family: 'Segoe UI', style: w };
  await figma.loadFontAsync(fb); textNode.fontName = fb;
}
`;
    const wrappedCode = fontHelper + code;
    const result  = await sendToFigma({ type: 'execute-code', code: wrappedCode }, timeout, file_key || null);
    if (result.success) {
      const out = result.result !== null && result.result !== undefined
        ? (typeof result.result === 'object' ? JSON.stringify(result.result, null, 2) : String(result.result))
        : '(no return value)';
      return { content: [{ type: 'text', text: `✅ Executed successfully\n\nResult:\n${out}` }] };
    } else {
      return { content: [{ type: 'text', text: `❌ Error: ${result.error}` }] };
    }
  }
);

mcp.tool('figma_get_console_logs',
  'Get recent console.log/warn/error output from the Figma plugin sandbox',
  {
    count:    z.number().optional().describe('Number of recent logs to return (default 50, max 500)'),
    level:    z.enum(['log','warn','error','info','all']).optional().describe('Filter by log level (default: all)'),
    file_key: z.string().optional().describe('Target file (defaults to active file)')
  },
  async ({ count, level, file_key }) => {
    const key    = file_key || activeFileKey;
    const client = key ? clients.get(key) : [...clients.values()][0];
    if (!client) return { content: [{ type: 'text', text: 'No plugin connected.' }] };
    const n    = Math.min(count || 50, 500);
    let   logs = client.consoleLogs.slice(-n);
    if (level && level !== 'all') logs = logs.filter(l => l.level === level);
    if (logs.length === 0) return { content: [{ type: 'text', text: 'No console logs yet.' }] };
    const lines = logs.map(l => `[${new Date(l.timestamp).toLocaleTimeString()}] ${l.level.toUpperCase()}: ${l.message}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

mcp.tool('search_components',
  'Search components across all registered design systems',
  {
    query:      z.string().describe('Name or keyword to search'),
    system_id:  z.string().optional().describe('Limit to a specific system ID')
  },
  async ({ query, system_id }) => {
    const results = searchAllComponents(query, system_id ? [system_id] : null);
    return { content: [{ type: 'text', text: results.length ? JSON.stringify(results, null, 2) : `No components found for "${query}"` }] };
  }
);

mcp.tool('search_tokens',
  'Search design tokens (colors, spacing, radius, etc.) in a design system',
  {
    query:     z.string().describe('Token name, type (COLOR/FLOAT), or scope (FILL_COLOR/CORNER_RADIUS/GAP)'),
    system_id: z.string().optional().describe('System ID (defaults to active system)')
  },
  async ({ query, system_id }) => {
    const cfg = loadSystems();
    const sys = system_id ? cfg.systems.find(s => s.id === system_id) : getActiveSystem();
    if (!sys) return { content: [{ type: 'text', text: `Unknown system` }] };
    const results = searchTokens(query, sys);
    return { content: [{ type: 'text', text: results.length
      ? JSON.stringify(results, null, 2)
      : `No tokens found for "${query}" in ${sys.name}. Run index_tokens first.` }] };
  }
);

mcp.tool('apply_token',
  'Apply a design token (variable) to a property of the currently selected Figma node',
  {
    token_key: z.string().describe('Token key from search_tokens'),
    property:  z.enum(['fill','stroke','cornerRadius','gap','paddingTop','paddingRight','paddingBottom','paddingLeft']).describe('Which property to bind the token to'),
    node_id:   z.string().optional().describe('Target node ID (defaults to current selection)')
  },
  async ({ token_key, property, node_id }) => {
    const result = await sendToFigma({ type: 'apply-token', tokenKey: token_key, property, nodeId: node_id || null });
    return { content: [{ type: 'text', text: result.success ? `✅ Token applied to ${property}` : `❌ ${result.error}` }] };
  }
);

// ── Layout tools ──────────────────────────────────────────────────────────

mcp.tool('create_page_layout',
  'Create a full page layout in Figma from a natural language description',
  {
    description:  z.string().describe('What to create, e.g. "Dashboard with nav, metric cards, and data grid"'),
    frame_width:  z.number().optional(),
    frame_height: z.number().optional(),
    system_id:    z.string().optional().describe('Design system to use (defaults to active)')
  },
  async ({ description, frame_width, frame_height, system_id }) => {
    const cfg = loadSystems();
    if (system_id) { const s = cfg.systems.find(x => x.id === system_id); if (s) { cfg.activeSystem = s.id; } }

    const w  = frame_width  || 1920;
    const h  = frame_height || 1080;
    const ai = await resolveWithAI(`Create a page layout: ${description}. frameWidth=${w}, frameHeight=${h}`);
    if (!ai.components?.length) return { content: [{ type: 'text', text: 'AI returned no components.' }] };

    const result = await sendToFigma({ type: 'create-page-layout', components: ai.components, layoutName: ai.layoutName || description.slice(0, 40), frameWidth: w, frameHeight: h });

    // Apply any token overrides the AI specified
    if (ai.tokenOverrides?.length) {
      for (const to of ai.tokenOverrides) {
        try { await sendToFigma({ type: 'apply-token', tokenKey: to.tokenKey, property: to.property, layerName: to.layerName }); } catch (_) {}
      }
    }

    const placed = (result.placed || []).map(p => p.name).join(', ');
    const errs   = (result.errors || []).map(e => `${e.name}: ${e.error}`).join('; ');
    return { content: [{ type: 'text', text: `✅ Layout created.\nPlaced: ${placed}${errs ? `\n⚠️ ${errs}` : ''}\n\n${ai.explanation || ''}` }] };
  }
);

mcp.tool('edit_layout',
  'Add or modify components in an existing Figma layout (must be selected in Figma)',
  {
    description:    z.string().describe('What to add/change'),
    target_node_id: z.string().optional()
  },
  async ({ description, target_node_id }) => {
    const ai = await resolveWithAI(`Edit existing layout: ${description}. Respond with mode "edit".`);
    if (!ai.components?.length) return { content: [{ type: 'text', text: 'No components to add.' }] };

    const result = await sendToFigma({ type: 'edit-layout', components: ai.components, targetNodeId: target_node_id || null });
    const placed = (result.placed || []).map(p => p.name).join(', ');
    return { content: [{ type: 'text', text: `✅ Added: ${placed}` }] };
  }
);

mcp.tool('place_component',
  'Place a specific component on the current Figma page',
  {
    description: z.string().describe('Component to place'),
    x: z.number().optional(), y: z.number().optional()
  },
  async ({ description, x, y }) => {
    const ai = await resolveWithAI(`Place component: ${description}`);
    if (!ai.components?.length) return { content: [{ type: 'text', text: 'No component found.' }] };
    const comps  = ai.components.map(c => ({ ...c, x: x || 100, y: y || 100 }));
    const result = await sendToFigma({ type: 'place-components', components: comps });
    return { content: [{ type: 'text', text: `✅ Placed: ${(result.placed||[]).map(p=>p.name).join(', ')}` }] };
  }
);

mcp.tool('get_selection', 'Get info about what is currently selected in Figma (from live buffer — instant)', {},
  async () => {
    const key    = activeFileKey;
    const client = key ? clients.get(key) : [...clients.values()][0];
    if (!client) return { content: [{ type: 'text', text: 'No plugin connected.' }] };
    // Return buffered selection (updated in real-time via SELECTION_CHANGE events)
    const sel = client.selection;
    if (!sel || !sel.nodes?.length) return { content: [{ type: 'text', text: 'Nothing selected.' }] };
    return { content: [{ type: 'text', text: JSON.stringify(sel, null, 2) }] };
  }
);

mcp.tool('list_pages', 'List all pages in the Figma document', {},
  async () => {
    const result = await sendToFigma({ type: 'list-pages' });
    return { content: [{ type: 'text', text: (result.pages || []).join('\n') || 'No pages' }] };
  }
);

} // ── end registerTools ──────────────────────────────────────────────────

// ── Start ─────────────────────────────────────────────────────────────────

// stdio transport (Claude Desktop, Copilot, etc.)
const mcpStdio = new McpServer({ name: 'figma-fauna', version: '2.0.0' });
registerTools(mcpStdio);
const transport = new StdioServerTransport();
await mcpStdio.connect(transport);

// ── HTTP/MCP server — any app that speaks MCP over HTTP can connect ────────

const HTTP_PORT    = 3336;
const httpSessions = new Map(); // sessionId → StreamableHTTPServerTransport

const httpServer = createServer(async (req, res) => {
  // CORS — allow local browser-based MCP clients
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
  if (url.pathname !== '/mcp') { res.writeHead(404); res.end('Not found'); return; }

  // GET /mcp — resume an existing SSE session
  if (req.method === 'GET') {
    const sid = req.headers['mcp-session-id'];
    if (sid && httpSessions.has(sid)) {
      await httpSessions.get(sid).handleRequest(req, res);
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown session — POST /mcp to initialize' }));
    }
    return;
  }

  // DELETE /mcp — close session
  if (req.method === 'DELETE') {
    const sid = req.headers['mcp-session-id'];
    if (sid && httpSessions.has(sid)) {
      await httpSessions.get(sid).handleRequest(req, res);
      httpSessions.delete(sid);
    } else {
      res.writeHead(404); res.end();
    }
    return;
  }

  // POST /mcp — MCP protocol messages
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { res.writeHead(400); res.end('Invalid JSON'); return; }

    const sid = req.headers['mcp-session-id'];

    if (sid && httpSessions.has(sid)) {
      // Existing session — route to its transport
      await httpSessions.get(sid).handleRequest(req, res, parsed);

    } else if (isInitializeRequest(parsed)) {
      // New or re-initializing session (stale session IDs are ignored — client
      // may send a leftover mcp-session-id after the relay restarts, and that's fine)
      if (sid) process.stderr.write(`[HTTP] Stale session ${sid} — creating new session\n`);
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
          httpSessions.set(id, t);
          process.stderr.write(`[HTTP] MCP session opened: ${id}\n`);
        }
      });
      t.onclose = () => {
        const id = t.sessionId;
        if (id) { httpSessions.delete(id); process.stderr.write(`[HTTP] MCP session closed: ${id}\n`); }
      };
      const httpMcp = new McpServer({ name: 'figma-fauna', version: '2.0.0' });
      registerTools(httpMcp);
      await httpMcp.connect(t);
      await t.handleRequest(req, res, parsed);

    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Send an MCP initialize request (no mcp-session-id) to start a session' }));
    }
    return;
  }

  res.writeHead(405); res.end('Method not allowed');
});

httpServer.on('error', err => handleServerError('HTTP/MCP', HTTP_PORT, err));

httpServer.listen(HTTP_PORT, () => {
  process.stderr.write(`[MCP] HTTP/MCP server on http://localhost:${HTTP_PORT}/mcp\n`);
});

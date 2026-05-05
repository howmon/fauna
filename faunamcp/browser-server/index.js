/**
 * FaunaBrowserMCP relay server
 *
 * WS  :3340  — Chrome/Edge extension connects here
 * HTTP :3341  — MCP clients connect (Streamable HTTP, 2025-03-26)
 * stdio       — stdio MCP for Claude Desktop / VS Code / Cursor
 *
 * Protocol (extension ↔ relay):
 *   ext → relay: { type:'ext:hello', version, activeTab, userAgent }
 *   ext → relay: { type:'result', id, ok, ...data }
 *   ext → relay: { type:'ping' }
 *   relay → ext: { type:'pong' }
 *   relay → ext: { type:'cmd', id, action, params, tabId? }
 */

import { WebSocketServer }              from 'ws';
import { McpServer }                    from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }         from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest }          from '@modelcontextprotocol/sdk/types.js';
import { createServer }                 from 'http';
import { randomUUID }                   from 'crypto';
import { z }                            from 'zod';

const WS_PORT   = 3340;
const HTTP_PORT = 3341;

// ── Extension connection state ────────────────────────────────────────────

let extConn = null; // { ws, info }

// Pending relay→extension commands  id → { resolve, reject, timer }
const pending = new Map();

function sendToExt(action, params = {}, tabId = null, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!extConn || extConn.ws.readyState !== 1) {
      return reject(new Error(
        '❌ No browser extension connected.\n' +
        'Install the FaunaBrowserMCP extension in Chrome or Edge, ' +
        'then check it shows "Connected" in the extension popup.'
      ));
    }
    const id    = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command "${action}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const msg = { type: 'cmd', id, action, params };
    if (tabId != null) msg.tabId = tabId;
    extConn.ws.send(JSON.stringify(msg));
  });
}

function resultText(r) {
  if (!r.ok) return `❌ ${r.error || 'Unknown error'}`;
  const { type, id, ok, ...data } = r;
  return JSON.stringify(data, null, 2);
}

// ── WebSocket server (extension connects here) ────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws) => {
  let conn = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'ext:hello') {
      conn = { ws, info: msg };
      extConn = conn;
      process.stderr.write(`[Browser] Extension connected — ${msg.userAgent || 'unknown'}\n`);
      if (msg.activeTab) {
        process.stderr.write(`[Browser] Active tab: ${msg.activeTab.title || msg.activeTab.url}\n`);
      }
      return;
    }

    // Result from extension → resolve pending promise
    if ((msg.type === 'result') && msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  });

  ws.on('close', () => {
    if (conn === extConn) {
      extConn = null;
      process.stderr.write('[Browser] Extension disconnected\n');
    }
  });
});

// ── MCP tool registry ─────────────────────────────────────────────────────
// registerTools is called once per McpServer instance (stdio + each HTTP session).

function registerTools(mcp) {

mcp.tool('browser_status',
  'Check if the FaunaBrowserMCP browser extension is connected and which tab is active',
  {},
  async () => {
    if (!extConn) {
      return { content: [{ type: 'text', text: '❌ No browser extension connected.\nInstall FaunaBrowserMCP extension in Chrome/Edge.' }] };
    }
    const info = extConn.info;
    const tab  = info.activeTab;
    const lines = [
      '✅ Browser extension connected',
      tab ? `Active tab: "${tab.title}" — ${tab.url}` : 'No active tab info'
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

mcp.tool('browser_list_tabs',
  'List all open browser tabs across all windows',
  {},
  async () => {
    const r = await sendToExt('tab:list');
    return { content: [{ type: 'text', text: r.ok ? JSON.stringify(r.tabs, null, 2) : `❌ ${r.error}` }] };
  }
);

mcp.tool('browser_navigate',
  'Navigate the active tab (or a specific tab) to a URL',
  {
    url:    z.string().describe('Full URL to navigate to, e.g. https://example.com'),
    tab_id: z.number().optional().describe('Tab ID to navigate (defaults to active tab)')
  },
  async ({ url, tab_id }) => {
    const r = await sendToExt('navigate', { url }, tab_id ?? null);
    return { content: [{ type: 'text', text: r.ok ? `✅ Navigated to ${r.url}` : `❌ ${r.error}` }] };
  }
);

mcp.tool('browser_get_content',
  'Get the text content, links, headings and cards from the current page',
  {
    max_chars: z.number().optional().describe('Max characters of page text to return (default 12000)'),
    tab_id:    z.number().optional()
  },
  async ({ max_chars, tab_id }) => {
    const r = await sendToExt('extract', { maxChars: max_chars || 12000 }, tab_id ?? null);
    return { content: [{ type: 'text', text: resultText(r) }] };
  }
);

mcp.tool('browser_get_forms',
  'Extract all form fields (inputs, selects, textareas) from the current page',
  { tab_id: z.number().optional() },
  async ({ tab_id }) => {
    const r = await sendToExt('extract-forms', {}, tab_id ?? null);
    return { content: [{ type: 'text', text: resultText(r) }] };
  }
);

mcp.tool('browser_get_assets',
  'Extract all CSS, scripts, images, SVGs and design tokens from the current page',
  { tab_id: z.number().optional() },
  async ({ tab_id }) => {
    const r = await sendToExt('extract-assets', {}, tab_id ?? null);
    return { content: [{ type: 'text', text: resultText(r) }] };
  }
);

mcp.tool('browser_click',
  'Click an element on the page by CSS selector, visible text, or coordinates',
  {
    selector: z.string().optional().describe('CSS selector, e.g. button.submit or #login-btn'),
    text:     z.string().optional().describe('Visible text to match, e.g. "Sign in"'),
    x:        z.number().optional().describe('X coordinate (viewport pixels)'),
    y:        z.number().optional().describe('Y coordinate (viewport pixels)'),
    tab_id:   z.number().optional()
  },
  async ({ selector, text, x, y, tab_id }) => {
    const r = await sendToExt('click', { selector, text, x, y }, tab_id ?? null);
    return { content: [{ type: 'text', text: r.ok ? '✅ Clicked' : `❌ ${r.error}${r.candidates ? '\n\nNearby elements:\n' + JSON.stringify(r.candidates, null, 2) : ''}` }] };
  }
);

mcp.tool('browser_type',
  'Type text into a focused or selected input field, character by character (triggers autocomplete)',
  {
    text:        z.string().describe('Text to type'),
    selector:    z.string().optional().describe('CSS selector of the input (defaults to currently focused element)'),
    clear:       z.boolean().optional().describe('Clear existing value first (default true)'),
    press_enter: z.boolean().optional().describe('Press Enter after typing'),
    delay_ms:    z.number().optional().describe('Delay between keystrokes in ms (default 40)'),
    tab_id:      z.number().optional()
  },
  async ({ text, selector, clear, press_enter, delay_ms, tab_id }) => {
    const r = await sendToExt('type', {
      text, selector,
      clear:      clear      ?? true,
      pressEnter: press_enter ?? false,
      delay:      delay_ms   ?? 40
    }, tab_id ?? null);
    return { content: [{ type: 'text', text: r.ok ? `✅ Typed: "${text}"` : `❌ ${r.error}` }] };
  }
);

mcp.tool('browser_fill_form',
  'Fill multiple form fields at once. Each field needs a CSS selector and value.',
  {
    fields: z.array(z.object({
      selector: z.string().describe('CSS selector for the input'),
      value:    z.string().describe('Value to fill')
    })).describe('Array of { selector, value } pairs'),
    tab_id: z.number().optional()
  },
  async ({ fields, tab_id }) => {
    const r = await sendToExt('fill', { fields }, tab_id ?? null);
    return { content: [{ type: 'text', text: resultText(r) }] };
  }
);

mcp.tool('browser_scroll',
  'Scroll the page or a specific element',
  {
    direction: z.enum(['up', 'down', 'left', 'right', 'top', 'bottom']).optional().describe('Scroll direction (default: down)'),
    px:        z.number().optional().describe('Pixels to scroll (default: ~80% of viewport)'),
    selector:  z.string().optional().describe('Scroll a specific element instead of the page'),
    tab_id:    z.number().optional()
  },
  async ({ direction, px, selector, tab_id }) => {
    const r = await sendToExt('scroll', { direction: direction || 'down', px, selector }, tab_id ?? null);
    return { content: [{ type: 'text', text: r.ok ? `✅ Scrolled ${direction || 'down'}${px ? ` ${px}px` : ''}` : `❌ ${r.error}` }] };
  }
);

mcp.tool('browser_eval',
  'Execute JavaScript in the context of the current page and return the result',
  {
    js:     z.string().describe('JavaScript code to execute (can be async)'),
    tab_id: z.number().optional()
  },
  async ({ js, tab_id }) => {
    const r = await sendToExt('eval', { js }, tab_id ?? null);
    return { content: [{ type: 'text', text: r.ok ? `Result: ${r.result}` : `❌ ${r.error}` }] };
  }
);

mcp.tool('browser_screenshot',
  'Take a screenshot of the visible area of the current tab',
  {
    full_page: z.boolean().optional().describe('Capture full scrollable page (default: false = visible area only)'),
    tab_id:    z.number().optional()
  },
  async ({ full_page, tab_id }) => {
    const action = full_page ? 'snapshot-full' : 'snapshot';
    const r = await sendToExt(action, {}, tab_id ?? null, 30000);
    if (!r.ok) return { content: [{ type: 'text', text: `❌ ${r.error}` }] };
    if (r.base64 || r.dataUrl) {
      const b64 = r.base64 || r.dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
      return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
    }
    return { content: [{ type: 'text', text: '❌ No image data returned' }] };
  }
);

mcp.tool('browser_get_console',
  'Get recent console.log / warn / error output from the current page',
  {
    limit:  z.number().optional().describe('Number of entries to return (default 100)'),
    tab_id: z.number().optional()
  },
  async ({ limit, tab_id }) => {
    const r = await sendToExt('devtools:console', { limit: limit || 100 }, tab_id ?? null);
    return { content: [{ type: 'text', text: resultText(r) }] };
  }
);

mcp.tool('browser_get_network',
  'Get network requests made by the current page (from Performance API)',
  {
    filter:    z.string().optional().describe('Filter requests by URL substring'),
    tab_id:    z.number().optional()
  },
  async ({ filter, tab_id }) => {
    const r = await sendToExt('devtools:network', { filter }, tab_id ?? null);
    return { content: [{ type: 'text', text: resultText(r) }] };
  }
);

mcp.tool('browser_get_cookies',
  'Get all cookies for the current tab',
  { tab_id: z.number().optional() },
  async ({ tab_id }) => {
    const r = await sendToExt('devtools:cookies', {}, tab_id ?? null);
    return { content: [{ type: 'text', text: resultText(r) }] };
  }
);

mcp.tool('browser_get_storage',
  'Get localStorage and sessionStorage contents for the current page',
  { tab_id: z.number().optional() },
  async ({ tab_id }) => {
    const r = await sendToExt('devtools:storage', {}, tab_id ?? null);
    return { content: [{ type: 'text', text: resultText(r) }] };
  }
);

mcp.tool('browser_new_tab',
  'Open a new browser tab',
  { url: z.string().optional().describe('URL to open (default: about:blank)') },
  async ({ url }) => {
    const r = await sendToExt('tab:new', { url: url || 'about:blank' });
    return { content: [{ type: 'text', text: r.ok ? `✅ New tab opened (id: ${r.tabId})` : `❌ ${r.error}` }] };
  }
);

mcp.tool('browser_close_tab',
  'Close a browser tab',
  { tab_id: z.number().optional().describe('Tab ID to close (defaults to active tab)') },
  async ({ tab_id }) => {
    const r = await sendToExt('tab:close', { tabId: tab_id ?? null });
    return { content: [{ type: 'text', text: r.ok ? `✅ Closed tab ${r.closed}` : `❌ ${r.error}` }] };
  }
);

mcp.tool('browser_switch_tab',
  'Switch focus to a different browser tab',
  {
    tab_id: z.number().optional().describe('Tab ID to switch to'),
    index:  z.number().optional().describe('Tab index (0-based) as alternative to tab_id')
  },
  async ({ tab_id, index }) => {
    const r = await sendToExt('tab:switch', { tabId: tab_id, index });
    return { content: [{ type: 'text', text: r.ok ? `✅ Switched to "${r.title}" — ${r.url}` : `❌ ${r.error}` }] };
  }
);

mcp.tool('browser_keyboard',
  'Send a keyboard event to the focused element or a target selector',
  {
    key:      z.string().describe('Key name, e.g. "Enter", "Escape", "Tab", "ArrowDown"'),
    selector: z.string().optional().describe('Target element selector (defaults to focused element)'),
    tab_id:   z.number().optional()
  },
  async ({ key, selector, tab_id }) => {
    const r = await sendToExt('keyboard', { key, selector }, tab_id ?? null);
    return { content: [{ type: 'text', text: r.ok ? `✅ Key "${key}" sent` : `❌ ${r.error}` }] };
  }
);

mcp.tool('browser_hover',
  'Hover over an element (triggers tooltips, dropdowns, etc.)',
  {
    selector: z.string().describe('CSS selector of element to hover'),
    tab_id:   z.number().optional()
  },
  async ({ selector, tab_id }) => {
    const r = await sendToExt('hover', { selector }, tab_id ?? null);
    return { content: [{ type: 'text', text: r.ok ? `✅ Hovered on "${selector}"` : `❌ ${r.error}` }] };
  }
);

mcp.tool('browser_select',
  'Select an option in a <select> element by value or label',
  {
    selector: z.string().describe('CSS selector of the <select> element'),
    value:    z.string().optional().describe('Option value to select'),
    label:    z.string().optional().describe('Option label text to select'),
    tab_id:   z.number().optional()
  },
  async ({ selector, value, label, tab_id }) => {
    const r = await sendToExt('select', { selector, value, label }, tab_id ?? null);
    return { content: [{ type: 'text', text: r.ok ? `✅ Selected` : `❌ ${r.error}` }] };
  }
);

mcp.tool('browser_get_security',
  'Get TLS, HTTPS, mixed-content and CSP info for the current page',
  { tab_id: z.number().optional() },
  async ({ tab_id }) => {
    const r = await sendToExt('devtools:security', {}, tab_id ?? null);
    return { content: [{ type: 'text', text: resultText(r) }] };
  }
);

} // ── end registerTools ─────────────────────────────────────────────────────

// ── Stdio MCP (Claude Desktop, VS Code Copilot, Cursor) ──────────────────

process.stderr.write(`[MCP] FaunaBrowserMCP relay\n`);
process.stderr.write(`[MCP] Extension WS:  ws://localhost:${WS_PORT}\n`);
process.stderr.write(`[MCP] HTTP/MCP:      http://localhost:${HTTP_PORT}/mcp\n`);

const mcpStdio = new McpServer({ name: 'fauna-browser-mcp', version: '1.0.0' });
registerTools(mcpStdio);
const stdioTransport = new StdioServerTransport();
await mcpStdio.connect(stdioTransport);

// ── HTTP/MCP server ────────────────────────────────────────────────────────

const httpSessions = new Map();

const httpServer = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
  if (url.pathname !== '/mcp') { res.writeHead(404); res.end('Not found'); return; }

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

  if (req.method === 'DELETE') {
    const sid = req.headers['mcp-session-id'];
    if (sid && httpSessions.has(sid)) {
      await httpSessions.get(sid).handleRequest(req, res);
      httpSessions.delete(sid);
    } else { res.writeHead(404); res.end(); }
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }

    const sid = req.headers['mcp-session-id'];

    if (sid && httpSessions.has(sid)) {
      await httpSessions.get(sid).handleRequest(req, res, parsed);
    } else if (isInitializeRequest(parsed)) {
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
      const httpMcp = new McpServer({ name: 'fauna-browser-mcp', version: '1.0.0' });
      registerTools(httpMcp);
      await httpMcp.connect(t);
      await t.handleRequest(req, res, parsed);
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Send an MCP initialize request to start a session' }));
    }
    return;
  }

  res.writeHead(405); res.end('Method not allowed');
});

httpServer.listen(HTTP_PORT, () => {
  process.stderr.write(`[MCP] HTTP/MCP listening on http://localhost:${HTTP_PORT}/mcp\n`);
});

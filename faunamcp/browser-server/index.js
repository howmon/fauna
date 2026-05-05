/**
 * FaunaBrowserMCP relay server — v2
 *
 * WS  :3340  — Chrome/Edge extension connects here (optional)
 * HTTP :3341  — MCP clients connect (Streamable HTTP, 2025-03-26)
 * stdio       — stdio MCP for Claude Desktop / VS Code / Cursor
 *
 * Backend priority:
 *   1. Chrome/Edge extension (if connected) — user's real browser session
 *   2. Playwright headless fallback          — always available, no extension needed
 */

import { WebSocketServer }               from 'ws';
import { McpServer }                     from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }          from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest }           from '@modelcontextprotocol/sdk/types.js';
import { createServer }                  from 'http';
import { randomUUID }                    from 'crypto';
import { z }                             from 'zod';
import fs                                from 'fs';
import os                                from 'os';
import path                              from 'path';

const WS_PORT   = 3340;
const HTTP_PORT = 3341;

// ── Extension connection state ────────────────────────────────────────────

let extConn = null;
const pending = new Map();

function sendToExt(action, params = {}, tabId = null, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!extConn || extConn.ws.readyState !== 1) return reject(new Error('NO_EXT'));
    const id    = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Command "${action}" timed out after ${timeoutMs}ms`)); }, timeoutMs);
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

// ── Playwright fallback backend ───────────────────────────────────────────

class PlaywrightBackend {
  constructor() {
    this._pw      = null;
    this._browser = null;
    this._ctx     = null;
    this._page    = null;
    this._tracing = false;
    this._video   = false;
    this._consoleMsgs = [];
    this._netReqs     = [];
    this._routes      = new Map();
  }

  async _load() {
    if (this._pw) return;
    try {
      this._pw = await import('playwright-core');
    } catch (_) {
      const rootMod = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'node_modules', 'playwright-core', 'index.js');
      if (fs.existsSync(rootMod)) { this._pw = await import(rootMod); }
      else throw new Error('playwright-core not found. Run: npm install playwright-core');
    }
  }

  async _ensurePage() {
    await this._load();
    const chromium = this._pw.chromium || this._pw.default?.chromium;
    if (!chromium) throw new Error('playwright-core: chromium not found');
    if (this._browser && !this._browser.isConnected()) { this._browser = null; this._ctx = null; this._page = null; }
    if (!this._browser) {
      const EDGE   = process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      const CHROME = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      const execPath = fs.existsSync(EDGE) ? EDGE : fs.existsSync(CHROME) ? CHROME : undefined;
      this._browser = await chromium.launch({ executablePath: execPath, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
      process.stderr.write(`[PW] Browser launched${execPath ? ` (${path.basename(execPath)})` : ' (bundled)'}\n`);
    }
    if (!this._ctx) {
      this._ctx = await this._browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36', viewport: { width: 1280, height: 900 } });
    }
    if (!this._page || this._page.isClosed()) {
      this._page = await this._ctx.newPage();
      this._page.on('console', msg => { this._consoleMsgs.push({ type: msg.type(), text: msg.text(), time: Date.now() }); if (this._consoleMsgs.length > 500) this._consoleMsgs.shift(); });
      this._page.on('request', req => { this._netReqs.push({ url: req.url(), method: req.method(), time: Date.now() }); if (this._netReqs.length > 500) this._netReqs.shift(); });
      this._page.on('dialog', d => d.dismiss().catch(() => {}));
    }
    return this._page;
  }

  async navigate(url) { const p = await this._ensurePage(); await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); return { ok: true, url: p.url() }; }
  async navigateBack() { const p = await this._ensurePage(); await p.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }); return { ok: true, url: p.url() }; }
  async navigateForward() { const p = await this._ensurePage(); await p.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }); return { ok: true, url: p.url() }; }
  async reload() { const p = await this._ensurePage(); await p.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }); return { ok: true, url: p.url() }; }

  async snapshot() {
    const p = await this._ensurePage();
    try { const s = await p.accessibility.snapshot(); return { ok: true, snapshot: JSON.stringify(s, null, 2) }; } catch (_) {}
    const text = await p.evaluate(() => document.body?.innerText?.slice(0, 20000) || '');
    return { ok: true, snapshot: text };
  }

  async screenshot(fullPage = false) { const p = await this._ensurePage(); const buf = await p.screenshot({ fullPage, type: 'png' }); return { ok: true, base64: buf.toString('base64') }; }
  async pdfSave(filePath) { const p = await this._ensurePage(); const out = filePath || path.join(os.tmpdir(), `fauna-${Date.now()}.pdf`); await p.pdf({ path: out }); return { ok: true, path: out }; }

  async click({ selector, text, x, y }) {
    const p = await this._ensurePage();
    if (x != null && y != null) await p.mouse.click(x, y);
    else if (text) await p.getByText(text, { exact: false }).first().click({ timeout: 10000 });
    else if (selector) await p.locator(selector).first().click({ timeout: 10000 });
    else throw new Error('Provide selector, text, or x/y');
    return { ok: true };
  }

  async hover({ selector }) { const p = await this._ensurePage(); await p.locator(selector).first().hover({ timeout: 10000 }); return { ok: true }; }

  async type({ text, selector, clear = true, pressEnter = false, delay = 40 }) {
    const p = await this._ensurePage();
    const loc = selector ? p.locator(selector).first() : p.locator(':focus');
    if (clear) await loc.fill('', { timeout: 5000 }).catch(() => {});
    await loc.pressSequentially(text, { delay });
    if (pressEnter) await loc.press('Enter');
    return { ok: true };
  }

  async fill({ fields }) { const p = await this._ensurePage(); for (const { selector, value } of fields) await p.locator(selector).first().fill(value, { timeout: 5000 }); return { ok: true }; }
  async select({ selector, value, label }) { const p = await this._ensurePage(); const o = {}; if (value != null) o.value = value; if (label != null) o.label = label; await p.locator(selector).first().selectOption(o, { timeout: 5000 }); return { ok: true }; }
  async check({ selector }) { const p = await this._ensurePage(); await p.locator(selector).first().check({ timeout: 5000 }); return { ok: true }; }
  async uncheck({ selector }) { const p = await this._ensurePage(); await p.locator(selector).first().uncheck({ timeout: 5000 }); return { ok: true }; }
  async drag({ sourceSelector, targetSelector }) { const p = await this._ensurePage(); await p.locator(sourceSelector).first().dragTo(p.locator(targetSelector).first(), { timeout: 10000 }); return { ok: true }; }
  async mouseMove(x, y) { const p = await this._ensurePage(); await p.mouse.move(x, y); return { ok: true }; }
  async mouseDown() { const p = await this._ensurePage(); await p.mouse.down(); return { ok: true }; }
  async mouseUp() { const p = await this._ensurePage(); await p.mouse.up(); return { ok: true }; }
  async mouseWheel(dx, dy) { const p = await this._ensurePage(); await p.mouse.wheel(dx || 0, dy || 0); return { ok: true }; }
  async mouseDrag(sx, sy, ex, ey) { const p = await this._ensurePage(); await p.mouse.move(sx, sy); await p.mouse.down(); await p.mouse.move(ex, ey, { steps: 10 }); await p.mouse.up(); return { ok: true }; }
  async pressKey({ key, selector }) { const p = await this._ensurePage(); if (selector) await p.locator(selector).first().press(key, { timeout: 5000 }); else await p.keyboard.press(key); return { ok: true }; }
  async keydown(key) { const p = await this._ensurePage(); await p.keyboard.down(key); return { ok: true }; }
  async keyup(key) { const p = await this._ensurePage(); await p.keyboard.up(key); return { ok: true }; }

  async scroll({ direction = 'down', px, selector }) {
    const p = await this._ensurePage();
    const a = px || 600;
    const dx = direction === 'left' ? -a : direction === 'right' ? a : 0;
    const dy = direction === 'up' ? -a : direction === 'down' ? a : direction === 'top' ? -999999 : direction === 'bottom' ? 999999 : 0;
    if (selector) await p.locator(selector).first().evaluate((el, [x, y]) => el.scrollBy(x, y), [dx, dy]);
    else await p.mouse.wheel(dx, dy);
    return { ok: true };
  }

  async eval({ js }) { const p = await this._ensurePage(); const r = await p.evaluate(new Function(`return (async()=>{ ${js} })()`)); return { ok: true, result: JSON.stringify(r) }; }

  async waitFor({ text, appear = true, timeout = 15000 }) {
    const p = await this._ensurePage();
    if (text) { const loc = p.getByText(text, { exact: false }); if (appear) await loc.first().waitFor({ state: 'visible', timeout }); else await loc.first().waitFor({ state: 'hidden', timeout }); }
    else await p.waitForTimeout(timeout);
    return { ok: true };
  }

  async verifyTextVisible(text) { const p = await this._ensurePage(); const v = await p.getByText(text, { exact: false }).first().isVisible().catch(() => false); return { ok: true, visible: v }; }
  async verifyElementVisible(selector) { const p = await this._ensurePage(); const v = await p.locator(selector).first().isVisible().catch(() => false); return { ok: true, visible: v }; }
  async verifyValue(selector, expected) { const p = await this._ensurePage(); const value = await p.locator(selector).first().inputValue().catch(() => null); return { ok: true, value, matches: value === expected }; }

  async handleDialog({ action = 'accept', text }) { const p = await this._ensurePage(); p.once('dialog', async d => { if (action === 'accept') await d.accept(text); else await d.dismiss(); }); return { ok: true }; }
  async fileUpload({ selector, filePaths }) { const p = await this._ensurePage(); await p.locator(selector).first().setInputFiles(filePaths, { timeout: 10000 }); return { ok: true }; }
  async generateLocator({ x, y, selector }) { if (x != null && y != null) { const p = await this._ensurePage(); const h = await p.evaluateHandle(([px,py]) => document.elementFromPoint(px,py), [x,y]); return { ok: true, locator: (await h.asElement()?.toString()) || `point(${x},${y})` }; } return { ok: true, locator: selector }; }
  async consoleMessages({ limit = 100 }) { return { ok: true, messages: this._consoleMsgs.slice(-limit) }; }
  async consoleClear() { this._consoleMsgs = []; return { ok: true }; }
  async networkRequests({ filter }) { let r = this._netReqs; if (filter) r = r.filter(x => x.url.includes(filter)); return { ok: true, requests: r }; }
  async networkClear() { this._netReqs = []; return { ok: true }; }

  async route({ pattern, responseBody, responseStatus = 200, responseHeaders = {} }) {
    const p = await this._ensurePage();
    const h = route => route.fulfill({ status: responseStatus, headers: { 'Content-Type': 'application/json', ...responseHeaders }, body: responseBody });
    this._routes.set(pattern, h);
    await p.route(pattern, h);
    return { ok: true };
  }
  async routeList() { return { ok: true, routes: [...this._routes.keys()] }; }
  async unroute({ pattern }) { const p = await this._ensurePage(); if (pattern) { const h = this._routes.get(pattern); if (h) { await p.unroute(pattern, h); this._routes.delete(pattern); } } else { for (const [pt, h] of this._routes) await p.unroute(pt, h).catch(() => {}); this._routes.clear(); } return { ok: true }; }

  async cookieList({ domain } = {}) { const p = await this._ensurePage(); const c = await this._ctx.cookies(p.url()); return { ok: true, cookies: domain ? c.filter(x => x.domain.includes(domain)) : c }; }
  async cookieGet({ name }) { const { cookies } = await this.cookieList(); return { ok: true, cookie: cookies.find(c => c.name === name) || null }; }
  async cookieSet({ name, value, domain, path: cp = '/', expires, httpOnly, secure, sameSite }) { const c = { name, value, domain: domain || new URL(this._page?.url() || 'about:blank').hostname, path: cp }; if (expires != null) c.expires = expires; if (httpOnly != null) c.httpOnly = httpOnly; if (secure != null) c.secure = secure; if (sameSite) c.sameSite = sameSite; await this._ctx.addCookies([c]); return { ok: true }; }
  async cookieDelete({ name }) { const { cookies } = await this.cookieList(); const rest = cookies.filter(c => c.name !== name); await this._ctx.clearCookies(); if (rest.length) await this._ctx.addCookies(rest); return { ok: true }; }
  async cookieClear() { await this._ctx.clearCookies(); return { ok: true }; }

  async localStorageGet({ key }) { const p = await this._ensurePage(); return { ok: true, key, value: await p.evaluate(k => localStorage.getItem(k), key) }; }
  async localStorageList() { const p = await this._ensurePage(); return { ok: true, items: await p.evaluate(() => Object.fromEntries(Object.entries(localStorage))) }; }
  async localStorageSet({ key, value }) { const p = await this._ensurePage(); await p.evaluate(([k,v]) => localStorage.setItem(k,v), [key,value]); return { ok: true }; }
  async localStorageDelete({ key }) { const p = await this._ensurePage(); await p.evaluate(k => localStorage.removeItem(k), key); return { ok: true }; }
  async localStorageClear() { const p = await this._ensurePage(); await p.evaluate(() => localStorage.clear()); return { ok: true }; }

  async sessionStorageGet({ key }) { const p = await this._ensurePage(); return { ok: true, key, value: await p.evaluate(k => sessionStorage.getItem(k), key) }; }
  async sessionStorageList() { const p = await this._ensurePage(); return { ok: true, items: await p.evaluate(() => Object.fromEntries(Object.entries(sessionStorage))) }; }
  async sessionStorageSet({ key, value }) { const p = await this._ensurePage(); await p.evaluate(([k,v]) => sessionStorage.setItem(k,v), [key,value]); return { ok: true }; }
  async sessionStorageDelete({ key }) { const p = await this._ensurePage(); await p.evaluate(k => sessionStorage.removeItem(k), key); return { ok: true }; }
  async sessionStorageClear() { const p = await this._ensurePage(); await p.evaluate(() => sessionStorage.clear()); return { ok: true }; }

  async storageState({ filePath }) { const out = filePath || path.join(os.tmpdir(), `fauna-storage-${Date.now()}.json`); await this._ctx.storageState({ path: out }); return { ok: true, path: out }; }
  async setStorageState({ filePath }) { if (this._ctx) { await this._ctx.close().catch(() => {}); this._ctx = null; this._page = null; } this._ctx = await this._browser.newContext({ storageState: filePath }); return { ok: true }; }

  async startTracing({ screenshots = true, snapshots = true } = {}) { if (!this._ctx) await this._ensurePage(); await this._ctx.tracing.start({ screenshots, snapshots }); this._tracing = true; return { ok: true }; }
  async stopTracing({ filePath }) { const out = filePath || path.join(os.tmpdir(), `fauna-trace-${Date.now()}.zip`); await this._ctx.tracing.stop({ path: out }); this._tracing = false; return { ok: true, path: out }; }

  async startVideo({ dir } = {}) {
    const videoDir = dir || os.tmpdir();
    if (this._ctx) { await this._ctx.close().catch(() => {}); this._ctx = null; this._page = null; }
    await this._ensurePage(); // ensures browser
    this._ctx  = await this._browser.newContext({ recordVideo: { dir: videoDir } });
    this._page = await this._ctx.newPage();
    this._video = true;
    return { ok: true, dir: videoDir };
  }
  async stopVideo() { const vp = this._page?.video ? await this._page.video()?.path() : null; this._video = false; return { ok: true, path: vp }; }

  async resize({ width, height }) { const p = await this._ensurePage(); await p.setViewportSize({ width, height }); return { ok: true }; }
  async close() { if (this._page && !this._page.isClosed()) await this._page.close().catch(() => {}); this._page = null; return { ok: true }; }

  async tabsList() { if (!this._ctx) await this._ensurePage(); const pages = this._ctx.pages(); return { ok: true, tabs: pages.map((pg, i) => ({ index: i, url: pg.url(), active: pg === this._page })) }; }
  async tabNew({ url }) { if (!this._ctx) await this._ensurePage(); const p = await this._ctx.newPage(); if (url && url !== 'about:blank') await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); this._page = p; return { ok: true, index: this._ctx.pages().indexOf(p) }; }
  async tabClose({ index }) { if (!this._ctx) return { ok: false, error: 'No context' }; const pages = this._ctx.pages(); const pg = index != null ? pages[index] : this._page; if (!pg) return { ok: false, error: 'Tab not found' }; await pg.close(); this._page = this._ctx.pages().at(-1) || null; return { ok: true }; }
  async tabSwitch({ index }) { if (!this._ctx) return { ok: false, error: 'No context' }; const pg = this._ctx.pages()[index]; if (!pg) return { ok: false, error: `Tab ${index} not found` }; this._page = pg; await pg.bringToFront().catch(() => {}); return { ok: true, url: pg.url() }; }

  async extractContent({ maxChars = 12000 }) {
    const p = await this._ensurePage();
    return { ok: true, ...(await p.evaluate(max => ({
      text: (document.body?.innerText || '').slice(0, max),
      links: [...document.querySelectorAll('a[href]')].slice(0, 50).map(a => ({ text: a.innerText.trim(), href: a.href })),
      headings: [...document.querySelectorAll('h1,h2,h3')].map(h => ({ tag: h.tagName, text: h.innerText.trim() }))
    }), maxChars)) };
  }

  async extractForms() {
    const p = await this._ensurePage();
    return { ok: true, fields: await p.evaluate(() => [...document.querySelectorAll('input,select,textarea')].map(el => ({ tag: el.tagName.toLowerCase(), type: el.type, name: el.name, id: el.id, placeholder: el.placeholder, value: el.value, selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : el.tagName.toLowerCase() }))) };
  }
}

const pw = new PlaywrightBackend();

// ── Unified dispatch ──────────────────────────────────────────────────────
// Priority: 1) Playwright headless (primary)  2) Browser extension (last resort)

async function dispatch(extAction, extParams, extTabId, extTimeout, pwFn) {
  try {
    return await pwFn();
  } catch (pwErr) {
    // Fall back to extension only if it's connected
    if (extConn && extConn.ws.readyState === 1) {
      try {
        process.stderr.write(`[Browser] Playwright failed (${pwErr.message}) — retrying via extension\n`);
        return await sendToExt(extAction, extParams, extTabId, extTimeout || 20000);
      } catch (e) {
        if (e.message !== 'NO_EXT') throw e;
      }
    }
    throw pwErr;
  }
}

// ── WebSocket server ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT });
wss.on('connection', (ws) => {
  let conn = null;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
    if (msg.type === 'ext:hello') {
      conn = { ws, info: msg }; extConn = conn;
      process.stderr.write(`[Browser] Extension connected — ${msg.userAgent || 'unknown'}\n`);
      if (msg.activeTab) process.stderr.write(`[Browser] Active tab: ${msg.activeTab.title || msg.activeTab.url}\n`);
      return;
    }
    if (msg.type === 'result' && msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg);
    }
  });
  ws.on('close', () => { if (conn === extConn) { extConn = null; process.stderr.write('[Browser] Extension disconnected\n'); } });
});

// ── MCP tool registry ─────────────────────────────────────────────────────

function registerTools(mcp) {

mcp.tool('browser_status', 'Check Playwright/extension backend status and active URL', {}, async () => {
  const lines = [];
  try { const p = pw._page; if (p && !p.isClosed()) lines.push(`✅ Playwright active — ${p.url()}`); else lines.push('ℹ️ Playwright ready (no page open yet)'); } catch (_) { lines.push('⚠️ Playwright unavailable'); }
  if (extConn) { const tab = extConn.info.activeTab; lines.push('✅ Extension connected (fallback available)'); if (tab) lines.push(`Extension tab: "${tab.title}" — ${tab.url}`); }
  else lines.push('ℹ️ Extension not connected');
  return { content: [{ type: 'text', text: lines.join('\n') }] };
});

// ── Navigation ──

mcp.tool('browser_navigate', 'Navigate to a URL', { url: z.string(), tab_id: z.number().optional() }, async ({ url, tab_id }) => {
  const r = await dispatch('navigate', { url }, tab_id ?? null, 30000, () => pw.navigate(url));
  return { content: [{ type: 'text', text: r.ok ? `✅ Navigated to ${r.url}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_navigate_back', 'Go back in browser history', { tab_id: z.number().optional() }, async ({ tab_id }) => {
  const r = await dispatch('navigate-back', {}, tab_id ?? null, 15000, () => pw.navigateBack());
  return { content: [{ type: 'text', text: r.ok ? `✅ Back — ${r.url}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_navigate_forward', 'Go forward in browser history', { tab_id: z.number().optional() }, async ({ tab_id }) => {
  const r = await dispatch('navigate-forward', {}, tab_id ?? null, 15000, () => pw.navigateForward());
  return { content: [{ type: 'text', text: r.ok ? `✅ Forward — ${r.url}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_reload', 'Reload the current page', { tab_id: z.number().optional() }, async ({ tab_id }) => {
  const r = await dispatch('reload', {}, tab_id ?? null, 15000, () => pw.reload());
  return { content: [{ type: 'text', text: r.ok ? `✅ Reloaded — ${r.url}` : `❌ ${r.error}` }] };
});

// ── Snapshot & Screenshots ──

mcp.tool('browser_snapshot', 'Capture accessibility snapshot of the current page (prefer over screenshot for reading content)', { tab_id: z.number().optional() }, async () => {
  const r = await pw.snapshot();
  return { content: [{ type: 'text', text: r.ok ? r.snapshot : `❌ ${r.error}` }] };
});

mcp.tool('browser_take_screenshot', 'Take a screenshot of the current page', { full_page: z.boolean().optional(), tab_id: z.number().optional() }, async ({ full_page, tab_id }) => {
  const r = await dispatch(full_page ? 'snapshot-full' : 'snapshot', {}, tab_id ?? null, 30000, () => pw.screenshot(full_page || false));
  if (!r.ok) return { content: [{ type: 'text', text: `❌ ${r.error}` }] };
  const b64 = r.base64 || (r.dataUrl ? r.dataUrl.replace(/^data:image\/[^;]+;base64,/, '') : null);
  if (!b64) return { content: [{ type: 'text', text: '❌ No image data' }] };
  return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
});

mcp.tool('browser_screenshot', 'Take a screenshot (alias for browser_take_screenshot)', { full_page: z.boolean().optional(), tab_id: z.number().optional() }, async ({ full_page, tab_id }) => {
  const r = await dispatch(full_page ? 'snapshot-full' : 'snapshot', {}, tab_id ?? null, 30000, () => pw.screenshot(full_page || false));
  if (!r.ok) return { content: [{ type: 'text', text: `❌ ${r.error}` }] };
  const b64 = r.base64 || (r.dataUrl ? r.dataUrl.replace(/^data:image\/[^;]+;base64,/, '') : null);
  if (!b64) return { content: [{ type: 'text', text: '❌ No image data' }] };
  return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
});

mcp.tool('browser_pdf_save', 'Save the current page as a PDF', { file_path: z.string().optional() }, async ({ file_path }) => {
  const r = await pw.pdfSave(file_path);
  return { content: [{ type: 'text', text: r.ok ? `✅ Saved to ${r.path}` : `❌ ${r.error}` }] };
});

// ── Interaction ──

mcp.tool('browser_click', 'Click an element by CSS selector, visible text, or coordinates', { selector: z.string().optional(), text: z.string().optional(), x: z.number().optional(), y: z.number().optional(), tab_id: z.number().optional() }, async ({ selector, text, x, y, tab_id }) => {
  const r = await dispatch('click', { selector, text, x, y }, tab_id ?? null, 15000, () => pw.click({ selector, text, x, y }));
  return { content: [{ type: 'text', text: r.ok ? '✅ Clicked' : `❌ ${r.error}` }] };
});

mcp.tool('browser_hover', 'Hover over an element', { selector: z.string(), tab_id: z.number().optional() }, async ({ selector, tab_id }) => {
  const r = await dispatch('hover', { selector }, tab_id ?? null, 10000, () => pw.hover({ selector }));
  return { content: [{ type: 'text', text: r.ok ? `✅ Hovered "${selector}"` : `❌ ${r.error}` }] };
});

mcp.tool('browser_type', 'Type text into an input field character by character', { text: z.string(), selector: z.string().optional(), clear: z.boolean().optional(), press_enter: z.boolean().optional(), delay_ms: z.number().optional(), tab_id: z.number().optional() }, async ({ text, selector, clear, press_enter, delay_ms, tab_id }) => {
  const r = await dispatch('type', { text, selector, clear: clear ?? true, pressEnter: press_enter ?? false, delay: delay_ms ?? 40 }, tab_id ?? null, 20000, () => pw.type({ text, selector, clear: clear ?? true, pressEnter: press_enter ?? false, delay: delay_ms ?? 40 }));
  return { content: [{ type: 'text', text: r.ok ? `✅ Typed: "${text}"` : `❌ ${r.error}` }] };
});

mcp.tool('browser_press_key', 'Press a single key', { key: z.string(), selector: z.string().optional(), tab_id: z.number().optional() }, async ({ key, selector, tab_id }) => {
  const r = await dispatch('keyboard', { key, selector }, tab_id ?? null, 5000, () => pw.pressKey({ key, selector }));
  return { content: [{ type: 'text', text: r.ok ? `✅ Key "${key}" sent` : `❌ ${r.error}` }] };
});

mcp.tool('browser_keyboard', 'Send a keyboard event (alias for browser_press_key)', { key: z.string(), selector: z.string().optional(), tab_id: z.number().optional() }, async ({ key, selector, tab_id }) => {
  const r = await dispatch('keyboard', { key, selector }, tab_id ?? null, 5000, () => pw.pressKey({ key, selector }));
  return { content: [{ type: 'text', text: r.ok ? `✅ Key "${key}" sent` : `❌ ${r.error}` }] };
});

mcp.tool('browser_press_sequentially', 'Type text key-by-key triggering autocomplete on every keystroke', { text: z.string(), selector: z.string().optional(), delay_ms: z.number().optional(), tab_id: z.number().optional() }, async ({ text, selector, delay_ms, tab_id }) => {
  const r = await dispatch('type', { text, selector, clear: false, pressEnter: false, delay: delay_ms ?? 40 }, tab_id ?? null, 20000, () => pw.type({ text, selector, clear: false, pressEnter: false, delay: delay_ms ?? 40 }));
  return { content: [{ type: 'text', text: r.ok ? `✅ Typed sequentially: "${text}"` : `❌ ${r.error}` }] };
});

mcp.tool('browser_keydown', 'Hold a key down', { key: z.string() }, async ({ key }) => {
  const r = await pw.keydown(key);
  return { content: [{ type: 'text', text: r.ok ? `✅ Keydown: "${key}"` : `❌ ${r.error}` }] };
});

mcp.tool('browser_keyup', 'Release a held key', { key: z.string() }, async ({ key }) => {
  const r = await pw.keyup(key);
  return { content: [{ type: 'text', text: r.ok ? `✅ Keyup: "${key}"` : `❌ ${r.error}` }] };
});

mcp.tool('browser_drag', 'Drag and drop one element onto another', { source_selector: z.string(), target_selector: z.string() }, async ({ source_selector, target_selector }) => {
  const r = await pw.drag({ sourceSelector: source_selector, targetSelector: target_selector });
  return { content: [{ type: 'text', text: r.ok ? '✅ Dragged' : `❌ ${r.error}` }] };
});

mcp.tool('browser_check', 'Check a checkbox or radio button', { selector: z.string(), tab_id: z.number().optional() }, async ({ selector }) => {
  const r = await pw.check({ selector });
  return { content: [{ type: 'text', text: r.ok ? `✅ Checked "${selector}"` : `❌ ${r.error}` }] };
});

mcp.tool('browser_uncheck', 'Uncheck a checkbox or radio button', { selector: z.string(), tab_id: z.number().optional() }, async ({ selector }) => {
  const r = await pw.uncheck({ selector });
  return { content: [{ type: 'text', text: r.ok ? `✅ Unchecked "${selector}"` : `❌ ${r.error}` }] };
});

mcp.tool('browser_select_option', 'Select an option in a <select> dropdown', { selector: z.string(), value: z.string().optional(), label: z.string().optional(), tab_id: z.number().optional() }, async ({ selector, value, label, tab_id }) => {
  const r = await dispatch('select', { selector, value, label }, tab_id ?? null, 5000, () => pw.select({ selector, value, label }));
  return { content: [{ type: 'text', text: r.ok ? '✅ Selected' : `❌ ${r.error}` }] };
});

mcp.tool('browser_select', 'Select an option in a <select> element (alias)', { selector: z.string(), value: z.string().optional(), label: z.string().optional(), tab_id: z.number().optional() }, async ({ selector, value, label, tab_id }) => {
  const r = await dispatch('select', { selector, value, label }, tab_id ?? null, 5000, () => pw.select({ selector, value, label }));
  return { content: [{ type: 'text', text: r.ok ? '✅ Selected' : `❌ ${r.error}` }] };
});

mcp.tool('browser_fill_form', 'Fill multiple form fields at once', { fields: z.array(z.object({ selector: z.string(), value: z.string() })), tab_id: z.number().optional() }, async ({ fields, tab_id }) => {
  const r = await dispatch('fill', { fields }, tab_id ?? null, 15000, () => pw.fill({ fields }));
  return { content: [{ type: 'text', text: resultText(r) }] };
});

mcp.tool('browser_file_upload', 'Upload one or more files via a file input element', { selector: z.string(), file_paths: z.array(z.string()) }, async ({ selector, file_paths }) => {
  const r = await pw.fileUpload({ selector, filePaths: file_paths });
  return { content: [{ type: 'text', text: r.ok ? `✅ Uploaded ${file_paths.length} file(s)` : `❌ ${r.error}` }] };
});

mcp.tool('browser_handle_dialog', 'Accept or dismiss the next browser dialog', { action: z.enum(['accept','dismiss']).optional(), text: z.string().optional() }, async ({ action, text }) => {
  const r = await pw.handleDialog({ action: action || 'accept', text });
  return { content: [{ type: 'text', text: r.ok ? `✅ Next dialog will be ${action || 'accept'}ed` : `❌ ${r.error}` }] };
});

mcp.tool('browser_generate_locator', 'Generate a CSS/Playwright locator for an element', { x: z.number().optional(), y: z.number().optional(), selector: z.string().optional() }, async ({ x, y, selector }) => {
  const r = await pw.generateLocator({ x, y, selector });
  return { content: [{ type: 'text', text: r.ok ? `Locator: ${r.locator}` : `❌ ${r.error}` }] };
});

// ── Mouse (low-level) ──

mcp.tool('browser_mouse_click_xy', 'Click at specific x,y viewport coordinates', { x: z.number(), y: z.number(), tab_id: z.number().optional() }, async ({ x, y, tab_id }) => {
  const r = await dispatch('click', { x, y }, tab_id ?? null, 5000, () => pw.click({ x, y }));
  return { content: [{ type: 'text', text: r.ok ? `✅ Clicked (${x},${y})` : `❌ ${r.error}` }] };
});

mcp.tool('browser_mouse_move_xy', 'Move the mouse to specific coordinates', { x: z.number(), y: z.number() }, async ({ x, y }) => {
  const r = await pw.mouseMove(x, y);
  return { content: [{ type: 'text', text: r.ok ? `✅ Mouse moved to (${x},${y})` : `❌ ${r.error}` }] };
});

mcp.tool('browser_mouse_down', 'Press the left mouse button down', {}, async () => {
  const r = await pw.mouseDown();
  return { content: [{ type: 'text', text: r.ok ? '✅ Mouse down' : `❌ ${r.error}` }] };
});

mcp.tool('browser_mouse_up', 'Release the left mouse button', {}, async () => {
  const r = await pw.mouseUp();
  return { content: [{ type: 'text', text: r.ok ? '✅ Mouse up' : `❌ ${r.error}` }] };
});

mcp.tool('browser_mouse_wheel', 'Scroll the mouse wheel', { delta_x: z.number().optional(), delta_y: z.number().optional() }, async ({ delta_x, delta_y }) => {
  const r = await pw.mouseWheel(delta_x || 0, delta_y ?? 300);
  return { content: [{ type: 'text', text: r.ok ? '✅ Scrolled' : `❌ ${r.error}` }] };
});

mcp.tool('browser_mouse_drag_xy', 'Drag from one position to another using raw mouse events', { start_x: z.number(), start_y: z.number(), end_x: z.number(), end_y: z.number() }, async ({ start_x, start_y, end_x, end_y }) => {
  const r = await pw.mouseDrag(start_x, start_y, end_x, end_y);
  return { content: [{ type: 'text', text: r.ok ? '✅ Dragged' : `❌ ${r.error}` }] };
});

// ── Wait & Verify ──

mcp.tool('browser_wait_for', 'Wait for text to appear/disappear or wait a specified timeout', { text: z.string().optional(), appear: z.boolean().optional(), timeout: z.number().optional(), tab_id: z.number().optional() }, async ({ text, appear, timeout }) => {
  const r = await pw.waitFor({ text, appear: appear ?? true, timeout: timeout ?? 15000 });
  return { content: [{ type: 'text', text: r.ok ? '✅ Done waiting' : `❌ ${r.error}` }] };
});

mcp.tool('browser_verify_text_visible', 'Assert that a text string is visible on the page', { text: z.string(), tab_id: z.number().optional() }, async ({ text }) => {
  const r = await pw.verifyTextVisible(text);
  if (!r.ok) return { content: [{ type: 'text', text: `❌ ${r.error}` }] };
  return { content: [{ type: 'text', text: r.visible ? `✅ Text visible: "${text}"` : `❌ Text NOT visible: "${text}"` }] };
});

mcp.tool('browser_verify_element_visible', 'Assert that a CSS selector is visible on the page', { selector: z.string(), tab_id: z.number().optional() }, async ({ selector }) => {
  const r = await pw.verifyElementVisible(selector);
  if (!r.ok) return { content: [{ type: 'text', text: `❌ ${r.error}` }] };
  return { content: [{ type: 'text', text: r.visible ? `✅ Element visible: "${selector}"` : `❌ Element NOT visible: "${selector}"` }] };
});

mcp.tool('browser_verify_list_visible', 'Assert all items in a list are visible on the page', { items: z.array(z.string()), tab_id: z.number().optional() }, async ({ items }) => {
  const results = await Promise.all(items.map(t => pw.verifyTextVisible(t)));
  const lines = items.map((t, i) => `${results[i].visible ? '✅' : '❌'} "${t}"`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
});

mcp.tool('browser_verify_value', 'Assert that an input element has a specific value', { selector: z.string(), expected: z.string(), tab_id: z.number().optional() }, async ({ selector, expected }) => {
  const r = await pw.verifyValue(selector, expected);
  if (!r.ok) return { content: [{ type: 'text', text: `❌ ${r.error}` }] };
  return { content: [{ type: 'text', text: r.matches ? `✅ Value matches: "${expected}"` : `❌ Value mismatch — got: "${r.value}", expected: "${expected}"` }] };
});

// ── JavaScript ──

mcp.tool('browser_evaluate', 'Evaluate a JavaScript expression on the current page', { js: z.string(), tab_id: z.number().optional() }, async ({ js, tab_id }) => {
  const r = await dispatch('eval', { js }, tab_id ?? null, 15000, () => pw.eval({ js }));
  return { content: [{ type: 'text', text: r.ok ? `Result: ${r.result}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_eval', 'Evaluate JavaScript (alias for browser_evaluate)', { js: z.string(), tab_id: z.number().optional() }, async ({ js, tab_id }) => {
  const r = await dispatch('eval', { js }, tab_id ?? null, 15000, () => pw.eval({ js }));
  return { content: [{ type: 'text', text: r.ok ? `Result: ${r.result}` : `❌ ${r.error}` }] };
});

// ── Console ──

mcp.tool('browser_console_messages', 'Return all captured console messages', { limit: z.number().optional(), tab_id: z.number().optional() }, async ({ limit, tab_id }) => {
  const r = await dispatch('devtools:console', { limit: limit || 100 }, tab_id ?? null, 10000, () => pw.consoleMessages({ limit: limit || 100 }));
  return { content: [{ type: 'text', text: resultText(r) }] };
});

mcp.tool('browser_get_console', 'Get recent console output (alias for browser_console_messages)', { limit: z.number().optional(), tab_id: z.number().optional() }, async ({ limit, tab_id }) => {
  const r = await dispatch('devtools:console', { limit: limit || 100 }, tab_id ?? null, 10000, () => pw.consoleMessages({ limit: limit || 100 }));
  return { content: [{ type: 'text', text: resultText(r) }] };
});

mcp.tool('browser_console_clear', 'Clear all captured console messages', {}, async () => {
  const r = await pw.consoleClear();
  return { content: [{ type: 'text', text: r.ok ? '✅ Console cleared' : `❌ ${r.error}` }] };
});

// ── Network ──

mcp.tool('browser_network_requests', 'Return all network requests recorded since the page loaded', { filter: z.string().optional(), tab_id: z.number().optional() }, async ({ filter, tab_id }) => {
  const r = await dispatch('devtools:network', { filter }, tab_id ?? null, 10000, () => pw.networkRequests({ filter }));
  return { content: [{ type: 'text', text: resultText(r) }] };
});

mcp.tool('browser_get_network', 'Get network requests (alias for browser_network_requests)', { filter: z.string().optional(), tab_id: z.number().optional() }, async ({ filter, tab_id }) => {
  const r = await dispatch('devtools:network', { filter }, tab_id ?? null, 10000, () => pw.networkRequests({ filter }));
  return { content: [{ type: 'text', text: resultText(r) }] };
});

mcp.tool('browser_network_clear', 'Clear all recorded network requests', {}, async () => {
  const r = await pw.networkClear();
  return { content: [{ type: 'text', text: r.ok ? '✅ Network log cleared' : `❌ ${r.error}` }] };
});

mcp.tool('browser_route', 'Mock network requests matching a URL pattern', { pattern: z.string(), response_body: z.string().optional(), response_status: z.number().optional(), response_headers: z.record(z.string()).optional() }, async ({ pattern, response_body, response_status, response_headers }) => {
  const r = await pw.route({ pattern, responseBody: response_body || '', responseStatus: response_status, responseHeaders: response_headers });
  return { content: [{ type: 'text', text: r.ok ? `✅ Route set: ${pattern}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_route_list', 'List all active mock routes', {}, async () => {
  const r = await pw.routeList();
  return { content: [{ type: 'text', text: r.ok ? JSON.stringify(r.routes, null, 2) : `❌ ${r.error}` }] };
});

mcp.tool('browser_unroute', 'Remove a mock route (or all routes if no pattern given)', { pattern: z.string().optional() }, async ({ pattern }) => {
  const r = await pw.unroute({ pattern });
  return { content: [{ type: 'text', text: r.ok ? `✅ Route removed${pattern ? `: ${pattern}` : ' (all)'}` : `❌ ${r.error}` }] };
});

// ── Cookies ──

mcp.tool('browser_cookie_list', 'List all cookies', { domain: z.string().optional(), tab_id: z.number().optional() }, async ({ domain, tab_id }) => {
  const r = await dispatch('devtools:cookies', {}, tab_id ?? null, 10000, () => pw.cookieList({ domain }));
  return { content: [{ type: 'text', text: resultText(r) }] };
});

mcp.tool('browser_get_cookies', 'Get all cookies for the current page (alias)', { tab_id: z.number().optional() }, async ({ tab_id }) => {
  const r = await dispatch('devtools:cookies', {}, tab_id ?? null, 10000, () => pw.cookieList());
  return { content: [{ type: 'text', text: resultText(r) }] };
});

mcp.tool('browser_cookie_get', 'Get a specific cookie by name', { name: z.string() }, async ({ name }) => {
  const r = await pw.cookieGet({ name });
  return { content: [{ type: 'text', text: r.ok ? JSON.stringify(r.cookie, null, 2) : `❌ ${r.error}` }] };
});

mcp.tool('browser_cookie_set', 'Set a cookie', { name: z.string(), value: z.string(), domain: z.string().optional(), path: z.string().optional(), expires: z.number().optional(), http_only: z.boolean().optional(), secure: z.boolean().optional(), same_site: z.enum(['Strict','Lax','None']).optional() }, async ({ name, value, domain, path: cp, expires, http_only, secure, same_site }) => {
  const r = await pw.cookieSet({ name, value, domain, path: cp, expires, httpOnly: http_only, secure, sameSite: same_site });
  return { content: [{ type: 'text', text: r.ok ? `✅ Cookie set: ${name}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_cookie_delete', 'Delete a specific cookie by name', { name: z.string() }, async ({ name }) => {
  const r = await pw.cookieDelete({ name });
  return { content: [{ type: 'text', text: r.ok ? `✅ Cookie deleted: ${name}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_cookie_clear', 'Clear all cookies', {}, async () => {
  const r = await pw.cookieClear();
  return { content: [{ type: 'text', text: r.ok ? '✅ All cookies cleared' : `❌ ${r.error}` }] };
});

// ── localStorage ──

mcp.tool('browser_localstorage_get', 'Get a localStorage item by key', { key: z.string() }, async ({ key }) => {
  const r = await pw.localStorageGet({ key });
  return { content: [{ type: 'text', text: r.ok ? `${key}: ${r.value}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_localstorage_list', 'List all localStorage key-value pairs', {}, async () => {
  const r = await pw.localStorageList();
  return { content: [{ type: 'text', text: r.ok ? JSON.stringify(r.items, null, 2) : `❌ ${r.error}` }] };
});

mcp.tool('browser_localstorage_set', 'Set a localStorage item', { key: z.string(), value: z.string() }, async ({ key, value }) => {
  const r = await pw.localStorageSet({ key, value });
  return { content: [{ type: 'text', text: r.ok ? `✅ Set ${key}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_localstorage_delete', 'Delete a localStorage item', { key: z.string() }, async ({ key }) => {
  const r = await pw.localStorageDelete({ key });
  return { content: [{ type: 'text', text: r.ok ? `✅ Deleted ${key}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_localstorage_clear', 'Clear all localStorage', {}, async () => {
  const r = await pw.localStorageClear();
  return { content: [{ type: 'text', text: r.ok ? '✅ localStorage cleared' : `❌ ${r.error}` }] };
});

// ── sessionStorage ──

mcp.tool('browser_sessionstorage_get', 'Get a sessionStorage item by key', { key: z.string() }, async ({ key }) => {
  const r = await pw.sessionStorageGet({ key });
  return { content: [{ type: 'text', text: r.ok ? `${key}: ${r.value}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_sessionstorage_list', 'List all sessionStorage key-value pairs', {}, async () => {
  const r = await pw.sessionStorageList();
  return { content: [{ type: 'text', text: r.ok ? JSON.stringify(r.items, null, 2) : `❌ ${r.error}` }] };
});

mcp.tool('browser_sessionstorage_set', 'Set a sessionStorage item', { key: z.string(), value: z.string() }, async ({ key, value }) => {
  const r = await pw.sessionStorageSet({ key, value });
  return { content: [{ type: 'text', text: r.ok ? `✅ Set ${key}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_sessionstorage_delete', 'Delete a sessionStorage item', { key: z.string() }, async ({ key }) => {
  const r = await pw.sessionStorageDelete({ key });
  return { content: [{ type: 'text', text: r.ok ? `✅ Deleted ${key}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_sessionstorage_clear', 'Clear all sessionStorage', {}, async () => {
  const r = await pw.sessionStorageClear();
  return { content: [{ type: 'text', text: r.ok ? '✅ sessionStorage cleared' : `❌ ${r.error}` }] };
});

// ── Storage state ──

mcp.tool('browser_storage_state', 'Save cookies + localStorage to a file', { file_path: z.string().optional() }, async ({ file_path }) => {
  const r = await pw.storageState({ filePath: file_path });
  return { content: [{ type: 'text', text: r.ok ? `✅ Storage state saved to ${r.path}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_set_storage_state', 'Restore cookies + localStorage from a saved file', { file_path: z.string() }, async ({ file_path }) => {
  const r = await pw.setStorageState({ filePath: file_path });
  return { content: [{ type: 'text', text: r.ok ? '✅ Storage state restored' : `❌ ${r.error}` }] };
});

// ── Storage convenience ──

mcp.tool('browser_get_storage', 'Get localStorage and sessionStorage contents', { tab_id: z.number().optional() }, async ({ tab_id }) => {
  try {
    const [ls, ss] = await Promise.all([pw.localStorageList(), pw.sessionStorageList()]);
    return { content: [{ type: 'text', text: JSON.stringify({ localStorage: ls.items, sessionStorage: ss.items }, null, 2) }] };
  } catch (pwErr) {
    if (extConn && extConn.ws.readyState === 1) {
      const r = await sendToExt('devtools:storage', {}, tab_id ?? null).catch(() => null);
      if (r) return { content: [{ type: 'text', text: resultText(r) }] };
    }
    throw pwErr;
  }
});

// ── Tabs ──

mcp.tool('browser_list_tabs', 'List all open browser tabs', {}, async () => {
  const r = await dispatch('tab:list', {}, null, 10000, () => pw.tabsList());
  return { content: [{ type: 'text', text: r.ok ? JSON.stringify(r.tabs, null, 2) : `❌ ${r.error}` }] };
});

mcp.tool('browser_new_tab', 'Open a new browser tab', { url: z.string().optional() }, async ({ url }) => {
  const r = await dispatch('tab:new', { url: url || 'about:blank' }, null, 15000, () => pw.tabNew({ url: url || 'about:blank' }));
  return { content: [{ type: 'text', text: r.ok ? `✅ New tab (index: ${r.index ?? r.tabId})` : `❌ ${r.error}` }] };
});

mcp.tool('browser_close_tab', 'Close a browser tab', { tab_id: z.number().optional() }, async ({ tab_id }) => {
  const r = await dispatch('tab:close', { tabId: tab_id ?? null }, null, 10000, () => pw.tabClose({ index: tab_id ?? undefined }));
  return { content: [{ type: 'text', text: r.ok ? '✅ Tab closed' : `❌ ${r.error}` }] };
});

mcp.tool('browser_switch_tab', 'Switch focus to a different tab', { tab_id: z.number().optional(), index: z.number().optional() }, async ({ tab_id, index }) => {
  const r = await dispatch('tab:switch', { tabId: tab_id, index }, null, 10000, () => pw.tabSwitch({ index: index ?? tab_id ?? 0 }));
  return { content: [{ type: 'text', text: r.ok ? `✅ Switched — ${r.url || ''}` : `❌ ${r.error}` }] };
});

// ── Scroll / Resize / Close ──

mcp.tool('browser_scroll', 'Scroll the page or a specific element', { direction: z.enum(['up','down','left','right','top','bottom']).optional(), px: z.number().optional(), selector: z.string().optional(), tab_id: z.number().optional() }, async ({ direction, px, selector, tab_id }) => {
  const r = await dispatch('scroll', { direction: direction || 'down', px, selector }, tab_id ?? null, 10000, () => pw.scroll({ direction: direction || 'down', px, selector }));
  return { content: [{ type: 'text', text: r.ok ? `✅ Scrolled ${direction || 'down'}${px ? ` ${px}px` : ''}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_resize', 'Resize the browser viewport', { width: z.number(), height: z.number() }, async ({ width, height }) => {
  const r = await pw.resize({ width, height });
  return { content: [{ type: 'text', text: r.ok ? `✅ Viewport ${width}x${height}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_close', 'Close the current page', {}, async () => {
  const r = await pw.close();
  return { content: [{ type: 'text', text: r.ok ? '✅ Page closed' : `❌ ${r.error}` }] };
});

// ── Tracing & Video ──

mcp.tool('browser_start_tracing', 'Start Playwright trace recording', { screenshots: z.boolean().optional(), snapshots: z.boolean().optional() }, async ({ screenshots, snapshots }) => {
  const r = await pw.startTracing({ screenshots: screenshots ?? true, snapshots: snapshots ?? true });
  return { content: [{ type: 'text', text: r.ok ? '✅ Tracing started' : `❌ ${r.error}` }] };
});

mcp.tool('browser_stop_tracing', 'Stop trace recording and save to a file', { file_path: z.string().optional() }, async ({ file_path }) => {
  const r = await pw.stopTracing({ filePath: file_path });
  return { content: [{ type: 'text', text: r.ok ? `✅ Trace saved to ${r.path}` : `❌ ${r.error}` }] };
});

mcp.tool('browser_start_video', 'Start recording a video of the browser session', { dir: z.string().optional() }, async ({ dir }) => {
  const r = await pw.startVideo({ dir });
  return { content: [{ type: 'text', text: r.ok ? `✅ Video recording started (dir: ${r.dir})` : `❌ ${r.error}` }] };
});

mcp.tool('browser_stop_video', 'Stop video recording and return the file path', {}, async () => {
  const r = await pw.stopVideo();
  return { content: [{ type: 'text', text: r.ok ? `✅ Video saved to ${r.path || '(unknown)'}` : `❌ ${r.error}` }] };
});

// ── Extension-exclusive with Playwright fallbacks ──

mcp.tool('browser_get_content', 'Get text content, links, and headings from the current page', { max_chars: z.number().optional(), tab_id: z.number().optional() }, async ({ max_chars, tab_id }) => {
  const r = await dispatch('extract', { maxChars: max_chars || 12000 }, tab_id ?? null, 20000, () => pw.extractContent({ maxChars: max_chars || 12000 }));
  return { content: [{ type: 'text', text: resultText(r) }] };
});

mcp.tool('browser_get_forms', 'Extract all form fields from the current page', { tab_id: z.number().optional() }, async ({ tab_id }) => {
  const r = await dispatch('extract-forms', {}, tab_id ?? null, 20000, () => pw.extractForms());
  return { content: [{ type: 'text', text: resultText(r) }] };
});

mcp.tool('browser_get_assets', 'Extract CSS, scripts, images, design tokens (extension only — returns info message in headless mode)', { tab_id: z.number().optional() }, async ({ tab_id }) => {
  if (!extConn || extConn.ws.readyState !== 1) return { content: [{ type: 'text', text: 'ℹ️ browser_get_assets requires the FaunaBrowserMCP extension.' }] };
  const r = await sendToExt('extract-assets', {}, tab_id ?? null);
  return { content: [{ type: 'text', text: resultText(r) }] };
});

mcp.tool('browser_get_security', 'Get TLS/CSP/HTTPS info (extension only — returns info message in headless mode)', { tab_id: z.number().optional() }, async ({ tab_id }) => {
  if (!extConn || extConn.ws.readyState !== 1) return { content: [{ type: 'text', text: 'ℹ️ browser_get_security requires the FaunaBrowserMCP extension.' }] };
  const r = await sendToExt('devtools:security', {}, tab_id ?? null);
  return { content: [{ type: 'text', text: resultText(r) }] };
});

} // end registerTools

// ── Startup ───────────────────────────────────────────────────────────────

process.stderr.write(`[MCP] FaunaBrowserMCP v2 (Playwright-first, extension fallback)\n`);
process.stderr.write(`[MCP] Extension WS:  ws://localhost:${WS_PORT}\n`);
process.stderr.write(`[MCP] HTTP/MCP:      http://localhost:${HTTP_PORT}/mcp\n`);

const mcpStdio = new McpServer({ name: 'fauna-browser-mcp', version: '2.0.0' });
registerTools(mcpStdio);
const stdioTransport = new StdioServerTransport();
await mcpStdio.connect(stdioTransport);

// ── HTTP/MCP server ───────────────────────────────────────────────────────

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
    if (sid && httpSessions.has(sid)) await httpSessions.get(sid).handleRequest(req, res);
    else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unknown session' })); }
    return;
  }

  if (req.method === 'DELETE') {
    const sid = req.headers['mcp-session-id'];
    if (sid && httpSessions.has(sid)) { await httpSessions.get(sid).handleRequest(req, res); httpSessions.delete(sid); }
    else { res.writeHead(404); res.end(); }
    return;
  }

  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
    const sid = req.headers['mcp-session-id'];
    if (sid && httpSessions.has(sid)) {
      await httpSessions.get(sid).handleRequest(req, res, parsed);
    } else if (isInitializeRequest(parsed)) {
      if (sid) process.stderr.write(`[HTTP] Stale session ${sid} — creating new\n`);
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: id => { httpSessions.set(id, t); process.stderr.write(`[HTTP] Session opened: ${id}\n`); } });
      t.onclose = () => { const id = t.sessionId; if (id) { httpSessions.delete(id); process.stderr.write(`[HTTP] Session closed: ${id}\n`); } };
      const httpMcp = new McpServer({ name: 'fauna-browser-mcp', version: '2.0.0' });
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

httpServer.listen(HTTP_PORT, () => { process.stderr.write(`[MCP] HTTP/MCP listening on http://localhost:${HTTP_PORT}/mcp\n`); });

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile as _execFile } from 'child_process';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EDGE_PATH = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const EDGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.3856.62';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.153 Safari/537.36';

function nowIso() {
  return new Date().toISOString();
}

function boundedPush(list, item, max = 500) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

function htmlToMarkdownFallback(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

const BROWSER_STATE_SCHEMA_VERSION = 1;

export class FaunaBrowserManager {
  constructor({ require: nodeRequire, stateDir, logger } = {}) {
    this._require = nodeRequire || null;
    this.stateDir = stateDir || path.join(os.homedir(), '.config', 'fauna', 'browser');
    this.stateFile = path.join(this.stateDir, 'state.json');
    this.logger = logger || console;

    this.browser = null;
    this.context = null;
    this.page = null;
    this.playwrightAvailable = null;
    this.mode = 'headed';
    this.startedAt = null;
    this.lastActionAt = null;
    this.lastError = null;
    this.activeTabId = 1;
    this.nextTabId = 2;
    this.tabs = new Map();
    this.tabPages = new Map();
    this.consoleLog = [];
    this.networkLog = [];
    this.dialogLog = [];

    this.browserPath = fs.existsSync(EDGE_PATH) ? EDGE_PATH : CHROME_PATH;
    this.isEdge = fs.existsSync(EDGE_PATH);
    this.userAgent = this.isEdge ? EDGE_UA : CHROME_UA;
    this.secChUa = this.isEdge
      ? '"Microsoft Edge";v="146", "Chromium";v="146", "Not/A)Brand";v="24"'
      : '"Google Chrome";v="146", "Chromium";v="146", "Not/A)Brand";v="24"';
    this.warmedDomains = new Set();
  }

  getStatus() {
    return {
      ok: true,
      browser: {
        connected: this.isConnected(),
        mode: this.mode,
        startedAt: this.startedAt,
        lastActionAt: this.lastActionAt,
        lastError: this.lastError,
        browserPath: this.browserPath,
        stateFile: this.stateFile,
        tabCount: this.tabs.size,
        activeTabId: this.activeTabId,
        playwrightAvailable: this.playwrightAvailable,
      },
      logs: {
        console: this.consoleLog.length,
        network: this.networkLog.length,
        dialog: this.dialogLog.length,
      },
    };
  }

  isConnected() {
    try {
      return !!this.browser && (this.browser._isPuppeteer || this.browser.isConnected());
    } catch (_) {
      return false;
    }
  }

  async check() {
    let playwrightOk = false;
    let playwrightError = null;
    try {
      const pw = await import('playwright-core');
      playwrightOk = !!(pw.chromium || pw.default?.chromium);
    } catch (e) {
      playwrightError = e.message;
    }
    return {
      chromeExists: fs.existsSync(this.browserPath),
      chromeExePath: this.browserPath,
      playwrightOk,
      playwrightError,
      manager: this.getStatus().browser,
    };
  }

  async handleAction({ url, action = 'extract', selector, text, waitFor, maxChars = 12000, tabId = null, index = null } = {}) {
    const normalizedAction = String(action || 'extract');
    if (normalizedAction === 'list-tabs') return { ok: true, tabs: this.listTabs(), activeTabId: this.activeTabId };
    if (normalizedAction === 'switch-tab') return this.switchTab({ tabId, index });
    if (normalizedAction === 'close-tab') return this.closeTab({ tabId, index });
    if (normalizedAction === 'new-tab') return this.newTab({ url, maxChars });
    if (!url && normalizedAction === 'navigate') throw new Error('url required');

    const page = await this.getPage(tabId ? Number(tabId) : null);
    this.lastActionAt = nowIso();
    this.writeState();

    try {
      if (url) await this.navigateWithWarmup(page, url);
      await this.waitThroughChallenge(page);
      try { await page.waitForLoadState?.('networkidle', { timeout: 8000 }); } catch (_) {}

      if (waitFor) {
        try { await page.waitForSelector(waitFor, { timeout: 8000 }); } catch (_) {}
      }

      let result;
      if (normalizedAction === 'extract' || normalizedAction === 'navigate') {
        const title = await page.title();
        const pageUrl = page.url();
        const html = await page.content();
        const md = this.htmlToMarkdown(html, pageUrl);
        const browserState = await this.getBrowserState(page, { maxChars });
        result = { url: pageUrl, title, content: md.slice(0, maxChars), chars: md.length, browserState };
        if (browserState.diagnostics.blocked) result.blocked = true;
      } else if (normalizedAction === 'screenshot') {
        const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
        result = { url: page.url(), screenshot: buf.toString('base64'), mime: 'image/jpeg', browserState: await this.getBrowserState(page, { maxChars: 2000 }) };
      } else if (normalizedAction === 'click') {
        await page.click(selector || text, { timeout: 5000 });
        const html = await page.content();
        result = { url: page.url(), content: this.htmlToMarkdown(html, page.url()).slice(0, maxChars), browserState: await this.getBrowserState(page, { maxChars }) };
      } else if (normalizedAction === 'type') {
        await page.fill(selector, text);
        result = { ok: true, url: page.url(), browserState: await this.getBrowserState(page, { maxChars: 4000 }) };
      } else if (normalizedAction === 'eval') {
        const evalResult = await page.evaluate(text);
        result = { result: JSON.stringify(evalResult), url: page.url(), browserState: await this.getBrowserState(page, { maxChars: 4000 }) };
      } else {
        throw new Error('unknown browser action: ' + action);
      }

      this.rememberPage(page);
      return result;
    } catch (e) {
      this.lastError = e.message;
      this.writeState();
      throw e;
    }
  }

  listTabs() {
    return [...this.tabs.values()].map((tab, index) => ({ ...tab, index, active: tab.id === this.activeTabId }));
  }

  resolveTabId({ tabId = null, index = null } = {}) {
    if (tabId != null && tabId !== '') {
      const id = Number(tabId);
      if (this.tabs.has(id) || this.tabPages.has(id) || id === this.activeTabId) return id;
      throw new Error('Unknown tabId: ' + tabId);
    }
    if (index != null && index !== '') {
      const tabs = this.listTabs();
      const tab = tabs[Number(index)];
      if (!tab) throw new Error('Unknown tab index: ' + index);
      return tab.id;
    }
    return this.activeTabId;
  }

  switchTab({ tabId = null, index = null } = {}) {
    const id = this.resolveTabId({ tabId, index });
    this.activeTabId = id;
    this.page = this.tabPages.get(id) || this.page;
    for (const tab of this.tabs.values()) tab.active = tab.id === id;
    this.rememberPage(this.page, id);
    return { ok: true, tabId: id, activeTabId: this.activeTabId, tabs: this.listTabs() };
  }

  async closeTab({ tabId = null, index = null } = {}) {
    const id = this.resolveTabId({ tabId, index });
    const page = this.tabPages.get(id);
    if (page) await page.close?.().catch?.(() => {});
    this.tabPages.delete(id);
    this.tabs.delete(id);
    if (this.activeTabId === id) {
      const next = this.listTabs()[0];
      this.activeTabId = next?.id || 1;
      this.page = this.tabPages.get(this.activeTabId) || null;
    }
    this.writeState();
    return { ok: true, closedTabId: id, activeTabId: this.activeTabId, tabs: this.listTabs() };
  }

  async newTab({ url = null, maxChars = 12000 } = {}) {
    const id = this.nextTabId++;
    this.activeTabId = id;
    const page = await this.createPage();
    this.page = page;
    this.tabPages.set(id, page);
    this.rememberPage(page, id);
    if (!url) return { ok: true, tabId: id, activeTabId: this.activeTabId, tabs: this.listTabs() };
    const result = await this.handleAction({ url, action: 'navigate', tabId: id, maxChars });
    return { ...result, ok: true, tabId: id, activeTabId: this.activeTabId, tabs: this.listTabs() };
  }

  normalizeBrowserState(raw = {}) {
    const now = nowIso();
    const scroll = raw.scroll || {};
    const viewport = raw.viewport || {};
    const interactiveElements = Array.isArray(raw.interactiveElements)
      ? raw.interactiveElements.map((el, index) => ({
          index: Number.isInteger(el.index) ? el.index : index,
          tag: String(el.tag || '').toLowerCase(),
          role: el.role ? String(el.role) : null,
          text: String(el.text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
          selector: el.selector ? String(el.selector) : null,
          href: el.href ? String(el.href) : null,
          inputType: el.inputType ? String(el.inputType) : null,
          disabled: !!el.disabled,
          visible: el.visible !== false,
        }))
      : [];

    const pagesAbove = Number.isFinite(scroll.y) && Number.isFinite(viewport.height) && viewport.height > 0
      ? scroll.y / viewport.height
      : 0;
    const pixelsBelow = Math.max(0, Number(scroll.totalHeight || 0) - Number(scroll.y || 0) - Number(viewport.height || 0));
    const pagesBelow = Number.isFinite(viewport.height) && viewport.height > 0 ? pixelsBelow / viewport.height : 0;
    const blocked = !!raw.blocked;
    const blockedReason = raw.blockedReason || (blocked ? 'challenge_or_access_denied' : null);
    const url = String(raw.url || '');
    const title = String(raw.title || '');
    const visibleText = String(raw.visibleText || '').replace(/\s{3,}/g, ' ').trim();

    return {
      schemaVersion: BROWSER_STATE_SCHEMA_VERSION,
      source: 'fauna-browser-manager',
      sessionId: 'managed-browser',
      windowId: 'managed-window',
      tabId: raw.tabId || this.activeTabId,
      active: raw.active !== false,
      url,
      title,
      viewport: {
        width: Number(viewport.width || 0),
        height: Number(viewport.height || 0),
        deviceScaleFactor: Number(viewport.deviceScaleFactor || 1),
      },
      scroll: {
        x: Number(scroll.x || 0),
        y: Number(scroll.y || 0),
        totalWidth: Number(scroll.totalWidth || 0),
        totalHeight: Number(scroll.totalHeight || 0),
        pagesAbove: Number(pagesAbove.toFixed(2)),
        pagesBelow: Number(pagesBelow.toFixed(2)),
        pixelsBelow,
      },
      header: `Current Page: [${title || 'Untitled'}](${url || 'about:blank'})\nViewport: ${Number(viewport.width || 0)}x${Number(viewport.height || 0)}, scroll ${Number(scroll.y || 0)}px (${pagesAbove.toFixed(1)} pages above)`,
      content: interactiveElements.map(el => `[${el.index}]<${el.tag || 'element'}${el.role ? ` role="${el.role}"` : ''}>${el.text}</${el.tag || 'element'}>`).join('\n'),
      footer: pixelsBelow > 4 ? `... ${pixelsBelow} pixels below (${pagesBelow.toFixed(1)} pages) - scroll to see more ...` : '[End of page]',
      interactiveElements,
      visibleText,
      diagnostics: {
        updatedAt: raw.updatedAt || now,
        readable: !blocked && (!!visibleText || interactiveElements.length > 0),
        blocked,
        blockedReason,
        interactiveCount: interactiveElements.length,
        consoleErrorsRecent: this.consoleLog.filter(x => /error/i.test(x.type || '')).slice(-5).length,
        networkRequestsRecent: this.networkLog.length,
      },
    };
  }

  async getBrowserState(page = this.page, { maxChars = 12000 } = {}) {
    if (!page) return this.normalizeBrowserState({ blocked: true, blockedReason: 'no_page' });
    const [url, title, blocked, domState] = await Promise.all([
      Promise.resolve(page.url?.() || '').catch(() => ''),
      Promise.resolve(page.title?.() || '').catch(() => ''),
      this.isChallenge(page).catch(() => false),
      page.evaluate(() => {
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const labelFor = (el) => (
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          el.innerText ||
          el.value ||
          el.textContent ||
          ''
        );
        const selectorFor = (el) => {
          if (el.id) return `#${CSS.escape(el.id)}`;
          const attr = el.getAttribute('name') || el.getAttribute('aria-label') || el.getAttribute('href');
          if (attr) return `${el.tagName.toLowerCase()}[${el.getAttribute('name') ? 'name' : el.getAttribute('aria-label') ? 'aria-label' : 'href'}="${CSS.escape(attr)}"]`;
          return el.tagName.toLowerCase();
        };
        const nodes = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'));
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 },
          scroll: { x: window.scrollX, y: window.scrollY, totalWidth: document.documentElement.scrollWidth, totalHeight: document.documentElement.scrollHeight },
          visibleText: (document.body?.innerText || '').slice(0, 20000),
          interactiveElements: nodes.filter(isVisible).slice(0, 100).map((el, index) => ({
            index,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            text: labelFor(el),
            selector: selectorFor(el),
            href: el.href || null,
            inputType: el.getAttribute('type'),
            disabled: !!el.disabled,
            visible: true,
          })),
        };
      }).catch(() => ({})),
    ]);

    return this.normalizeBrowserState({
      ...domState,
      url,
      title,
      tabId: this.activeTabId,
      blocked,
      visibleText: String(domState.visibleText || '').slice(0, maxChars),
    });
  }

  async getPage(tabId = null) {
    const requestedTabId = tabId ? Number(tabId) : this.activeTabId;
    const existing = this.tabPages.get(requestedTabId) || (requestedTabId === this.activeTabId ? this.page : null);
    if (existing) {
      try {
        await existing.evaluate(() => true);
        this.activeTabId = requestedTabId;
        this.page = existing;
        this.rememberPage(existing, requestedTabId);
        return existing;
      } catch (_) {
        this.tabPages.delete(requestedTabId);
        if (requestedTabId === this.activeTabId) this.page = null;
      }
    }

    const page = await this.createPage();
    this.activeTabId = requestedTabId;
    this.page = page;
    this.tabPages.set(requestedTabId, page);
    this.rememberPage(page, requestedTabId);
    return page;
  }

  async createPage() {
    const browser = await this.getBrowser();
    let page;
    if (browser._isPuppeteer) {
      page = await browser.newPage();
      await page.setUserAgent(this.userAgent);
      await page.setViewport({ width: 1280, height: 900 });
      await page.setExtraHTTPHeaders(this.extraHeaders());
    } else {
      if (!this.context) {
        this.context = await browser.newContext({
          userAgent: this.userAgent,
          viewport: { width: 1280, height: 900 },
          locale: 'en-US',
          timezoneId: 'America/New_York',
          extraHTTPHeaders: this.extraHeaders(),
        });
        await this.context.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
      }
      page = await this.context.newPage();
    }

    this.attachPageLogs(page);
    return page;
  }

  async getBrowser() {
    if (this.isConnected()) return this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.tabPages.clear();

    if (this.playwrightAvailable === false) throw new Error('playwright-core not available in this environment');

    if (this._require) {
      try {
        const puppeteerExtra = this._require('puppeteer-extra');
        const StealthPlugin = this._require('puppeteer-extra-plugin-stealth');
        puppeteerExtra.use(StealthPlugin());
        const launchOpts = {
          executablePath: this.browserPath,
          headless: false,
          args: this.launchArgs(),
        };
        if (this.isEdge) launchOpts.userDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge');
        this.browser = await puppeteerExtra.launch(launchOpts);
        this.browser._isPuppeteer = true;
        this.playwrightAvailable = true;
        this.startedAt = nowIso();
        this.writeState();
        return this.browser;
      } catch (_) {
        this.browser = null;
      }
    }

    try {
      const pw = await import('playwright-core');
      const chromium = pw.chromium || pw.default?.chromium;
      if (!chromium) throw new Error('playwright-core loaded but chromium not found');
      this.browser = await chromium.launch({ executablePath: this.browserPath, headless: false, args: this.launchArgs() });
      this.playwrightAvailable = true;
      this.startedAt = nowIso();
      this.writeState();
      return this.browser;
    } catch (e) {
      this.browser = null;
      if (e.message.includes('playwright-core') || e.message.includes('Cannot find module')) this.playwrightAvailable = false;
      this.lastError = e.message;
      this.writeState();
      throw e;
    }
  }

  launchArgs() {
    return [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-size=1280,900',
      '--window-position=-2000,-2000',
      '--lang=en-US,en',
    ];
  }

  extraHeaders() {
    return {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': this.secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    };
  }

  async navigateWithWarmup(page, url) {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const isHomepage = parsed.pathname === '/' || parsed.pathname === '';
    if (!isHomepage && !this.warmedDomains.has(origin)) {
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 1500));
      this.warmedDomains.add(origin);
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    this.warmedDomains.add(origin);
  }

  async isChallenge(page) {
    const title = await page.title().catch(() => '');
    const body = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '').catch(() => '');
    return title === '' || /access denied|just a moment|checking your browser|powered and protected|enable javascript/i.test(title + ' ' + body);
  }

  async waitThroughChallenge(page) {
    if (!(await this.isChallenge(page))) return;
    await page.waitForFunction(
      () => {
        const t = document.title;
        if (!t) return false;
        return !/access denied|just a moment|checking your browser|powered and protected/i.test(t);
      },
      { timeout: 25000 },
    ).catch(() => {});
  }

  htmlToMarkdown(html, baseUrl) {
    if (!this._require) return htmlToMarkdownFallback(html);
    try {
      const TurndownService = this._require('turndown');
      const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
      td.remove(['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'svg', 'iframe']);
      if (baseUrl) {
        html = String(html || '').replace(/href="([^"]+)"/g, (m, href) => {
          try { return `href="${new URL(href, baseUrl).href}"`; } catch (_) { return m; }
        });
      }
      return td.turndown(html);
    } catch (_) {
      return htmlToMarkdownFallback(html);
    }
  }

  fetchUrlFallback(url, maxChars = 12000) {
    return new Promise((resolve, reject) => {
      _execFile('curl', ['-sL', '--max-time', '15', '-A', this.userAgent, '--', url], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        const html = stdout || '';
        const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
        const content = this.htmlToMarkdown(html, url);
        resolve({ url, title, content: content.slice(0, maxChars), chars: content.length, fallback: true });
      });
    });
  }

  attachPageLogs(page) {
    if (!page || page.__faunaLogsAttached) return;
    page.__faunaLogsAttached = true;
    try {
      page.on('console', msg => boundedPush(this.consoleLog, { ts: nowIso(), type: msg.type?.() || 'log', text: msg.text?.() || '' }));
      page.on('dialog', dialog => {
        boundedPush(this.dialogLog, { ts: nowIso(), type: dialog.type?.() || 'dialog', message: dialog.message?.() || '' });
        dialog.accept?.().catch?.(() => {});
      });
      page.on('request', req => boundedPush(this.networkLog, { ts: nowIso(), method: req.method?.() || 'GET', url: req.url?.() || '' }));
    } catch (_) {}
  }

  rememberPage(page, tabId = this.activeTabId) {
    if (!page) return;
    const id = Number(tabId || this.activeTabId);
    this.tabs.set(id, { id, url: page.url?.() || '', active: id === this.activeTabId, updatedAt: nowIso() });
    for (const tab of this.tabs.values()) tab.active = tab.id === this.activeTabId;
    this.writeState();
  }

  writeState() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const state = {
        mode: this.mode,
        startedAt: this.startedAt,
        lastActionAt: this.lastActionAt,
        lastError: this.lastError,
        browserPath: this.browserPath,
        activeTabId: this.activeTabId,
        tabs: [...this.tabs.values()],
      };
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (e) {
      this.logger.warn?.('[browser-manager] failed to write state:', e.message);
    }
  }
}

export function createFaunaBrowserManager(opts = {}) {
  return new FaunaBrowserManager(opts);
}

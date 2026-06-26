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

  async handleAction({ url, action = 'extract', selector, text, waitFor, maxChars = 12000 } = {}) {
    if (!url) throw new Error('url required');
    const page = await this.getPage();
    this.lastActionAt = nowIso();
    this.writeState();

    try {
      await this.navigateWithWarmup(page, url);
      await this.waitThroughChallenge(page);
      try { await page.waitForLoadState?.('networkidle', { timeout: 8000 }); } catch (_) {}

      if (waitFor) {
        try { await page.waitForSelector(waitFor, { timeout: 8000 }); } catch (_) {}
      }

      let result;
      if (action === 'extract' || action === 'navigate') {
        const title = await page.title();
        const pageUrl = page.url();
        const html = await page.content();
        const md = this.htmlToMarkdown(html, pageUrl);
        result = { url: pageUrl, title, content: md.slice(0, maxChars), chars: md.length };
        if (await this.isChallenge(page)) result.blocked = true;
      } else if (action === 'screenshot') {
        const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
        result = { url: page.url(), screenshot: buf.toString('base64'), mime: 'image/jpeg' };
      } else if (action === 'click') {
        await page.click(selector || text, { timeout: 5000 });
        const html = await page.content();
        result = { url: page.url(), content: this.htmlToMarkdown(html, page.url()).slice(0, maxChars) };
      } else if (action === 'type') {
        await page.fill(selector, text);
        result = { ok: true, url: page.url() };
      } else if (action === 'eval') {
        const evalResult = await page.evaluate(text);
        result = { result: JSON.stringify(evalResult), url: page.url() };
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

  async getPage() {
    if (this.page) {
      try {
        await this.page.evaluate(() => true);
        return this.page;
      } catch (_) {
        this.page = null;
      }
    }

    const browser = await this.getBrowser();
    if (browser._isPuppeteer) {
      this.page = await browser.newPage();
      await this.page.setUserAgent(this.userAgent);
      await this.page.setViewport({ width: 1280, height: 900 });
      await this.page.setExtraHTTPHeaders(this.extraHeaders());
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
      this.page = await this.context.newPage();
    }

    this.attachPageLogs(this.page);
    this.rememberPage(this.page);
    return this.page;
  }

  async getBrowser() {
    if (this.isConnected()) return this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;

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

  rememberPage(page) {
    if (!page) return;
    this.tabs.set(this.activeTabId, { id: this.activeTabId, url: page.url?.() || '', active: true, updatedAt: nowIso() });
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

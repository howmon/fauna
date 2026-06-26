// server/bridges/playwright-browse.js
//
// Playwright-based browser routes:
//   GET  /api/browse-check — verify Chromium/Edge + playwright-core availability
//   POST /api/browse        — full JS-rendered page fetch with bot-protection
//                             warm-up, screenshot, click/type/eval actions
//
// Uses installed Google Chrome or Microsoft Edge to load pages with full JS
// execution, bypassing anti-bot measures that block simple fetch requests.
// Inspired by github.com/ntegrals/openbrowser (MIT).
//
// Factory: registerBrowseRoutes(app, { require: nodeRequire })

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile as _execFile } from 'child_process';
import { createFaunaBrowserManager } from '../browser/browser-manager.js';

export function registerBrowseRoutes(app, { require: nodeRequire } = {}) {
  const _require = nodeRequire || ((m) => { throw new Error(`require not provided for ${m}`); });
  const browserManager = createFaunaBrowserManager({ require: _require });

  const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const EDGE_PATH   = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  const BROWSER_PATH = fs.existsSync(EDGE_PATH) ? EDGE_PATH : CHROME_PATH;
  const EDGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.3856.62';
  const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.153 Safari/537.36';
  const BROWSE_UA = fs.existsSync(EDGE_PATH) ? EDGE_UA : CHROME_UA;
  const ISEDGE = fs.existsSync(EDGE_PATH);
  const SEC_CH_UA = ISEDGE
    ? '"Microsoft Edge";v="146", "Chromium";v="146", "Not/A)Brand";v="24"'
    : '"Google Chrome";v="146", "Chromium";v="146", "Not/A)Brand";v="24"';

  let _browserInstance = null;
  let _browsePage = null;          // persistent reusable page (keeps cookies/session)
  let _playwrightAvailable = null; // null = unchecked, true/false after first attempt

  async function getBrowser() {
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
      _browserInstance._isPuppeteer = true;
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

  // Returns a persistent page that reuses cookies/session across browse calls.
  async function getBrowsePage() {
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

    if (!isHomepage && !_warmedDomains.has(origin)) {
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
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
      if (baseUrl) {
        html = html.replace(/href="([^"]+)"/g, (m, href) => {
          try { return `href="${new URL(href, baseUrl).href}"`; } catch { return m; }
        });
      }
      return td.turndown(html);
    } catch {
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
    try {
      res.json(await browserManager.check());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/browse/status', (_req, res) => {
    res.json(browserManager.getStatus());
  });

  app.get('/api/browse/diagnostics', (req, res) => {
    res.json(browserManager.getDiagnostics({ limit: req.query.limit }));
  });

  app.post('/api/browse', async (req, res) => {
    const { url, action = 'extract', selector, text, waitFor, maxChars = 12000, tabId = null, index = null, elementIndex = null } = req.body;
    if (!url && action === 'navigate') return res.status(400).json({ error: 'url required' });
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    req.on('aborted', abort);
    res.on('close', abort);

    try {
      res.json(await browserManager.handleAction({ url, action, selector, text, waitFor, maxChars, tabId, index, elementIndex, signal: abortController.signal }));
    } catch (err) {
      if (abortController.signal.aborted || err.name === 'AbortError' || err.code === 'ABORT_ERR') return;
      if ((action === 'extract' || action === 'navigate') && _playwrightAvailable !== false) {
        try {
          const fallback = await browserManager.fetchUrlFallback(url, maxChars, abortController.signal);
          return res.json(fallback);
        } catch { /* fall through to error */ }
      }
      res.status(500).json({ error: err.message });
    } finally {
      req.off?.('aborted', abort);
      res.off?.('close', abort);
    }
  });

  return { manager: browserManager, getStatus: () => browserManager.getStatus() };
}

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { passedBrowserVerification } from '../lib/browser-verification.js';
import { resolveBrowserExtensionRoot } from '../lib/verification-command.js';

const source = fs.readFileSync(path.join(process.cwd(), 'public/js/browser.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(process.cwd(), 'public/js/chat.js'), 'utf8');
const shellSource = fs.readFileSync(path.join(process.cwd(), 'public/js/shell.js'), 'utf8');

it('scopes extension verification from real manifests without exempting web or mixed-package changes', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.fauna-browser-scope-'));
  try {
    const extension = path.join(root, 'extensions', 'grader');
    const website = path.join(root, 'website');
    fs.mkdirSync(path.join(extension, 'src'), { recursive: true });
    fs.mkdirSync(website);
    fs.writeFileSync(path.join(extension, 'package.json'), '{}');
    fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'Grader', version: '1.0', side_panel: { default_path: 'panel.html' },
    }));
    fs.writeFileSync(path.join(website, 'package.json'), '{}');
    fs.writeFileSync(path.join(website, 'manifest.json'), JSON.stringify({ name: 'Website', version: '1.0' }));
    const panel = path.join(extension, 'src', 'panel.ts');
    const page = path.join(website, 'index.html');
    expect(resolveBrowserExtensionRoot(root, [panel])).toBe(extension);
    expect(resolveBrowserExtensionRoot(extension)).toBe(extension);
    expect(resolveBrowserExtensionRoot(root, [page])).toBeNull();
    expect(resolveBrowserExtensionRoot(root, [panel, page])).toBeNull();
    expect(resolveBrowserExtensionRoot(extension, [path.join(root, 'outside.html')])).toBeNull();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('browser backend routing', () => {
  it('gives extension blocks precedence over internal legacy blocks', () => {
    const functionStart = source.indexOf('function extractAndRenderBrowserActions');
    const extensionGuard = source.indexOf("container.querySelectorAll('code.language-browser-ext-action", functionStart);
    const internalRun = source.indexOf('_runBrowserActionSequence(widgets', functionStart);

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(extensionGuard).toBeGreaterThan(functionStart);
    expect(extensionGuard).toBeLessThan(internalRun);
    expect(source.slice(extensionGuard, internalRun)).toContain('return;');
  });

  describe('executed in-app browser journeys', () => {
    function journeyHarness({ consoleError = false, missing = false, noWebview = false } = {}) {
      const outcome = { innerText: 'Before', textContent: 'Before', getClientRects: () => [1] };
      const button = {
        tagName: 'BUTTON', scrollIntoView() {}, focus() {}, getClientRects: () => [1], getAttribute: () => null,
        click() { outcome.innerText = 'After'; if (consoleError) tab.consoleLogs.push({ level: 'error', text: 'UI crashed' }); },
      };
      const domContext = vm.createContext({
        document: {
          querySelector: selector => selector === '#submit' && !missing ? button : null,
          querySelectorAll: selector => selector === '#outcome' ? [outcome] : [],
        },
        getComputedStyle: () => ({ visibility: 'visible' }),
      });
      const listeners = new Map();
      let url = 'about:blank';
      const wv = {
        getURL: () => url,
        addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: name => listeners.delete(name),
      };
      const tab = { wv, consoleLogs: [] };
      const context = vm.createContext({
        _normalizeBrowserAction: action => action,
        getActiveWebview: () => noWebview ? null : wv,
        _getConvTabs: () => [tab], openBrowserPane() {},
        browserNavigateTo: next => { url = next; listeners.get('did-stop-loading')?.(); },
        wvExec: async (_wv, code) => vm.runInContext(code, domContext),
        _extConnectedBrowsers: [], getConv: () => ({}),
        state: { playwrightMCPEnabled: true },
        _executeBrowserActionViaPlaywright: () => { throw new Error('External browser must not run'); },
        setTimeout: fn => { queueMicrotask(fn); return 1; },
        clearTimeout() {}, setInterval: () => 1, clearInterval() {},
        Date, console,
      });
      const start = source.indexOf('async function executeBrowserAction(action)');
      const end = source.indexOf("\nif (typeof window !== 'undefined' && window.faunaApp?.onBrowserTool)", start);
      vm.runInContext(source.slice(start, end), context);
      return action => context.executeBrowserAction(action);
    }

    const journey = {
      action: 'verify', url: 'http://localhost:3000',
      steps: [
        { action: 'click', selector: '#submit' },
        { action: 'assert', selector: '#outcome', property: 'text', expected: 'After' },
      ],
    };

    it('executes the click and measures its DOM outcome internally even with Playwright enabled', async () => {
      const evidence = await journeyHarness()(journey);
      expect(evidence).toMatchObject({ ok: true, source: 'internal', consoleChecked: true,
        checks: [{ actual: 'After', expected: 'After', ok: true }] });
      expect(passedBrowserVerification(evidence)).toBe(true);
    });

    it('rejects navigation-only, failed interactions, wrong DOM outcomes and console errors', async () => {
      expect((await journeyHarness()({ ...journey, steps: [] })).ok).toBe(false);
      expect((await journeyHarness({ missing: true })(journey)).ok).toBe(false);
      expect((await journeyHarness({ consoleError: true })(journey)).ok).toBe(false);
      const bad = await journeyHarness()({ ...journey, steps: [journey.steps[0],
        { ...journey.steps[1], property: 'count', expected: 2 }] });
      expect(bad).toMatchObject({ ok: false, checks: [{ actual: 1, ok: false }] });
      expect((await journeyHarness({ noWebview: true })(journey)).ok).toBe(false);
      expect(passedBrowserVerification({ ok: true, result: 'verified screenshot' })).toBe(false);
    });
  });

  it('keeps native fauna_browser calls internal before backend arbitration', () => {
    expect(chatSource).toContain("Object.assign({}, ev.args || {}, { forceInternal: true })");
    expect(source).toContain("var preferPlaywright = !action.forceInternal && !isLocalUrl");
  });

  it('defers mixed browser actions until shell results settle', () => {
    expect(chatSource).toContain('var deferBrowserActions = shellBlocks > 0;');
    expect(chatSource).toContain('extractAndRenderBrowserActions(buffer, msgEl, false, convId, deferBrowserActions)');
    expect(source).toContain('function runDeferredBrowserActionsForMessage(messageEl)');
    expect(source).toContain("statusEl.textContent = 'Waiting for shell…'");
    expect(shellSource).toContain('resumedBrowserActions = runDeferredBrowserActionsForMessage');
    expect(shellSource).toContain('if (opts.autoFeed && !resumedBrowserActions)');
  });
});
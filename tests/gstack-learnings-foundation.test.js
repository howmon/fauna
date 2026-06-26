import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import { createFaunaBrowserManager } from '../server/browser/browser-manager.js';
import { buildIngestionDiagnostics, detectIngestionFormat } from '../server/lib/ingestion-diagnostics.js';
import { clearSecurityEvents, listSecurityEvents, recordSecurityEvent } from '../server/lib/security-events.js';
import capabilities from '../server/generated/capabilities.json' with { type: 'json' };

describe('gstack learnings foundation', () => {
  beforeEach(() => {
    clearSecurityEvents();
  });

  it('creates browser manager status without launching Chromium', () => {
    const manager = createFaunaBrowserManager();
    const status = manager.getStatus();
    expect(status.ok).toBe(true);
    expect(status.browser.connected).toBe(false);
    expect(status.browser.stateFile).toMatch(/state\.json$/);
  });

  it('normalizes browser state with tab identity and diagnostics', () => {
    const manager = createFaunaBrowserManager();
    const state = manager.normalizeBrowserState({
      tabId: 7,
      url: 'https://example.test/form',
      title: 'Example Form',
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 400, totalWidth: 1280, totalHeight: 1800 },
      visibleText: 'Example form Submit',
      interactiveElements: [
        { tag: 'button', text: 'Submit', selector: '#submit' },
        { tag: 'input', text: 'Email', selector: 'input[name="email"]', inputType: 'email' },
      ],
    });

    expect(state.schemaVersion).toBe(1);
    expect(state.tabId).toBe(7);
    expect(state.header).toContain('Example Form');
    expect(state.content).toContain('[0]<button>Submit</button>');
    expect(state.footer).toMatch(/pixels below/);
    expect(state.diagnostics).toMatchObject({
      readable: true,
      blocked: false,
      interactiveCount: 2,
    });
  });

  it('reports no-page browser state as blocked and unreadable', () => {
    const manager = createFaunaBrowserManager();
    const state = manager.normalizeBrowserState({ blocked: true, blockedReason: 'no_page' });
    expect(state.diagnostics.readable).toBe(false);
    expect(state.diagnostics.blockedReason).toBe('no_page');
  });

  it('routes browser tab actions by id or index without implicit globals', async () => {
    const manager = createFaunaBrowserManager();
    manager.tabs.set(1, { id: 1, url: 'https://one.example', active: true, updatedAt: 't1' });
    manager.tabs.set(2, { id: 2, url: 'https://two.example', active: false, updatedAt: 't2' });

    const listed = await manager.handleAction({ action: 'list-tabs' });
    expect(listed.tabs.map(t => t.id)).toEqual([1, 2]);
    expect(listed.activeTabId).toBe(1);

    const switched = await manager.handleAction({ action: 'switch-tab', index: 1 });
    expect(switched.activeTabId).toBe(2);
    expect(switched.tabs.find(t => t.id === 2).active).toBe(true);

    const closed = await manager.handleAction({ action: 'close-tab', tabId: 2 });
    expect(closed.closedTabId).toBe(2);
    expect(closed.tabs.map(t => t.id)).toEqual([1]);
    expect(closed.activeTabId).toBe(1);
  });

  it('aborts browser navigation before continuing long action chains', async () => {
    const manager = createFaunaBrowserManager();
    const controller = new AbortController();
    const navigations = [];
    const page = {
      goto: async (targetUrl) => {
        navigations.push(targetUrl);
        controller.abort();
      },
    };

    await expect(manager.navigateWithWarmup(page, 'https://example.test/path', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    expect(navigations).toEqual(['https://example.test']);
  });

  it('persists compact browser history without transient logs', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-browser-state-'));
    const manager = createFaunaBrowserManager({ stateDir });
    manager.consoleLog.push({ text: 'debug noise' });
    manager.networkLog.push({ url: 'https://asset.example/noisy.js' });

    manager.recordActionHistory({ action: 'navigate', url: 'https://example.test', title: 'Example', tabId: 3 });

    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    expect(state.schemaVersion).toBe(1);
    expect(state.history).toEqual([
      expect.objectContaining({ action: 'navigate', url: 'https://example.test', title: 'Example', tabId: 3, ok: true }),
    ]);
    expect(state).not.toHaveProperty('consoleLog');
    expect(state).not.toHaveProperty('networkLog');
    expect(state).not.toHaveProperty('dialogLog');
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('honors abort signals before starting browser fetch fallback', async () => {
    const manager = createFaunaBrowserManager();
    const controller = new AbortController();
    controller.abort();

    await expect(manager.fetchUrlFallback('https://example.test', 100, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
  });

  it('routes browser click and type actions through interactive element indexes', async () => {
    const manager = createFaunaBrowserManager();
    const page = {
      url: () => 'https://example.test/form',
      content: async () => '<button>Submit</button>',
      waitForLoadState: async () => {},
    };
    const actions = [];
    manager.getPage = async () => page;
    manager.waitThroughChallenge = async () => {};
    manager.getBrowserState = async () => manager.normalizeBrowserState({ tabId: 1, url: page.url(), interactiveElements: [] });
    manager.clickElementByIndex = async (_page, elementIndex) => actions.push(['click', elementIndex]);
    manager.fillElementByIndex = async (_page, elementIndex, value) => actions.push(['type', elementIndex, value]);

    await manager.handleAction({ action: 'click', elementIndex: 4 });
    await manager.handleAction({ action: 'type', elementIndex: 2, text: 'hello' });

    expect(actions).toEqual([
      ['click', 4],
      ['type', 2, 'hello'],
    ]);
  });

  it('returns capped sanitized browser diagnostics snapshots', () => {
    const manager = createFaunaBrowserManager();
    manager.tabs.set(1, { id: 1, url: 'https://example.test', active: true, updatedAt: 't1' });
    manager.recordActionHistory({ action: 'navigate', url: 'https://example.test', title: 'Example' });
    manager.consoleLog.push({ ts: 't2', type: 'error', text: 'x'.repeat(1200) });
    manager.networkLog.push({ ts: 't3', method: 'GET', url: 'https://example.test/' + 'y'.repeat(1200) });

    const diagnostics = manager.getDiagnostics({ limit: 1 });

    expect(diagnostics.schemaVersion).toBe(1);
    expect(diagnostics.tabs).toHaveLength(1);
    expect(diagnostics.recentHistory).toHaveLength(1);
    expect(diagnostics.recentLogs.console).toHaveLength(1);
    expect(diagnostics.recentLogs.console[0].text).toHaveLength(1000);
    expect(diagnostics.recentLogs.network[0].url).toHaveLength(1000);
    expect(diagnostics.diagnostics.consoleErrorCount).toBe(1);
  });

  it('generates capability catalog from actual tool metadata', () => {
    expect(capabilities.count).toBeGreaterThan(50);
    expect(capabilities.tools.some(t => t.name === 'fauna_browser')).toBe(true);
    expect(capabilities.byCategory.browser).toBeGreaterThan(0);
  });

  it('detects ingestion formats and warns on empty extraction', () => {
    expect(detectIngestionFormat({ sourceType: 'github', text: 'README' }).format).toBe('github');
    const diagnostics = buildIngestionDiagnostics(
      { sourceType: 'codex-rollout', sourceId: 'rollout.jsonl', text: '' },
      { ok: false, error: 'text is required' },
    );
    expect(diagnostics.status).toBe('failed');
    expect(diagnostics.sourceFormat).toBe('empty');
    expect(diagnostics.warnings.join(' ')).toMatch(/unknown sourceType|empty extraction/i);
  });

  it('stores recent security events newest first', () => {
    recordSecurityEvent({ type: 'permission-denied', surface: 'shell', message: 'first' });
    recordSecurityEvent({ type: 'permission-denied', surface: 'browser', message: 'second' });
    const events = listSecurityEvents({ limit: 2 });
    expect(events).toHaveLength(2);
    expect(events[0].message).toBe('second');
    expect(events[1].message).toBe('first');
  });
});

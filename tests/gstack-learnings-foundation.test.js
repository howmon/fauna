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

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

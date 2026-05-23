import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getSettings, updateSettings, getLog, clearLog,
  runHeartbeat, startHeartbeat, stopHeartbeat,
} from '../heartbeat.js';

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(() => JSON.stringify({ settings: {}, log: [] })),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => true),
    },
    readFileSync: vi.fn(() => JSON.stringify({ settings: {}, log: [] })),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

describe('heartbeat', () => {
  beforeEach(() => {
    stopHeartbeat();
    vi.clearAllMocks();
  });

  describe('defaults via getSettings', () => {
    it('has expected default values', () => {
      const s = getSettings();
      expect(s.enabled).toBe(false);
      expect(s.intervalMinutes).toBe(30);
      expect(s.model).toBeDefined();
    });
  });

  describe('getSettings()', () => {
    it('returns settings with defaults', () => {
      const s = getSettings();
      expect(s.enabled).toBeDefined();
      expect(s.intervalMinutes).toBeDefined();
      expect(s.prompt).toBeDefined();
    });
  });

  describe('updateSettings()', () => {
    it('updates interval', () => {
      const s = updateSettings({ intervalMinutes: 15 });
      expect(s.intervalMinutes).toBe(15);
    });

    it('clamps interval to valid range', () => {
      const s = updateSettings({ intervalMinutes: 0 });
      expect(s.intervalMinutes).toBeGreaterThanOrEqual(1);
    });

    it('rejects overly long prompts', () => {
      const s = updateSettings({ prompt: 'x'.repeat(2001) });
      // Should truncate or reject
      expect(s.prompt.length).toBeLessThanOrEqual(2000);
    });
  });

  describe('getLog() / clearLog()', () => {
    it('returns empty log initially', () => {
      expect(getLog()).toHaveLength(0);
    });

    it('clears log', () => {
      clearLog();
      expect(getLog()).toHaveLength(0);
    });
  });

  describe('runHeartbeat()', () => {
    it('skips when disabled', async () => {
      updateSettings({ enabled: false });
      const result = await runHeartbeat();
      expect(result.skipped).toBe(true);
    });

    it('runs when forced even if disabled', async () => {
      const aiCaller = vi.fn().mockResolvedValue('HEARTBEAT_OK');
      startHeartbeat(aiCaller, vi.fn());
      updateSettings({ enabled: false });
      const result = await runHeartbeat(true);
      expect(result.status).toBe('ok');
    });

    it('parses HEARTBEAT_OK response', async () => {
      const aiCaller = vi.fn().mockResolvedValue('HEARTBEAT_OK');
      startHeartbeat(aiCaller, vi.fn());
      updateSettings({ enabled: true });
      const result = await runHeartbeat(true);
      expect(result.status).toBe('ok');
    });

    it('parses HEARTBEAT_URGENT response and notifies', async () => {
      const aiCaller = vi.fn().mockResolvedValue('HEARTBEAT_URGENT|disk|Disk is 95% full');
      const notifier = vi.fn();
      startHeartbeat(aiCaller, notifier);
      updateSettings({ enabled: true });
      const result = await runHeartbeat(true);
      expect(result.status).toBe('urgent');
      expect(result.urgent.summary).toContain('Disk');
      expect(notifier).toHaveBeenCalled();
    });

    it('handles AI error gracefully', async () => {
      const aiCaller = vi.fn().mockRejectedValue(new Error('API error'));
      startHeartbeat(aiCaller, vi.fn());
      updateSettings({ enabled: true });
      const result = await runHeartbeat(true);
      expect(result.status).toBe('error');
    });

    it('records entries in log', async () => {
      const aiCaller = vi.fn().mockResolvedValue('HEARTBEAT_OK');
      startHeartbeat(aiCaller, vi.fn());
      updateSettings({ enabled: true });
      await runHeartbeat(true);
      const log = getLog();
      expect(log.length).toBeGreaterThan(0);
    });
  });

  // ── PR4.3 — _parseResponse robustness ───────────────────────────────
  describe('PR4.3 response parsing (object/list/quote variants)', () => {
    it('extracts content from a chat-completion-shaped object', async () => {
      const aiCaller = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'HEARTBEAT_URGENT|email|Boss replied' } }],
      });
      const notifier = vi.fn();
      startHeartbeat(aiCaller, notifier);
      updateSettings({ enabled: true });
      const r = await runHeartbeat(true);
      expect(r.status).toBe('urgent');
      expect(r.urgent.source).toBe('email');
      expect(r.urgent.summary).toContain('Boss');
      expect(notifier).toHaveBeenCalled();
    });

    it('extracts content from a { content } object', async () => {
      const aiCaller = vi.fn().mockResolvedValue({ content: 'HEARTBEAT_OK' });
      startHeartbeat(aiCaller, vi.fn());
      updateSettings({ enabled: true });
      const r = await runHeartbeat(true);
      expect(r.status).toBe('ok');
    });

    it('handles markdown list-prefixed token: "- HEARTBEAT_URGENT|..."', async () => {
      const aiCaller = vi.fn().mockResolvedValue('- HEARTBEAT_URGENT|slack|DM from PM');
      const notifier = vi.fn();
      startHeartbeat(aiCaller, notifier);
      updateSettings({ enabled: true });
      const r = await runHeartbeat(true);
      expect(r.status).toBe('urgent');
      expect(r.urgent.source).toBe('slack');
      expect(notifier).toHaveBeenCalled();
    });

    it('handles quote-prefixed token: "> HEARTBEAT_OK"', async () => {
      const aiCaller = vi.fn().mockResolvedValue('> HEARTBEAT_OK');
      startHeartbeat(aiCaller, vi.fn());
      updateSettings({ enabled: true });
      const r = await runHeartbeat(true);
      expect(r.status).toBe('ok');
    });

    it('handles case-insensitive token', async () => {
      const aiCaller = vi.fn().mockResolvedValue('heartbeat_urgent|calendar|Standup in 5m');
      const notifier = vi.fn();
      startHeartbeat(aiCaller, notifier);
      updateSettings({ enabled: true });
      const r = await runHeartbeat(true);
      expect(r.status).toBe('urgent');
      expect(r.urgent.source).toBe('calendar');
      expect(notifier).toHaveBeenCalled();
    });

    it('does NOT match a quoted example inside prose', async () => {
      // Anchored regex must not be tripped by a "for example, HEARTBEAT_URGENT|..." substring mid-line.
      const aiCaller = vi.fn().mockResolvedValue(
        'I reviewed everything. For example HEARTBEAT_URGENT|x|y would mean trouble. All clear though.'
      );
      const notifier = vi.fn();
      startHeartbeat(aiCaller, notifier);
      updateSettings({ enabled: true });
      const r = await runHeartbeat(true);
      expect(r.status).toBe('ok');
      expect(notifier).not.toHaveBeenCalled();
    });

    it('still finds token when preceded by other lines', async () => {
      const aiCaller = vi.fn().mockResolvedValue(
        'Summary of inbox:\n- nothing pressing\n\nHEARTBEAT_URGENT|jira|PROD-123 is on fire'
      );
      const notifier = vi.fn();
      startHeartbeat(aiCaller, notifier);
      updateSettings({ enabled: true });
      const r = await runHeartbeat(true);
      expect(r.status).toBe('urgent');
      expect(r.urgent.source).toBe('jira');
      expect(notifier).toHaveBeenCalled();
    });

    it('treats null/undefined/empty responses as ok (no crash)', async () => {
      for (const value of [null, undefined, '', {}]) {
        const aiCaller = vi.fn().mockResolvedValue(value);
        startHeartbeat(aiCaller, vi.fn());
        updateSettings({ enabled: true });
        const r = await runHeartbeat(true);
        expect(r.status).toBe('ok');
      }
    });
  });
});

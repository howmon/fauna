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
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => true),
    },
    readFileSync: vi.fn(() => JSON.stringify({ settings: {}, log: [] })),
    writeFileSync: vi.fn(),
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
});

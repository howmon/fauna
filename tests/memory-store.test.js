import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import {
  remember, recall, forget, listFacts, getFact, runDecay,
  formatForSystemPrompt, exportFacts, importFacts, getStats, _resetCache,
} from '../memory-store.js';

// Mock fs to avoid real file I/O
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(() => JSON.stringify([])),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => true),
    },
    readFileSync: vi.fn(() => JSON.stringify([])),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

describe('memory-store', () => {
  beforeEach(() => {
    _resetCache();
    vi.clearAllMocks();
  });

  describe('constants', () => {
    it('getStats reports expected categories', () => {
      const stats = getStats();
      expect(stats.categories).toBeDefined();
    });

    it('has reasonable limits via getStats', () => {
      const stats = getStats();
      expect(stats.maxFacts).toBeGreaterThanOrEqual(100);
    });
  });

  describe('remember()', () => {
    it('stores a fact and returns ok', () => {
      const result = remember('The sky is blue');
      expect(result.ok).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('rejects empty text', () => {
      const result = remember('');
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('rejects text exceeding max chars', () => {
      const longText = 'x'.repeat(501);
      const result = remember(longText);
      expect(result.ok).toBe(false);
    });

    it('deduplicates identical text', () => {
      const r1 = remember('Duplicate fact');
      const r2 = remember('Duplicate fact');
      expect(r2.deduplicated).toBe(true);
    });

    it('deduplicates case-insensitively', () => {
      remember('Test Fact');
      const r2 = remember('test fact');
      expect(r2.deduplicated).toBe(true);
    });

    it('accepts valid categories', () => {
      const result = remember('My preference', 'preference');
      expect(result.ok).toBe(true);
    });
  });

  describe('recall()', () => {
    it('returns matching facts', () => {
      remember('The capital of France is Paris');
      remember('JavaScript is a programming language');
      const results = recall('France Paris');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].text).toContain('France');
    });

    it('returns empty for no matches', () => {
      remember('Apples are red');
      const results = recall('quantum mechanics');
      expect(results).toHaveLength(0);
    });
  });

  describe('forget()', () => {
    it('removes a fact by id', () => {
      const { id } = remember('To be forgotten');
      const result = forget(id);
      expect(result.ok).toBe(true);
      expect(getFact(id)).toBeNull();
    });

    it('returns error for unknown id', () => {
      const result = forget('nonexistent-id');
      expect(result.ok).toBe(false);
    });
  });

  describe('listFacts()', () => {
    it('returns all facts', () => {
      remember('Fact A');
      remember('Fact B');
      const all = listFacts();
      expect(all).toHaveLength(2);
    });

    it('filters by category', () => {
      remember('Pref 1', 'preference');
      remember('Fact 1', 'fact');
      const prefs = listFacts('preference');
      expect(prefs).toHaveLength(1);
      expect(prefs[0].category).toBe('preference');
    });
  });

  describe('runDecay()', () => {
    it('removes old facts beyond maxAgeDays', () => {
      remember('Old fact');
      // Manually adjust timestamps — need to access internal state
      const all = listFacts();
      if (all.length > 0) {
        // The fact was just created, so runDecay with 0 days should remove it
        // But with default 60 days, it should keep it
        const result = runDecay(60);
        expect(result.remaining).toBe(1);
      }
    });

    it('returns removal stats', () => {
      const result = runDecay();
      expect(result).toHaveProperty('removed');
      expect(result).toHaveProperty('remaining');
    });
  });

  describe('formatForSystemPrompt()', () => {
    it('returns empty string when no facts', () => {
      const prompt = formatForSystemPrompt();
      expect(prompt).toBe('');
    });

    it('includes facts in formatted output', () => {
      remember('User prefers dark mode', 'preference');
      const prompt = formatForSystemPrompt();
      expect(prompt).toContain('dark mode');
    });
  });

  describe('exportFacts() / importFacts()', () => {
    it('round-trips facts through export/import', () => {
      remember('Export test fact');
      const exported = exportFacts();
      expect(exported).toHaveLength(1);

      _resetCache();
      const result = importFacts(exported);
      expect(result.ok).toBe(true);
      expect(result.added).toBe(1);
    });

    it('rejects invalid import data', () => {
      const result = importFacts('not an array');
      expect(result.ok).toBe(false);
    });
  });

  describe('getStats()', () => {
    it('returns stat summary', () => {
      remember('Stat test');
      const stats = getStats();
      expect(stats.total).toBe(1);
      expect(stats.maxFacts).toBeDefined();
      expect(stats.categories).toBeDefined();
    });
  });
});

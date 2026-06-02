import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared in-memory fs map — exposed via globalThis so beforeEach can wipe
// it between tests (otherwise persisted facts/cache leak across cases).
globalThis.__memFs = new Map();
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const memFs = globalThis.__memFs;
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn((p) => {
        if (memFs.has(p)) return memFs.get(p);
        throw enoent();
      }),
      writeFileSync: vi.fn((p, d) => { memFs.set(p, d); }),
      mkdirSync: vi.fn(),
      existsSync: vi.fn((p) => memFs.has(p)),
      unlinkSync: vi.fn((p) => { memFs.delete(p); }),
    },
    readFileSync: vi.fn((p) => {
      if (memFs.has(p)) return memFs.get(p);
      throw enoent();
    }),
    writeFileSync: vi.fn((p, d) => { memFs.set(p, d); }),
    mkdirSync: vi.fn(),
    existsSync: vi.fn((p) => memFs.has(p)),
    unlinkSync: vi.fn((p) => { memFs.delete(p); }),
  };
});

const {
  embedTexts, embedText, cosine, getCacheStats, clearCache, _resetCache, DEFAULT_EMBED_MODEL,
} = await import('../server/lib/embeddings.js');
const {
  remember, recallHybrid, attachEmbedding, listFactsWithoutEmbedding,
  projectContainerTag, _resetCache: resetFacts,
} = await import('../memory-store.js');

beforeEach(() => {
  globalThis.__memFs.clear();
  _resetCache();
  resetFacts();
  vi.clearAllMocks();
});

describe('embeddings module', () => {
  describe('cosine()', () => {
    it('returns 1 for identical vectors', () => {
      expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    });
    it('returns 0 for orthogonal vectors', () => {
      expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
    });
    it('returns 0 for mismatched / empty input', () => {
      expect(cosine([1, 2], [1])).toBe(0);
      expect(cosine([], [])).toBe(0);
      expect(cosine([0, 0], [1, 1])).toBe(0);
      expect(cosine(null, [1, 2])).toBe(0);
    });
  });

  describe('embedTexts()', () => {
    it('calls embedder for every input on first call', async () => {
      const embedder = vi.fn().mockResolvedValue([[1, 0], [0, 1]]);
      const out = await embedTexts(['hello', 'world'], { embedder });
      expect(out).toEqual([[1, 0], [0, 1]]);
      expect(embedder).toHaveBeenCalledTimes(1);
      expect(embedder.mock.calls[0][0]).toEqual(['hello', 'world']);
    });

    it('skips cached entries on subsequent calls', async () => {
      const embedder = vi.fn().mockResolvedValue([[1, 0]]);
      await embedTexts(['hello'], { embedder });
      embedder.mockClear();
      const out = await embedTexts(['hello'], { embedder });
      expect(out).toEqual([[1, 0]]);
      expect(embedder).not.toHaveBeenCalled();
    });

    it('only requests the missing subset, preserves order', async () => {
      const e1 = vi.fn().mockResolvedValue([[1, 0]]);
      await embedTexts(['a'], { embedder: e1 });
      const e2 = vi.fn().mockResolvedValue([[0, 1], [0.5, 0.5]]);
      const out = await embedTexts(['a', 'b', 'c'], { embedder: e2 });
      expect(out).toEqual([[1, 0], [0, 1], [0.5, 0.5]]);
      // Only b and c hit the embedder; a was cached.
      expect(e2.mock.calls[0][0]).toEqual(['b', 'c']);
    });

    it('partitions cache by model', async () => {
      const e1 = vi.fn().mockResolvedValue([[1, 0]]);
      await embedTexts(['hello'], { embedder: e1, model: 'm1' });
      const e2 = vi.fn().mockResolvedValue([[9, 9]]);
      await embedTexts(['hello'], { embedder: e2, model: 'm2' });
      expect(e2).toHaveBeenCalled(); // different model = different cache bucket
    });

    it('throws on size mismatch', async () => {
      const embedder = vi.fn().mockResolvedValue([[1, 0]]); // only 1 vector for 2 texts
      await expect(embedTexts(['a', 'b'], { embedder })).rejects.toThrow(/expected 2/);
    });

    it('embedText() returns a single vector', async () => {
      const embedder = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
      const v = await embedText('foo', { embedder });
      expect(v).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe('cache stats / clear', () => {
    it('reports counts per model after embeds', async () => {
      const embedder = vi.fn().mockResolvedValue([[1, 0]]);
      await embedTexts(['x'], { embedder });
      const s = getCacheStats();
      expect(s.total).toBe(1);
      expect(s.byModel[DEFAULT_EMBED_MODEL]).toBe(1);
    });

    it('clearCache() empties everything', async () => {
      const embedder = vi.fn().mockResolvedValue([[1, 0], [0, 1]]);
      await embedTexts(['x', 'y'], { embedder });
      const { removed } = clearCache();
      expect(removed).toBe(2);
      expect(getCacheStats().total).toBe(0);
    });
  });
});

describe('memory-store hybrid recall', () => {
  it('attachEmbedding stores the vector', () => {
    const { id } = remember('user likes TypeScript', { containerTag: projectContainerTag('p1') });
    const r = attachEmbedding(id, [1, 0, 0], 'm1');
    expect(r.ok).toBe(true);
    const unembedded = listFactsWithoutEmbedding();
    expect(unembedded.find(f => f.id === id)).toBeUndefined();
  });

  it('attachEmbedding rejects unknown id and empty vector', () => {
    expect(attachEmbedding('nope', [1, 2]).ok).toBe(false);
    const { id } = remember('a fact', {});
    expect(attachEmbedding(id, []).ok).toBe(false);
  });

  it('listFactsWithoutEmbedding excludes embedded + superseded', () => {
    const a = remember('first fact about cats', {}).id;
    const b = remember('second fact about dogs', {}).id;
    attachEmbedding(a, [1, 0]);
    const pending = listFactsWithoutEmbedding();
    expect(pending.map(f => f.id)).toEqual([b]);
  });

  it('recallHybrid blends cosine + keyword, ranks semantic match higher', () => {
    const tag = projectContainerTag('proj-hybrid');
    const { id: a } = remember('user prefers Postgres over MySQL', { containerTag: tag });
    const { id: b } = remember('weather is nice today', { containerTag: tag });
    attachEmbedding(a, [1, 0, 0]);
    attachEmbedding(b, [0, 1, 0]);
    // Query vector points the same direction as fact A.
    const results = recallHybrid('', [0.9, 0.1, 0], { containerTag: tag, includeGlobal: false });
    expect(results[0].id).toBe(a);
  });

  it('recallHybrid falls back to lexical when query vec is null', () => {
    const tag = projectContainerTag('proj-lex');
    const { id: a } = remember('user prefers Postgres', { containerTag: tag });
    remember('unrelated context note', { containerTag: tag });
    const results = recallHybrid('postgres', null, { containerTag: tag, includeGlobal: false });
    expect(results[0].id).toBe(a);
  });

  it('recallHybrid includes facts without embeddings via lexical path', () => {
    const tag = projectContainerTag('proj-mix');
    const { id: a } = remember('embedded fact about apples', { containerTag: tag });
    const { id: b } = remember('unembedded fact about apples', { containerTag: tag });
    attachEmbedding(a, [1, 0]);
    const results = recallHybrid('apples', [1, 0], { containerTag: tag, includeGlobal: false });
    const ids = results.map(r => r.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    // Embedded fact should rank first (lex tie, semantic >0 vs 0).
    expect(ids[0]).toBe(a);
  });

  it('recallHybrid honors containerTag scoping', () => {
    const tagA = projectContainerTag('A');
    const tagB = projectContainerTag('B');
    remember('alpha fact', { containerTag: tagA });
    remember('beta fact',  { containerTag: tagB });
    const results = recallHybrid('fact', null, { containerTag: tagA, includeGlobal: false });
    expect(results).toHaveLength(1);
    expect(results[0].text).toMatch(/alpha/);
  });

  it('recallHybrid skips superseded and expired facts', () => {
    const tag = projectContainerTag('proj-exp');
    const { id: old } = remember('old fact about thing', { containerTag: tag });
    remember('new fact about thing', { containerTag: tag, supersedes: old });
    remember('expired fact about thing', { containerTag: tag, expiresAt: Date.now() - 1000 });
    const results = recallHybrid('thing', null, { containerTag: tag, includeGlobal: false });
    expect(results).toHaveLength(1);
    expect(results[0].text).toMatch(/new fact/);
  });
});

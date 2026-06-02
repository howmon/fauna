import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.__memFs = globalThis.__memFs || new Map();
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const memFs = globalThis.__memFs;
  const api = {
    readFileSync: vi.fn((p) => { if (memFs.has(p)) return memFs.get(p); throw enoent(); }),
    writeFileSync: vi.fn((p, d) => { memFs.set(p, d); }),
    mkdirSync: vi.fn(),
    existsSync: vi.fn((p) => memFs.has(p)),
    unlinkSync: vi.fn((p) => { memFs.delete(p); }),
  };
  return { ...actual, default: { ...actual, ...api }, ...api };
});

const { remember, _resetCache: resetFacts, projectContainerTag } = await import('../memory-store.js');
const { ingestDocument, _resetCache: resetCtx } = await import('../server/lib/context-store.js');
const { _resetCache: resetEmbed } = await import('../server/lib/embeddings.js');
const {
  buildProfile, buildProjectProfile, formatProfileForPrompt, invalidateStaticCache, _internals,
} = await import('../server/lib/profile.js');

const VOCAB = ['postgres', 'react', 'typescript', 'apples', 'weather'];
let stubEmbed;
const makeStub = () => vi.fn(async (texts) => texts.map(t => {
  const lower = String(t).toLowerCase();
  return VOCAB.map(v => lower.includes(v) ? 1 : 0);
}));

beforeEach(() => {
  globalThis.__memFs.clear();
  resetFacts();
  resetCtx();
  resetEmbed();
  invalidateStaticCache();
  stubEmbed = makeStub();
  vi.clearAllMocks();
});

describe('profile builder', () => {
  it('returns empty buckets when nothing is remembered', async () => {
    const p = await buildProfile({ containerTag: 'global', embedder: stubEmbed });
    expect(p.static).toEqual([]);
    expect(p.dynamic).toEqual([]);
    expect(p.context).toEqual([]);
  });

  it('splits static vs dynamic/temporal facts', async () => {
    const tag = projectContainerTag('p1');
    remember('user prefers Postgres', { containerTag: tag, kind: 'static' });
    remember('exam tomorrow', { containerTag: tag, kind: 'temporal', expiresAt: Date.now() + 60000 });
    remember('opened file foo.js', { containerTag: tag, kind: 'dynamic' });

    const p = await buildProfile({ containerTag: tag, includeGlobal: false, embedder: stubEmbed });
    expect(p.static.map(f => f.text)).toEqual(['user prefers Postgres']);
    expect(p.dynamic.map(f => f.text).sort())
      .toEqual(['exam tomorrow', 'opened file foo.js'].sort());
  });

  it('includes context passages when query + context-store hit', async () => {
    const tag = projectContainerTag('p2');
    await ingestDocument({
      text: 'Postgres tuning: vacuum, pooling, and replication notes.',
      sourceId: 'pg', sourcePath: '/docs/pg.md', containerTag: tag,
    }, { embedder: stubEmbed });

    const p = await buildProfile({
      containerTag: tag, includeGlobal: false, q: 'postgres', embedder: stubEmbed,
    });
    expect(p.context.length).toBeGreaterThan(0);
    expect(p.context[0].sourcePath).toBe('/docs/pg.md');
  });

  it('skips context when includeContext=false', async () => {
    const tag = projectContainerTag('p3');
    await ingestDocument({ text: 'React notes', sourceId: 'r', containerTag: tag }, { embedder: stubEmbed });
    const p = await buildProfile({
      containerTag: tag, q: 'react', includeContext: false, embedder: stubEmbed,
    });
    expect(p.context).toEqual([]);
  });

  it('caches the static slice for 60s', async () => {
    const tag = projectContainerTag('p4');
    remember('static thing', { containerTag: tag, kind: 'static' });
    const p1 = await buildProfile({ containerTag: tag, includeGlobal: false, embedder: stubEmbed });
    // Add another static fact AFTER the cache has been populated.
    remember('another static thing', { containerTag: tag, kind: 'static' });
    const p2 = await buildProfile({ containerTag: tag, includeGlobal: false, embedder: stubEmbed });
    // Cache should still hold the original snapshot.
    expect(p2.static.map(f => f.text)).toEqual(p1.static.map(f => f.text));
    expect(p2.static).toHaveLength(1);
  });

  it('invalidateStaticCache(tag) drops only that scope', async () => {
    const tagA = projectContainerTag('A');
    const tagB = projectContainerTag('B');
    remember('A fact', { containerTag: tagA, kind: 'static' });
    remember('B fact', { containerTag: tagB, kind: 'static' });
    await buildProfile({ containerTag: tagA, includeGlobal: false, embedder: stubEmbed });
    await buildProfile({ containerTag: tagB, includeGlobal: false, embedder: stubEmbed });
    invalidateStaticCache(tagA);
    // The B entry should still be in cache.
    const keys = Array.from(_internals._staticCache.keys());
    expect(keys.some(k => k.startsWith(tagB))).toBe(true);
    expect(keys.some(k => k.startsWith(tagA))).toBe(false);
  });

  it('soft-fails to lexical when embedder throws', async () => {
    const tag = projectContainerTag('p5');
    remember('we use TypeScript everywhere', { containerTag: tag, kind: 'dynamic' });
    const bad = vi.fn(() => { throw new Error('embed offline'); });
    const p = await buildProfile({ containerTag: tag, q: 'typescript', embedder: bad });
    // Recall still works via lexical.
    expect(p.dynamic.length).toBeGreaterThan(0);
  });

  it('buildProjectProfile() resolves to project containerTag', async () => {
    remember('proj fact', { containerTag: projectContainerTag('xyz'), kind: 'static' });
    const p = await buildProjectProfile('xyz', { embedder: stubEmbed });
    expect(p.containerTag).toBe('project:xyz');
    expect(p.static.map(f => f.text)).toContain('proj fact');
  });
});

describe('formatProfileForPrompt', () => {
  it('returns empty string for empty profile', () => {
    expect(formatProfileForPrompt({ static: [], dynamic: [], context: [] })).toBe('');
    expect(formatProfileForPrompt(null)).toBe('');
  });

  it('renders three labeled sections when populated', () => {
    const out = formatProfileForPrompt({
      containerTag: 'project:demo',
      static: [{ category: 'preference', text: 'uses Vim' }],
      dynamic: [{ category: 'context', kind: 'temporal', text: 'exam tomorrow' }],
      context: [{ sourcePath: '/r.md', text: 'snippet' }],
    });
    expect(out).toMatch(/Durable facts/);
    expect(out).toMatch(/Recent \/ time-bound/);
    expect(out).toMatch(/Relevant context passages/);
    expect(out).toMatch(/uses Vim/);
    expect(out).toMatch(/exam tomorrow/);
    expect(out).toMatch(/snippet/);
  });
});

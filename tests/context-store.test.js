import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared in-memory fs map so the chunk file and embedding cache stay
// isolated between tests.
globalThis.__memFs = globalThis.__memFs || new Map();
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const memFs = globalThis.__memFs;
  const api = {
    readFileSync: vi.fn((p) => {
      if (memFs.has(p)) return memFs.get(p);
      throw enoent();
    }),
    writeFileSync: vi.fn((p, d) => { memFs.set(p, d); }),
    mkdirSync: vi.fn(),
    existsSync: vi.fn((p) => memFs.has(p)),
    unlinkSync: vi.fn((p) => { memFs.delete(p); }),
  };
  return { ...actual, default: { ...actual, ...api }, ...api };
});

const { chunkText, _internals } = await import('../server/lib/chunker.js');
const {
  ingestDocument, searchContext, searchChunks, listDocuments,
  deleteDocument, getStats, _resetCache,
} = await import('../server/lib/context-store.js');
const { _resetCache: resetEmbedCache } = await import('../server/lib/embeddings.js');

beforeEach(() => {
  globalThis.__memFs.clear();
  _resetCache();
  resetEmbedCache();
  vi.clearAllMocks();
});

describe('chunker', () => {
  it('returns single chunk for short text', () => {
    const r = chunkText('hello world');
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('hello world');
  });

  it('returns empty array for empty / whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('splits long text into multiple overlapping chunks', () => {
    const para = 'This is a sentence. '.repeat(120); // ~2400 chars
    const r = chunkText(para);
    expect(r.length).toBeGreaterThan(1);
    // Overlap: every chunk after the first should share some prefix with the
    // previous chunk's suffix.
    for (let i = 1; i < r.length; i++) {
      expect(r[i].start).toBeLessThan(r[i - 1].end);
    }
  });

  it('honors targetChars / overlapChars opts', () => {
    const txt = 'word '.repeat(500);
    const r = chunkText(txt, { targetChars: 200, overlapChars: 40, minChars: 50 });
    expect(r.length).toBeGreaterThan(3);
    for (const c of r) {
      expect(c.text.length).toBeLessThanOrEqual(220); // some slack for boundary
    }
  });

  it('throws when overlap >= target', () => {
    expect(() => chunkText('x'.repeat(5000), { targetChars: 100, overlapChars: 100 }))
      .toThrow(/overlapChars/);
  });

  it('prefers paragraph boundaries when available', () => {
    const text = 'A'.repeat(500) + '\n\n' + 'B'.repeat(500) + '\n\n' + 'C'.repeat(500);
    const r = chunkText(text, { targetChars: 600, overlapChars: 50, minChars: 100 });
    // First chunk should end at the first paragraph break, not mid-word.
    expect(r[0].text.endsWith('A'.repeat(500))).toBe(true);
  });
});

describe('context-store', () => {
  // Deterministic stub embedder: vectors that encode token presence.
  const VOCAB = ['postgres', 'react', 'typescript', 'weather', 'apples'];
  const makeStub = () => vi.fn(async (texts) => texts.map(t => {
    const lower = String(t).toLowerCase();
    return VOCAB.map(v => lower.includes(v) ? 1 : 0);
  }));
  let stubEmbed;

  beforeEach(() => { stubEmbed = makeStub(); });

  it('ingestDocument chunks, embeds, and persists', async () => {
    const r = await ingestDocument({
      text: 'Postgres is our database. We chose React for the UI.',
      sourceId: 'doc-1',
      sourcePath: '/notes/stack.md',
      sourceType: 'note',
      containerTag: 'project:p1',
    }, { embedder: stubEmbed });
    expect(r.ok).toBe(true);
    expect(r.added).toBeGreaterThan(0);
    expect(r.replaced).toBe(0);
    expect(getStats().chunks).toBe(r.added);
  });

  it('re-ingesting the same sourceId replaces prior chunks', async () => {
    await ingestDocument({ text: 'first', sourceId: 'doc-2', containerTag: 'global' }, { embedder: stubEmbed });
    const before = getStats().chunks;
    const r = await ingestDocument({ text: 'second', sourceId: 'doc-2', containerTag: 'global' }, { embedder: stubEmbed });
    expect(r.replaced).toBe(before);
    expect(getStats().chunks).toBe(r.added);
    expect(getStats().documents).toBe(1);
  });

  it('searchContext ranks by semantic + lexical blend', async () => {
    await ingestDocument({
      text: 'Postgres tuning notes: vacuum settings and connection pooling.',
      sourceId: 'pg-doc', containerTag: 'project:p',
    }, { embedder: stubEmbed });
    await ingestDocument({
      text: 'Weather forecast for the weekend.',
      sourceId: 'weather-doc', containerTag: 'project:p',
    }, { embedder: stubEmbed });

    const r = await searchContext('postgres', {
      containerTag: 'project:p', includeGlobal: false,
      embedder: stubEmbed,
    });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].chunk.sourceId).toBe('pg-doc');
    expect(r[0].sem).toBeGreaterThan(0);
  });

  it('searchContext returns empty for empty query', async () => {
    const r = await searchContext('  ', { embedder: stubEmbed });
    expect(r).toEqual([]);
  });

  it('searchContext gracefully falls back to lexical when embed fails', async () => {
    await ingestDocument({
      text: 'React component patterns and hooks usage.',
      sourceId: 'react-doc', containerTag: 'global',
    }, { embedder: stubEmbed });
    const failingEmbedder = vi.fn(() => { throw new Error('boom'); });
    const r = await searchContext('react', { embedder: failingEmbedder });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].lex).toBeGreaterThan(0);
    expect(r[0].sem).toBe(0);
  });

  it('searchChunks honors containerTag scoping', async () => {
    await ingestDocument({ text: 'alpha typescript', sourceId: 'a', containerTag: 'project:A' }, { embedder: stubEmbed });
    await ingestDocument({ text: 'beta typescript',  sourceId: 'b', containerTag: 'project:B' }, { embedder: stubEmbed });
    const r = searchChunks({ query: 'typescript', containerTag: 'project:A', includeGlobal: false });
    expect(r).toHaveLength(1);
    expect(r[0].chunk.sourceId).toBe('a');
  });

  it('listDocuments groups chunks by docId', async () => {
    await ingestDocument({ text: 'x '.repeat(2000), sourceId: 'big', containerTag: 'global' }, { embedder: stubEmbed });
    await ingestDocument({ text: 'small', sourceId: 'sm',  containerTag: 'global' }, { embedder: stubEmbed });
    const docs = listDocuments();
    expect(docs).toHaveLength(2);
    expect(docs.find(d => d.sourceId === 'big').chunks).toBeGreaterThan(1);
  });

  it('deleteDocument removes only the matching docId', async () => {
    const a = await ingestDocument({ text: 'aaa', sourceId: 'A', containerTag: 'global' }, { embedder: stubEmbed });
    await ingestDocument({ text: 'bbb', sourceId: 'B', containerTag: 'global' }, { embedder: stubEmbed });
    const r = deleteDocument(a.docId);
    expect(r.removed).toBeGreaterThan(0);
    expect(listDocuments().map(d => d.sourceId)).toEqual(['B']);
  });

  it('returns error on empty text', async () => {
    const r = await ingestDocument({ text: '   ' }, { embedder: stubEmbed });
    expect(r.ok).toBe(false);
  });
});

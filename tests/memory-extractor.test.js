import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs BEFORE importing the modules under test so the in-memory cache
// starts empty and writes don't touch disk.
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  const memFs = { files: new Map() };
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn((p, enc) => {
        if (memFs.files.has(p)) return memFs.files.get(p);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
      writeFileSync: vi.fn((p, data) => { memFs.files.set(p, data); }),
      mkdirSync: vi.fn(),
      existsSync: vi.fn((p) => memFs.files.has(p)),
    },
    readFileSync: vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
  };
});

const { _resetCache, listFacts, projectContainerTag } = await import('../memory-store.js');
const {
  extractFacts, listProposals, approveProposal, rejectProposal,
  getProposalStats, _resetProposalsCache, _internals,
} = await import('../server/lib/memory-extractor.js');

beforeEach(() => {
  _resetCache();
  _resetProposalsCache();
  vi.clearAllMocks();
});

describe('memory-extractor', () => {
  describe('extractFacts()', () => {
    it('returns empty when no aiCaller provided', async () => {
      const r = await extractFacts({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] });
      expect(r.proposals).toHaveLength(0);
    });

    it('returns empty for too-short conversations', async () => {
      const r = await extractFacts({
        messages: [{ role: 'user', content: 'hi' }],
        aiCaller: vi.fn(),
      });
      expect(r.proposals).toHaveLength(0);
    });

    it('auto-approves and persists extracted facts', async () => {
      const aiCaller = vi.fn().mockResolvedValue(JSON.stringify({
        facts: [
          { text: 'user prefers TypeScript', category: 'preference', kind: 'static' },
          { text: 'project uses Postgres', category: 'fact', kind: 'static' },
        ],
      }));
      const r = await extractFacts({
        messages: [
          { role: 'user', content: 'I love TypeScript. We are using Postgres for storage.' },
          { role: 'assistant', content: 'Got it.' },
        ],
        projectId: 'proj-a',
        aiCaller,
        autoApprove: true,
      });
      expect(r.applied).toBe(2);
      expect(r.proposals).toHaveLength(2);
      const facts = listFacts({ containerTag: projectContainerTag('proj-a'), includeGlobal: false });
      expect(facts).toHaveLength(2);
      expect(facts.map(f => f.text)).toContain('user prefers TypeScript');
    });

    it('leaves proposals pending when autoApprove=false', async () => {
      const aiCaller = vi.fn().mockResolvedValue(JSON.stringify({
        facts: [{ text: 'user uses Vim', category: 'preference', kind: 'static' }],
      }));
      const r = await extractFacts({
        messages: [
          { role: 'user', content: 'I switched to Vim.' },
          { role: 'assistant', content: 'Nice.' },
        ],
        projectId: 'proj-b',
        aiCaller,
        autoApprove: false,
      });
      expect(r.applied).toBe(0);
      expect(r.proposals[0].status).toBe('pending');
      const facts = listFacts({ containerTag: projectContainerTag('proj-b'), includeGlobal: false });
      expect(facts).toHaveLength(0);
    });

    it('tolerates markdown code fences in LLM response', async () => {
      const aiCaller = vi.fn().mockResolvedValue('```json\n{"facts":[{"text":"user is on macOS","category":"fact","kind":"static"}]}\n```');
      const r = await extractFacts({
        messages: [
          { role: 'user', content: 'I am on macOS.' },
          { role: 'assistant', content: 'OK.' },
        ],
        projectId: 'proj-c',
        aiCaller,
      });
      expect(r.applied).toBe(1);
    });

    it('caps at 5 facts per extraction', async () => {
      const facts = Array.from({ length: 10 }, (_, i) => ({
        text: `fact number ${i}`, category: 'fact', kind: 'static',
      }));
      const aiCaller = vi.fn().mockResolvedValue(JSON.stringify({ facts }));
      const r = await extractFacts({
        messages: [
          { role: 'user', content: 'tell me 10 things' },
          { role: 'assistant', content: 'here' },
        ],
        projectId: 'proj-d',
        aiCaller,
      });
      expect(r.proposals).toHaveLength(5);
    });

    it('handles malformed LLM output gracefully', async () => {
      const aiCaller = vi.fn().mockResolvedValue('I cannot do that, Dave.');
      const r = await extractFacts({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hi' },
        ],
        projectId: 'proj-e',
        aiCaller,
      });
      expect(r.proposals).toHaveLength(0);
    });

    it('detects contradictions via similarity and links supersedes', async () => {
      // Seed an existing fact.
      const seedCaller = vi.fn().mockResolvedValue(JSON.stringify({
        facts: [{ text: 'user lives in New York City', category: 'fact', kind: 'static' }],
      }));
      await extractFacts({
        messages: [
          { role: 'user', content: 'I live in NYC.' },
          { role: 'assistant', content: 'noted' },
        ],
        projectId: 'proj-f',
        aiCaller: seedCaller,
      });

      // Now extract a contradicting fact with high token overlap.
      const updateCaller = vi.fn().mockResolvedValue(JSON.stringify({
        facts: [{ text: 'user lives in New York City suburbs now', category: 'fact', kind: 'static' }],
      }));
      const r = await extractFacts({
        messages: [
          { role: 'user', content: 'Actually I moved to the suburbs of New York City.' },
          { role: 'assistant', content: 'ok' },
        ],
        projectId: 'proj-f',
        aiCaller: updateCaller,
      });
      expect(r.proposals[0].supersedes).toBeTruthy();
    });
  });

  describe('proposal queue management', () => {
    it('approveProposal applies a pending proposal', async () => {
      const aiCaller = vi.fn().mockResolvedValue(JSON.stringify({
        facts: [{ text: 'approve me', category: 'fact', kind: 'static' }],
      }));
      await extractFacts({
        messages: [
          { role: 'user', content: 'note something' },
          { role: 'assistant', content: 'ok' },
        ],
        projectId: 'proj-g',
        aiCaller,
        autoApprove: false,
      });
      const [p] = listProposals({ status: 'pending', projectId: 'proj-g' });
      expect(p).toBeDefined();
      const r = approveProposal(p.id);
      expect(r.ok).toBe(true);
      expect(r.factId).toBeDefined();
      expect(listProposals({ status: 'approved', projectId: 'proj-g' })).toHaveLength(1);
    });

    it('rejectProposal marks proposal rejected with reason', async () => {
      const aiCaller = vi.fn().mockResolvedValue(JSON.stringify({
        facts: [{ text: 'reject me', category: 'fact', kind: 'static' }],
      }));
      await extractFacts({
        messages: [
          { role: 'user', content: 'note something' },
          { role: 'assistant', content: 'ok' },
        ],
        projectId: 'proj-h',
        aiCaller,
        autoApprove: false,
      });
      const [p] = listProposals({ status: 'pending', projectId: 'proj-h' });
      const r = rejectProposal(p.id, 'not durable');
      expect(r.ok).toBe(true);
      expect(listProposals({ status: 'rejected', projectId: 'proj-h' })).toHaveLength(1);
    });

    it('getProposalStats reports counts', async () => {
      const aiCaller = vi.fn().mockResolvedValue(JSON.stringify({
        facts: [{ text: 'count me', category: 'fact', kind: 'static' }],
      }));
      await extractFacts({
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: 'y' },
        ],
        projectId: 'proj-i',
        aiCaller,
      });
      const stats = getProposalStats();
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.byStatus.approved).toBeGreaterThan(0);
    });
  });

  describe('internals', () => {
    it('jaccard similarity is symmetric and bounded', () => {
      const a = _internals._tokenize('user lives in new york city');
      const b = _internals._tokenize('user lives in new york city');
      expect(_internals._jaccard(a, b)).toBeCloseTo(1, 5);
      expect(_internals._jaccard(a, new Set())).toBe(0);
    });

    it('parses JSON wrapped in surrounding prose', () => {
      const r = _internals._parseExtractionResponse('Sure! Here you go: {"facts":[]} thanks');
      expect(r).toEqual({ facts: [] });
    });
  });
});

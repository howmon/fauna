// ── Tool scorer tests ────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { scoreLexical, scoreEmbedding, pickTopTools } from '../server/lib/tool-scorer.js';

const TOOLS = [
  { name: 'browser_navigate', description: 'Open a URL in the browser and load the page.',
    parameters: { properties: { url: { type: 'string' } } } },
  { name: 'browser_click',    description: 'Click an element on the current page.',
    parameters: { properties: { element: { type: 'string' } } } },
  { name: 'agent_read_file',  description: 'Read a file from disk and return its contents.',
    parameters: { properties: { path: { type: 'string' } } } },
  { name: 'agent_write_file', description: 'Write a string to a file on disk.',
    parameters: { properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'shell_exec',       description: 'Run a shell command and return stdout / stderr.',
    parameters: { properties: { command: { type: 'string' } } } },
  { name: 'figma_execute',    description: 'Execute a JavaScript snippet inside the Figma plugin sandbox.',
    parameters: { properties: { code: { type: 'string' } } } },
];

describe('scoreLexical', () => {
  it('ranks browser tools highest for a browser query', () => {
    const r = scoreLexical('open the browser and navigate to nairaland', TOOLS);
    expect(r[0].tool.name).toBe('browser_navigate');
    expect(r[0].score).toBeGreaterThan(0);
  });

  it('ranks file tools highest for a file query', () => {
    const r = scoreLexical('read the contents of a file from disk', TOOLS);
    expect(r[0].tool.name).toBe('agent_read_file');
  });

  it('returns zero scores when no token overlap', () => {
    const r = scoreLexical('xylophone marimba kettledrum', TOOLS);
    expect(r.every(x => x.score === 0)).toBe(true);
  });

  it('reports which tokens matched', () => {
    const r = scoreLexical('figma plugin sandbox', TOOLS);
    const top = r[0];
    expect(top.tool.name).toBe('figma_execute');
    expect(top.matches.length).toBeGreaterThan(0);
  });

  it('tolerates empty input gracefully', () => {
    expect(scoreLexical('', TOOLS)).toHaveLength(TOOLS.length);
    expect(scoreLexical('anything', [])).toEqual([]);
  });
});

describe('pickTopTools', () => {
  it('returns top-K ordered by relevance', async () => {
    const picked = await pickTopTools('click a button in the page', TOOLS, { topK: 2 });
    expect(picked).toHaveLength(2);
    expect(picked.map(t => t.name)).toContain('browser_click');
  });

  it('honours mustKeep regardless of score', async () => {
    const picked = await pickTopTools('run a shell command', TOOLS, {
      topK: 2,
      mustKeep: ['agent_read_file'],
    });
    expect(picked.map(t => t.name)).toContain('agent_read_file');
    expect(picked.map(t => t.name)).toContain('shell_exec');
  });

  it('returns first-K when query is empty', async () => {
    const picked = await pickTopTools('', TOOLS, { topK: 3 });
    expect(picked).toHaveLength(3);
  });
});

describe('scoreEmbedding', () => {
  it('blends semantic + lexical, with caching', async () => {
    // Fake embedder: returns one-hot-ish vectors over tool name initials.
    const calls = [];
    const embed = async (texts) => {
      calls.push(texts.length);
      return texts.map(t => {
        // 26-dim vector: bumps for each letter present.
        const v = new Array(26).fill(0);
        for (const c of t.toLowerCase()) {
          const i = c.charCodeAt(0) - 97;
          if (i >= 0 && i < 26) v[i] += 1;
        }
        return v;
      });
    };
    const cache = new Map();
    const r1 = await scoreEmbedding('navigate to a webpage', TOOLS, { embed, cache });
    expect(r1[0].tool.name).toBe('browser_navigate');
    expect(r1[0].semantic).toBeGreaterThan(0);

    // Second call should hit the cache for all tools, only re-embed the query.
    const before = calls.length;
    await scoreEmbedding('open the browser', TOOLS, { embed, cache });
    const lastBatchSize = calls[calls.length - 1];
    expect(lastBatchSize).toBe(1); // query only
    expect(calls.length).toBe(before + 1);
  });

  it('throws if embed() returns wrong vector count', async () => {
    const embed = async () => [[1, 2, 3]]; // too short
    await expect(scoreEmbedding('q', TOOLS, { embed })).rejects.toThrow(/embed\(\) must return/);
  });
});

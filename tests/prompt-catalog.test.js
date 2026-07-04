import { describe, it, expect } from 'vitest';
import {
  SCORE_WEIGHTS,
  CANDIDATES,
  scoreCandidate,
  dedupe,
  selectBest,
} from '../lib/prompt-catalog.js';

describe('prompt-catalog scoring', () => {
  it('score weights sum to 1', () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(+sum.toFixed(6)).toBe(1);
  });

  it('scores are normalised to [0,1]', () => {
    for (const c of CANDIDATES) {
      const w = scoreCandidate(c);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('a max-scored candidate beats a min-scored one', () => {
    const hi = scoreCandidate({ scores: { impact: 5, faunaFit: 5, uniqueness: 5, prevalence: 5 } });
    const lo = scoreCandidate({ scores: { impact: 0, faunaFit: 0, uniqueness: 0, prevalence: 0 } });
    expect(hi).toBe(1);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(lo);
  });

  it('missing sub-scores count as zero, not NaN', () => {
    expect(scoreCandidate({})).toBe(0);
    expect(Number.isNaN(scoreCandidate({ scores: {} }))).toBe(false);
  });
});

describe('prompt-catalog dedupe', () => {
  it('merges near-duplicate candidates and unions their sources', () => {
    const a = {
      id: 'a', kind: 'behavior', name: 'Batch independent tool calls in parallel',
      behavior: 'Issue independent tool calls in parallel in a single turn.',
      sources: ['x'], scores: { impact: 4, faunaFit: 4, uniqueness: 4, prevalence: 5 },
    };
    const b = {
      id: 'b', kind: 'behavior', name: 'Parallel independent tool calls single turn',
      behavior: 'Issue independent tool calls in parallel in a single turn.',
      sources: ['y'], scores: { impact: 2, faunaFit: 2, uniqueness: 2, prevalence: 2 },
    };
    const out = dedupe([a, b], { threshold: 0.5 });
    expect(out.length).toBe(1);
    // Higher-weighted survivor is kept…
    expect(out[0].id).toBe('a');
    // …and the merged-away entry's provenance is preserved.
    expect(out[0].sources).toEqual(expect.arrayContaining(['x', 'y']));
  });

  it('does not merge candidates of different kinds', () => {
    const t = {
      id: 't', kind: 'tool', name: 'context snip pruning',
      behavior: 'prune resolved history under context pressure', sources: [], scores: {},
    };
    const s = {
      id: 's', kind: 'skill', name: 'context snip pruning',
      behavior: 'prune resolved history under context pressure', sources: [], scores: {},
    };
    expect(dedupe([t, s], { threshold: 0.5 }).length).toBe(2);
  });

  it('leaves distinct catalog entries intact', () => {
    // The real catalog has no accidental near-duplicates.
    expect(dedupe(CANDIDATES).length).toBe(CANDIDATES.length);
  });
});

describe('prompt-catalog selectBest', () => {
  it('returns entries sorted by weight descending', () => {
    const best = selectBest();
    for (let i = 1; i < best.length; i++) {
      expect(best[i - 1].weight).toBeGreaterThanOrEqual(best[i].weight);
    }
  });

  it('flags redundant (already-shipped) entries', () => {
    const best = selectBest();
    const progressive = best.find((c) => c.id === 'progressive-skill-load');
    expect(progressive.redundant).toBe(true);
    const subagent = best.find((c) => c.id === 'subagent-dispatch');
    expect(subagent.redundant).toBe(false);
  });

  it('onlyGaps drops entries Fauna already ships', () => {
    const gaps = selectBest(CANDIDATES, { onlyGaps: true });
    expect(gaps.every((c) => !c.redundant)).toBe(true);
    expect(gaps.find((c) => c.id === 'todo-tracker')).toBeUndefined();
    expect(gaps.find((c) => c.id === 'subagent-dispatch')).toBeDefined();
  });

  it('the top gap is the highest-leverage non-redundant pattern', () => {
    const [top] = selectBest(CANDIDATES, { onlyGaps: true });
    // sub-agent dispatch scores 5/4/5/5 — the strongest real gap.
    expect(top.id).toBe('subagent-dispatch');
  });

  it('minWeight filters low-value entries', () => {
    const strong = selectBest(CANDIDATES, { minWeight: 0.7 });
    expect(strong.length).toBeGreaterThan(0);
    expect(strong.every((c) => c.weight >= 0.7)).toBe(true);
  });

  it('limit caps the result count', () => {
    expect(selectBest(CANDIDATES, { limit: 3 }).length).toBe(3);
  });
});

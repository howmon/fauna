import { describe, it, expect } from 'vitest';
import {
  parseVerdict,
  runGate,
  buildSemanticPrompt,
  makeMechanicalStage,
  makeSemanticStage,
  makeConsensusStage,
} from '../lib/evaluate-gate.js';

describe('parseVerdict', () => {
  it('parses a JSON verdict', () => {
    const v = parseVerdict('Here is my call: {"pass": true, "reason": "all criteria met", "evidence": ["test x passed"]}');
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('all criteria met');
    expect(v.evidence).toEqual(['test x passed']);
  });

  it('parses a JSON fail verdict', () => {
    const v = parseVerdict('{"pass": false, "reason": "criterion 2 unmet"}');
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('criterion 2 unmet');
  });

  it('parses a plain PASS keyword', () => {
    expect(parseVerdict('PASS — everything looks good').ok).toBe(true);
  });

  it('parses a plain FAIL keyword', () => {
    expect(parseVerdict('FAIL: missing tests').ok).toBe(false);
  });

  it('fails closed on unparseable text', () => {
    expect(parseVerdict('hmm, maybe?').ok).toBe(false);
  });

  it('fails closed on empty text', () => {
    expect(parseVerdict('').ok).toBe(false);
  });

  it('treats FAIL as dominant when both keywords appear', () => {
    expect(parseVerdict('it does not PASS, this is a FAIL').ok).toBe(false);
  });
});

describe('runGate — ordering & short-circuit', () => {
  it('passes when all stages pass', async () => {
    const r = await runGate({
      mechanical: async () => ({ ok: true }),
      semantic: async () => ({ ok: true }),
    });
    expect(r.ok).toBe(true);
    expect(r.stages.map((s) => s.stage)).toEqual(['mechanical', 'semantic']);
  });

  it('short-circuits at mechanical and never runs semantic', async () => {
    let semanticRan = false;
    const r = await runGate({
      mechanical: async () => ({ ok: false, reason: 'tests failed' }),
      semantic: async () => { semanticRan = true; return { ok: true }; },
    });
    expect(r.ok).toBe(false);
    expect(r.failedStage).toBe('mechanical');
    expect(semanticRan).toBe(false);
  });

  it('runs consensus only when enabled', async () => {
    let consensusRan = false;
    const stages = {
      mechanical: async () => ({ ok: true }),
      semantic: async () => ({ ok: true }),
      consensus: async () => { consensusRan = true; return { ok: true }; },
    };
    await runGate(stages, { consensus: false });
    expect(consensusRan).toBe(false);
    await runGate(stages, { consensus: true });
    expect(consensusRan).toBe(true);
  });

  it('fails closed when a stage throws', async () => {
    const r = await runGate({ mechanical: async () => { throw new Error('boom'); } });
    expect(r.ok).toBe(false);
    expect(r.failedStage).toBe('mechanical');
    expect(r.stages[0].reason).toMatch(/boom/);
  });

  it('returns ok with a note when no stages are configured', async () => {
    const r = await runGate({});
    expect(r.ok).toBe(true);
    expect(r.stages).toEqual([]);
  });
});

describe('makeMechanicalStage', () => {
  it('treats a skipped verifier as a pass', async () => {
    const stage = makeMechanicalStage(async () => ({ ok: true, skipped: true }));
    expect((await stage()).ok).toBe(true);
  });
  it('maps a failing verifier to a fail with output evidence', async () => {
    const stage = makeMechanicalStage(async () => ({ ok: false, output: 'Error: 1 test failed' }));
    const v = await stage();
    expect(v.ok).toBe(false);
    expect(v.evidence[0]).toMatch(/test failed/);
  });
});

describe('makeSemanticStage', () => {
  it('routes the model reply through parseVerdict', async () => {
    const stage = makeSemanticStage({
      complete: async () => '{"pass": false, "reason": "criterion unmet"}',
      goal: 'add feature',
      acceptanceCriteria: ['does X'],
      diff: 'some diff',
    });
    const v = await stage();
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('criterion unmet');
  });
});

describe('makeConsensusStage', () => {
  const base = { goal: 'g', acceptanceCriteria: ['x'], diff: 'd' };

  it('passes when the quorum agrees', async () => {
    const stage = makeConsensusStage({
      ...base,
      models: ['m1', 'm2', 'm3'],
      complete: async () => 'PASS',
    });
    const v = await stage();
    expect(v.ok).toBe(true);
  });

  it('fails when a dissenter breaks a full-agreement threshold', async () => {
    const stage = makeConsensusStage({
      ...base,
      models: ['m1', 'm2'],
      threshold: 1,
      complete: async ({ model }) => (model === 'm2' ? 'FAIL: nope' : 'PASS'),
    });
    const v = await stage();
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/1\/2/);
  });

  it('counts an erroring model as a fail vote', async () => {
    const stage = makeConsensusStage({
      ...base,
      models: ['m1', 'm2'],
      threshold: 1,
      complete: async ({ model }) => { if (model === 'm2') throw new Error('timeout'); return 'PASS'; },
    });
    expect((await stage()).ok).toBe(false);
  });

  it('honours a fractional threshold', async () => {
    const stage = makeConsensusStage({
      ...base,
      models: ['m1', 'm2', 'm3'],
      threshold: 0.5, // need ceil(1.5) = 2
      complete: async ({ model }) => (model === 'm3' ? 'FAIL' : 'PASS'),
    });
    expect((await stage()).ok).toBe(true);
  });
});

describe('buildSemanticPrompt', () => {
  it('includes acceptance criteria and diff', () => {
    const p = buildSemanticPrompt({ goal: 'G', acceptanceCriteria: ['a', 'b'], diff: 'DIFF' });
    expect(p).toMatch(/ACCEPTANCE CRITERIA/);
    expect(p).toMatch(/1\. a/);
    expect(p).toMatch(/DIFF/);
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadEngineeringFlow,
  recommendPhaseBoundary,
  routeEngineeringFlow,
  validateEngineeringFlow,
} from '../lib/engineering-flow.js';

const graph = loadEngineeringFlow();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const availableSkills = fs.readdirSync(path.join(repoRoot, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repoRoot, 'skills', entry.name, 'SKILL.md')))
  .map((entry) => entry.name);

describe('engineering flow validation', () => {
  it('accepts the bundled graph and its installed skill references', () => {
    const result = validateEngineeringFlow(graph, {
      availableSkills,
    });
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('rejects missing phase references', () => {
    const invalid = structuredClone(graph);
    invalid.flows[0].phases[0].next = 'missing';
    expect(validateEngineeringFlow(invalid).errors.join(' ')).toMatch(/missing phase/i);
  });

  it('rejects phase cycles', () => {
    const invalid = structuredClone(graph);
    invalid.flows[0].phases.at(-1).next = invalid.flows[0].entryPhase;
    expect(validateEngineeringFlow(invalid).errors.join(' ')).toMatch(/cycle/i);
  });
});

describe('engineering flow routing', () => {
  const cases = [
    ['The requirements for this new feature are ambiguous', 'feature-delivery', 'clarify', 'spec-driven-development'],
    ['The production app crashes intermittently with a regression', 'bug-recovery', 'diagnose', 'diagnosing-bugs'],
    ['Triage the queue of incoming bug reports and feature requests', 'incoming-work', 'qualify', 'spec-driven-development'],
  ];

  for (const [situation, flow, phase, skill] of cases) {
    it(`routes ${flow}`, () => {
      const result = routeEngineeringFlow(situation, graph);
      expect(result.ok).toBe(true);
      expect(result.flow.id).toBe(flow);
      expect(result.phase.id).toBe(phase);
      expect(result.phase.skills).toContain(skill);
      expect(result.reason).toBeTruthy();
    });
  }

  it('asks a discriminating question for a tied or empty situation', () => {
    const result = routeEngineeringFlow('Please help me with engineering work', graph);
    expect(result.confidence).toBe(0);
    expect(result.clarify).toMatch(/feature work|failure|incoming/i);
  });

  it('resolves a named phase and returns the next transition', () => {
    const result = routeEngineeringFlow({ flow: 'feature-delivery', phase: 'implement' }, graph);
    expect(result.phase.skills).toEqual(['incremental-implementation', 'test-driven-development']);
    expect(result.nextPhase).toEqual({ id: 'review', label: 'Review against standards and intent' });
  });
});

describe('phase-boundary assistance', () => {
  const recommend = (overrides = {}) => recommendPhaseBoundary({
    flow: 'feature-delivery',
    phase: 'clarify',
    taskState: 'phase-complete',
    contextBudget: { usedTokens: 20_000, bodyTokenLimit: 100_000 },
    ...overrides,
  }, graph);

  it('continues when the next phase needs current context and budget remains', () => {
    expect(recommend()).toMatchObject({ ok: true, action: 'continue', triggered: true });
  });

  it('clears for a self-contained fresh ticket or irrelevant context', () => {
    expect(recommend({ destination: 'new-ticket' }).action).toBe('clear');
    expect(recommend({ nextNeedsCurrentContext: false }).action).toBe('clear');
  });

  it('creates a handoff across ownership boundaries or when blocked', () => {
    expect(recommend({ destination: 'new-owner' })).toMatchObject({ action: 'handoff' });
    expect(recommend({ taskState: 'blocked' })).toMatchObject({
      action: 'handoff',
      handoffRequires: expect.arrayContaining(['blocking decision', 'attempted evidence']),
    });
  });

  it('uses a subagent only for a tightly scoped unattended side task', () => {
    expect(recommend({ taskState: 'active', destination: 'side-task', unattended: true }).action).toBe('subagent');
    expect(recommend({ taskState: 'active', destination: 'side-task', unattended: false }).action).toBe('continue');
  });

  it('compacts relevant context near the model-specific threshold', () => {
    expect(recommend({
      taskState: 'active',
      contextBudget: { usedTokens: 90_000, bodyTokenLimit: 100_000 },
    })).toMatchObject({ action: 'compact', contextPressure: { approachingLimit: true, ratio: 0.9 } });
  });

  it('stays silent during ordinary in-phase work', () => {
    expect(recommend({ taskState: 'active' })).toMatchObject({ action: 'none', triggered: false });
  });

  it('attaches a recommendation to a routed phase when boundary state is supplied', () => {
    const result = routeEngineeringFlow({
      flow: 'feature-delivery',
      phase: 'clarify',
      boundary: {
        taskState: 'phase-complete',
        contextBudget: { usedTokens: 20_000, bodyTokenLimit: 100_000 },
      },
    }, graph);
    expect(result.contextRecommendation).toMatchObject({ action: 'continue', nextPhase: 'implement' });
  });
});
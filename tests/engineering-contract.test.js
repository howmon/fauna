import { describe, expect, it } from 'vitest';
import { buildEngineeringContract } from '../lib/engineering-contract.js';

function profile() {
  return {
    projectName: 'Acme',
    tracker: {
      name: 'Any Tracker',
      url: 'https://tracker.example/acme',
      operations: { search: 'Search before creating', create: 'Create one issue', update: 'Update fields', comment: 'Add evidence', close: 'Close after verification' },
    },
    triageRoles: [{ role: 'confirmed-bug', when: 'Behavior contradicts the contract', trackerValue: 'type:bug' }],
    domain: { summary: 'Acme processes orders.', terms: [{ term: 'Order', meaning: 'A confirmed purchase request' }] },
    context: {
      overview: 'A service for processing orders.',
      entryPoints: [{ path: 'server.js', purpose: 'HTTP entry point' }],
      commands: [{ purpose: 'Focused tests', command: 'npm test' }],
      boundaries: ['Do not access payment credentials outside the payment adapter.'],
    },
  };
}

describe('buildEngineeringContract', () => {
  it('generates the portable contract file set', () => {
    const result = buildEngineeringContract(profile());
    expect(result.ok).toBe(true);
    expect(result.files.map(file => file.path)).toEqual([
      'CONTEXT.md',
      'docs/agents/issue-tracker.md',
      'docs/agents/triage-labels.md',
      'docs/agents/domain.md',
      'docs/adr/README.md',
    ]);
    expect(result.files.find(file => file.path === 'docs/agents/issue-tracker.md').content).toContain('| search | Search before creating |');
  });

  it('requires provider-neutral tracker operations and durable context', () => {
    const input = profile();
    input.tracker.operations.close = '';
    input.context.boundaries = [];
    const result = buildEngineeringContract(input);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('tracker.operations.close is required');
    expect(result.errors).toContain('context.boundaries must contain at least one boundary');
  });
});

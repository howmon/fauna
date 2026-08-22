import { describe, expect, it } from 'vitest';
import { validateTicketPlan } from '../lib/ticket-plan.js';

function ticket(key, blockedBy = []) {
  return {
    key,
    title: `Implement ${key}`,
    acceptanceCriteria: [`${key} works`],
    verifyCommand: `npm test -- ${key}`,
    blockedBy,
  };
}

describe('validateTicketPlan', () => {
  it('orders dependencies first and exposes the ready frontier', () => {
    const result = validateTicketPlan({ tickets: [{ ...ticket('ui', ['api']), fileScope: ['public/ui'] }, ticket('api')] });
    expect(result.ok).toBe(true);
    expect(result.tickets.map(item => item.key)).toEqual(['api', 'ui']);
    expect(result.readyFrontier).toEqual(['api']);
    expect(result.tickets.find(item => item.key === 'ui').fileScope).toEqual(['public/ui']);
  });

  it('accepts completed existing blockers as ready', () => {
    const result = validateTicketPlan({
      tickets: [ticket('ui', ['bk-1'])],
      existingItems: [{ id: 'bk-1', column: 'done', blockedBy: [] }],
    });
    expect(result.ok).toBe(true);
    expect(result.readyFrontier).toEqual(['ui']);
  });

  it('rejects tickets without independent verification data', () => {
    const result = validateTicketPlan({ tickets: [{ key: 'api', title: 'API' }] });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('api requires acceptance criteria');
    expect(result.errors).toContain('api requires a verification command');
  });

  it('rejects unknown blockers', () => {
    const result = validateTicketPlan({ tickets: [ticket('ui', ['missing'])] });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('ui references unknown blocker "missing"');
  });

  it('rejects cycles with the cycle path', () => {
    const result = validateTicketPlan({ tickets: [ticket('api', ['ui']), ticket('ui', ['api'])] });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('dependency cycle: api -> ui -> api');
  });
});

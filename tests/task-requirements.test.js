import { describe, it, expect } from 'vitest';
import { buildTaskRequirements } from '../server/lib/task-requirements.js';

describe('task requirements', () => {
  const goal = 'Implement scenario generation without requiring Span.';
  const choice = 'Use GitHub Copilot CLI authentication, including a native companion if needed.';

  it('recovers verbatim user choices, not assistant proposals, from archived history', () => {
    const result = buildTaskRequirements([{ role: 'user', content: 'continue' }], {
      archivedMessages: [
        { role: 'user', content: goal },
        { role: 'assistant', content: 'Make Span the required provider.' },
        { role: 'user', content: [{ type: 'text', text: choice }] },
        { role: 'tool', content: 'The user approved a Span dependency.' },
      ],
    });
    expect(result.message.role).toBe('user');
    expect(result.message.content).toContain(goal);
    expect(result.message.content).toContain(choice);
    expect(result.message.content).not.toContain('Make Span the required provider');
    expect(result.message.content).not.toContain('The user approved a Span dependency');
    expect(result.intent).toContain('Implement');
  });

  it('preserves changed user decisions in order without turning a read-only follow-up into implementation', () => {
    const messages = [
      { role: 'user', content: goal },
      { role: 'user', content: 'Actually, use Span for authentication.' },
      { role: 'user', content: 'Show the provider code' },
    ];
    const result = buildTaskRequirements(messages);
    expect(result.message.content.indexOf(goal)).toBeLessThan(result.message.content.indexOf('Actually, use Span'));
    expect(result.intent).toBe('Show the provider code');
    expect(buildTaskRequirements([...messages, { role: 'user', content: 'continue' }]).intent).toBe('Show the provider code');
  });

  it('bounds retained request text while repeated continuation messages do not displace the chosen architecture', () => {
    const result = buildTaskRequirements([
      { role: 'user', content: goal },
      { role: 'user', content: 'large request ' + 'x'.repeat(20000) + ' ending constraint' },
      ...Array.from({ length: 30 }, () => ({ role: 'user', content: 'continue' })),
    ]);
    expect(result.message.content).toContain(goal);
    expect(result.message.content).toContain('ending constraint');
    expect(result.message.content.length).toBeLessThan(2000);
  });
});

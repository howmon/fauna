// Tests for server/prompts/context-gating.js — focused on the backlog cluster
// trigger regex (the "AI didn't see fauna_feature_request_create when I said
// 'add to taskboard'" class of bug).

import { describe, it, expect } from 'vitest';

const { computeToolFlags } = await import('../server/prompts/context-gating.js');

function withUserText(text) {
  return computeToolFlags({
    messages: [{ role: 'user', content: text }],
    systemPrompt: '',
    isDelegation: false,
    isCLI: false,
    noTools: false,
  });
}

describe('computeToolFlags — backlog cluster', () => {
  it('triggers on "taskboard" (compound word)', () => {
    expect(withUserText('add this to the taskboard').backlog).toBe(true);
  });

  it('triggers on "task board" (two words)', () => {
    expect(withUserText('please add to task board').backlog).toBe(true);
  });

  it('triggers on "task-board" (hyphenated)', () => {
    expect(withUserText('drop this on the task-board').backlog).toBe(true);
  });

  it('triggers on "kanban"', () => {
    expect(withUserText('show me the kanban').backlog).toBe(true);
  });

  it('triggers on "backlog"', () => {
    expect(withUserText('add to backlog').backlog).toBe(true);
  });

  it('triggers on "what should i do next"', () => {
    expect(withUserText('what should I do next?').backlog).toBe(true);
  });

  it('does NOT trigger on unrelated chat', () => {
    expect(withUserText('what is the weather in tokyo').backlog).toBeUndefined();
  });

  it('triggers on "add to the board"', () => {
    expect(withUserText('add this to the board').backlog).toBe(true);
  });
});

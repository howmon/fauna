import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('chat plan continuation UI contract', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'public/js/chat.js'), 'utf8');

  it('inherits the latest persisted plan for chained streams', () => {
    expect(source).toContain('var _isChainContinuation = !!conv._chainMode;');
    expect(source).toContain("message.role === 'assistant' && message.plan && Array.isArray(message.plan.items)");
    expect(source).toContain('var _currentPlan = _latestPlannedMessage ? _latestPlannedMessage.plan : null;');
  });

  it('surfaces depth exhaustion while preserving the incomplete plan', () => {
    expect(source).toContain('var _planStillIncompleteAtLimit');
    expect(source).toContain('the automatic continuation limit was reached while the plan still has incomplete steps');
    expect(source).toContain('conv._depthLimitNotified = true;');
  });
});
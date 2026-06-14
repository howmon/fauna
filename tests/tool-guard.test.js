// Tests for tool-guard.js — the pre-tool-call gate. Focused on the
// free-tool exemption introduced to stop board bookkeeping calls from
// eating into the same budget as real engineering work.

import { describe, it, expect } from 'vitest';
import { ToolGuardContext, isFreeTool, getToolCategory } from '../tool-guard.js';

describe('isFreeTool', () => {
  it('marks kanban bookkeeping tools as free', () => {
    expect(isFreeTool('fauna_workitem_move')).toBe(true);
    expect(isFreeTool('fauna_workitem_claim')).toBe(true);
    expect(isFreeTool('fauna_workitem_comment')).toBe(true);
    expect(isFreeTool('fauna_workitem_update')).toBe(true);
    expect(isFreeTool('fauna_workitem_verify')).toBe(true);
    expect(isFreeTool('fauna_board_scan')).toBe(true);
    expect(isFreeTool('fauna_project_audit')).toBe(true);
    expect(isFreeTool('fauna_list_projects')).toBe(true);
  });

  it('does NOT mark real engineering tools as free', () => {
    expect(isFreeTool('shell_exec')).toBe(false);
    expect(isFreeTool('bash')).toBe(false);
    expect(isFreeTool('agent_write_file')).toBe(false);
    expect(isFreeTool('browser_click')).toBe(false);
    expect(isFreeTool('figma_execute')).toBe(false);
    expect(isFreeTool('some_random_tool')).toBe(false);
  });
});

describe('ToolGuardContext.check — free tools', () => {
  it('allows kanban tools without consuming any cap budget', async () => {
    const g = new ToolGuardContext();
    for (let i = 0; i < 200; i++) {
      const r = await g.check('fauna_workitem_move', { itemId: 'c' + i, column: 'in_progress' });
      expect(r.action).toBe('allow');
    }
    // Counters never moved.
    expect(g.totalCount).toBe(0);
    expect(g.categoryCounts.other).toBe(0);
  });

  it('still enforces total limit for non-free tools', async () => {
    const g = new ToolGuardContext({ limits: { total: 3, other: 10 } });
    expect((await g.check('fauna_get_skill', { name: 'x' })).action).toBe('allow'); // free
    expect((await g.check('something_real', {})).action).toBe('allow');
    expect((await g.check('something_real', {})).action).toBe('allow');
    expect((await g.check('something_real', {})).action).toBe('allow');
    const denied = await g.check('something_real', {});
    expect(denied.action).toBe('deny');
    expect(denied.reason).toMatch(/Tool call limit reached/);
  });

  it('a long shell-heavy run can still post the closing comment + move', async () => {
    // Simulate the bug from the user report: 30 "other" calls (the
    // non-autonomous cap), then a workitem_comment + workitem_move at
    // the end. Without the free-tool exemption the move would be denied.
    const g = new ToolGuardContext(); // non-autonomous = other:30, total:40
    for (let i = 0; i < 30; i++) {
      const r = await g.check('something_real', {});
      expect(r.action).toBe('allow');
    }
    // Now bookkeeping — should still succeed.
    expect((await g.check('fauna_workitem_comment', { body: 'done' })).action).toBe('allow');
    expect((await g.check('fauna_workitem_move', { column: 'done' })).action).toBe('allow');
    expect((await g.check('fauna_workitem_verify', {})).action).toBe('allow');
  });
});

describe('getToolCategory unchanged', () => {
  it('still classifies known tools correctly', () => {
    expect(getToolCategory('shell_exec')).toBe('shell');
    expect(getToolCategory('agent_write_file')).toBe('file');
    expect(getToolCategory('browser_click')).toBe('browser');
    expect(getToolCategory('figma_execute')).toBe('figma');
    expect(getToolCategory('mystery_tool')).toBe('other');
  });
});

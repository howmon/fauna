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

  it('marks read-only research + introspection tools as free', () => {
    expect(isFreeTool('fauna_grep')).toBe(true);
    expect(isFreeTool('fauna_file_search')).toBe(true);
    expect(isFreeTool('fauna_semantic_search')).toBe(true);
    expect(isFreeTool('fauna_context_search')).toBe(true);
    expect(isFreeTool('fauna_read_file')).toBe(true);
    expect(isFreeTool('fauna_list_windows')).toBe(true);
    expect(isFreeTool('fauna_screen_context')).toBe(true);
    expect(isFreeTool('figma_status')).toBe(true);
    expect(isFreeTool('figma_get_selection')).toBe(true);
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

  it('no longer enforces a numeric total cap (autonomy by design)', async () => {
    // The chat loop's narration-repetition guard + tool-call dedup are the
    // real loop guards. A numeric ceiling here just punished legitimate
    // multi-file refactors. Free tools stay free; non-free tools now run
    // unbounded for the lifetime of the turn.
    const g = new ToolGuardContext({ limits: { total: 3, other: 10 } });
    expect((await g.check('fauna_get_skill', { name: 'x' })).action).toBe('allow'); // free
    for (let i = 0; i < 200; i++) {
      const r = await g.check('something_real', {});
      expect(r.action).toBe('allow');
    }
    // Counter still ticks for telemetry, but no deny.
    expect(g.totalCount).toBeGreaterThan(g.totalLimit);
  });

  it('a long shell-heavy run can still post the closing comment + move', async () => {
    // Simulate the bug from the user report: 30 "other" calls (well under
    // the bumped non-autonomous cap of 60), then a workitem_comment +
    // workitem_move at the end. Without the free-tool exemption the move
    // would be denied.
    const g = new ToolGuardContext(); // non-autonomous = other:60, total:80
    for (let i = 0; i < 30; i++) {
      const r = await g.check('something_real', {});
      expect(r.action).toBe('allow');
    }
    // Now bookkeeping — should still succeed.
    expect((await g.check('fauna_workitem_comment', { body: 'done' })).action).toBe('allow');
    expect((await g.check('fauna_workitem_move', { column: 'done' })).action).toBe('allow');
    expect((await g.check('fauna_workitem_verify', {})).action).toBe('allow');
  });

  it('read-only research tools (grep / file_search / semantic_search) are free', async () => {
    // Regression: previously these were "other" and ate the 30-cap, so a
    // long engineering turn would burn its budget on research and then get
    // denied when it tried to write files.
    const g = new ToolGuardContext();
    for (let i = 0; i < 100; i++) {
      expect((await g.check('fauna_grep', { q: 'foo' })).action).toBe('allow');
      expect((await g.check('fauna_file_search', { q: '*.js' })).action).toBe('allow');
      expect((await g.check('fauna_semantic_search', { q: 'bar' })).action).toBe('allow');
      expect((await g.check('fauna_read_file', { path: 'x' })).action).toBe('allow');
    }
    expect(g.totalCount).toBe(0);
  });

  it('figma read-only introspection does not eat the figma cap', async () => {
    const g = new ToolGuardContext();
    for (let i = 0; i < 50; i++) {
      expect((await g.check('figma_status', {})).action).toBe('allow');
      expect((await g.check('figma_get_selection', {})).action).toBe('allow');
      expect((await g.check('figma_search_components', { q: 'a' })).action).toBe('allow');
    }
    expect(g.categoryCounts.figma).toBe(0);
    // figma_execute (actually mutates) still counts
    expect((await g.check('figma_execute', { code: 'x' })).action).toBe('allow');
    expect(g.categoryCounts.figma).toBe(1);
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
  it('classifies native fauna/agent shell tools as shell (regression)', () => {
    // These are the actual function names the model sees. Before this fix
    // they fell into 'other' because SHELL_TOOLS only listed generic names.
    expect(getToolCategory('fauna_shell_exec')).toBe('shell');
    expect(getToolCategory('agent_shell_exec')).toBe('shell');
  });
});

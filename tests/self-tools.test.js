import { describe, it, expect, vi } from 'vitest';
import { executeSelfTool, isSelfTool, SELF_TOOL_DEFS } from '../self-tools.js';

// Mock memory-store
vi.mock('../memory-store.js', () => ({
  remember: vi.fn(() => ({ ok: true, id: 'mock-id' })),
  recall: vi.fn(() => [{ id: '1', text: 'recalled fact', category: 'fact' }]),
  forget: vi.fn(() => ({ ok: true })),
}));

// Mock project-manager
vi.mock('../project-manager.js', () => ({
  createProject: vi.fn(() => ({ id: 'proj-1', name: 'Test Project' })),
  getProjectList: vi.fn(() => [{ id: 'proj-1', name: 'Test Project' }]),
}));

describe('self-tools', () => {
  const mockContext = {
    getModels: () => [{ id: 'gpt-4.1', name: 'GPT-4.1' }],
    getSettings: () => ({ model: 'gpt-4.1', thinkingBudget: 'medium' }),
    sendToRenderer: vi.fn(),
    sendNotification: vi.fn(),
  };

  describe('isSelfTool()', () => {
    it('recognizes valid self-tool names', () => {
      expect(isSelfTool('fauna_remember')).toBe(true);
      expect(isSelfTool('fauna_recall')).toBe(true);
      expect(isSelfTool('fauna_forget')).toBe(true);
      expect(isSelfTool('fauna_list_models')).toBe(true);
      expect(isSelfTool('fauna_switch_model')).toBe(true);
      expect(isSelfTool('fauna_send_notification')).toBe(true);
    });

    it('rejects non-self-tool names', () => {
      expect(isSelfTool('unknown_tool')).toBe(false);
      expect(isSelfTool('shell_exec')).toBe(false);
      expect(isSelfTool('')).toBe(false);
    });
  });

  describe('SELF_TOOL_DEFS', () => {
    it('exports the expected number of tool definitions', () => {
      // Bumped from 17 → 22 after adding fauna_shell_exec, fauna_read_file,
      // fauna_replace_string, fauna_apply_patch, fauna_browser (Codex-style
      // native tool migration, Phases 2–4). Bumped to 24 after adding
      // fauna_list_windows and fauna_arrange_windows.
      expect(SELF_TOOL_DEFS).toHaveLength(24);
    });

    it('each tool has required OpenAI function format', () => {
      SELF_TOOL_DEFS.forEach((def) => {
        expect(def.type).toBe('function');
        expect(def.function.name).toBeDefined();
        expect(def.function.description).toBeDefined();
      });
    });
  });

  describe('executeSelfTool()', () => {
    it('fauna_remember stores a fact', () => {
      const result = JSON.parse(executeSelfTool('fauna_remember', { text: 'Test fact' }, mockContext));
      expect(result.ok).toBe(true);
    });

    it('fauna_recall returns facts', () => {
      const result = JSON.parse(executeSelfTool('fauna_recall', { keywords: 'test' }, mockContext));
      expect(Array.isArray(result)).toBe(true);
    });

    it('fauna_forget removes a fact', () => {
      const result = JSON.parse(executeSelfTool('fauna_forget', { id: 'mock-id' }, mockContext));
      expect(result.ok).toBe(true);
    });

    it('fauna_list_models returns models from context', () => {
      const result = JSON.parse(executeSelfTool('fauna_list_models', {}, mockContext));
      expect(Array.isArray(result)).toBe(true);
      expect(result[0].id).toBe('gpt-4.1');
    });

    it('fauna_switch_model sends event to renderer', () => {
      const result = JSON.parse(executeSelfTool('fauna_switch_model', { model: 'gpt-4.1' }, mockContext));
      expect(result.ok).toBe(true);
      expect(mockContext.sendToRenderer).toHaveBeenCalled();
    });

    it('fauna_get_settings returns settings', () => {
      const result = JSON.parse(executeSelfTool('fauna_get_settings', {}, mockContext));
      expect(result.model).toBe('gpt-4.1');
    });

    it('fauna_send_notification calls notifier', () => {
      const result = JSON.parse(executeSelfTool('fauna_send_notification', { title: 'Test', body: 'Hello' }, mockContext));
      expect(result.ok).toBe(true);
      expect(mockContext.sendNotification).toHaveBeenCalledWith('Test', 'Hello');
    });

    it('returns error for unknown tool', () => {
      const result = JSON.parse(executeSelfTool('unknown_tool', {}, mockContext));
      expect(result.error).toBeDefined();
    });
  });

  describe('Codex-style native tools', () => {
    it('registers all 5 new native tools', () => {
      const names = SELF_TOOL_DEFS.map((d) => d.function.name);
      ['fauna_shell_exec', 'fauna_read_file', 'fauna_replace_string', 'fauna_apply_patch', 'fauna_browser'].forEach((n) => {
        expect(names).toContain(n);
        expect(isSelfTool(n)).toBe(true);
      });
    });

    it('fauna_shell_exec delegates to context.runShell', async () => {
      const runShell = vi.fn(async () => 'ok');
      const result = await executeSelfTool('fauna_shell_exec', { command: 'echo hi' }, { ...mockContext, runShell });
      expect(runShell).toHaveBeenCalledWith({ command: 'echo hi' });
      expect(result).toBe('ok');
    });

    it('fauna_browser returns clean error when no client RPC is wired', async () => {
      const result = JSON.parse(await executeSelfTool('fauna_browser', { action: 'navigate', url: 'https://example.com' }, mockContext));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not available/);
    });

    it('fauna_browser delegates to context.callClientTool', async () => {
      const callClientTool = vi.fn(async () => 'page-content');
      const result = await executeSelfTool('fauna_browser', { action: 'extract' }, { ...mockContext, callClientTool });
      expect(callClientTool).toHaveBeenCalledWith('browser', { action: 'extract' }, { timeoutMs: 60000 });
      expect(result).toBe('page-content');
    });

    it('fauna_apply_patch delegates to context.applyPatch', () => {
      const applyPatch = vi.fn(() => [{ file: 'a.js', ok: true }]);
      const result = JSON.parse(executeSelfTool('fauna_apply_patch', { patch: '*** Begin Patch\n*** End Patch' }, { ...mockContext, applyPatch }));
      expect(applyPatch).toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });
  });
});

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
    it('exports 11 tool definitions', () => {
      expect(SELF_TOOL_DEFS).toHaveLength(11);
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
});

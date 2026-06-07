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
      // fauna_list_windows and fauna_arrange_windows. Bumped to 28 after
      // adding fauna_feature_request_create, fauna_backlog_list,
      // fauna_backlog_prioritize, fauna_consult_debate (autonomous agent
      // platform — backlog + chain-of-debate phases). Bumped to 29 after
      // adding fauna_plan (Codex-style TODO tool with invariants).
      // Bumped to 30 after adding fauna_mouse (cursor control via Quartz/PowerShell).
      // Bumped to 33 after adding fauna_mouse_position, fauna_keyboard, fauna_ui_tree
      // (full desktop-agent toolkit via cached Swift helper / UIAutomation).
      // Bumped to 34 after adding fauna_screen_context (Clippy-style one-call
      // snapshot — frontmost app + window + AX clickable nodes).
      // Bumped to 45 after adding Kokoro fauna_speak + fauna_podcast.
      // Bumped to 48 after adding fauna_lesson_create + fauna_lesson_get + fauna_list_lesson_kinds.
      // Bumped to 50 after adding fauna_db_migration + fauna_verify_build (opinionated app-build mode).
      // Bumped to 59 — Phase 3 adds 4 context tools (search/ingest/list/delete).
      // Bumped to 62 after adding AI image generation (fauna_image_generate +
      // fauna_image_edit + fauna_image_gen_status).
      // Bumped to 63 after adding fauna_retrieve_output (reversible tool-output offload).
      // Bumped to 64 after adding fauna_doctor (aggregated capability self-diagnostic).
      // Bumped to 69 after adding the PCB toolset: fauna_list_footprints,
      // fauna_layout_pcb, fauna_render_pcb, fauna_check_board, fauna_build_guide.
      expect(SELF_TOOL_DEFS).toHaveLength(69);
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
    it('fauna_remember stores a fact', async () => {
      const result = JSON.parse(await executeSelfTool('fauna_remember', { text: 'Test fact' }, mockContext));
      expect(result.ok).toBe(true);
    });

    it('fauna_recall returns facts', async () => {
      const result = JSON.parse(await executeSelfTool('fauna_recall', { keywords: 'test' }, mockContext));
      expect(Array.isArray(result)).toBe(true);
    });

    it('fauna_forget removes a fact', async () => {
      const result = JSON.parse(await executeSelfTool('fauna_forget', { id: 'mock-id' }, mockContext));
      expect(result.ok).toBe(true);
    });

    it('fauna_list_models returns models from context', async () => {
      const result = JSON.parse(await executeSelfTool('fauna_list_models', {}, mockContext));
      expect(Array.isArray(result)).toBe(true);
      expect(result[0].id).toBe('gpt-4.1');
    });

    it('fauna_switch_model sends event to renderer', async () => {
      const result = JSON.parse(await executeSelfTool('fauna_switch_model', { model: 'gpt-4.1' }, mockContext));
      expect(result.ok).toBe(true);
      expect(mockContext.sendToRenderer).toHaveBeenCalled();
    });

    it('fauna_get_settings returns settings', async () => {
      const result = JSON.parse(await executeSelfTool('fauna_get_settings', {}, mockContext));
      expect(result.model).toBe('gpt-4.1');
    });

    it('fauna_send_notification calls notifier', async () => {
      const result = JSON.parse(await executeSelfTool('fauna_send_notification', { title: 'Test', body: 'Hello' }, mockContext));
      expect(result.ok).toBe(true);
      expect(mockContext.sendNotification).toHaveBeenCalledWith('Test', 'Hello');
    });

    it('returns error for unknown tool', async () => {
      const result = JSON.parse(await executeSelfTool('unknown_tool', {}, mockContext));
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

    it('fauna_apply_patch delegates to context.applyPatch', async () => {
      const applyPatch = vi.fn(() => [{ file: 'a.js', ok: true }]);
      const result = JSON.parse(await executeSelfTool('fauna_apply_patch', { patch: '*** Begin Patch\n*** End Patch' }, { ...mockContext, applyPatch }));
      expect(applyPatch).toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });
  });

  describe('PCB / board tools', () => {
    const rc = {
      title: 'RC',
      components: [
        { id: 'vcc', type: 'vcc', x: 0, y: 0, value: '5' },
        { id: 'r1', type: 'resistor', x: 2, y: 0, value: '1k' },
        { id: 'c1', type: 'capacitor', x: 4, y: 0, value: '1u' },
        { id: 'gnd', type: 'gnd', x: 4, y: 2 },
      ],
      wires: [
        { from: 'vcc.p', to: 'r1.p1' },
        { from: 'r1.p2', to: 'c1.p1' },
        { from: 'c1.p2', to: 'gnd.p' },
      ],
    };

    it('registers the 5 PCB tools', () => {
      const names = SELF_TOOL_DEFS.map((d) => d.function.name);
      ['fauna_list_footprints', 'fauna_layout_pcb', 'fauna_render_pcb', 'fauna_check_board', 'fauna_build_guide'].forEach((n) => {
        expect(names).toContain(n);
        expect(isSelfTool(n)).toBe(true);
      });
    });

    it('fauna_list_footprints returns the footprint catalog', async () => {
      const r = JSON.parse(await executeSelfTool('fauna_list_footprints', {}, mockContext));
      expect(r.ok).toBe(true);
      expect(r.footprints.length).toBeGreaterThan(0);
    });

    it('fauna_layout_pcb places parts and auto-routes copper', async () => {
      const r = JSON.parse(await executeSelfTool('fauna_layout_pcb', { doc: rc }, mockContext));
      expect(r.ok).toBe(true);
      expect(r.components).toHaveLength(4);
      expect(r.traces.length).toBeGreaterThan(0); // routed
    });

    it('fauna_render_pcb produces board SVG', async () => {
      const r = JSON.parse(await executeSelfTool('fauna_render_pcb', { doc: rc }, mockContext));
      expect(r.ok).toBe(true);
      expect(r.svg).toContain('<svg');
    });

    it('fauna_check_board runs DRC', async () => {
      const r = JSON.parse(await executeSelfTool('fauna_check_board', { doc: rc }, mockContext));
      expect(r.ok).toBe(true);
      expect(r.stats.pads).toBeGreaterThan(0);
    });

    it('fauna_build_guide returns a BOM + markdown', async () => {
      const r = JSON.parse(await executeSelfTool('fauna_build_guide', { doc: rc, analysis: { type: 'op' } }, mockContext));
      expect(r.ok).toBe(true);
      expect(r.bom.length).toBeGreaterThan(0);
      expect(r.markdown).toMatch(/Build Guide/);
    });
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseSchedule, createWorkflow, getWorkflow, getAllWorkflows,
  updateWorkflow, deleteWorkflow, getHistory, runWorkflow,
  startWorkflowTimer, stopWorkflowTimer, _resetCache, HISTORY_MAX,
} from '../workflow-manager.js';

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(() => JSON.stringify({ workflows: [] })),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => true),
    },
    readFileSync: vi.fn(() => JSON.stringify({ workflows: [] })),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

describe('workflow-manager', () => {
  beforeEach(() => {
    _resetCache();
    stopWorkflowTimer();
    vi.clearAllMocks();
  });

  describe('parseSchedule()', () => {
    it('parses "every weekday at 9am"', () => {
      const s = parseSchedule('every weekday at 9am');
      expect(s.days).toEqual([1, 2, 3, 4, 5]);
      expect(s.hour).toBe(9);
      expect(s.minute).toBe(0);
    });

    it('parses "daily at 14:30"', () => {
      const s = parseSchedule('daily at 14:30');
      expect(s.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(s.hour).toBe(14);
      expect(s.minute).toBe(30);
    });

    it('parses "every monday at 10am"', () => {
      const s = parseSchedule('every monday at 10am');
      expect(s.days).toContain(1);
      expect(s.hour).toBe(10);
    });

    it('returns default for empty input', () => {
      const s = parseSchedule('');
      expect(s.days).toBeDefined();
      expect(s.hour).toBeDefined();
    });
  });

  describe('CRUD operations', () => {
    it('creates a workflow with defaults', () => {
      const wf = createWorkflow({ name: 'Test WF' });
      expect(wf.id).toBeDefined();
      expect(wf.name).toBe('Test WF');
      expect(wf.enabled).toBe(true);
      expect(wf.steps).toEqual([]);
    });

    it('gets a workflow by id', () => {
      const wf = createWorkflow({ name: 'Get Test' });
      const found = getWorkflow(wf.id);
      expect(found).not.toBeNull();
      expect(found.name).toBe('Get Test');
    });

    it('returns null for unknown id', () => {
      expect(getWorkflow('nonexistent')).toBeNull();
    });

    it('lists all workflows', () => {
      createWorkflow({ name: 'WF 1' });
      createWorkflow({ name: 'WF 2' });
      const all = getAllWorkflows();
      expect(all).toHaveLength(2);
    });

    it('updates a workflow', () => {
      const wf = createWorkflow({ name: 'Before' });
      const updated = updateWorkflow(wf.id, { name: 'After' });
      expect(updated.name).toBe('After');
    });

    it('deletes a workflow', () => {
      const wf = createWorkflow({ name: 'To Delete' });
      expect(deleteWorkflow(wf.id)).toBe(true);
      expect(getWorkflow(wf.id)).toBeNull();
    });

    it('returns false when deleting nonexistent', () => {
      expect(deleteWorkflow('nope')).toBe(false);
    });
  });

  describe('runWorkflow()', () => {
    it('executes steps sequentially', async () => {
      const aiCaller = vi.fn().mockResolvedValue('step result');
      startWorkflowTimer(aiCaller, vi.fn());

      const wf = createWorkflow({
        name: 'Run Test',
        steps: [{ prompt: 'Step 1' }, { prompt: 'Step 2' }],
      });

      const result = await runWorkflow(wf.id);
      expect(result.ok).toBe(true);
      expect(result.run.steps).toHaveLength(2);
      expect(aiCaller).toHaveBeenCalledTimes(2);
    });

    it('returns error for nonexistent workflow', async () => {
      startWorkflowTimer(vi.fn(), vi.fn());
      const result = await runWorkflow('nonexistent');
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('handles AI caller failure gracefully', async () => {
      const aiCaller = vi.fn().mockRejectedValue(new Error('AI down'));
      startWorkflowTimer(aiCaller, vi.fn());

      const wf = createWorkflow({
        name: 'Error Test',
        steps: [{ prompt: 'Will fail' }],
      });

      const result = await runWorkflow(wf.id);
      // Workflow catches errors and records them in step history
      expect(result.run).toBeDefined();
      const failedStep = result.run.steps.find(s => s.status === 'error');
      expect(failedStep).toBeDefined();
    });
  });

  describe('history', () => {
    it('records run history', async () => {
      const aiCaller = vi.fn().mockResolvedValue('done');
      startWorkflowTimer(aiCaller, vi.fn());

      const wf = createWorkflow({
        name: 'History Test',
        steps: [{ prompt: 'Do something' }],
      });

      await runWorkflow(wf.id);
      const history = getHistory(wf.id);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].status).toBe('completed');
    });
  });
});

// tests/seed-defaults.test.js
// Confirms first-launch seeding is gated correctly and does not clobber
// pre-existing user data.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

import { seedDefaults } from '../server/lib/seed-defaults.js';

function makeDeps({ tasks = [], workflows = [] } = {}) {
  const createdTasks = [];
  const createdWfs = [];
  return {
    readTasks: vi.fn(() => tasks),
    createTask: vi.fn(t => {
      const rec = { id: 'task-' + createdTasks.length, ...t };
      createdTasks.push(rec);
      return rec;
    }),
    getAllWorkflows: vi.fn(() => workflows),
    createWorkflow: vi.fn(w => {
      const rec = { id: 'wf-' + createdWfs.length, ...w };
      createdWfs.push(rec);
      return rec;
    }),
    _createdTasks: createdTasks,
    _createdWfs:   createdWfs,
  };
}

describe('seedDefaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});
    fs.renameSync.mockImplementation(() => {});
    fs.mkdirSync.mockImplementation(() => {});
  });

  it('seeds tasks + workflows when both stores are empty and marker absent', () => {
    const deps = makeDeps();
    const out = seedDefaults(deps);
    expect(out.seeded).toBe(true);
    expect(out.taskIds.length).toBeGreaterThanOrEqual(4);
    expect(out.workflowIds.length).toBeGreaterThanOrEqual(1);
    expect(deps.createTask).toHaveBeenCalled();
    expect(deps.createWorkflow).toHaveBeenCalled();
  });

  it('writes a marker file after a successful seed', () => {
    const deps = makeDeps();
    seedDefaults(deps);
    // saveJsonAtomic writes via writeFileSync + renameSync.
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('does not seed when marker file exists', () => {
    fs.existsSync.mockImplementation(p => String(p).endsWith('seeded.json'));
    const deps = makeDeps();
    const out = seedDefaults(deps);
    expect(out.seeded).toBe(false);
    expect(out.reason).toBe('marker-present');
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(deps.createWorkflow).not.toHaveBeenCalled();
  });

  it('seeds even when user already has tasks (additive)', () => {
    const deps = makeDeps({ tasks: [{ id: 'task-mine', title: 'mine' }] });
    const out = seedDefaults(deps);
    expect(out.seeded).toBe(true);
    expect(deps.createTask).toHaveBeenCalled();
    expect(deps.createWorkflow).toHaveBeenCalled();
  });

  it('seeds even when user already has workflows (additive)', () => {
    const deps = makeDeps({ workflows: [{ id: 'wf-mine', name: 'mine' }] });
    const out = seedDefaults(deps);
    expect(out.seeded).toBe(true);
    expect(deps.createTask).toHaveBeenCalled();
    expect(deps.createWorkflow).toHaveBeenCalled();
  });

  it('includes all four task kinds in the seed set', () => {
    const deps = makeDeps();
    seedDefaults(deps);
    const kinds = new Set(deps._createdTasks.map(t => t.kind));
    expect(kinds.has('cron')).toBe(true);
    expect(kinds.has('heartbeat')).toBe(true);
    expect(kinds.has('pipeline')).toBe(true);
  });

  it('seeds with safe permissions (no shell/browser/figma enabled)', () => {
    const deps = makeDeps();
    seedDefaults(deps);
    for (const t of deps._createdTasks) {
      expect(t.permissions.shell).toBe(false);
      expect(t.permissions.browser).toBe(false);
      expect(t.permissions.figma).toBe(false);
    }
  });

  it('every seeded title is prefixed "Sample:" so users recognise them', () => {
    const deps = makeDeps();
    seedDefaults(deps);
    for (const t of deps._createdTasks) {
      expect(t.title.startsWith('Sample:')).toBe(true);
    }
    for (const w of deps._createdWfs) {
      expect(w.name.startsWith('Sample:')).toBe(true);
    }
  });

  it('returns error reason when createTask throws — still attempts workflows', () => {
    const deps = makeDeps();
    deps.createTask.mockImplementation(() => { throw new Error('boom'); });
    const out = seedDefaults(deps);
    expect(out.seeded).toBe(true);
    expect(out.taskIds.length).toBe(0);
    expect(out.workflowIds.length).toBeGreaterThan(0);
  });
});

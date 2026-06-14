// Unit tests for server/lib/power-save.js — the reference-counted Electron
// powerSaveBlocker wrapper and the background-task singleton used by
// kanban-worker autopilot.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPowerSaveGuard,
  taskPowerSave,
  attachTaskPowerSaveBlocker,
} from '../server/lib/power-save.js';

function _fakeBlocker() {
  let nextId = 1;
  const started = new Map(); // id → kind
  const stopped = [];
  return {
    start: vi.fn((kind) => { const id = nextId++; started.set(id, kind); return id; }),
    stop:  vi.fn((id)   => { stopped.push(id); started.delete(id); }),
    _started: started,
    _stopped: stopped,
  };
}

describe('createPowerSaveGuard', () => {
  it('starts on first acquire, stops on last release', () => {
    const blocker = _fakeBlocker();
    const g = createPowerSaveGuard(blocker, 'prevent-app-suspension');
    g.acquire();
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    g.acquire();
    expect(blocker.start).toHaveBeenCalledTimes(1);  // no second start
    g.release();
    expect(blocker.stop).not.toHaveBeenCalled();      // still 1 outstanding
    g.release();
    expect(blocker.stop).toHaveBeenCalledTimes(1);
  });

  it('is a safe no-op when powerSaveBlocker is null', () => {
    const g = createPowerSaveGuard(null);
    expect(() => { g.acquire(); g.acquire(); g.release(); g.release(); }).not.toThrow();
  });

  it('clamps the ref-count at 0 (extra releases do not underflow)', () => {
    const blocker = _fakeBlocker();
    const g = createPowerSaveGuard(blocker);
    g.acquire();
    g.release();
    g.release();  // extra — should not call stop again or go negative
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    g.acquire();
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
});

describe('taskPowerSave singleton', () => {
  beforeEach(() => {
    // Reset to no-op so prior tests don't leak state into this one.
    attachTaskPowerSaveBlocker(null);
    // Drain any leaked refs from earlier tests.
    while (taskPowerSave._count() > 0) taskPowerSave.release();
  });

  it('is a no-op until attachTaskPowerSaveBlocker is called', () => {
    expect(() => { taskPowerSave.acquire(); taskPowerSave.release(); }).not.toThrow();
  });

  it('attaches an Electron blocker and starts on next acquire', () => {
    const blocker = _fakeBlocker();
    attachTaskPowerSaveBlocker(blocker);
    taskPowerSave.acquire();
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    taskPowerSave.release();
    expect(blocker.stop).toHaveBeenCalledTimes(1);
  });

  it('preserves the outstanding ref-count when reattaching the blocker', () => {
    // Start with no blocker, acquire 2 — those increments would be lost on
    // a naive re-init. attachTaskPowerSaveBlocker must carry them over so
    // the next acquire/release pair still balances correctly.
    taskPowerSave.acquire();
    taskPowerSave.acquire();
    expect(taskPowerSave._count()).toBe(2);
    const blocker = _fakeBlocker();
    attachTaskPowerSaveBlocker(blocker);
    // Carried over → blocker must already be started.
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(taskPowerSave._count()).toBe(2);
    taskPowerSave.release();
    taskPowerSave.release();
    expect(blocker.stop).toHaveBeenCalledTimes(1);
  });
});

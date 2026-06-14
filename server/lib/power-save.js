// Reference-counted power-save blocker.
// `prevent-display-sleep` keeps the screen and CPU awake while any chat request
// is active. Safe no-op when powerSaveBlocker is unavailable (non-Electron run).
//
// Two flavors:
//   - createPowerSaveGuard(...)  — uses 'prevent-display-sleep' (legacy chat path)
//   - the module-level `taskPowerSave` singleton uses 'prevent-app-suspension'
//     for background autopilot tasks (kanban-worker) so the display can still
//     dim/sleep but the CPU / event loop stays alive.

export function createPowerSaveGuard(powerSaveBlocker, kind = 'prevent-display-sleep') {
  let id = null;
  let active = 0;

  return {
    acquire() {
      active++;
      if (active === 1 && powerSaveBlocker && id === null) {
        try { id = powerSaveBlocker.start(kind); } catch (_) { id = null; }
      }
    },
    release() {
      active = Math.max(0, active - 1);
      if (active === 0 && powerSaveBlocker && id !== null) {
        try { powerSaveBlocker.stop(id); } catch (_) {}
        id = null;
      }
    },
    // Test helpers
    _count() { return active; },
    _id()    { return id; },
  };
}

// ── Background-task singleton ────────────────────────────────────────────
// The Electron `powerSaveBlocker` API is bound at server.js startup. The
// kanban-worker (which runs autopilot cards) imports `taskPowerSave` and
// calls acquire/release per in-flight card so the laptop doesn't sleep
// mid-run. Until `attachTaskPowerSaveBlocker` is called, the guard is a
// no-op — safe in non-Electron contexts (CLI, tests).
let _taskGuard = createPowerSaveGuard(null, 'prevent-app-suspension');

export const taskPowerSave = {
  acquire() { _taskGuard.acquire(); },
  release() { _taskGuard.release(); },
  // Tests
  _count() { return _taskGuard._count(); },
};

export function attachTaskPowerSaveBlocker(powerSaveBlocker) {
  // Preserve any outstanding ref-count by reading the old count first.
  const carryover = _taskGuard._count();
  _taskGuard = createPowerSaveGuard(powerSaveBlocker, 'prevent-app-suspension');
  // Re-acquire to match the previous active count, so callers that already
  // hold the guard don't have their releases drop us into the negative.
  for (let i = 0; i < carryover; i++) _taskGuard.acquire();
}

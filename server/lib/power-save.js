// Reference-counted power-save blocker.
// `prevent-display-sleep` keeps the screen and CPU awake while any chat request
// is active. Safe no-op when powerSaveBlocker is unavailable (non-Electron run).

export function createPowerSaveGuard(powerSaveBlocker) {
  let id = null;
  let active = 0;

  return {
    acquire() {
      active++;
      if (active === 1 && powerSaveBlocker && id === null) {
        id = powerSaveBlocker.start('prevent-display-sleep');
      }
    },
    release() {
      active = Math.max(0, active - 1);
      if (active === 0 && powerSaveBlocker && id !== null) {
        try { powerSaveBlocker.stop(id); } catch (_) {}
        id = null;
      }
    },
  };
}

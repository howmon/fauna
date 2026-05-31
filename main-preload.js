// ── Preload bridge for the main Fauna window ─────────────────────────────
// Exposes a tiny, vetted API to the renderer so it can ask the main process
// to spawn additional windows (multi-window support).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('faunaApp', {
  /**
   * Per-process nonce required by privileged UI-only routes
   * (e.g. /api/agent-builder/*). Read from process.env in the main
   * process at app start.
   */
  uiNonce: process.env.FAUNA_UI_NONCE || '',

  /**
   * Open a new Fauna window, optionally pre-selecting a conversation/project.
   * Pass blank:true to open a fresh window with no project context (used by
   * the "open new chat in new window" affordance).
   * @param {{convId?: string, projectId?: string, blank?: boolean}} [opts]
   */
  openWindow(opts) {
    const payload = {
      convId:    opts && typeof opts.convId    === 'string' ? opts.convId    : null,
      projectId: opts && typeof opts.projectId === 'string' ? opts.projectId : null,
      blank:     !!(opts && opts.blank),
    };
    ipcRenderer.send('fauna:open-window', payload);
  },

  /**
   * Report the renderer's currently active conversation / project so the main
   * process can persist it for next-launch restore.
   * @param {{convId?: string|null, projectId?: string|null}} [opts]
   */
  reportWindowState(opts) {
    const payload = {
      convId:    opts && typeof opts.convId    === 'string' ? opts.convId    : null,
      projectId: opts && typeof opts.projectId === 'string' ? opts.projectId : null,
    };
    ipcRenderer.send('fauna:report-window-state', payload);
  },
});

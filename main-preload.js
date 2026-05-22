// ── Preload bridge for the main Fauna window ─────────────────────────────
// Exposes a tiny, vetted API to the renderer so it can ask the main process
// to spawn additional windows (multi-window support).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('faunaApp', {
  /**
   * Open a new Fauna window, optionally pre-selecting a conversation/project.
   * @param {{convId?: string, projectId?: string}} [opts]
   */
  openWindow(opts) {
    const payload = {
      convId:    opts && typeof opts.convId    === 'string' ? opts.convId    : null,
      projectId: opts && typeof opts.projectId === 'string' ? opts.projectId : null,
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

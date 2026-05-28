// ── Widget Preload — secure bridge between widget renderer and main process ──
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  togglePin:    () => ipcRenderer.send('widget:toggle-pin'),
  hide:         () => ipcRenderer.send('widget:hide'),
  openInApp:    () => ipcRenderer.send('widget:open-in-app'),
  ask:          (text, opts) => ipcRenderer.send('widget:ask', { text, withContext: opts?.withContext !== false, openMain: !!opts?.openMain }),
  onPinChanged: (cb) => ipcRenderer.on('widget:pin-changed', (_e, pinned) => cb(pinned)),
  onFocusAsk:   (cb) => ipcRenderer.on('widget:focus-ask', () => cb()),
});

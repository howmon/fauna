// ── Widget Preload — secure bridge between widget renderer and main process ──
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  togglePin:    () => ipcRenderer.send('widget:toggle-pin'),
  hide:         () => ipcRenderer.send('widget:hide'),
  onPinChanged: (cb) => ipcRenderer.on('widget:pin-changed', (_e, pinned) => cb(pinned)),
});

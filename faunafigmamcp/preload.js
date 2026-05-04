'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcp', {
  getStatus:    ()       => ipcRenderer.invoke('get-status'),
  startRelay:   ()       => ipcRenderer.invoke('start-relay'),
  stopRelay:    ()       => ipcRenderer.invoke('stop-relay'),
  copy:         txt      => ipcRenderer.invoke('copy', txt),
  setLogin:     on       => ipcRenderer.invoke('set-login', on),
  close:        ()       => ipcRenderer.invoke('close-popup'),
  savePlugin:   ()       => ipcRenderer.invoke('save-plugin'),
  revealPlugin: ()       => ipcRenderer.invoke('reveal-plugin'),
  onLog:        cb       => ipcRenderer.on('log',    (_, d) => cb(d)),
  onStatus:     cb       => ipcRenderer.on('status', (_, d) => cb(d))
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcp', {
  getStatus:       ()           => ipcRenderer.invoke('get-status'),
  startRelay:      which        => ipcRenderer.invoke('start-relay', which),
  stopRelay:       which        => ipcRenderer.invoke('stop-relay',  which),
  setEnabled:      (which, on)  => ipcRenderer.invoke('set-enabled', which, on),
  copy:            txt          => ipcRenderer.invoke('copy', txt),
  setLogin:        on           => ipcRenderer.invoke('set-login', on),
  close:           ()           => ipcRenderer.invoke('close-popup'),
  saveExtension:   ()           => ipcRenderer.invoke('save-extension'),
  revealExtension: ()           => ipcRenderer.invoke('reveal-extension'),
  savePlugin:      ()           => ipcRenderer.invoke('save-plugin'),
  revealPlugin:    ()           => ipcRenderer.invoke('reveal-plugin'),
  onLog:           cb           => ipcRenderer.on('log',    (_, d) => cb(d)),
  onStatus:        cb           => ipcRenderer.on('status', (_, d) => cb(d)),
});

// ── Preload bridge for the dictation-capture window ─────────────────────
// Mirrors audio-preload.js but for dictation channels. Exposes `send` for
// renderer→main and `onStop` so the renderer can react to main's "stop
// recording" signal.

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_SEND = new Set([
  'dictation:ready',
  'dictation:level',
  'dictation:result',
  'dictation:error',
]);

contextBridge.exposeInMainWorld('faunaDictation', {
  send(channel, payload, transferList) {
    if (!ALLOWED_SEND.has(channel)) return;
    try {
      if (transferList && transferList.length) {
        ipcRenderer.postMessage(channel, payload, transferList);
      } else {
        ipcRenderer.send(channel, payload);
      }
    } catch (e) {
      try { ipcRenderer.send('dictation:error', { message: String(e && e.message || e) }); } catch (_) {}
    }
  },
  onStop(handler) {
    if (typeof handler !== 'function') return;
    ipcRenderer.on('dictation:stop', () => { try { handler(); } catch (_) {} });
  },
});

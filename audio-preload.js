// ── Preload bridge for the hidden audio-capture window ──────────────────
// Exposes a single, minimal `send` channel to the renderer. The renderer
// uses it to push mic frames + VAD events to the main process; nothing
// else is exposed.

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = new Set([
  'voice:ready',
  'voice:frame',
  'voice:speech-start',
  'voice:speech-end',
  'voice:error',
]);

contextBridge.exposeInMainWorld('faunaVoice', {
  send(channel, payload, transferList) {
    if (!ALLOWED.has(channel)) return;
    try {
      if (transferList && transferList.length) {
        // postMessage supports transferables; ipcRenderer.send does not.
        ipcRenderer.postMessage(channel, payload, transferList);
      } else {
        ipcRenderer.send(channel, payload);
      }
    } catch (e) {
      try { ipcRenderer.send('voice:error', { message: String(e && e.message || e) }); } catch (_) {}
    }
  },
});

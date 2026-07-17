// ── Preload bridge for the main Fauna window ─────────────────────────────
// Exposes a tiny, vetted API to the renderer so it can ask the main process
// to spawn additional windows (multi-window support).

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('faunaApp', {
  openExternal: (url) => ipcRenderer.send('browser:open-external', url),
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

  /**
   * Resolve a DOM File object (from drag-drop or <input type=file>) to its
   * absolute filesystem path. Returns '' when the File came from a source
   * without a backing path (e.g. clipboard image, generated blob).
   * Electron 32+ removed `file.path`; webUtils.getPathForFile is the
   * supported replacement.
   */
  getPathForFile(file) {
    try {
      if (!file || typeof file !== 'object') return '';
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file) || '';
      }
      return (file && typeof file.path === 'string') ? file.path : '';
    } catch (_) { return ''; }
  },

  /**
   * Subscribe to markdown files opened via a file association, dock drop, or
   * the command line. The callback receives `{ path, name, content }`. Returns
   * an unsubscribe function.
   * @param {(payload: {path: string, name: string, content: string}) => void} callback
   */
  onOpenFile(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => {
      try { callback(payload); } catch (_) {}
    };
    ipcRenderer.on('fauna:open-file', handler);
    return () => ipcRenderer.removeListener('fauna:open-file', handler);
  },

  /**
   * Subscribe to errors raised while opening a markdown file (e.g. too large
   * or unreadable). The callback receives `{ name, error }`.
   * @param {(payload: {name: string, error: string}) => void} callback
   */
  onOpenFileError(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => {
      try { callback(payload); } catch (_) {}
    };
    ipcRenderer.on('fauna:open-file-error', handler);
    return () => ipcRenderer.removeListener('fauna:open-file-error', handler);
  },

  /**
   * Speak `text` through the server-side Tts engine (Kokoro by default).
   * Resolves when playback finishes (or `{cancelled:true}` on stop). The
   * renderer used to call window.speechSynthesis directly — that routes
   * through the OS native voice and bypasses Kokoro entirely, so prefer
   * this whenever it's available.
   * @param {string} text
   * @param {{voice?: string, rate?: number}} [opts]
   * @returns {Promise<{done?:true, cancelled?:true, error?:string}>}
   */
  speak(text, opts) {
    const payload = {
      text: String(text == null ? '' : text),
      voice: opts && typeof opts.voice === 'string' ? opts.voice : undefined,
      rate:  opts && Number.isFinite(Number(opts.rate)) ? Number(opts.rate) : undefined,
    };
    return ipcRenderer.invoke('tts:speak', payload);
  },

  /** Cancel current + queued TTS playback. */
  stopSpeak() {
    ipcRenderer.send('tts:stop');
  },

  /** Whether the server-side Tts is currently speaking. */
  isSpeaking() {
    return ipcRenderer.invoke('tts:isSpeaking');
  },
});

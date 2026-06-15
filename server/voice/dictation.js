// ── Dictation orchestrator (Phase 5) ────────────────────────────────────
//
// Push-to-talk-ish dictation: user triggers `start()` (e.g. global shortcut),
// a hidden window opens the mic and continuously buffers PCM16@16k, then on
// `stop()` (second shortcut tap, or `MAX_SECONDS` cap) the buffer is shipped
// back, transcribed with Whisper, and emitted as a final transcript.
//
// We intentionally do NOT VAD-gate dictation — the user wants every word
// between the two shortcut taps captured, including natural pauses.
//
// Main process is responsible for:
//   * Providing a window factory via `attachWindowFactory()` that returns
//     a hidden BrowserWindow loading `public/dictation-capture.html` with
//     `dictation-preload.js`. This module never imports Electron directly.
//   * Forwarding the four dictation IPC channels into `handleIpc()`.
//   * Acting on `transcribed` events (e.g. clipboard + notification).
//
// Mic exclusion: when the resident voice loop is also running we tell it
// to mute itself for the duration of dictation, so wake-word transcripts
// don't fire on the user's dictated speech.

import { EventEmitter } from 'node:events';
import { transcribePcm, isWhisperReady } from './transcribe-pcm.js';

export const SAMPLE_RATE = 16000;
export const MAX_SECONDS = 120;
const MIN_SAMPLES = Math.round(0.25 * SAMPLE_RATE);  // <250ms = treat as cancel

export class Dictation extends EventEmitter {
  constructor({ appDir, augmentedPath, residentAudio = null } = {}) {
    super();
    if (!appDir) throw new Error('Dictation requires appDir');
    this.appDir         = appDir;
    this.augmentedPath  = augmentedPath || process.env.PATH || '';
    this.residentAudio  = residentAudio;
    this._windowFactory = null;
    this._win           = null;
    this._state         = 'idle';   // idle | starting | recording | transcribing
    this._autoStopTimer = null;
    this._mutedResident = false;
    this._sessionId     = null;     // string id for the current dictation session
    this._sessionSeq    = 0;        // monotonic counter for sessionId generation
  }

  attachWindowFactory(fn) { this._windowFactory = fn; }
  attachResidentAudio(ra) { this.residentAudio = ra; }

  getState() { return this._state; }
  getSessionId() { return this._sessionId; }
  isActive() { return this._state === 'recording' || this._state === 'starting'; }

  start() {
    if (this._state !== 'idle') return false;
    if (!isWhisperReady()) {
      this.emit('error', new Error('Whisper not ready — model or binary missing'));
      return false;
    }
    if (typeof this._windowFactory !== 'function') {
      this.emit('error', new Error('Dictation window factory not attached'));
      return false;
    }
    try {
      // Hard-mute resident mic so its wake-word loop doesn't latch onto
      // the user's dictation. We restore on cleanup.
      if (this.residentAudio?.isEnabled?.() && !this.residentAudio.isMuted?.()) {
        this.residentAudio.setMuted(true);
        this._mutedResident = true;
      }
      this._win = this._windowFactory();
      // Assign a session id BEFORE the state event so subscribers can
      // tag everything they emit downstream with the same id.
      this._sessionSeq += 1;
      this._sessionId   = 'd' + Date.now().toString(36) + '-' + this._sessionSeq;
      this._state = 'starting';
      this.emit('state', { state: this._state, sessionId: this._sessionId });

      // Safety: if user forgets to stop, finalise after MAX_SECONDS.
      this._autoStopTimer = setTimeout(() => {
        if (this.isActive()) this.stop('max-duration');
      }, (MAX_SECONDS + 2) * 1000);
      return true;
    } catch (e) {
      this._cleanup();
      this.emit('error', e);
      return false;
    }
  }

  stop(reason = 'user') {
    if (this._state !== 'recording' && this._state !== 'starting') return false;
    try { this._win?.webContents?.send?.('dictation:stop', { reason }); } catch (_) {}
    // Transition to 'transcribing' happens when the result IPC arrives.
    return true;
  }

  cancel() {
    if (this._state === 'idle') return;
    const sid = this._sessionId;
    try { this._win?.webContents?.send?.('dictation:stop', { reason: 'cancelled' }); } catch (_) {}
    this._cleanup();
    this.emit('state', { state: 'idle', cancelled: true, sessionId: sid });
  }

  toggle() { return this._state === 'idle' ? this.start() : this.stop('toggle'); }

  handleIpc(channel, payload) {
    switch (channel) {
      case 'dictation:ready':  return this._onReady(payload);
      case 'dictation:level':  return; // reserved for UI mirror
      case 'dictation:result': return this._onResult(payload);
      case 'dictation:error':  return this._onError(payload);
    }
  }

  _onReady() {
    if (this._state !== 'starting') return;
    this._state = 'recording';
    this.emit('state', { state: this._state, sessionId: this._sessionId });
  }

  async _onResult({ pcm, samples } = {}) {
    if (this._state === 'idle') return; // late delivery after cancel
    const sid = this._sessionId;
    this._state = 'transcribing';
    this.emit('state', { state: this._state, sessionId: sid });

    try {
      if (!pcm || !samples || samples < MIN_SAMPLES) {
        this.emit('transcribed', { text: '', durationMs: Math.round((samples || 0) / SAMPLE_RATE * 1000), empty: true, sessionId: sid });
        return;
      }
      const pcmBuf = Buffer.from(pcm);
      const t0 = Date.now();
      const res = await transcribePcm(pcmBuf, {
        sampleRate:    SAMPLE_RATE,
        appDir:        this.appDir,
        augmentedPath: this.augmentedPath,
        timeoutMs:     60000,
      });
      if (!res || !res.ok) {
        this.emit('error', new Error('transcribe failed: ' + (res?.error || res?.code || 'unknown')));
        return;
      }
      const raw   = res.text || '';
      const clean = _cleanTranscript(raw);
      this.emit('transcribed', {
        text:       clean,
        raw,
        durationMs: Math.round(samples / SAMPLE_RATE * 1000),
        elapsedMs:  Date.now() - t0,
        empty:      !clean,
        sessionId:  sid,
      });
    } catch (e) {
      this.emit('error', e);
    } finally {
      this._cleanup();
      this.emit('state', { state: 'idle', sessionId: sid });
    }
  }

  _onError({ message } = {}) {
    const sid = this._sessionId;
    this.emit('error', new Error('renderer: ' + (message || 'unknown')));
    this._cleanup();
    this.emit('state', { state: 'idle', sessionId: sid });
  }

  _cleanup() {
    if (this._autoStopTimer) { clearTimeout(this._autoStopTimer); this._autoStopTimer = null; }
    if (this._win && !this._win.isDestroyed?.()) {
      try { this._win.close(); } catch (_) {}
    }
    this._win = null;
    this._state = 'idle';
    this._sessionId = null;
    if (this._mutedResident) {
      try { this.residentAudio?.setMuted?.(false); } catch (_) {}
      this._mutedResident = false;
    }
  }

  shutdown() {
    try { this._win?.close?.(); } catch (_) {}
    this._cleanup();
  }
}

// Whisper occasionally emits bracketed annotations like "[BLANK_AUDIO]",
// "(silence)", etc. Strip them and trim.
function _cleanTranscript(t) {
  if (!t) return '';
  let s = String(t);
  s = s.replace(/\[(?:BLANK_AUDIO|MUSIC|silence|inaudible)\]/gi, '');
  s = s.replace(/\((?:silence|inaudible|noise)\)/gi, '');
  s = s.replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

let _singleton = null;
export function getDictation(opts) {
  if (!_singleton) _singleton = new Dictation(opts);
  else if (opts?.residentAudio && !_singleton.residentAudio) _singleton.attachResidentAudio(opts.residentAudio);
  return _singleton;
}

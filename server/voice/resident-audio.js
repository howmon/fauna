// ── Resident audio broker (Phase 1) ──────────────────────────────────────
//
// Owns the lifecycle of the always-on microphone capture for Fauna's voice
// assistant. The actual mic stream + VAD runs in a hidden renderer
// (public/audio-capture.html) because Electron's main process cannot call
// getUserMedia directly. This module:
//
//   • opens / closes that hidden window on demand
//   • receives audio frames + VAD events over IPC
//   • maintains an in-memory pre-roll ring buffer of recent PCM16 audio
//   • re-emits high-level events ('speech-start', 'speech-end', 'utterance')
//     for later phases (wake word, intent judge, agent dispatch)
//
// Wake word, streaming Whisper, intent judge, and TTS are intentionally NOT
// here yet — they hook in via the EventEmitter exposed by getResidentAudio().
//
// Persisted config lives at ~/.config/fauna/voice.json:
//   { "resident": true|false, "preRollMs": 2000 }
//
// Public API (consumed by main.js):
//   const bus = getResidentAudio({ appDir });
//   bus.setEnabled(true|false);     // persist + start/stop
//   bus.isEnabled();
//   bus.on('state', ({enabled, listening, speaking}) => ...)
//   bus.on('speech-start', ({ts}) => ...)
//   bus.on('speech-end',   ({ts, durationMs, pcm}) => ...)  // pcm = Int16 Buffer of utterance
//   bus.shutdown();

import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const SAMPLE_RATE = 16000;          // matches whisper.cpp expected input
const FRAME_BYTES_PER_SAMPLE = 2;   // int16 mono
const DEFAULT_PRE_ROLL_MS = 2000;
const MAX_UTTERANCE_MS = 15000;     // hard cap so a stuck VAD can't OOM us
const RING_BUFFER_MS = 5000;        // hold last 5s for pre-roll snapshot

const CONFIG_DIR  = path.join(os.homedir(), '.config', 'fauna');
const CONFIG_FILE = path.join(CONFIG_DIR, 'voice.json');

let _instance = null;

function _readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      resident:  !!raw.resident,
      preRollMs: Number.isFinite(raw.preRollMs) ? raw.preRollMs : DEFAULT_PRE_ROLL_MS,
    };
  } catch (_) {
    return { resident: false, preRollMs: DEFAULT_PRE_ROLL_MS };
  }
}

function _writeConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.warn('[voice] failed to write voice config:', e.message);
  }
}

// ── Ring buffer of PCM16 mono samples ───────────────────────────────────
class PcmRing {
  constructor(capacityMs, sampleRate) {
    this.capacity = Math.ceil((capacityMs / 1000) * sampleRate); // samples
    this.buf = new Int16Array(this.capacity);
    this.write = 0;
    this.filled = 0;
  }
  push(int16) {
    for (let i = 0; i < int16.length; i++) {
      this.buf[this.write] = int16[i];
      this.write = (this.write + 1) % this.capacity;
      if (this.filled < this.capacity) this.filled++;
    }
  }
  /** Return the most recent `ms` of audio as a fresh Int16Array (chronological). */
  tail(ms) {
    const want = Math.min(Math.ceil((ms / 1000) * SAMPLE_RATE), this.filled);
    const out  = new Int16Array(want);
    // read starts `want` samples behind write
    let start = (this.write - want + this.capacity) % this.capacity;
    for (let i = 0; i < want; i++) {
      out[i] = this.buf[(start + i) % this.capacity];
    }
    return out;
  }
  clear() { this.write = 0; this.filled = 0; }
}

class ResidentAudio extends EventEmitter {
  constructor({ appDir }) {
    super();
    this.appDir = appDir;
    this.cfg = _readConfig();
    this.window = null;        // BrowserWindow (set by main.js via attachWindowFactory)
    this.windowFactory = null; // () => BrowserWindow (hidden)
    this.listening = false;
    this.speaking = false;
    this.ring = new PcmRing(RING_BUFFER_MS, SAMPLE_RATE);
    this.utterance = null;     // { startTs, frames:[Int16Array], samples:0 }
    this.maxUtteranceTimer = null;
  }

  isEnabled() { return !!this.cfg.resident; }

  /**
   * main.js calls this with a factory that creates the hidden BrowserWindow
   * pointed at public/audio-capture.html. Keeping the factory injection here
   * avoids a circular import on Electron from this server-side module.
   */
  attachWindowFactory(factory) { this.windowFactory = factory; }

  /** main.js forwards IPC messages from the hidden audio window here. */
  handleIpc(channel, payload) {
    switch (channel) {
      case 'voice:ready':
        this.listening = true;
        this._emitState();
        break;
      case 'voice:frame':
        this._onFrame(payload);
        break;
      case 'voice:speech-start':
        this._onSpeechStart(payload);
        break;
      case 'voice:speech-end':
        this._onSpeechEnd(payload);
        break;
      case 'voice:error':
        console.warn('[voice] capture error:', payload?.message);
        this.emit('error', new Error(payload?.message || 'capture error'));
        break;
      default:
        // ignore unknown
    }
  }

  setEnabled(on) {
    const next = !!on;
    if (next === this.cfg.resident && (next ? !!this.window : !this.window)) return;
    this.cfg.resident = next;
    _writeConfig(this.cfg);
    if (next) this._start();
    else this._stop();
  }

  shutdown() {
    this._stop();
    this.removeAllListeners();
  }

  // ── internal ──────────────────────────────────────────────────────────
  _start() {
    if (this.window && !this.window.isDestroyed?.()) return;
    if (!this.windowFactory) {
      console.warn('[voice] resident audio enabled but no windowFactory attached');
      return;
    }
    try {
      this.window = this.windowFactory();
      this.window.on('closed', () => {
        this.window = null;
        this.listening = false;
        this.speaking = false;
        this._emitState();
      });
      this._emitState();
    } catch (e) {
      console.warn('[voice] failed to open audio window:', e.message);
    }
  }

  _stop() {
    this.listening = false;
    this.speaking = false;
    this._abortUtterance();
    this.ring.clear();
    if (this.window && !this.window.isDestroyed?.()) {
      try { this.window.close(); } catch (_) {}
    }
    this.window = null;
    this._emitState();
  }

  _emitState() {
    this.emit('state', {
      enabled:   !!this.cfg.resident,
      listening: !!this.listening,
      speaking:  !!this.speaking,
    });
  }

  _onFrame(payload) {
    // payload.pcm is an ArrayBuffer (Int16 PCM @ 16kHz mono) shipped via IPC
    if (!payload || !payload.pcm) return;
    const int16 = new Int16Array(payload.pcm);
    this.ring.push(int16);
    if (this.utterance) {
      this.utterance.frames.push(int16);
      this.utterance.samples += int16.length;
      const elapsedMs = (this.utterance.samples / SAMPLE_RATE) * 1000;
      if (elapsedMs >= MAX_UTTERANCE_MS) {
        this._onSpeechEnd({ ts: Date.now(), reason: 'max-duration' });
      }
    }
  }

  _onSpeechStart(payload) {
    if (this.speaking) return;
    this.speaking = true;
    const ts = payload?.ts || Date.now();
    // Seed the utterance with pre-roll so wake word + early consonants aren't lost
    const preRoll = this.ring.tail(this.cfg.preRollMs);
    this.utterance = {
      startTs: ts,
      frames: preRoll.length ? [preRoll] : [],
      samples: preRoll.length,
    };
    if (this.maxUtteranceTimer) clearTimeout(this.maxUtteranceTimer);
    this.maxUtteranceTimer = setTimeout(() => {
      this._onSpeechEnd({ ts: Date.now(), reason: 'max-duration-timer' });
    }, MAX_UTTERANCE_MS + 500);
    this._emitState();
    this.emit('speech-start', { ts });
  }

  _onSpeechEnd(payload) {
    if (!this.speaking) return;
    this.speaking = false;
    const ts = payload?.ts || Date.now();
    if (this.maxUtteranceTimer) { clearTimeout(this.maxUtteranceTimer); this.maxUtteranceTimer = null; }
    const utt = this.utterance;
    this.utterance = null;
    this._emitState();
    if (!utt || !utt.samples) {
      this.emit('speech-end', { ts, durationMs: 0, pcm: null });
      return;
    }
    // Concatenate captured Int16Arrays into one buffer for downstream consumers.
    const out = new Int16Array(utt.samples);
    let off = 0;
    for (const frag of utt.frames) {
      out.set(frag, off);
      off += frag.length;
    }
    const durationMs = Math.round((utt.samples / SAMPLE_RATE) * 1000);
    const pcm = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    this.emit('speech-end', { ts, durationMs, pcm, sampleRate: SAMPLE_RATE });
  }

  _abortUtterance() {
    if (this.maxUtteranceTimer) { clearTimeout(this.maxUtteranceTimer); this.maxUtteranceTimer = null; }
    this.utterance = null;
  }
}

export function getResidentAudio(opts = {}) {
  if (!_instance) _instance = new ResidentAudio(opts);
  return _instance;
}

export const VOICE_SAMPLE_RATE = SAMPLE_RATE;
export const VOICE_BYTES_PER_SAMPLE = FRAME_BYTES_PER_SAMPLE;

// Allow this file's directory to be derived (used by main.js to locate the
// hidden HTML page when bundled).
export const __VOICE_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

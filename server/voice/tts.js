// ── Text-to-Speech (Phase 4) ─────────────────────────────────────────────
//
// Pluggable, cancel-able TTS for the resident voice loop. Picks a sensible
// system-native engine by default so there are no extra runtime deps:
//
//   macOS    → /usr/bin/say          (excellent voices, "-r" for rate)
//   Linux    → espeak-ng → spd-say   (whichever is on PATH)
//   Windows  → PowerShell SAPI       (System.Speech.Synthesis.SpeechSynthesizer)
//
// Public API:
//   const tts = getTts({ onStateChange });
//   tts.speak("hello world", { voice?, rate? }) → Promise<{done:true|cancelled:true}>
//   tts.stop()                                  → cancels current + queued
//   tts.isSpeaking()
//
// Queueing: calls to speak() while already speaking are queued FIFO so
// short streamed chunks (from a future Phase-4b LLM token stream) play
// in order. stop() drains the queue and kills the active child process.
//
// Engines are intentionally minimal — easy to swap later for edge-tts,
// kokoro, or coqui without changing callers.

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { existsSync } from 'fs';

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

function which(bin) {
  const paths = (process.env.PATH || '').split(IS_WIN ? ';' : ':');
  for (const p of paths) {
    const full = (p || '') + (IS_WIN ? '\\' : '/') + bin + (IS_WIN ? '.exe' : '');
    try { if (existsSync(full)) return full; } catch (_) {}
  }
  return null;
}

// ── Engine implementations ──────────────────────────────────────────────
//
// Each engine returns a function `(text, opts) => ChildProcess`. The
// caller manages cancellation + completion via the returned child.

function macEngine(text, opts) {
  const args = [];
  if (opts.voice) args.push('-v', opts.voice);
  if (opts.rate)  args.push('-r', String(opts.rate)); // words per minute
  args.push('--', text);
  return spawn('/usr/bin/say', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function linuxEngine(text, opts) {
  const espeak = which('espeak-ng') || which('espeak');
  if (espeak) {
    const args = [];
    if (opts.voice) args.push('-v', opts.voice);
    if (opts.rate)  args.push('-s', String(opts.rate)); // words per minute
    args.push('--', text);
    return spawn(espeak, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  const spd = which('spd-say');
  if (spd) {
    const args = ['-w']; // wait until spoken
    if (opts.rate) args.push('-r', String(opts.rate)); // -100..100
    args.push('--', text);
    return spawn(spd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  return null;
}

function winEngine(text, opts) {
  // Use PowerShell + SAPI. Escape single quotes for the PS string literal.
  const safe = String(text).replace(/'/g, "''");
  const voiceLine = opts.voice ? `$s.SelectVoice('${opts.voice.replace(/'/g, "''")}');` : '';
  const rateLine  = Number.isFinite(opts.rate) ? `$s.Rate = ${Math.max(-10, Math.min(10, opts.rate | 0))};` : '';
  const ps = `Add-Type -AssemblyName System.Speech; ` +
             `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
             voiceLine + rateLine +
             `$s.Speak('${safe}');`;
  return spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'ignore', 'pipe'] });
}

function pickEngine() {
  if (IS_MAC) return { name: 'say',     run: macEngine };
  if (IS_WIN) return { name: 'sapi',    run: winEngine };
  const linux = linuxEngine.bind(null);
  return { name: 'espeak/spd', run: linux };
}

class Tts extends EventEmitter {
  constructor({ onStateChange } = {}) {
    super();
    this.engine    = pickEngine();
    this.queue     = [];   // {text, opts, resolve}
    this.active    = null; // {child, resolve, cancelled}
    this.defaults  = { voice: '', rate: null, enabled: true };
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
  }

  /** Configure engine-level defaults (voice, rate, master enable). */
  setDefaults({ voice, rate, enabled } = {}) {
    if (typeof voice    === 'string')                 this.defaults.voice   = voice;
    if (rate === null || rate === '' || rate === undefined) this.defaults.rate = null;
    else if (Number.isFinite(Number(rate)))           this.defaults.rate    = Number(rate);
    if (typeof enabled  === 'boolean')                this.defaults.enabled = enabled;
  }

  isSpeaking() { return !!this.active; }

  /**
   * Queue text for playback. Resolves when this specific item finishes
   * (or is cancelled).
   * @returns {Promise<{done?:true, cancelled?:true, error?:string}>}
   */
  speak(text, opts = {}) {
    return new Promise((resolve) => {
      if (!this.defaults.enabled) return resolve({ done: true, disabled: true });
      if (!text || !String(text).trim()) return resolve({ done: true });
      // Merge per-call opts on top of stored defaults.
      const merged = { ...this.defaults, ...(opts || {}) };
      if (!merged.voice) delete merged.voice;
      if (merged.rate === null || merged.rate === undefined) delete merged.rate;
      this.queue.push({ text: String(text), opts: merged, resolve });
      this._drain();
    });
  }

  /** Cancel current + all queued items. */
  stop() {
    // Drain queue (resolve as cancelled so callers can unblock).
    while (this.queue.length) {
      const item = this.queue.shift();
      try { item.resolve({ cancelled: true }); } catch (_) {}
    }
    const a = this.active;
    if (a && a.child && !a.child.killed) {
      a.cancelled = true;
      try { a.child.kill(IS_WIN ? 'SIGTERM' : 'SIGINT'); } catch (_) {}
      // Fallback hard kill after 250ms.
      setTimeout(() => { try { a.child.kill('SIGKILL'); } catch (_) {} }, 250);
    }
  }

  _setActive(next) {
    const wasSpeaking = !!this.active;
    this.active = next;
    const nowSpeaking = !!this.active;
    if (wasSpeaking !== nowSpeaking) {
      try { this.onStateChange?.(nowSpeaking); } catch (_) {}
      this.emit('state', nowSpeaking);
    }
  }

  _drain() {
    if (this.active) return;
    const item = this.queue.shift();
    if (!item) return;

    let child;
    try {
      child = this.engine.run(item.text, item.opts || {});
    } catch (e) {
      try { item.resolve({ error: e.message }); } catch (_) {}
      return this._drain();
    }
    if (!child) {
      try { item.resolve({ error: 'no TTS engine available on this system' }); } catch (_) {}
      return this._drain();
    }

    const handle = { child, resolve: item.resolve, cancelled: false };
    this._setActive(handle);

    let stderr = '';
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      this._setActive(null);
      try { item.resolve({ error: 'tts spawn error: ' + err.message }); } catch (_) {}
      this._drain();
    });
    child.on('close', (code, signal) => {
      const cancelled = handle.cancelled || (signal && code === null);
      this._setActive(null);
      if (cancelled)         { try { item.resolve({ cancelled: true }); } catch (_) {} }
      else if (code === 0)   { try { item.resolve({ done: true }); } catch (_) {} }
      else                   { try { item.resolve({ error: `tts exit ${code}: ${stderr.trim()}` }); } catch (_) {} }
      this._drain();
    });
  }

  shutdown() {
    this.stop();
    this.removeAllListeners();
    this.onStateChange = null;
  }
}

let _instance = null;
export function getTts(opts = {}) {
  if (!_instance) _instance = new Tts(opts);
  return _instance;
}

/**
 * Enumerate available TTS voices on the host. Best-effort and may return
 * an empty array on Linux (espeak/spd-say don't expose a uniform listing
 * across distros). Used by the voice-settings UI.
 *
 * @returns {Promise<Array<{name:string, language?:string}>>}
 */
export async function listVoices() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  try {
    if (IS_MAC) {
      const { stdout } = await exec('/usr/bin/say', ['-v', '?'], { timeout: 4000 });
      return stdout.split('\n').map(line => {
        // "Alex                en_US    # Most...what?"
        const m = line.match(/^(\S(?:[^#]*?\S)?)\s{2,}([a-z]{2,3}(?:[_-][A-Za-z0-9]+)?)/);
        if (!m) return null;
        return { name: m[1].trim(), language: m[2] };
      }).filter(Boolean);
    }
    if (IS_WIN) {
      const ps = "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 6000 });
      return stdout.split(/\r?\n/).map(line => {
        const [name, language] = line.split('|');
        if (!name) return null;
        return { name: name.trim(), language: (language || '').trim() };
      }).filter(Boolean);
    }
    // Linux: espeak-ng --voices gives a fixed-column listing.
    if (existsSync('/usr/bin/espeak-ng') || existsSync('/usr/local/bin/espeak-ng')) {
      const { stdout } = await exec('espeak-ng', ['--voices'], { timeout: 4000 });
      const lines = stdout.split('\n').slice(1); // skip header
      return lines.map(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) return null;
        return { name: parts[3], language: parts[1] };
      }).filter(Boolean);
    }
    return [];
  } catch (_) {
    return [];
  }
}

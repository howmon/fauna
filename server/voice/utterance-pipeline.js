// ── Utterance pipeline (Phase 2 orchestrator) ────────────────────────────
//
// Glue between resident-audio (raw PCM utterances) and the rest of Fauna.
// Subscribes to the broker's `speech-end` events, transcribes the audio,
// runs wake-word detection, and re-emits high-level events:
//
//   utterance:transcribed { ts, durationMs, text, addressed, command }
//   utterance:addressed   { ts, text, command }   ← wake word found
//   utterance:ignored     { ts, text }            ← no wake word
//
// Phase-3 hooks (intent judge) will sit between `transcribed` and
// `addressed`. Phase-4 (chat dispatch + TTS) listens on `addressed`.
//
// Concurrency: utterances are processed sequentially in arrival order so
// whisper-cli isn't fighting itself for CPU when somebody speaks twice
// quickly. Backlog is capped — if it exceeds MAX_QUEUE, oldest items are
// dropped (and counted) so we don't run forever on a stuck pipeline.

import { EventEmitter } from 'events';

import { transcribePcm, isSttReady } from './stt-provider.js';
import { matchWake, DEFAULT_WAKE_WORDS } from './wake-word.js';
import { ruleBasedJudge } from './intent-judge.js';

const MIN_UTTERANCE_MS = 250;   // skip clicks/keystrokes shorter than this
const MAX_QUEUE        = 4;

class UtterancePipeline extends EventEmitter {
  constructor({
    residentAudio,
    appDir,
    augmentedPath,
    wakeWords,
    wakeRequired = true,
    followUpWindowMs,             // optional override; otherwise judge default
    judge = ruleBasedJudge,
    getContext,                  // () => { ttsSpeaking, lastAddressedTs }
  } = {}) {
    super();
    this.residentAudio = residentAudio;
    this.appDir        = appDir;
    this.augmentedPath = augmentedPath;
    this.wakeWords     = Array.isArray(wakeWords) && wakeWords.length ? wakeWords : DEFAULT_WAKE_WORDS;
    this.wakeRequired  = !!wakeRequired;
    this.followUpWindowMs = Number.isFinite(followUpWindowMs) ? followUpWindowMs : undefined;
    this.judge         = judge;
    this.getContext    = typeof getContext === 'function' ? getContext : (() => ({ ttsSpeaking: false, lastAddressedTs: 0 }));

    this.queue   = [];
    this.busy    = false;
    this.dropped = 0;
    this._lastAddressedTs = 0;   // updated when an addressed turn fires

    this._onSpeechEnd = this._onSpeechEnd.bind(this);
    if (residentAudio) residentAudio.on('speech-end', this._onSpeechEnd);
  }

  setWakeWords(words) {
    if (Array.isArray(words) && words.length) this.wakeWords = words;
  }
  setWakeRequired(req) { this.wakeRequired = !!req; }
  setFollowUpWindowMs(ms) {
    const n = Number(ms);
    if (Number.isFinite(n) && n > 0) this.followUpWindowMs = n;
  }

  shutdown() {
    if (this.residentAudio) this.residentAudio.off('speech-end', this._onSpeechEnd);
    this.queue.length = 0;
    this.removeAllListeners();
  }

  _onSpeechEnd({ ts, durationMs, pcm, sampleRate }) {
    if (!pcm || !durationMs || durationMs < MIN_UTTERANCE_MS) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      this.dropped++;
      console.warn('[voice] utterance queue full, dropped oldest (total dropped:', this.dropped + ')');
    }
    this.queue.push({ ts, durationMs, pcm, sampleRate: sampleRate || 16000 });
    this._drain();
  }

  async _drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        await this._processOne(job);
      }
    } finally {
      this.busy = false;
    }
  }

  async _processOne({ ts, durationMs, pcm, sampleRate }) {
    if (!isSttReady()) {
      // Model not downloaded yet — emit a one-time hint then drop silently.
      this.emit('error', new Error('whisper model not ready'));
      return;
    }
    let result;
    try {
      result = await transcribePcm(pcm, {
        sampleRate,
        appDir:        this.appDir,
        augmentedPath: this.augmentedPath,
      });
    } catch (e) {
      this.emit('error', e);
      return;
    }
    if (!result || !result.ok) {
      this.emit('error', new Error(result?.error || 'transcribe failed'));
      return;
    }
    const text = (result.text || '').trim();
    // Whisper occasionally hallucinates "[BLANK_AUDIO]" / "(silence)" on
    // very quiet input. Filter those out so they don't pollute downstream.
    if (!text || /^[\[\(].*(blank|silence|music|inaudible).*[\]\)]$/i.test(text)) {
      this.emit('utterance:ignored', { ts, text: '', reason: 'empty' });
      return;
    }

    const wake = matchWake(text, { wakeWords: this.wakeWords });

    // Pull live context (TTS speaking? recent addressed turn?) from the
    // injected provider so the judge is pure + testable.
    let ctx = { ttsSpeaking: false, lastAddressedTs: this._lastAddressedTs };
    try { ctx = { ...ctx, ...(this.getContext() || {}) }; } catch (_) {}
    // Always prefer the pipeline's own record of last-addressed (more
    // accurate than caller-provided if they forgot to update it).
    if (this._lastAddressedTs > (ctx.lastAddressedTs || 0)) {
      ctx.lastAddressedTs = this._lastAddressedTs;
    }

    const verdict = this.judge.classify({
      text,
      wakeMatched: wake.matched,
      command:     wake.command,
      ttsSpeaking: !!ctx.ttsSpeaking,
      lastAddressedTs: ctx.lastAddressedTs || 0,
      now: ts,
      followUpWindowMs: this.followUpWindowMs,
    });

    // Honour the legacy `wakeRequired = false` escape hatch: if wake-word
    // gating is off and the judge said 'ignore', upgrade to 'addressed'.
    let intent  = verdict.intent;
    let command = verdict.command || text;
    if (!this.wakeRequired && intent === 'ignore') {
      intent  = 'addressed';
      command = text;
    }

    const addressed = intent === 'addressed' || intent === 'follow-up';

    this.emit('utterance:transcribed', { ts, durationMs, text, addressed, command, intent });
    this.emit('utterance:intent',      { ts, text, intent, command });

    switch (intent) {
      case 'interrupt':
        this.emit('utterance:interrupt', { ts, text });
        break;
      case 'addressed':
      case 'follow-up':
        this._lastAddressedTs = ts;
        this.emit('utterance:addressed', { ts, text, command, followUp: intent === 'follow-up' });
        break;
      default:
        this.emit('utterance:ignored', { ts, text });
    }
  }
}

let _instance = null;
export function getUtterancePipeline(opts = {}) {
  if (!_instance) _instance = new UtterancePipeline(opts);
  return _instance;
}

// ── Hidden audio-capture renderer (Phase 1) ──────────────────────────────
//
// Runs inside an off-screen BrowserWindow. Owns the microphone, downsamples
// to 16 kHz mono PCM16, and runs a simple energy-based VAD. Streams audio
// frames + VAD events to the main process via the audio-preload bridge
// (window.faunaVoice).
//
// Wake word + Whisper streaming + intent judge are NOT here — they're added
// in later phases. This module only has to deliver:
//   - voice:ready          when mic is open
//   - voice:frame          { pcm: ArrayBuffer(Int16) }  ~every 100ms
//   - voice:speech-start   when sustained voice activity begins
//   - voice:speech-end     when ~700ms of silence follows speech
//   - voice:error          on any unrecoverable failure
//
// VAD strategy: short-term RMS in dBFS with hysteresis. Tunable below.

(() => {
  const TARGET_SR     = 16000;
  const FRAME_MS      = 100;          // emit frames every 100ms
  const SPEECH_DB     = -40;          // above this RMS dBFS = speech
  const SILENCE_DB    = -50;          // below this for SILENCE_HOLD_MS = end
  const SPEECH_HOLD_MS  = 150;        // must be loud this long to count as start
  const SILENCE_HOLD_MS = 700;        // quiet this long after speech = end

  const stateEl = document.getElementById('state');
  const barEl   = document.getElementById('bar');
  const infoEl  = document.getElementById('info');
  const errEl   = document.getElementById('err');

  function setState(s, kind = '') {
    stateEl.textContent = s;
    stateEl.className = 'state ' + kind;
  }
  function showErr(msg) {
    errEl.textContent = msg;
    try { window.faunaVoice?.send('voice:error', { message: msg }); } catch (_) {}
  }

  let ctx = null;
  let stream = null;
  let processor = null;
  let source = null;

  // Buffer to accumulate samples until we have a full FRAME_MS chunk.
  let pending = [];           // array of Float32 sub-arrays at TARGET_SR
  let pendingLen = 0;
  const FRAME_SAMPLES = Math.round((FRAME_MS / 1000) * TARGET_SR);

  // VAD state
  let inSpeech = false;
  let loudSince = 0;
  let quietSince = 0;

  async function start() {
    try {
      // Ask for raw audio with browser AEC/NS enabled — this also helps when
      // Fauna's own TTS plays through the same default output device later.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
        },
        video: false,
      });
    } catch (e) {
      showErr('mic permission denied: ' + e.message);
      setState('error');
      return;
    }

    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: TARGET_SR,   // may be ignored; we resample below if needed
      });
    } catch (e) {
      showErr('audio context failed: ' + e.message);
      return;
    }

    source = ctx.createMediaStreamSource(stream);

    // ScriptProcessor is deprecated but works everywhere in Electron without
    // needing a separate AudioWorklet file. Buffer size 2048 ≈ 128ms @ 16k or
    // ~46ms @ 44.1k — small enough for low-latency VAD.
    processor = ctx.createScriptProcessor(2048, 1, 1);
    source.connect(processor);
    processor.connect(ctx.destination); // required for ScriptProcessor to fire

    const srcSR = ctx.sampleRate;
    const ratio = srcSR / TARGET_SR;

    processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      const down = (ratio === 1) ? input : downsample(input, ratio);
      pending.push(down);
      pendingLen += down.length;

      while (pendingLen >= FRAME_SAMPLES) {
        const frame = takeFrame(FRAME_SAMPLES);
        emitFrame(frame);
        runVad(frame);
      }
    };

    setState('listening', 'live');
    infoEl.textContent = `sr=${srcSR} → ${TARGET_SR}`;
    try { window.faunaVoice?.send('voice:ready', { ts: Date.now(), sourceRate: srcSR }); } catch (_) {}
  }

  function takeFrame(n) {
    const out = new Float32Array(n);
    let off = 0;
    while (off < n && pending.length) {
      const head = pending[0];
      const take = Math.min(head.length, n - off);
      out.set(head.subarray(0, take), off);
      off += take;
      if (take === head.length) pending.shift();
      else pending[0] = head.subarray(take);
    }
    pendingLen -= n;
    return out;
  }

  function downsample(input, ratio) {
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    // Simple decimating average; good enough for whisper. Replace later if
    // we want better anti-aliasing.
    let pos = 0;
    for (let i = 0; i < outLen; i++) {
      const next = Math.floor((i + 1) * ratio);
      let sum = 0, count = 0;
      for (let j = pos; j < next && j < input.length; j++) { sum += input[j]; count++; }
      out[i] = count ? sum / count : 0;
      pos = next;
    }
    return out;
  }

  function emitFrame(float32) {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    // Transfer the underlying buffer to main; we won't reuse it on this side.
    try {
      window.faunaVoice?.send('voice:frame', { pcm: int16.buffer }, [int16.buffer]);
    } catch (_) {
      // Some IPC paths can't transfer — fall back to copy.
      try { window.faunaVoice?.send('voice:frame', { pcm: int16.buffer.slice(0) }); } catch (_) {}
    }
  }

  function runVad(float32) {
    // RMS in dBFS
    let sum = 0;
    for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    const rms = Math.sqrt(sum / float32.length);
    const db  = rms > 0 ? 20 * Math.log10(rms) : -120;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    barEl.style.width = pct.toFixed(0) + '%';

    const now = performance.now();
    if (db >= SPEECH_DB) {
      if (!loudSince) loudSince = now;
      quietSince = 0;
      if (!inSpeech && (now - loudSince) >= SPEECH_HOLD_MS) {
        inSpeech = true;
        setState('speaking', 'speak');
        try { window.faunaVoice?.send('voice:speech-start', { ts: Date.now() }); } catch (_) {}
      }
    } else if (db <= SILENCE_DB) {
      if (!quietSince) quietSince = now;
      loudSince = 0;
      if (inSpeech && (now - quietSince) >= SILENCE_HOLD_MS) {
        inSpeech = false;
        setState('listening', 'live');
        try { window.faunaVoice?.send('voice:speech-end', { ts: Date.now() }); } catch (_) {}
      }
    } else {
      // Hysteresis dead-zone: hold current state.
    }
  }

  // Clean up on close so the OS mic indicator releases.
  window.addEventListener('beforeunload', () => {
    try { processor?.disconnect(); } catch (_) {}
    try { source?.disconnect(); } catch (_) {}
    try { stream?.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { ctx?.close(); } catch (_) {}
  });

  start();
})();

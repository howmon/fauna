// ── Dictation capture renderer (Phase 5) ─────────────────────────────────
//
// Opens the microphone, continuously appends PCM16@16k mono samples to a
// single in-memory buffer, and when told to stop ships the whole buffer
// back to main as a single transferable. No VAD — dictation explicitly
// captures everything between start and stop so pauses inside sentences
// are preserved.
//
// IPC contract (window.faunaDictation, exposed by audio-preload.js):
//   send 'dictation:ready'                                  — mic opened
//   send 'dictation:level' { pct }                          — for UI bar
//   send 'dictation:result' { pcm:ArrayBuffer, samples }    — on stop
//   send 'dictation:error'  { message }                     — on failure
//   on   'dictation:stop'                                   — main asks us to finalise

(() => {
  const TARGET_SR  = 16000;
  const FRAME_MS   = 100;
  const MAX_SECONDS = 120;          // safety cap; main may stop earlier

  const stateEl = document.getElementById('state');
  const barEl   = document.getElementById('bar');
  const infoEl  = document.getElementById('info');
  const errEl   = document.getElementById('err');

  function showErr(msg) {
    errEl.textContent = msg;
    try { window.faunaDictation?.send('dictation:error', { message: msg }); } catch (_) {}
  }

  let ctx = null, stream = null, processor = null, source = null;
  let chunks = [];           // Array<Int16Array>
  let totalSamples = 0;
  let finished = false;
  let pending = [];          // accumulator before each FRAME_MS flush
  let pendingLen = 0;
  const FRAME_SAMPLES = Math.round((FRAME_MS / 1000) * TARGET_SR);
  const MAX_SAMPLES = MAX_SECONDS * TARGET_SR;

  async function start() {
    // Resolve preferred input device from voice-settings (best-effort: if the
    // server is unreachable or the saved deviceId no longer exists we fall
    // back to the OS default mic).
    let deviceId = '';
    try {
      const r = await fetch('/api/voice-settings');
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok && j.settings && typeof j.settings.dictationDeviceId === 'string') {
          deviceId = j.settings.dictationDeviceId;
        }
      }
    } catch (_) { /* offline or pre-server-ready; default mic is fine */ }

    const audioConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    } catch (e) {
      // If the saved device is gone / blocked, retry once with the default.
      if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          });
        } catch (e2) {
          showErr('mic permission denied: ' + e2.message);
          stateEl.textContent = 'error';
          return;
        }
      } else {
        showErr('mic permission denied: ' + e.message);
        stateEl.textContent = 'error';
        return;
      }
    }
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_SR });
    source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(2048, 1, 1);
    source.connect(processor);
    processor.connect(ctx.destination);

    const srcSR = ctx.sampleRate;
    const ratio = srcSR / TARGET_SR;
    infoEl.textContent = `sr=${srcSR} → ${TARGET_SR}`;

    processor.onaudioprocess = (ev) => {
      if (finished) return;
      const input = ev.inputBuffer.getChannelData(0);
      const down  = (ratio === 1) ? input : downsample(input, ratio);
      pending.push(down);
      pendingLen += down.length;

      while (pendingLen >= FRAME_SAMPLES) {
        const frame = takeFrame(FRAME_SAMPLES);
        const int16 = float32ToInt16(frame);
        chunks.push(int16);
        totalSamples += int16.length;
        updateLevel(frame);
        if (totalSamples >= MAX_SAMPLES) {
          // Self-stop on overflow so we don't OOM the renderer.
          finish('max-duration');
          break;
        }
      }
    };

    try { window.faunaDictation?.send('dictation:ready', { ts: Date.now(), sourceRate: srcSR }); } catch (_) {}
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
  function float32ToInt16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  function updateLevel(f32) {
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / f32.length);
    const db  = rms > 0 ? 20 * Math.log10(rms) : -120;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    barEl.style.width = pct.toFixed(0) + '%';
  }

  function finish(reason) {
    if (finished) return;
    finished = true;
    stateEl.textContent = 'finishing';
    try { processor?.disconnect(); } catch (_) {}
    try { source?.disconnect(); } catch (_) {}
    try { stream?.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { ctx?.close(); } catch (_) {}

    // Concatenate everything into one Int16Array, then transfer the buffer.
    const merged = new Int16Array(totalSamples);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    chunks = []; // help GC
    try {
      window.faunaDictation?.send('dictation:result',
        { pcm: merged.buffer, samples: totalSamples, reason: reason || 'stopped' },
        [merged.buffer]);
    } catch (e) {
      showErr('dictation send failed: ' + e.message);
    }
  }

  // Main asks us to finalise via this channel.
  window.faunaDictation?.onStop?.(() => finish('stop-requested'));

  window.addEventListener('beforeunload', () => { if (!finished) finish('unload'); });

  start();
})();

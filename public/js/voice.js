// ── Voice Control ─────────────────────────────────────────────────────────
// Wake-word detection + command routing via Web Speech API.
// Runs entirely in Chromium — no server, no API key required.

var VOICE_SETTINGS_KEY = 'fauna-voice-settings';
var VOICE_WAKEWORD_KEY = 'fauna-voice-wakeword';

var _voiceEnabled     = false;
var _whisperWorker    = null;   // Web Worker running Whisper
var _whisperReady     = false;  // model loaded and ready
var _micStream        = null;   // MediaStream from getUserMedia
var _audioCtx         = null;   // AudioContext for VAD analyser
var _micSource        = null;   // MediaStreamSourceNode — must stay referenced (GC breaks graph)
var _analyserNode     = null;   // AnalyserNode for energy detection
var _mediaRecorder    = null;   // MediaRecorder for audio chunks
var _recordChunks     = [];     // Blob chunks from current recording
var _voiceActive      = false;  // in command capture mode
var _vadState         = 'idle'; // 'idle'|'recording_wake'|'recording_cmd'|'transcribing'
var _vadSpeechFrames  = 0;      // consecutive frames above energy threshold
var _vadSilenceFrames = 0;      // consecutive frames below threshold
var _vadTimer         = null;   // setInterval id for VAD loop

// ── Persistence ───────────────────────────────────────────────────────────

function _loadVoiceSettings() {
  try { return JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) || '{}'); }
  catch (_) { return {}; }
}

function _saveVoiceSettings(s) {
  localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(s));
}

function getWakeWord() {
  return (localStorage.getItem(VOICE_WAKEWORD_KEY) || 'fauna').toLowerCase().trim();
}

function _setWakeWord(w) {
  localStorage.setItem(VOICE_WAKEWORD_KEY, w.trim().toLowerCase());
}

// ── Audio feedback ────────────────────────────────────────────────────────

function _playVoiceChime(type) {
  try {
    var ctx  = new (window.AudioContext || window.webkitAudioContext)();
    var osc  = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    if (type === 'activate') {
      // Rising two-tone: wake word matched
      osc.frequency.setValueAtTime(820, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1100, ctx.currentTime + 0.14);
    } else {
      // Falling: command captured / dismissed
      osc.frequency.setValueAtTime(700, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.14);
    }
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = function() { ctx.close(); };
  } catch (_) {}
}

// ── Text-to-speech ────────────────────────────────────────────────────────

var _speakTimer = null;

function _speak(text) {
  if (!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  var utt = new SpeechSynthesisUtterance(text);
  utt.rate   = 1.05;
  utt.pitch  = 1.0;
  utt.volume = 0.9;
  var voices = window.speechSynthesis.getVoices();
  var preferred = voices.find(function(v) {
    return /samantha|karen|daniel|google us|zira/i.test(v.name);
  }) || voices.find(function(v) { return v.lang === 'en-US'; });
  if (preferred) utt.voice = preferred;

  // Show response card
  _showResponseCard(text);

  utt.onend = function() { _hideResponseCard(); };
  utt.onerror = function() { _hideResponseCard(); };

  window.speechSynthesis.speak(utt);
}

function _showResponseCard(text) {
  var card = document.getElementById('voice-response-card');
  var textEl = document.getElementById('voice-response-text');
  if (!card) return;
  if (textEl) textEl.textContent = text;
  card.classList.add('visible');
  // Safety auto-hide after 12s in case onend never fires
  if (_speakTimer) clearTimeout(_speakTimer);
  _speakTimer = setTimeout(_hideResponseCard, 12000);
}

function _hideResponseCard() {
  if (_speakTimer) { clearTimeout(_speakTimer); _speakTimer = null; }
  var card = document.getElementById('voice-response-card');
  if (card) card.classList.remove('visible');
}

// ── Mic pill state ────────────────────────────────────────────────────────
// data-voice-state: 'off' | 'listening' | 'active'

function _setVoicePillState(st) {
  var btn = document.getElementById('voice-mic-btn');
  if (!btn) return;
  btn.dataset.voiceState = st;
  var icon = btn.querySelector('i');
  if (!icon) return;
  icon.className = (st === 'off') ? 'ti ti-microphone-off' : 'ti ti-microphone';
}

// ── Voice overlay ─────────────────────────────────────────────────────────

function _showVoiceOverlay(transcript) {
  var ov = document.getElementById('voice-overlay');
  var tx = document.getElementById('voice-overlay-text');
  if (!ov) return;
  ov.classList.add('visible');
  if (tx) tx.textContent = transcript || 'Listening…';
}

function _hideVoiceOverlay() {
  var ov = document.getElementById('voice-overlay');
  if (ov) ov.classList.remove('visible');
}

// ── Command routing ───────────────────────────────────────────────────────

var _VOICE_ROUTES = [
  // ── Status queries (always speak the answer) ───────────────────────────
  {
    pattern: /\b(how many|list|what|show)\s+(?:my\s+)?agents?\b/i,
    action: function() {
      var agents = typeof getAllAgents === 'function' ? getAllAgents() : [];
      var n = agents.length;
      if (n === 0) {
        _speak('You have no agents installed.');
      } else {
        var names = agents.slice(0, 4).map(function(a) { return a.displayName || a.name; }).join(', ');
        _speak('You have ' + n + ' agent' + (n === 1 ? '' : 's') + ': ' + names + (n > 4 ? ', and more.' : '.'));
      }
    }
  },
  {
    pattern: /\b(what|which)\s+model\b/i,
    action: function() {
      var sel = document.getElementById('model-select');
      var model = sel ? (sel.options[sel.selectedIndex] || {}).text || sel.value : 'unknown';
      _speak('You are using ' + model + '.');
    }
  },
  {
    pattern: /\b(are you|is\s+(?:the\s+)?figma)\s+(?:connected|online|running|active)\b/i,
    action: function() {
      var dot = document.getElementById('figma-dot');
      var connected = dot && dot.classList.contains('on');
      _speak(connected ? 'Yes, Figma MCP is connected.' : 'No, Figma MCP is not connected.');
    }
  },
  {
    pattern: /\b(what(?:'s|\s+is)\s+(?:my\s+)?(?:current\s+)?conversation|what\s+(?:am\s+i|are\s+we)\s+(?:working\s+on|talking\s+about))\b/i,
    action: function() {
      var title = document.getElementById('topbar-title');
      var t = title ? title.textContent.trim() : '';
      _speak(t && t !== 'New conversation' ? 'Current conversation: ' + t : 'You have no active conversation.');
    }
  },
  {
    pattern: /\b(how many|how\s+much)\s+(?:conversations?|chats?)\b/i,
    action: function() {
      var n = (typeof state !== 'undefined' && state.conversations) ? state.conversations.length : 0;
      _speak('You have ' + n + ' conversation' + (n === 1 ? '.' : 's.'));
    }
  },
  {
    pattern: /\bwhat\s+(?:can\s+you|do\s+you)\s+(?:do|understand|support)\b/i,
    action: function() {
      _speak('You can say: install agent, uninstall agent, open store, new conversation, open settings, build an agent, switch to a conversation, or ask me a status question like what model or how many agents.');
    }
  },

  // ── Actions (speak a confirmation after performing) ────────────────────
  {
    pattern: /\b(install|add|get)\s+(?:the\s+)?(?:agent\s+)?(.+)/i,
    action: function(m) {
      var name = m[2].trim();
      if (typeof openAgentStore === 'function') openAgentStore();
      setTimeout(function() {
        var search = document.getElementById('store-search-input');
        if (search) {
          search.value = name;
          search.dispatchEvent(new Event('input'));
        }
      }, 600);
      _speak('Searching for ' + name + ' in the agent store.');
    }
  },
  {
    pattern: /\b(uninstall|remove|delete)\s+(?:the\s+)?(?:agent\s+)?(.+)/i,
    action: function(m) {
      var name = m[2].trim();
      var agents = typeof getAllAgents === 'function' ? getAllAgents() : [];
      var found = agents.find(function(a) {
        return a.name.toLowerCase().includes(name.toLowerCase()) ||
               (a.displayName || '').toLowerCase().includes(name.toLowerCase());
      });
      if (found) {
        _speak('Removing ' + (found.displayName || found.name) + '.');
        if (typeof deleteAgent === 'function') deleteAgent(found.name);
      } else {
        _speak('No agent found matching ' + name + '.');
        if (typeof showToast === 'function') showToast('No agent found matching "' + name + '"');
      }
    }
  },
  {
    pattern: /\b(open|show)\s+(?:the\s+)?(?:agent\s+)?store\b/i,
    action: function() {
      _speak('Opening the agent store.');
      if (typeof openAgentStore === 'function') openAgentStore();
    }
  },
  {
    pattern: /\b(new|start)\s+(?:a\s+)?(?:conversation|chat)\b/i,
    action: function() {
      _speak('Starting a new conversation.');
      if (typeof newConversation === 'function') newConversation();
    }
  },
  {
    pattern: /\b(?:open\s+)?settings\b/i,
    action: function() {
      _speak('Opening settings.');
      if (typeof toggleSettings === 'function') toggleSettings();
    }
  },
  {
    pattern: /\b(?:build|create|make)\s+(?:an?\s+)?agent\b/i,
    action: function() {
      _speak('Opening the agent builder.');
      if (typeof openAgentBuilder === 'function') openAgentBuilder();
    }
  },
  {
    pattern: /\b(?:switch\s+to|open)\s+(?:conversation\s+)?(.+)/i,
    action: function(m) {
      var name = m[1].trim();
      var convs = (typeof state !== 'undefined' && state.conversations) ? state.conversations : [];
      var found = convs.find(function(c) {
        return (c.title || '').toLowerCase().includes(name.toLowerCase());
      });
      if (found) {
        _speak('Switching to ' + found.title + '.');
        if (typeof loadConversation === 'function') loadConversation(found.id);
      } else {
        _speak('No conversation found matching ' + name + '.');
        if (typeof showToast === 'function') showToast('No conversation matching "' + name + '"');
      }
    }
  }
];

function _routeVoiceCommand(transcript) {
  var t = transcript.trim();
  if (!t) return;

  for (var i = 0; i < _VOICE_ROUTES.length; i++) {
    var m = t.match(_VOICE_ROUTES[i].pattern);
    if (m) {
      _VOICE_ROUTES[i].action(m);
      return;
    }
  }

  // Default: inject into the chat input and submit
  var input = document.getElementById('msg-input');
  if (input) {
    input.value = t;
    if (typeof resizeTextarea === 'function') resizeTextarea(input);
    if (typeof sendMessage === 'function') sendMessage();
  }
}

// ── Whisper worker ────────────────────────────────────────────────────────

function _initWhisperWorker() {
  if (_whisperWorker) return;
  _whisperWorker = new Worker('/js/whisper-worker.js', { type: 'module' });
  _whisperWorker.onmessage = function(e) {
    var d = e.data;
    if (d.type === 'ready') {
      _whisperReady = true;
      if (typeof showToast === 'function') showToast('Voice ready — say "' + getWakeWord() + '" to activate');
    } else if (d.type === 'status') {
      console.log('[whisper]', d.msg);
      if (typeof showToast === 'function') showToast(d.msg);
    } else if (d.type === 'result') {
      _onWhisperResult(d.text);
    } else if (d.type === 'error') {
      console.error('[whisper] error:', d.error);
      _vadState    = 'idle';
      _voiceActive = false;
      _hideVoiceOverlay();
      _setVoicePillState(_voiceEnabled ? 'listening' : 'off');
    }
  };
  _whisperWorker.onerror = function(err) {
    console.error('[whisper] Worker crashed:', err);
    _whisperReady  = false;
    _whisperWorker = null;
  };
}

// ── Audio pipeline ────────────────────────────────────────────────────────

async function _resampleTo16k(audioBuffer) {
  var targetRate = 16000;
  var numFrames  = Math.ceil(audioBuffer.duration * targetRate);
  if (numFrames < 1) return new Float32Array(0);
  var offCtx = new OfflineAudioContext(1, numFrames, targetRate);
  var src    = offCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offCtx.destination);
  src.start(0);
  var rendered = await offCtx.startRendering();
  return rendered.getChannelData(0);
}

function _bestMime() {
  var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (var i = 0; i < types.length; i++) {
    if (MediaRecorder.isTypeSupported(types[i])) return types[i];
  }
  return '';
}

async function _transcribeBlobs(chunks, mode) {
  if (!chunks.length || !_whisperWorker || !_whisperReady) {
    _vadState    = 'idle';
    _voiceActive = false;
    _hideVoiceOverlay();
    _setVoicePillState(_voiceEnabled ? 'listening' : 'off');
    return;
  }
  console.log('[voice] transcribing', chunks.length, 'chunks, total bytes:', chunks.reduce(function(s,c){return s+c.size;},0), 'mode:', mode);
  try {
    var blobType = (chunks[0] && chunks[0].type) || 'audio/webm';
    var blob     = new Blob(chunks, { type: blobType });
    console.log('[voice] blob type:', blobType, 'size:', blob.size);
    var arrayBuf = await blob.arrayBuffer();
    var audioBuf = await _audioCtx.decodeAudioData(arrayBuf);
    console.log('[voice] decoded audio — duration:', audioBuf.duration.toFixed(3) + 's', 'sampleRate:', audioBuf.sampleRate, 'channels:', audioBuf.numberOfChannels);
    var float32  = await _resampleTo16k(audioBuf);
    var maxAmp = 0; for (var i = 0; i < float32.length; i++) { var a = Math.abs(float32[i]); if (a > maxAmp) maxAmp = a; }
    console.log('[voice] resampled float32 — length:', float32.length, 'maxAmplitude:', maxAmp.toFixed(4));
    if (float32.length < 1600) {        // < 0.1s — noise, ignore
      _vadState = 'idle';
      if (mode === 'cmd') { _voiceActive = false; _hideVoiceOverlay(); _setVoicePillState(_voiceEnabled ? 'listening' : 'off'); }
      return;
    }
    _vadState = 'transcribing';
    _whisperWorker.postMessage({ type: 'transcribe', audio: float32 }, [float32.buffer]);
  } catch (err) {
    console.warn('[voice] audio decode error:', err);
    _vadState    = 'idle';
    _voiceActive = false;
    _hideVoiceOverlay();
    _setVoicePillState(_voiceEnabled ? 'listening' : 'off');
  }
}

// ── VAD (Voice Activity Detection) ───────────────────────────────────────

var VAD_RMS_THRESHOLD       = 0.004;  // energy floor: speech vs ambient
var VAD_SPEECH_FRAMES_START = 3;      // consecutive loud frames to start recording (~300ms)
var VAD_SILENCE_FRAMES_WAKE = 10;     // silence frames to end wake chunk (~1s)
var VAD_SILENCE_FRAMES_CMD  = 12;     // silence frames to end command chunk (~1.2s)
var VAD_MAX_WAKE_FRAMES     = 30;     // max frames before force-stopping wake recording (~3s)
var _vadPeakRms             = 0;      // peak RMS during current recording (for threshold tuning)
var _vadRecordFrames        = 0;      // frames elapsed since recording started

function _rms(data) {
  var sum = 0;
  for (var i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

var _vadRmsLogTimer = 0;
function _startVADLoop() {
  if (_vadTimer) clearInterval(_vadTimer);
  var buf = new Float32Array(_analyserNode.fftSize);
  _vadTimer = setInterval(function() {
    if (!_voiceEnabled || !_analyserNode) { clearInterval(_vadTimer); return; }
    if (_audioCtx.state === 'suspended' || _audioCtx.state === 'interrupted') {
      console.log('[vad] AudioContext', _audioCtx.state, '— resuming');
      _audioCtx.resume().catch(function(){});
      // don't return — keep polling; reads will be zero until resumed
    }
    if (_vadState === 'transcribing') return;

    _analyserNode.getFloatTimeDomainData(buf);
    var level         = _rms(buf);
    var now = Date.now();
    if (now - _vadRmsLogTimer > 2000) { _vadRmsLogTimer = now; console.log('[vad] rms:', level.toFixed(4), '| threshold:', VAD_RMS_THRESHOLD, '| state:', _vadState); }
    var silenceFrames = (_vadState === 'recording_cmd') ? VAD_SILENCE_FRAMES_CMD : VAD_SILENCE_FRAMES_WAKE;

    if (level > VAD_RMS_THRESHOLD) {
      _vadSilenceFrames = 0;
      _vadSpeechFrames++;
      if (_vadState === 'recording_wake' || _vadState === 'recording_cmd') {
        if (level > _vadPeakRms) _vadPeakRms = level;
        _vadRecordFrames++;
      }
      if (_vadSpeechFrames >= VAD_SPEECH_FRAMES_START && _vadState === 'idle') {
        var nextState    = _voiceActive ? 'recording_cmd' : 'recording_wake';
        _vadState        = nextState;
        _vadSpeechFrames = 0;
        _vadPeakRms      = 0;
        _vadRecordFrames = 0;
        _recordChunks    = [];
        try {
          var mime = _bestMime();
          console.log('[vad] speech detected — starting MediaRecorder, mode:', nextState, 'mime:', mime || '(default)');
          _mediaRecorder = new MediaRecorder(_micStream, mime ? { mimeType: mime } : {});
          _mediaRecorder.ondataavailable = function(ev) {
            if (ev.data && ev.data.size > 0) _recordChunks.push(ev.data);
          };
          _mediaRecorder.start(100);
          if (nextState === 'recording_cmd') _showVoiceOverlay('Listening…');
        } catch (err) {
          console.warn('[voice] MediaRecorder start error:', err);
          _vadState = 'idle';
        }
      }
    } else {
      _vadSpeechFrames = 0;
      if (_vadState === 'recording_wake' || _vadState === 'recording_cmd') {
        _vadRecordFrames++;
        _vadSilenceFrames++;
        var forceStop = (_vadState === 'recording_wake' && _vadRecordFrames >= VAD_MAX_WAKE_FRAMES);
        if (_vadSilenceFrames >= silenceFrames || forceStop) {
          if (forceStop) console.log('[vad] force-stopping wake recording after', _vadRecordFrames, 'frames');
          var capturedMode   = (_vadState === 'recording_cmd') ? 'cmd' : 'wake';
          console.log('[vad] end of speech — peak rms during recording:', _vadPeakRms.toFixed(4));
          _vadSpeechFrames   = 0;
          _vadSilenceFrames  = 0;
          _vadPeakRms        = 0;
          _vadRecordFrames   = 0;
          _vadState          = 'transcribing';  // block VAD from starting a new recording before onstop fires
          if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
            var mr = _mediaRecorder;
            mr.onstop = function() {
              // Slice AFTER onstop so we include the final ondataavailable chunk
              _transcribeBlobs(_recordChunks.slice(), capturedMode);
            };
            try { mr.stop(); } catch (_) {}
          }
        }
      }
    }
  }, 100);
}

// ── Whisper result handler ────────────────────────────────────────────────

// Whisper hallucination tokens to ignore
var WHISPER_NOISE_TOKENS = /^\s*\*?(?:unintelligible|inaudible|silence|music|noise|applause|laughter|\[.*?\])\*?\s*$/i;

function _onWhisperResult(text) {
  var lower = (text || '').toLowerCase().trim();
  console.log('[whisper] (' + (_voiceActive ? 'cmd' : 'wake') + '):', lower);

  // Ignore hallucination/noise tokens
  if (!lower || WHISPER_NOISE_TOKENS.test(lower)) {
    _vadState = 'idle';
    return;
  }

  if (!_voiceActive) {
    // Wake word scan
    _vadState = 'idle';
    if (lower.includes(getWakeWord())) {
      var ww        = getWakeWord();
      var idx       = lower.indexOf(ww);
      var afterWake = text.slice(idx + ww.length).replace(/^[\s,.!?]+/, '').trim();
      if (afterWake.length > 2) {
        // Inline command: "fauna new conversation"
        _playVoiceChime('activate');
        setTimeout(function() { _playVoiceChime('dismiss'); }, 300);
        _routeVoiceCommand(afterWake);
      } else {
        _enterCommandMode();
      }
    }
    // No wake word found: VAD continues scanning
  } else {
    // Command result
    _exitCommandMode(lower);
  }
}

// ── Command mode ──────────────────────────────────────────────────────────

function _enterCommandMode() {
  if (_voiceActive) return;
  _voiceActive      = true;
  _vadState         = 'idle';   // let VAD pick up command speech
  _vadSpeechFrames  = 0;
  _vadSilenceFrames = 0;
  _playVoiceChime('activate');
  _setVoicePillState('active');
  _showVoiceOverlay('');
  // Guard: auto-exit after 8s
  setTimeout(function() {
    if (!_voiceActive) return;
    if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
      var chunks = _recordChunks.slice();
      var mr = _mediaRecorder;
      mr.onstop = function() {
        if (chunks.length) _transcribeBlobs(chunks, 'cmd');
        else _exitCommandMode('');
      };
      try { mr.stop(); } catch (_) { _exitCommandMode(''); }
    } else {
      _exitCommandMode('');
    }
  }, 8000);
}

function _exitCommandMode(transcript) {
  _voiceActive = false;
  _vadState    = 'idle';
  _playVoiceChime('dismiss');
  _hideVoiceOverlay();
  _setVoicePillState(_voiceEnabled ? 'listening' : 'off');
  if ((transcript || '').trim()) _routeVoiceCommand(transcript.trim());
}

// ── Wake word listener (VAD + Whisper) ───────────────────────────────────

function _startWakeListener() {
  if (!_voiceEnabled) return;
  _vadState         = 'idle';
  _vadSpeechFrames  = 0;
  _vadSilenceFrames = 0;

  if (_micStream) {
    // Mic already open — restart VAD loop
    _startVADLoop();
    _setVoicePillState('listening');
    return;
  }

  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then(function(stream) {
      _micStream    = stream;
      _audioCtx     = new (window.AudioContext || window.webkitAudioContext)();
      _audioCtx.resume().catch(function(){});  // unblock autoplay suspension immediately
      _micSource    = _audioCtx.createMediaStreamSource(stream);  // keep ref — prevents GC disconnect
      _analyserNode = _audioCtx.createAnalyser();
      _analyserNode.fftSize = 2048;
      _micSource.connect(_analyserNode);
      // NOT connected to destination — avoids mic feedback
      _startVADLoop();
      _setVoicePillState('listening');
    })
    .catch(function(err) {
      console.error('[voice] getUserMedia error:', err);
      _voiceEnabled = false;
      _setVoicePillState('off');
      _syncVoiceToggleUI(false);
      var s = _loadVoiceSettings(); s.enabled = false; _saveVoiceSettings(s);
      if (typeof showToast === 'function') showToast('Microphone access denied — check Fauna permissions in System Settings');
    });
}

function _stopVoiceListeners() {
  if (_vadTimer) { clearInterval(_vadTimer); _vadTimer = null; }
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
    try { _mediaRecorder.stop(); } catch (_) {}
    _mediaRecorder = null;
  }
  if (_micStream) {
    _micStream.getTracks().forEach(function(t) { t.stop(); });
    _micStream = null;
  }
  if (_micSource) {
    try { _micSource.disconnect(); } catch (_) {}
    _micSource = null;
  }
  if (_audioCtx) {
    try { _audioCtx.close(); } catch (_) {}
    _audioCtx     = null;
    _analyserNode = null;
  }
  _vadState         = 'idle';
  _vadSpeechFrames  = 0;
  _vadSilenceFrames = 0;
  _voiceActive      = false;
  _recordChunks     = [];
  _hideVoiceOverlay();
  _setVoicePillState('off');
}

// ── Settings UI sync ──────────────────────────────────────────────────────

function _syncVoiceToggleUI(enabled) {
  var tog = document.getElementById('voice-toggle');
  if (tog) tog.checked = enabled;
  var wakeRow = document.getElementById('voice-wake-row');
  if (wakeRow) wakeRow.style.display = enabled ? '' : 'none';
}

function _loadVoiceSettingsUI() {
  var s = _loadVoiceSettings();
  _syncVoiceToggleUI(s.enabled || false);
  var wakeInput = document.getElementById('voice-wake-input');
  if (wakeInput) wakeInput.value = getWakeWord();
}

// ── Public API ────────────────────────────────────────────────────────────

function setVoiceEnabled(enabled) {
  var s = _loadVoiceSettings();
  s.enabled = enabled;
  _saveVoiceSettings(s);
  _syncVoiceToggleUI(enabled);

  if (enabled) {
    _voiceEnabled = true;
    _initWhisperWorker();
    _startWakeListener();
    setTimeout(function() {
      _speak('Voice control on. Say ' + getWakeWord() + ' to activate.');
    }, 500);
  } else {
    _voiceEnabled = false;
    _stopVoiceListeners();
    _speak('Voice control off.');
  }
}

function saveVoiceWakeWord() {
  var input = document.getElementById('voice-wake-input');
  if (!input) return;
  var w = input.value.trim().toLowerCase();
  if (!w) return;
  _setWakeWord(w);
  if (typeof showToast === 'function') showToast('Wake word set to "' + w + '"');
  // No restart needed — wake word is checked at transcription time
}

function initVoice() {
  var btn = document.getElementById('voice-mic-btn');

  // Restore saved enabled state
  var s = _loadVoiceSettings();
  _voiceEnabled = s.enabled || false;

  if (_voiceEnabled) {
    _initWhisperWorker();
    _startWakeListener();
  } else {
    _setVoicePillState('off');
  }

  // Mic button: click to toggle voice on/off
  if (btn) {
    btn.addEventListener('click', function() {
      setVoiceEnabled(!_voiceEnabled);
    });
  }

  // Sync settings UI whenever the settings panel opens
  var settingsPanel = document.getElementById('settings-panel');
  if (settingsPanel) {
    var obs = new MutationObserver(function() {
      if (settingsPanel.classList.contains('open')) _loadVoiceSettingsUI();
    });
    obs.observe(settingsPanel, { attributes: true, attributeFilter: ['class'] });
  }
}

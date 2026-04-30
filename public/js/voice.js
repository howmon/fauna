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
var _ttsActive  = false;   // true while speechSynthesis is playing
var _ttsResumeText = null; // text saved for false-interruption recovery
var _ttsResumeTimer = null;

function _speak(text) {
  if (!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  _ttsActive     = true;
  _ttsResumeText = text;
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

  utt.onend = function() { _ttsActive = false; _ttsResumeText = null; _hideResponseCard(); };
  utt.onerror = function() { _ttsActive = false; _ttsResumeText = null; _hideResponseCard(); };

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
      _speak('You can say: install agent, uninstall agent, open store, new conversation, open settings, build an agent, switch to a conversation, next or previous conversation, status of a conversation, progress of a conversation, list conversations, or summarize a conversation.');
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
  },

  // ── Conversation context & progress ───────────────────────────────────
  {
    // "what's the status of X" / "check status of X" / "status of X"
    pattern: /\b(?:what(?:'s|\s+is)\s+(?:the\s+)?status\s+of|check\s+(?:the\s+)?status\s+of|status\s+of)\s+(.+)/i,
    action: function(m) {
      var name = m[1].trim();
      var convs = (typeof state !== 'undefined' && state.conversations) ? state.conversations : [];
      var found = convs.find(function(c) {
        return (c.title || '').toLowerCase().includes(name.toLowerCase());
      });
      if (!found) { _speak('No conversation found matching ' + name + '.'); return; }
      var msgs = found.messages || [];
      var n = msgs.length;
      if (n === 0) { _speak(found.title + ' has no messages yet.'); return; }
      // Find the last assistant message as the "status"
      var last = null;
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') { last = msgs[i]; break; }
      }
      var preview = last ? (last.content || '').replace(/[#*`]/g, '').trim().slice(0, 200) : '';
      if (preview.length === 200) preview += '…';
      _speak(found.title + ' has ' + n + ' message' + (n === 1 ? '' : 's') + '. Last reply: ' + (preview || 'no reply yet.'));
    }
  },
  {
    // "what's the progress of X" / "check progress on X" / "how is X going"
    pattern: /\b(?:what(?:'s|\s+is)\s+(?:the\s+)?progress\s+(?:of|on)|check\s+progress\s+(?:of|on)|how\s+is\s+)\s*(.+?)\s*(?:going|doing|coming along)?\b/i,
    action: function(m) {
      var name = m[1].trim();
      var convs = (typeof state !== 'undefined' && state.conversations) ? state.conversations : [];
      var found = convs.find(function(c) {
        return (c.title || '').toLowerCase().includes(name.toLowerCase());
      });
      if (!found) { _speak('No conversation found matching ' + name + '.'); return; }
      var msgs = found.messages || [];
      var userCount = msgs.filter(function(x) { return x.role === 'user'; }).length;
      var asstCount = msgs.filter(function(x) { return x.role === 'assistant'; }).length;
      if (msgs.length === 0) { _speak(found.title + ' hasn\'t started yet.'); return; }
      _speak(found.title + ': ' + userCount + ' prompt' + (userCount === 1 ? '' : 's') + ' sent, ' + asstCount + ' repl' + (asstCount === 1 ? 'y' : 'ies') + ' received.');
    }
  },
  {
    // "list all conversations" / "what conversations do I have" / "show my conversations"
    pattern: /\b(?:list|show|what)\s+(?:all\s+)?(?:my\s+)?conversations?\b/i,
    action: function() {
      var convs = (typeof state !== 'undefined' && state.conversations) ? state.conversations : [];
      if (convs.length === 0) { _speak('You have no conversations.'); return; }
      var names = convs.slice(0, 5).map(function(c, i) { return (i + 1) + ': ' + (c.title || 'Untitled'); }).join('. ');
      _speak('You have ' + convs.length + ' conversation' + (convs.length === 1 ? '' : 's') + '. ' + names + (convs.length > 5 ? ', and more.' : '.'));
    }
  },
  {
    // "go to next conversation" / "next conversation" / "previous conversation"
    pattern: /\b(next|previous|prev|go\s+(?:to\s+)?(?:next|previous|prev))\s+conversation\b/i,
    action: function(m) {
      var dir = /prev/i.test(m[1]) ? -1 : 1;
      var convs = (typeof state !== 'undefined' && state.conversations) ? state.conversations : [];
      if (convs.length < 2) { _speak('You only have one conversation.'); return; }
      var idx = convs.findIndex(function(c) { return c.id === state.currentId; });
      var next = convs[(idx + dir + convs.length) % convs.length];
      _speak('Switching to ' + (next.title || 'Untitled') + '.');
      if (typeof loadConversation === 'function') loadConversation(next.id);
    }
  },
  {
    // "summarize this conversation" / "summarize X"
    pattern: /\bsummariz(?:e|ing)\s+(?:this\s+)?(?:conversation|chat)?(?:\s+(.+))?\b/i,
    action: function(m) {
      var name = m[1] ? m[1].trim() : null;
      var convs = (typeof state !== 'undefined' && state.conversations) ? state.conversations : [];
      var conv = name
        ? convs.find(function(c) { return (c.title || '').toLowerCase().includes(name.toLowerCase()); })
        : (typeof state !== 'undefined' && state.currentId ? convs.find(function(c) { return c.id === state.currentId; }) : null);
      if (!conv) { _speak(name ? 'No conversation found matching ' + name + '.' : 'No active conversation.'); return; }
      var msgs = (conv.messages || []).filter(function(x) { return x.role === 'user' || x.role === 'assistant'; });
      if (msgs.length === 0) { _speak(conv.title + ' has no messages to summarize.'); return; }
      // Grab last 3 user messages as a quick spoken summary
      var userMsgs = msgs.filter(function(x) { return x.role === 'user'; }).slice(-3);
      var topics = userMsgs.map(function(x) { return (x.content || '').replace(/\n/g, ' ').trim().slice(0, 60); }).join('; ');
      _speak(conv.title + ' — last ' + userMsgs.length + ' topic' + (userMsgs.length === 1 ? '' : 's') + ': ' + topics + '.');
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

// ── Whisper via server-side whisper.cpp ──────────────────────────────────
// No ONNX worker needed — audio blob is POSTed to /api/transcribe which runs
// whisper.cpp natively (4-8× faster than WASM, Metal-accelerated on Apple Silicon).

var _whisperModelReady = false;

async function _checkWhisperModel() {
  try {
    var resp = await fetch('/api/whisper-model-status');
    var data = await resp.json();
    return data.ready;
  } catch (_) { return false; }
}

async function _downloadWhisperModel() {
  return new Promise(function(resolve, reject) {
    if (typeof showToast === 'function') showToast('Downloading voice model (~465 MB)…', 'info', 0);

    // Show a progress bar in the toast area
    var bar = document.getElementById('whisper-download-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'whisper-download-bar';
      bar.innerHTML =
        '<div style="margin:12px auto;max-width:340px;text-align:center;font-size:13px;color:var(--text-secondary,#aaa)">' +
          '<div style="margin-bottom:6px" id="whisper-dl-label">Downloading voice model… 0%</div>' +
          '<div style="background:var(--bg-tertiary,#333);border-radius:6px;height:8px;overflow:hidden">' +
            '<div id="whisper-dl-fill" style="width:0%;height:100%;background:var(--accent,#7c5cff);border-radius:6px;transition:width .2s"></div>' +
          '</div>' +
        '</div>';
      var chatArea = document.querySelector('.chat-messages') || document.body;
      chatArea.appendChild(bar);
    }

    var label = document.getElementById('whisper-dl-label');
    var fill  = document.getElementById('whisper-dl-fill');
    var es = new EventSource('/api/whisper-model-download');

    es.onmessage = function(ev) {
      try {
        var d = JSON.parse(ev.data);
        if (d.error) {
          es.close();
          if (bar) bar.remove();
          if (typeof showToast === 'function') showToast('Voice model download failed: ' + d.error, 'error');
          reject(new Error(d.error));
          return;
        }
        if (label) label.textContent = 'Downloading voice model… ' + (d.pct || 0) + '%';
        if (fill)  fill.style.width  = (d.pct || 0) + '%';
        if (d.ready) {
          es.close();
          if (bar) bar.remove();
          if (typeof showToast === 'function') showToast('Voice model ready!', 'success');
          resolve(true);
        }
      } catch (_) {}
    };

    es.onerror = function() {
      es.close();
      if (bar) bar.remove();
      if (typeof showToast === 'function') showToast('Voice model download interrupted', 'error');
      reject(new Error('Download interrupted'));
    };
  });
}

async function _ensureWhisperModel() {
  if (_whisperModelReady) return true;
  var ready = await _checkWhisperModel();
  if (ready) { _whisperModelReady = true; return true; }
  try {
    await _downloadWhisperModel();
    _whisperModelReady = true;
    return true;
  } catch (_) {
    return false;
  }
}

function _initWhisperWorker() {
  if (_whisperReady) return;
  _whisperReady = true;
  // Check model in background — don't block init, download happens on first voice use
  _checkWhisperModel().then(function(ready) { _whisperModelReady = ready; });
  if (typeof showToast === 'function') showToast('Voice ready — say "' + getWakeWord() + '" to activate');
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
  if (!chunks.length) {
    _vadState    = 'idle';
    _voiceActive = false;
    _hideVoiceOverlay();
    _setVoicePillState(_voiceEnabled ? 'listening' : 'off');
    return;
  }

  // Ensure model is downloaded before first transcription
  if (!_whisperModelReady) {
    var modelOk = await _ensureWhisperModel();
    if (!modelOk) {
      _vadState    = 'idle';
      _voiceActive = false;
      _hideVoiceOverlay();
      _setVoicePillState(_voiceEnabled ? 'listening' : 'off');
      return;
    }
  }

  var blobType = (chunks[0] && chunks[0].type) || 'audio/webm';
  var blob = new Blob(chunks, { type: blobType });
  console.log('[voice] POSTing', blob.size, 'bytes to /api/transcribe, mode:', mode);
  _vadState = 'transcribing';
  try {
    var resp = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blobType },
      body: blob,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var data = await resp.json();
    var text = (data.text || '').replace(WHISPER_NOISE_TOKENS, '').trim();
    console.log('[voice] transcribed:', JSON.stringify(text));
    _onWhisperResult(text);
  } catch (err) {
    console.warn('[voice] transcribe error:', err);
    _vadState    = 'idle';
    _voiceActive = false;
    _hideVoiceOverlay();
    _setVoicePillState(_voiceEnabled ? 'listening' : 'off');
  }
}

// ── VAD (Voice Activity Detection) ───────────────────────────────────────

// Asymmetric thresholds (Pipecat/LiveKit pattern): higher bar to START, lower to STOP.
// Eliminates false triggers from brief noise and prevents premature silence cuts.
var VAD_RMS_START           = 0.012;  // RMS level needed to BEGIN speech (STARTING state)
var VAD_RMS_STOP            = 0.006;  // RMS level to confirm silence (STOPPING state) — lower for hysteresis
var VAD_SPEECH_FRAMES_START = 3;      // consecutive frames above START threshold → commit to recording (~300ms)
var VAD_SILENCE_FRAMES_STOP = 8;      // consecutive frames below STOP threshold → commit to silence (~800ms)
var VAD_MIN_RECORD_FRAMES   = 8;      // minimum recording frames before silence can end it (~800ms)
var VAD_SILENCE_FRAMES_WAKE = 6;      // silence frames to end wake chunk (~600ms)
var VAD_SILENCE_FRAMES_CMD  = 7;      // silence frames to end command chunk (~700ms — was 1.2s)
var VAD_MAX_WAKE_FRAMES     = 35;     // max frames before force-stopping wake recording (~3.5s)
var _vadPeakRms             = 0;      // peak RMS during current recording (for threshold tuning)
var _vadRecordFrames        = 0;      // frames elapsed since recording started
var _vadSmoothedRms         = 0;      // EMA-smoothed RMS (alpha=0.2, Pipecat default)
var VAD_EMA_ALPHA           = 0.2;    // smoothing factor: lower = more smoothing

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
    }
    if (_vadState === 'transcribing') return;

    _analyserNode.getFloatTimeDomainData(buf);
    var rawRms = _rms(buf);
    // Exponential moving average smoothing (Pipecat alpha=0.2): damps single-frame spikes
    _vadSmoothedRms = _vadSmoothedRms * (1 - VAD_EMA_ALPHA) + rawRms * VAD_EMA_ALPHA;
    var level = _vadSmoothedRms;

    var now = Date.now();
    if (now - _vadRmsLogTimer > 2000) {
      _vadRmsLogTimer = now;
      console.log('[vad] rms:', level.toFixed(4), '| start:', VAD_RMS_START, '| stop:', VAD_RMS_STOP, '| state:', _vadState);
    }

    // ── 5-state machine: idle → starting → recording_* → stopping → transcribing ──

    if (_vadState === 'idle') {
      if (level > VAD_RMS_START) {
        _vadSpeechFrames++;
        // Barge-in guard: while TTS is playing, require 5× more frames before committing
        // (≈500ms sustained speech) — prevents background noise from killing a response.
        var framesNeeded = _ttsActive ? (VAD_SPEECH_FRAMES_START * 5) : VAD_SPEECH_FRAMES_START;
        if (_vadSpeechFrames >= framesNeeded) {
          // If TTS was playing, cancel it and set a 2s recovery timer.
          // If no real transcript arrives within 2s, resume speaking from the saved text.
          if (_ttsActive) {
            var savedText = _ttsResumeText;
            window.speechSynthesis.cancel();
            _ttsActive = false;
            if (_ttsResumeTimer) clearTimeout(_ttsResumeTimer);
            _ttsResumeTimer = setTimeout(function() {
              // No real command arrived — false interruption, resume TTS
              if (!_voiceActive && _vadState === 'idle' && savedText) {
                console.log('[vad] false interruption detected — resuming TTS');
                _speak(savedText);
              }
              _ttsResumeTimer = null;
            }, 2000);
          }
          var nextState = _voiceActive ? 'recording_cmd' : 'recording_wake';
          _vadState        = nextState;
          _vadSpeechFrames = 0;
          _vadSilenceFrames = 0;
          _vadPeakRms      = 0;
          _vadRecordFrames = 0;
          _recordChunks    = [];
          try {
            var mime = _bestMime();
            console.log('[vad] speech confirmed (' + VAD_SPEECH_FRAMES_START + ' frames) — starting MediaRecorder, mode:', nextState, 'mime:', mime || '(default)');
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
      }

    } else if (_vadState === 'recording_wake' || _vadState === 'recording_cmd') {
      _vadRecordFrames++;
      if (level > VAD_RMS_STOP) {
        // Still speaking — reset silence counter
        _vadSilenceFrames = 0;
        if (level > _vadPeakRms) _vadPeakRms = level;
        // Check force-stop for wake chunk
        if (_vadState === 'recording_wake' && _vadRecordFrames >= VAD_MAX_WAKE_FRAMES) {
          console.log('[vad] force-stopping wake recording after', _vadRecordFrames, 'frames');
          _commitStop();
        }
      } else {
        _vadSilenceFrames++;
        var silenceNeeded = (_vadState === 'recording_cmd') ? VAD_SILENCE_FRAMES_CMD : VAD_SILENCE_FRAMES_WAKE;
        var minMet = (_vadRecordFrames >= VAD_MIN_RECORD_FRAMES);
        if (minMet && _vadSilenceFrames >= VAD_SILENCE_FRAMES_STOP) {
          // Enter STOPPING — use the silence threshold that applies to the mode as a further gate,
          // then commit. (Pipecat has a separate STOPPING state; we merge it into the silence count.)
          console.log('[vad] silence confirmed (', _vadSilenceFrames, 'frames) — peak rms:', _vadPeakRms.toFixed(4));
          _commitStop();
        }
      }
    }
  }, 100);
}

function _commitStop() {
  var capturedMode = (_vadState === 'recording_cmd') ? 'cmd' : 'wake';
  _vadSpeechFrames  = 0;
  _vadSilenceFrames = 0;
  _vadPeakRms       = 0;
  _vadRecordFrames  = 0;
  _vadSmoothedRms   = 0;
  _vadState         = 'transcribing';
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
    var mr = _mediaRecorder;
    mr.onstop = function() {
      _transcribeBlobs(_recordChunks.slice(), capturedMode);
    };
    try { mr.stop(); } catch (_) {}
  }
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
  // Cancel any false-interruption TTS recovery — a real command arrived
  if (_ttsResumeTimer) { clearTimeout(_ttsResumeTimer); _ttsResumeTimer = null; }
  if ((transcript || '').trim()) _routeVoiceCommand(transcript.trim());
}

// ── Wake word listener (VAD + Whisper) ───────────────────────────────────

function _startWakeListener() {
  if (!_voiceEnabled) return;
  _vadState         = 'idle';
  _vadSpeechFrames  = 0;
  _vadSilenceFrames = 0;
  _vadSmoothedRms   = 0;

  if (_micStream) {
    // Mic already open — restart VAD loop
    // Ensure AudioContext is running (may have been suspended)
    if (_audioCtx && _audioCtx.state !== 'running') _audioCtx.resume().catch(function(){});
    _startVADLoop();
    _setVoicePillState('listening');
    return;
  }

  // Create AudioContext NOW — synchronously — while still in the user gesture call stack.
  // Creating it inside the async .then() puts it outside the gesture context and Chromium
  // auto-suspends it, causing getFloatTimeDomainData to return all zeros.
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  _audioCtx.resume().catch(function(){});

  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then(function(stream) {
      _micStream    = stream;
      _micSource    = _audioCtx.createMediaStreamSource(stream);  // keep ref — prevents GC disconnect
      _analyserNode = _audioCtx.createAnalyser();
      _analyserNode.fftSize = 2048;
      // Connect through a silent gain node to destination — Chromium optimizes away
      // audio graphs that don't reach the destination, causing getFloatTimeDomainData
      // to return all zeros even with a live mic stream.
      var _silentGain = _audioCtx.createGain();
      _silentGain.gain.value = 0;
      _micSource.connect(_analyserNode);
      _analyserNode.connect(_silentGain);
      _silentGain.connect(_audioCtx.destination);
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
    // Don't call _startWakeListener() on auto-restore — AudioContext must be
    // created from a user gesture. We'll start it on the first mic-btn click instead.
    _setVoicePillState('listening');
    // Attempt start after a short delay in case page was loaded by a gesture (e.g. reload)
    setTimeout(function() { if (_voiceEnabled && !_micStream) _startWakeListener(); }, 300);
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

// ── Inline dictation — webkitSpeechRecognition (SFSpeechRecognizer on macOS) ──

var _dictMediaRecorder = null;  // MediaRecorder for dictation
var _dictStream        = null;  // MediaStream for dictation
var _dictAudioCtx      = null;  // AudioContext for dictation VAD
var _dictChunks        = [];    // recorded audio chunks
var _dictState = 'idle'; // 'idle' | 'listening' | 'processing'

var _DICTATION_CONV_CMDS = [
  { re: /\bnew\s+conv(ersation)?\b/i,            action: 'new' },
  { re: /\bcreate\s+(a\s+)?conv(ersation)?\b/i,  action: 'new' },
  { re: /\bstart\s+(a\s+)?conv(ersation)?\b/i,   action: 'new' },
  { re: /\bnext\s+conv(ersation)?\b/i,           action: 'next' },
  { re: /\bprev(ious)?\s+conv(ersation)?\b/i,    action: 'prev' },
];

function _dictSetState(s) {
  _dictState = s;
  var btn = document.getElementById('dictate-btn');
  if (!btn) return;
  btn.classList.remove('recording', 'processing');
  if (s === 'listening') {
    btn.classList.add('recording');
    btn.title = 'Listening\u2026 (silence stops automatically)';
    btn.innerHTML = '<i class="ti ti-microphone-off"></i>';
  } else if (s === 'processing') {
    btn.classList.add('processing');
    btn.title = 'Transcribing\u2026';
    btn.innerHTML = '<i class="ti ti-loader"></i>';
  } else {
    btn.title = 'Dictate message';
    btn.innerHTML = '<i class="ti ti-microphone"></i>';
  }
}

// Insert / append text into the textarea, showing interim results live
function _dictApplyInterim(text) {
  var ta = document.getElementById('msg-input');
  if (!ta) return;
  // Store a baseline each recognition session; interim overwrites from baseline forward
  if (ta._dictBase === undefined) ta._dictBase = ta.value;
  var base = ta._dictBase || '';
  var sep  = (base && !base.endsWith(' ')) ? ' ' : '';
  ta.value = base + sep + text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.selectionStart = ta.selectionEnd = ta.value.length;
}

function _dictCommitFinal(text) {
  var ta = document.getElementById('msg-input');
  if (!ta) return;
  var base = ta._dictBase !== undefined ? ta._dictBase : ta.value;
  var sep  = (base && !base.endsWith(' ')) ? ' ' : '';
  ta._dictBase = base + sep + text; // advance baseline
  ta.value = ta._dictBase;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.selectionStart = ta.selectionEnd = ta.value.length;
}

function _dictHandleTranscript(text) {
  text = text.trim();
  _dictSetState('idle');
  if (!text) return;

  // Check for conversation commands first
  for (var i = 0; i < _DICTATION_CONV_CMDS.length; i++) {
    if (_DICTATION_CONV_CMDS[i].re.test(text)) {
      var action = _DICTATION_CONV_CMDS[i].action;
      if (action === 'new') {
        if (typeof newConversation === 'function') newConversation();
        else if (typeof startNewConversation === 'function') startNewConversation();
        if (typeof showToast === 'function') showToast('New conversation started');
      } else if (action === 'next') {
        _speakConvNavigate(1);
      } else if (action === 'prev') {
        _speakConvNavigate(-1);
      }
      return;
    }
  }

  _dictCommitFinal(text);
  var ta = document.getElementById('msg-input');
  if (ta) { ta.focus(); ta._dictBase = undefined; }
}

function _speakConvNavigate(dir) {
  if (typeof state === 'undefined' || !state.conversations) return;
  var convs = state.conversations;
  var idx = convs.findIndex(function(c) { return c.id === state.activeConversationId; });
  var next = idx + dir;
  if (next < 0 || next >= convs.length) {
    _speak(dir > 0 ? 'Already at the last conversation.' : 'Already at the first conversation.');
    return;
  }
  if (typeof loadConversation === 'function') loadConversation(convs[next].id);
}

var DICT_SILENCE_MS    = 1500;  // ms of silence before auto-stop
var DICT_MAX_MS        = 30000; // absolute max recording length
var DICT_RMS_THRESHOLD = 0.004; // energy floor (same as wake word VAD)

function startDictation() {
  // Toggle off if already running
  if (_dictState === 'listening' || _dictState === 'processing') {
    _dictStopRecording();
    return;
  }

  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then(function(stream) {
      _dictStream   = stream;
      _dictChunks   = [];
      _dictAudioCtx = new (window.AudioContext || window.webkitAudioContext)();

      // Route through silent gain so Chromium doesn't cull the graph
      var source    = _dictAudioCtx.createMediaStreamSource(stream);
      var analyser  = _dictAudioCtx.createAnalyser();
      analyser.fftSize = 2048;
      var silentGain = _dictAudioCtx.createGain();
      silentGain.gain.value = 0;
      source.connect(analyser);
      analyser.connect(silentGain);
      silentGain.connect(_dictAudioCtx.destination);

      var mime = _bestMime();
      _dictMediaRecorder = new MediaRecorder(stream, { mimeType: mime });
      _dictMediaRecorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) _dictChunks.push(e.data);
      };
      _dictMediaRecorder.onstop = function() { _dictTranscribe(); };
      _dictMediaRecorder.start(100);
      _dictSetState('listening');

      // VAD: stop on silence after speech detected
      var buf       = new Float32Array(analyser.fftSize);
      var hadSpeech = false;
      var silenceMs = 0;
      var maxTimer  = setTimeout(function() { _dictStopRecording(); }, DICT_MAX_MS);
      var vadTimer  = setInterval(function() {
        if (_dictState !== 'listening') { clearInterval(vadTimer); clearTimeout(maxTimer); return; }
        analyser.getFloatTimeDomainData(buf);
        var rms = _rms(buf);
        if (rms > DICT_RMS_THRESHOLD) {
          hadSpeech = true;
          silenceMs = 0;
        } else if (hadSpeech) {
          silenceMs += 100;
          if (silenceMs >= DICT_SILENCE_MS) {
            clearInterval(vadTimer);
            clearTimeout(maxTimer);
            _dictStopRecording();
          }
        }
      }, 100);
    })
    .catch(function(err) {
      console.error('[dictate] getUserMedia error:', err);
      if (typeof showToast === 'function') showToast('Microphone access denied');
    });
}

function _dictStopRecording() {
  if (_dictMediaRecorder && _dictMediaRecorder.state !== 'inactive') {
    _dictMediaRecorder.stop();
  }
  if (_dictStream) {
    _dictStream.getTracks().forEach(function(t) { t.stop(); });
    _dictStream = null;
  }
  if (_dictAudioCtx) {
    try { _dictAudioCtx.close(); } catch (_) {}
    _dictAudioCtx = null;
  }
  _dictSetState('processing');
}

async function _dictTranscribe() {
  if (!_dictChunks.length) { _dictSetState('idle'); return; }

  // Ensure model is downloaded before first transcription
  if (!_whisperModelReady) {
    var modelOk = await _ensureWhisperModel();
    if (!modelOk) { _dictSetState('idle'); return; }
  }

  var blobType = (_dictChunks[0] && _dictChunks[0].type) || 'audio/webm';
  var blob = new Blob(_dictChunks, { type: blobType });
  _dictChunks = [];
  try {
    var resp = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blobType },
      body: blob,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var data = await resp.json();
    var text = (data.text || '').replace(WHISPER_NOISE_TOKENS, '').trim();
    if (text) _dictHandleTranscript(text);
  } catch (err) {
    console.warn('[dictate] transcribe error:', err);
    if (typeof showToast === 'function') showToast('Dictation failed — try again');
  } finally {
    _dictSetState('idle');
  }
}

// ── Voice Control ─────────────────────────────────────────────────────────
// Wake-word detection + command routing via Web Speech API.
// Runs entirely in Chromium — no server, no API key required.

var VOICE_SETTINGS_KEY = 'fauna-voice-settings';
var VOICE_WAKEWORD_KEY = 'fauna-voice-wakeword';

var _voiceEnabled  = false;
var _wakeRecog     = null;   // continuous recognition — scanning for wake word
var _cmdRecog      = null;   // one-shot recognition — capturing the command
var _voiceActive   = false;  // currently capturing a command
var _voiceRestart  = true;   // should the wake listener auto-restart
var _finalTranscript = '';

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
  // Install / add agent (searches the store)
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
    }
  },
  // Uninstall / remove / delete agent
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
        if (typeof deleteAgent === 'function') deleteAgent(found.name);
      } else {
        if (typeof showToast === 'function') showToast('No agent found matching "' + name + '"');
      }
    }
  },
  // Open agent store
  {
    pattern: /\b(open|show)\s+(?:the\s+)?(?:agent\s+)?store\b/i,
    action: function() {
      if (typeof openAgentStore === 'function') openAgentStore();
    }
  },
  // New conversation
  {
    pattern: /\b(new|start)\s+(?:a\s+)?(?:conversation|chat)\b/i,
    action: function() {
      if (typeof newConversation === 'function') newConversation();
    }
  },
  // Open settings
  {
    pattern: /\b(?:open\s+)?settings\b/i,
    action: function() {
      if (typeof toggleSettings === 'function') toggleSettings();
    }
  },
  // Build / create an agent
  {
    pattern: /\b(?:build|create|make)\s+(?:an?\s+)?agent\b/i,
    action: function() {
      if (typeof openAgentBuilder === 'function') openAgentBuilder();
    }
  },
  // Switch to / open a conversation by name
  {
    pattern: /\b(?:switch\s+to|open)\s+(?:conversation\s+)?(.+)/i,
    action: function(m) {
      var name = m[1].trim();
      var convs = (typeof state !== 'undefined' && state.conversations) ? state.conversations : [];
      var found = convs.find(function(c) {
        return (c.title || '').toLowerCase().includes(name.toLowerCase());
      });
      if (found) {
        if (typeof loadConversation === 'function') loadConversation(found.id);
      } else {
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

// ── Command capture ───────────────────────────────────────────────────────

function _startCommandCapture() {
  if (_voiceActive) return;
  _voiceActive   = true;
  _finalTranscript = '';

  _playVoiceChime('activate');
  _setVoicePillState('active');
  _showVoiceOverlay('');

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  _cmdRecog = new SR();
  _cmdRecog.lang             = 'en-US';
  _cmdRecog.continuous       = false;
  _cmdRecog.interimResults   = true;
  _cmdRecog.maxAlternatives  = 1;

  _cmdRecog.onresult = function(e) {
    var transcript = '';
    for (var i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    _showVoiceOverlay(transcript);
    if (e.results[e.results.length - 1].isFinal) {
      _finalTranscript = transcript;
    }
  };

  _cmdRecog.onend = function() {
    _voiceActive = false;
    _playVoiceChime('dismiss');
    _hideVoiceOverlay();
    _setVoicePillState(_voiceEnabled ? 'listening' : 'off');
    if (_finalTranscript.trim()) {
      _routeVoiceCommand(_finalTranscript.trim());
    }
    // Restart wake word listener
    if (_voiceEnabled) {
      _voiceRestart = true;
      setTimeout(_startWakeListener, 300);
    }
  };

  _cmdRecog.onerror = function() {
    _voiceActive = false;
    _hideVoiceOverlay();
    _setVoicePillState(_voiceEnabled ? 'listening' : 'off');
  };

  try { _cmdRecog.start(); } catch (_) {
    _voiceActive = false;
    _setVoicePillState(_voiceEnabled ? 'listening' : 'off');
  }
}

// ── Wake word listener ────────────────────────────────────────────────────

function _startWakeListener() {
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !_voiceEnabled || _voiceActive) return;

  _wakeRecog = new SR();
  _wakeRecog.lang            = 'en-US';
  _wakeRecog.continuous      = true;
  _wakeRecog.interimResults  = true;
  _wakeRecog.maxAlternatives = 1;

  _wakeRecog.onresult = function(e) {
    if (_voiceActive) return;
    var wakeWord = getWakeWord();
    for (var i = e.resultIndex; i < e.results.length; i++) {
      var t = (e.results[i][0].transcript || '').toLowerCase();
      if (t.includes(wakeWord)) {
        try { _wakeRecog.abort(); } catch (_) {}
        _startCommandCapture();
        return;
      }
    }
  };

  _wakeRecog.onend = function() {
    // Auto-restart so it stays perpetually alive
    if (_voiceRestart && _voiceEnabled && !_voiceActive) {
      setTimeout(function() {
        if (_voiceEnabled && !_voiceActive) {
          try { _wakeRecog.start(); } catch (_) {}
        }
      }, 350);
    }
  };

  _wakeRecog.onerror = function(e) {
    if (e.error === 'not-allowed') {
      _voiceEnabled = false;
      _setVoicePillState('off');
      _syncVoiceToggleUI(false);
      var s = _loadVoiceSettings();
      s.enabled = false;
      _saveVoiceSettings(s);
      if (typeof showToast === 'function') showToast('Microphone access denied — voice control disabled');
    }
    // 'no-speech' and 'audio-capture' errors: the onend handler will restart
  };

  try {
    _wakeRecog.start();
    _setVoicePillState('listening');
  } catch (_) {}
}

function _stopVoiceListeners() {
  _voiceRestart = false;
  if (_wakeRecog) { try { _wakeRecog.abort(); } catch (_) {} _wakeRecog = null; }
  if (_cmdRecog)  { try { _cmdRecog.abort();  } catch (_) {} _cmdRecog  = null; }
  _voiceActive = false;
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
    _voiceRestart = true;
    _startWakeListener();
    if (typeof showToast === 'function') showToast('Voice on — say "' + getWakeWord() + '" to activate');
  } else {
    _voiceEnabled = false;
    _stopVoiceListeners();
    if (typeof showToast === 'function') showToast('Voice control off');
  }
}

function saveVoiceWakeWord() {
  var input = document.getElementById('voice-wake-input');
  if (!input) return;
  var w = input.value.trim().toLowerCase();
  if (!w) return;
  _setWakeWord(w);
  if (typeof showToast === 'function') showToast('Wake word set to "' + w + '"');
  // Restart listener to pick up new word
  if (_voiceEnabled) {
    _stopVoiceListeners();
    _voiceEnabled = true;
    _voiceRestart = true;
    _startWakeListener();
  }
}

function initVoice() {
  var SR  = window.SpeechRecognition || window.webkitSpeechRecognition;
  var btn = document.getElementById('voice-mic-btn');

  if (!SR) {
    // Speech API unavailable — hide mic button
    if (btn) btn.style.display = 'none';
    return;
  }

  // Restore saved enabled state
  var s = _loadVoiceSettings();
  _voiceEnabled = s.enabled || false;

  if (_voiceEnabled) {
    _voiceRestart = true;
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

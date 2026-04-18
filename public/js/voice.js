// ── Voice Control ─────────────────────────────────────────────────────────
// Wake-word detection + command routing via Web Speech API.
// Runs entirely in Chromium — no server, no API key required.

var VOICE_SETTINGS_KEY = 'fauna-voice-settings';
var VOICE_WAKEWORD_KEY = 'fauna-voice-wakeword';

var _voiceEnabled       = false;
var _wakeRecog          = null;   // continuous recognition — scanning for wake word
var _cmdRecog           = null;   // one-shot recognition — capturing the command
var _voiceActive        = false;  // currently capturing a command
var _voiceRestart       = true;   // should the wake listener auto-restart
var _finalTranscript    = '';
var _wakeNetworkErrors  = 0;      // consecutive network errors — for backoff
var _wakeRestartTimer   = null;   // pending restart timeout
var _wakeBackoffCycles  = 0;      // how many 30s pause cycles have elapsed

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
  _voiceRestart = true;
  // Tear down any stale instance before creating a fresh one
  if (_wakeRecog) { try { _wakeRecog.abort(); } catch (_) {} _wakeRecog = null; }

  _wakeRecog = new SR();
  _wakeRecog.lang            = 'en-US';
  _wakeRecog.continuous      = true;
  _wakeRecog.interimResults  = true;
  _wakeRecog.maxAlternatives = 1;

  _wakeRecog.onresult = function(e) {
    if (_voiceActive) return;
    _wakeNetworkErrors = 0; // successful audio — reset backoff
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
    if (!_voiceRestart || !_voiceEnabled || _voiceActive) return;
    // Backoff: 350ms → 1s → 3s → 30s pause; give up after 2 x 30s cycles
    var delay = 350;
    if (_wakeNetworkErrors >= 3) {
      _wakeBackoffCycles++;
      _wakeNetworkErrors = 0;
      if (_wakeBackoffCycles >= 2) {
        // Give up — webkitSpeechRecognition needs Google cloud (not available in this build)
        console.error('[voice] Giving up — Google STT unavailable in this Electron build.');
        _voiceEnabled = false;
        _setVoicePillState('off');
        _syncVoiceToggleUI(false);
        var s = _loadVoiceSettings(); s.enabled = false; _saveVoiceSettings(s);
        if (typeof showToast === 'function') showToast('Voice recognition unavailable — Google STT is not supported in this build. Voice control disabled.');
        return;
      }
      console.warn('[voice] Network errors — pausing 30s before retry.');
      if (typeof showToast === 'function') showToast('Voice recognition needs internet. Retrying in 30s…');
      delay = 30000;
    } else if (_wakeNetworkErrors === 2) {
      delay = 3000;
    } else if (_wakeNetworkErrors === 1) {
      delay = 1000;
    }
    if (_wakeRestartTimer) clearTimeout(_wakeRestartTimer);
    _wakeRestartTimer = setTimeout(function() {
      if (_voiceEnabled && !_voiceActive) _startWakeListener();
    }, delay);
  };

  _wakeRecog.onerror = function(e) {
    console.warn('[voice] wake recognition error:', e.error);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      _voiceEnabled = false;
      _setVoicePillState('off');
      _syncVoiceToggleUI(false);
      var s = _loadVoiceSettings();
      s.enabled = false;
      _saveVoiceSettings(s);
      if (typeof showToast === 'function') showToast('Microphone access denied — check Fauna permissions in System Settings');
      _speak('Microphone access denied. Please allow microphone access in System Settings.');
    } else if (e.error === 'network') {
      _wakeNetworkErrors++;
      // onend fires next and schedules the backoff restart
    }
    // 'no-speech' / 'audio-capture' / 'aborted': onend handles restart normally
  };

  try {
    _wakeRecog.start();
    _setVoicePillState('listening');
  } catch (_) {}
}

function _stopVoiceListeners() {
  _voiceRestart = false;
  _wakeNetworkErrors = 0;
  _wakeBackoffCycles = 0;
  if (_wakeRestartTimer) { clearTimeout(_wakeRestartTimer); _wakeRestartTimer = null; }
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
    _wakeNetworkErrors = 0;
    _wakeBackoffCycles = 0;
    _startWakeListener();
    // Voices load asynchronously — wait briefly before speaking
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

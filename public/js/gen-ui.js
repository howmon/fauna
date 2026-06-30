// ── Generative UI — inline artifact renderer ──────────────────────────────
// Renders json-render-compatible flat specs (root + elements map) directly
// in the chat message using vanilla JS components. AI can emit:
//
//   ```gen-ui
//   { "root": "card-1", "elements": { ... } }
//   ```
//
// Supported component types: Card, Stack, Heading, Text, Badge, Stat,
// Table, List, Progress, Alert, Button, Divider, KeyValue, Grid, Code, Image, SVG
//
// Actions: copy_text, open_url, toggle_visible, setState

// ── JSON recovery helper ──────────────────────────────────────────────────
// Escape unescaped control characters (newline, tab, etc.) that appear
// inside JSON string literals. Used as a fallback when JSON.parse rejects
// raw model output that embedded multi-line markup directly into a string.
function _sanitizeJsonControlChars(raw) {
  var out = '';
  var inStr = false;
  var esc = false;
  for (var i = 0; i < raw.length; i++) {
    var ch = raw.charAt(i);
    var code = raw.charCodeAt(i);
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      if (code < 0x20) {
        if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else if (ch === '\b') out += '\\b';
        else if (ch === '\f') out += '\\f';
        else out += '\\u' + ('0000' + code.toString(16)).slice(-4);
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

// Second-pass recovery: when the model emits an unescaped \" inside a string
// value (e.g. \`"text": "She said "hi""\`), JSON.parse rejects with
// "Unterminated string". We look at each \" while inside a string — if the
// next non-whitespace character is NOT a structural close (\`,\`, \`}\`, \`]\`,
// \`:\`) and not end-of-input, treat it as a content quote and escape it.
function _escapeStrayQuotes(raw) {
  var out = '';
  var inStr = false;
  var esc = false;
  for (var i = 0; i < raw.length; i++) {
    var ch = raw.charAt(i);
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') {
        // Lookahead: skip whitespace, see what's next.
        var j = i + 1;
        while (j < raw.length && (raw.charAt(j) === ' ' || raw.charAt(j) === '\t' || raw.charAt(j) === '\n' || raw.charAt(j) === '\r')) j++;
        var next = j < raw.length ? raw.charAt(j) : '';
        if (next === ',' || next === '}' || next === ']' || next === ':' || next === '') {
          out += ch; inStr = false; continue;
        }
        // Stray quote inside a string — escape it.
        out += '\\"';
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

// Third-pass recovery: sometimes the model emits valid JSON followed by
// extra narrative text in the same gen-ui fence. Extract the first complete
// JSON object/array and parse only that value.
function _extractLeadingJsonValue(raw) {
  var s = String(raw || '');
  var start = -1;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === '{' || c === '[') { start = i; break; }
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') return '';
  }
  if (start < 0) return '';

  var depth = 0;
  var inStr = false;
  var esc = false;
  for (var j = start; j < s.length; j++) {
    var ch = s.charAt(j);
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = false; continue; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return s.slice(start, j + 1);
      continue;
    }
  }
  return '';
}

// ── State store (per-spec instance) ──────────────────────────────────────

function _genUiCreateState(initialState) {
  var state = Object.assign({}, initialState || {});
  var listeners = [];
  return {
    get: function(path) {
      var parts = (path || '').replace(/^\//, '').split('/');
      var cur = state;
      for (var i = 0; i < parts.length; i++) {
        if (cur == null) return undefined;
        cur = cur[parts[i]];
      }
      return cur;
    },
    set: function(path, value) {
      var parts = (path || '').replace(/^\//, '').split('/');
      var cur = state;
      for (var i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
      listeners.forEach(function(fn) { try { fn(state); } catch(_) {} });
    },
    // Persist a value without notifying subscribers (avoids re-rendering, e.g.
    // tearing down a playing media element when dismissing a fact).
    setQuiet: function(path, value) {
      var parts = (path || '').replace(/^\//, '').split('/');
      var cur = state;
      for (var i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    },
    subscribe: function(fn) { listeners.push(fn); },
    snapshot: function() { return state; }
  };
}

// ── Expression resolution ─────────────────────────────────────────────────

function _genUiResolve(expr, store) {
  if (expr === null || expr === undefined) return expr;
  if (typeof expr !== 'object') return expr;
  // { $state: "/path" }
  if (expr.$state !== undefined) return store.get(expr.$state);
  // { $template: "Hello ${/user/name}!" }
  if (expr.$template) {
    return expr.$template.replace(/\$\{([^}]+)\}/g, function(_, p) { return store.get(p) != null ? store.get(p) : ''; });
  }
  // { $cond, $then, $else }
  if (expr.$cond !== undefined) {
    var cond = _genUiResolve(expr.$cond, store);
    var result = expr.eq !== undefined ? cond == expr.eq : !!cond;
    return result ? _genUiResolve(expr.$then, store) : _genUiResolve(expr.$else, store);
  }
  // { $bindState: "/path" } — keep as-is; it's a binding sentinel that
  // form-field renderers (Input/Select/Checkbox/…) look for explicitly.
  if (expr.$bindState !== undefined) return expr;
  // Arrays: resolve each element.
  if (Array.isArray(expr)) {
    return expr.map(function(item) { return _genUiResolve(item, store); });
  }
  // Plain object: resolve nested fields so dynamic exprs inside
  // actionParams / options / etc. interpolate (e.g. a Submit button's
  // send_prompt text reading collected form state).
  var out = {};
  Object.keys(expr).forEach(function(k) { out[k] = _genUiResolve(expr[k], store); });
  return out;
}

function _genUiProps(rawProps, store) {
  var out = {};
  if (!rawProps) return out;
  Object.keys(rawProps).forEach(function(k) { out[k] = _genUiResolve(rawProps[k], store); });
  return out;
}

// ── Visibility check ─────────────────────────────────────────────────────

function _genUiVisible(el, store) {
  if (!el.visible) return true;
  var rules = Array.isArray(el.visible) ? el.visible : [el.visible];
  return rules.every(function(rule) {
    var val = store.get(rule.$state);
    var result = rule.eq !== undefined ? val == rule.eq : !!val;
    return rule.not ? !result : result;
  });
}

// ── Action dispatch ──────────────────────────────────────────────────────

function _genUiDispatch(action, params, store, rootEl) {
  if (!action) return;
  switch (action) {
    case 'setState':
      if (params && params.statePath) store.set(params.statePath, params.value);
      break;
    case 'toggle_visible': {
      var path = params && params.statePath;
      if (path) store.set(path, !store.get(path));
      break;
    }
    case 'copy_text': {
      var text = params && params.text;
      if (text && navigator.clipboard) navigator.clipboard.writeText(text).catch(function(){});
      if (typeof showToast === 'function') showToast('Copied!');
      break;
    }
    case 'open_url': {
      var url = params && params.url;
      if (url && /^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener');
      break;
    }
    case 'prefill_chat': {
      // Drop a suggested prompt into the composer without sending.
      // Lets a gen-ui Button seed a follow-up the user can edit before hitting send.
      var inputEl = document.getElementById('msg-input');
      if (inputEl && params && typeof params.text === 'string') {
        inputEl.value = params.text;
        // Fire 'input' so autosize / send-button-enable listeners react.
        try { inputEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
        try { inputEl.focus(); } catch (_) {}
      }
      break;
    }
    case 'send_prompt': {
      // Prefill the composer AND auto-submit. One-tap follow-up.
      var inputEl2 = document.getElementById('msg-input');
      if (inputEl2 && params && typeof params.text === 'string') {
        inputEl2.value = params.text;
        try { inputEl2.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
        if (typeof sendMessage === 'function') {
          // Defer so the input event finishes before send pulls .value.
          setTimeout(function() { try { sendMessage(); } catch (_) {} }, 0);
        }
      }
      break;
    }
    case 'open_artifact': {
      // Open an existing artifact in the right pane by id.
      var aid = params && params.id;
      if (aid && typeof openArtifact === 'function') {
        try { openArtifact(aid); } catch (_) {}
      }
      break;
    }
    case 'explore_into': {
      // Drill deeper on the Explore page — push a new gen-ui journey node.
      // Handled by public/js/explorer.js; no-op elsewhere.
      if (typeof window.faunaExploreInto === 'function') {
        try { window.faunaExploreInto(params || {}); } catch (_) {}
      }
      break;
    }
    default: break;
  }
}

// ── Media helpers ─────────────────────────────────────────────────────────

function _guiDetectMediaType(src) {
  if (!src) return 'video';
  if (/youtube\.com|youtu\.be/.test(src)) return 'youtube';
  if (/\.(mp3|wav|ogg|aac|m4a|flac)(\?|$)/i.test(src)) return 'audio';
  if (/\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(src)) return 'image';
  return 'video';
}

function _guiIsPlaceholderMediaValue(value) {
  var raw = String(value || '').trim().toLowerCase();
  if (!raw) return true;
  return /(^|[\/=_-])(placeholder|sample|example|dummy|todo|tbd)([\/?&#._-]|$)/.test(raw) ||
         /^0{6,}$/.test(raw) ||
         raw === 'aaaaaaaaaaa' ||
         raw === '-----------' ||
         raw === '___________';
}

function _guiIsValidYouTubeId(id) {
  return /^[A-Za-z0-9_-]{11}$/.test(id || '') && !_guiIsPlaceholderMediaValue(id);
}

function _guiSafeThumbnailUrl(url) {
  if (!url || _guiIsPlaceholderMediaValue(url)) return '';
  var raw = String(url).trim();
  try {
    var parsed = new URL(raw, window.location.origin);
    var host = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '');
    var parts = parsed.pathname.split('/').filter(Boolean);
    if ((host === 'i.ytimg.com' || host === 'img.youtube.com') && parts[0] === 'vi') {
      return _guiYouTubeThumbnailUrl(parts[1]);
    }
  } catch (_) {}
  return raw;
}

function _guiResolveImageUrl(rawUrl) {
  if (!rawUrl) return '';
  var src = String(rawUrl).trim();
  if (!src) return '';
  if (/^data:image\//i.test(src) || /^blob:/i.test(src)) return src;
  if (/^\/api\//.test(src)) return src;
  try {
    var parsed = new URL(src, window.location.origin);
    if (/^https?:$/i.test(parsed.protocol)) {
      return '/api/fetch-image?url=' + encodeURIComponent(parsed.href);
    }
  } catch (_) {}
  return src;
}

function _guiExtractYouTubeId(url) {
  if (!url) return null;
  var raw = String(url).trim();
  if (_guiIsPlaceholderMediaValue(raw)) return null;
  var bare = raw.match(/^[A-Za-z0-9_-]{11}$/);
  if (bare && _guiIsValidYouTubeId(bare[0])) return bare[0];

  function fromUrl(value) {
    var parsed;
    try { parsed = new URL(value); }
    catch (_) {
      try { parsed = new URL('https://' + value.replace(/^\/\//, '')); }
      catch (_) { return null; }
    }

    var host = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '');
    var parts = parsed.pathname.split('/').filter(Boolean);
    var candidate = null;

    if (host === 'youtu.be') candidate = parts[0];
    if (!candidate && /(^|\.)youtube(?:-nocookie)?\.com$/.test(host)) {
      candidate = parsed.searchParams.get('v') || parsed.searchParams.get('vi');
      if (!candidate && ['embed', 'shorts', 'live', 'v', 'e'].indexOf(parts[0]) !== -1) candidate = parts[1];
      if (!candidate && parts[0] === 'watch') candidate = parsed.searchParams.get('v');
      if (!candidate && parsed.searchParams.get('u')) candidate = fromUrl(parsed.searchParams.get('u'));
    }

    return _guiIsValidYouTubeId(candidate || '') ? candidate : null;
  }

  var id = fromUrl(raw);
  if (id) return id;
  var m = raw.match(/(?:v=|vi=|youtu\.be\/|embed\/|shorts\/|live\/|\/v\/|\/e\/)([A-Za-z0-9_-]{11})/);
  return m && _guiIsValidYouTubeId(m[1]) ? m[1] : null;
}

function _guiYouTubeThumbnailUrl(id) {
  return _guiIsValidYouTubeId(id) ? '/api/youtube-thumbnail?id=' + encodeURIComponent(id) : '';
}

function _guiNormalizeStats(stats) {
  if (!stats) return [];
  if (!Array.isArray(stats) && typeof stats === 'object') {
    return Object.keys(stats).map(function(key) { return { label: key, value: stats[key] }; });
  }
  return (Array.isArray(stats) ? stats : []).map(function(stat) {
    if (typeof stat === 'string' || typeof stat === 'number') return { value: stat };
    return stat || {};
  }).filter(function(stat) { return stat.value != null || stat.label != null; });
}

function _guiRenderPlaylistStats(stats) {
  var normalized = _guiNormalizeStats(stats);
  if (!normalized.length) return null;
  var wrap = document.createElement('div');
  wrap.className = 'gui-playlist-stats';
  normalized.forEach(function(stat) {
    var node = document.createElement('div');
    node.className = 'gui-playlist-stat';
    node.innerHTML =
      '<div class="gui-playlist-stat-value">' + escHtml(stat.value != null ? stat.value : '') + '</div>' +
      (stat.label != null ? '<div class="gui-playlist-stat-label">' + escHtml(stat.label) + '</div>' : '') +
      (stat.trend != null ? '<div class="gui-playlist-stat-trend ' + (stat.trendDir === 'down' ? 'down' : stat.trendDir === 'up' ? 'up' : '') + '">' + escHtml(stat.trend) + '</div>' : '');
    wrap.appendChild(node);
  });
  return wrap;
}

function _guiNormalizeFacts(facts) {
  if (!facts) return [];
  return (Array.isArray(facts) ? facts : [facts]).map(function(fact, i) {
    if (typeof fact === 'string') return { id: 'fact-' + i, text: fact };
    return Object.assign({ id: 'fact-' + i }, fact || {});
  }).filter(function(fact) { return fact.title || fact.text || fact.body; });
}

function _guiRenderPlaylistFacts(facts, store, stateBase) {
  var normalized = _guiNormalizeFacts(facts);
  if (!normalized.length) return null;
  var wrap = document.createElement('div');
  wrap.className = 'gui-playlist-facts';
  normalized.forEach(function(fact, i) {
    var factId = String(fact.id || fact.title || i).replace(/[^A-Za-z0-9_-]/g, '_');
    var dismissPath = stateBase + '/dismissedFacts/' + factId;
    if (fact.dismissible !== false && store.get(dismissPath)) return;

    var card = document.createElement('div');
    card.className = 'gui-playlist-fact';
    var content = document.createElement('div');
    content.className = 'gui-playlist-fact-content';
    content.innerHTML =
      (fact.title ? '<div class="gui-playlist-fact-title">' + escHtml(fact.title) + '</div>' : '') +
      '<div class="gui-playlist-fact-text">' + escHtml(fact.text || fact.body || '') + '</div>';
    card.appendChild(content);

    if (fact.dismissible !== false) {
      var btn = document.createElement('button');
      btn.className = 'gui-playlist-fact-dismiss';
      btn.title = 'Dismiss fact';
      btn.innerHTML = '<i class="ti ti-x"></i>';
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        // Persist dismissal without notifying subscribers, then remove just this
        // card. A full store.set() would re-render the player and reload the
        // currently-playing media — so we update the DOM in place instead.
        if (typeof store.setQuiet === 'function') store.setQuiet(dismissPath, true);
        else store.set(dismissPath, true);
        if (card.parentNode) card.parentNode.removeChild(card);
        if (wrap.childNodes.length === 0 && wrap.parentNode) wrap.parentNode.removeChild(wrap);
      });
      card.appendChild(btn);
    }
    wrap.appendChild(card);
  });
  return wrap.childNodes.length ? wrap : null;
}

function _guiBuildMediaFallback(type) {
  var fallback = document.createElement('div');
  fallback.className = 'gui-playlist-thumb-icon';
  fallback.innerHTML = '<i class="ti ' + _guiMediaIcon(type) + '"></i>';
  return fallback;
}

var _guiVideoThumbCache = Object.create(null);

function _guiCaptureVideoThumbnail(src) {
  return new Promise(function(resolve, reject) {
    if (!src) { reject(new Error('Missing video source')); return; }
    var video = document.createElement('video');
    var settled = false;
    var timer = setTimeout(function() { finish(null); }, 8000);

    function cleanup() {
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute('src');
      try { video.load(); } catch (_) {}
    }

    function finish(value) {
      if (settled) return;
      settled = true;
      cleanup();
      if (value) resolve(value);
      else reject(new Error('Unable to capture video thumbnail'));
    }

    function drawFrame() {
      try {
        var w = video.videoWidth || 640;
        var h = video.videoHeight || 360;
        if (!w || !h) { finish(null); return; }
        var canvas = document.createElement('canvas');
        var maxW = 480;
        var scale = Math.min(1, maxW / w);
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        var ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.78));
      } catch (_) {
        finish(null);
      }
    }

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.onerror = function() { finish(null); };
    video.onseeked = drawFrame;
    video.onloadeddata = function() {
      if (video.readyState >= 2 && (!isFinite(video.duration) || video.currentTime > 0)) drawFrame();
    };
    video.onloadedmetadata = function() {
      var duration = isFinite(video.duration) ? video.duration : 0;
      var target = duration > 1 ? Math.min(3, Math.max(0.25, duration * 0.08)) : 0;
      if (target > 0 && Math.abs(video.currentTime - target) > 0.05) {
        try { video.currentTime = target; }
        catch (_) { drawFrame(); }
      } else {
        drawFrame();
      }
    };
    video.src = src;
    try { video.load(); } catch (_) {}
  });
}

function _guiBuildVideoThumbnail(src, type) {
  if (!src) return _guiBuildMediaFallback(type);
  var cached = _guiVideoThumbCache[src];
  if (typeof cached === 'string') {
    var img = document.createElement('img');
    img.className = 'gui-playlist-thumb';
    img.src = cached;
    img.alt = '';
    return img;
  }

  var thumb = document.createElement('div');
  thumb.className = 'gui-playlist-thumb gui-playlist-video-thumb';
  thumb.innerHTML = '<i class="ti ' + _guiMediaIcon(type) + '"></i>';

  function apply(dataUrl) {
    if (!dataUrl) return;
    thumb.classList.add('ready');
    thumb.style.backgroundImage = 'url("' + dataUrl + '")';
    thumb.innerHTML = '';
  }

  if (cached && typeof cached.then === 'function') {
    cached.then(apply).catch(function(){});
  } else if (cached !== null) {
    _guiVideoThumbCache[src] = _guiCaptureVideoThumbnail(src).then(function(dataUrl) {
      _guiVideoThumbCache[src] = dataUrl;
      return dataUrl;
    }).catch(function(err) {
      _guiVideoThumbCache[src] = null;
      throw err;
    });
    _guiVideoThumbCache[src].then(apply).catch(function(){});
  }

  return thumb;
}

function _guiMediaIcon(type) {
  if (type === 'youtube' || type === 'video') return 'ti-video';
  if (type === 'audio') return 'ti-music';
  if (type === 'image') return 'ti-photo';
  return 'ti-file';
}

// ── "Ask about this" helpers ─────────────────────────────────────────────
function _guiAskAbout(prompt) {
  var inp = document.getElementById('msg-input');
  if (!inp) return;
  inp.value = prompt;
  inp.dispatchEvent(new Event('input')); // trigger auto-resize
  inp.focus();
  inp.setSelectionRange(prompt.length, prompt.length);
}
function _guiMakeAskBtn(getPrompt, title) {
  var btn = document.createElement('button');
  btn.className = 'gui-ask-btn';
  btn.title = title || 'Ask about this';
  btn.innerHTML = '<i class="ti ti-message-circle"></i>';
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    _guiAskAbout(typeof getPrompt === 'function' ? getPrompt() : getPrompt);
  });
  return btn;
}

function _guiBuildMediaEl(src, type, opts) {
  opts = opts || {};
  // Proxy any local path through the server — the renderer can't load file:// or bare /abs/paths
  if (src) {
    if (src.startsWith('file://')) {
      src = '/api/serve-media?path=' + encodeURIComponent(src.replace(/^file:\/\//, ''));
    } else if (/^~\//.test(src) || (/^\/[^/]/.test(src) && !/^\/api\//.test(src))) {
      // bare absolute path (/Users/... or ~/...) — but NOT an existing /api/... route
      src = '/api/serve-media?path=' + encodeURIComponent(src);
    }
  }
  if (type === 'youtube') {
    var ytId = _guiExtractYouTubeId(src || '');
    if (!ytId) return document.createTextNode('(invalid YouTube URL)');
    var iframe = document.createElement('iframe');
    iframe.className = 'gui-player-iframe';
    iframe.src = 'https://www.youtube-nocookie.com/embed/' + ytId + (opts.autoplay ? '?autoplay=1' : '');
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.setAttribute('frameborder', '0');
    return iframe;
  } else if (type === 'audio') {
    var audio = document.createElement('audio');
    audio.controls = true;
    audio.className = 'gui-player-audio';
    if (src) audio.src = src;
    if (opts.autoplay) audio.autoplay = true;
    return audio;
  } else if (type === 'image') {
    var img = document.createElement('img');
    img.className = 'gui-player-image';
    img.src = _guiResolveImageUrl(src || '');
    img.alt = opts.alt || '';
    img.style.maxWidth = '100%';
    return img;
  } else {
    var video = document.createElement('video');
    video.controls = true;
    video.className = 'gui-player-video';
    if (src) video.src = src;
    if (opts.poster) video.poster = opts.poster;
    if (opts.autoplay) video.autoplay = true;
    if (opts.onEnded) video.addEventListener('ended', opts.onEnded);
    return video;
  }
}

// ── Component renderers ───────────────────────────────────────────────────

var _genUiComponents = {

  Card: function(el, props, children, store) {
    var div = document.createElement('div');
    div.className = 'gui-card';
    if (props.title) {
      var h = document.createElement('div');
      h.className = 'gui-card-title';
      h.textContent = props.title;
      div.appendChild(h);
    }
    if (props.description) {
      var d = document.createElement('div');
      d.className = 'gui-card-desc';
      d.textContent = props.description;
      div.appendChild(d);
    }
    children.forEach(function(c) { div.appendChild(c); });
    return div;
  },

  Stack: function(el, props, children, store) {
    var div = document.createElement('div');
    var dir = props.direction === 'horizontal' ? 'row' : 'column';
    div.className = 'gui-stack gui-stack-' + dir;
    if (props.gap) div.style.gap = typeof props.gap === 'number' ? props.gap + 'px' : props.gap;
    if (props.align) div.style.alignItems = props.align;
    if (props.justify) div.style.justifyContent = props.justify;
    if (props.wrap) div.style.flexWrap = 'wrap';
    children.forEach(function(c) { div.appendChild(c); });
    return div;
  },

  Grid: function(el, props, children, store) {
    var div = document.createElement('div');
    div.className = 'gui-grid';
    // columns accepts:
    //   number          → N equal columns ("repeat(N, 1fr)")
    //   number[]        → "<n>fr <n>fr ..." (relative widths, e.g. [2,1])
    //   string[]        → verbatim track list (e.g. ["240px","1fr","1fr"])
    // Any non-finite/non-positive entry falls back to "1fr".
    function _trackList(spec) {
      if (Array.isArray(spec) && spec.length > 0) {
        return spec.map(function(t) {
          if (typeof t === 'number' && isFinite(t) && t > 0) return t + 'fr';
          if (typeof t === 'string' && /^[a-z0-9.%()\-\s]+$/i.test(t)) return t;
          return '1fr';
        }).join(' ');
      }
      var n = parseInt(spec, 10);
      if (!isFinite(n) || n < 1) n = 2;
      return 'repeat(' + n + ', 1fr)';
    }
    div.style.gridTemplateColumns = _trackList(props.columns);
    if (props.rows != null) div.style.gridTemplateRows = _trackList(props.rows);
    if (props.gap) div.style.gap = typeof props.gap === 'number' ? props.gap + 'px' : props.gap;
    children.forEach(function(c) { div.appendChild(c); });
    return div;
  },

  Heading: function(el, props, children, store) {
    var level = Math.min(6, Math.max(1, parseInt(props.level) || 2));
    var h = document.createElement('h' + level);
    h.className = 'gui-heading gui-heading-' + level;
    h.textContent = props.text || '';
    return h;
  },

  Text: function(el, props, children, store) {
    var p = document.createElement('p');
    p.className = 'gui-text';
    if (props.muted) p.classList.add('gui-text-muted');
    if (props.strong) p.classList.add('gui-text-strong');
    if (props.small) p.classList.add('gui-text-small');
    if (props.code) {
      var code = document.createElement('code');
      code.className = 'gui-inline-code';
      code.textContent = props.text || '';
      p.appendChild(code);
    } else {
      p.textContent = props.text || '';
    }
    return p;
  },

  Badge: function(el, props, children, store) {
    var span = document.createElement('span');
    var variant = props.variant || 'default';
    span.className = 'gui-badge gui-badge-' + variant;
    span.textContent = props.label || props.text || '';
    return span;
  },

  Icon: function(el, props, children, store) {
    // Tabler glyph wrapper. `name` is the suffix after `ti-`
    // (e.g. {name:"calendar"} → <i class="ti ti-calendar">).
    // Strips any `ti-` prefix the model might have included.
    var raw = String(props.name || props.icon || '').trim().replace(/^ti-/, '');
    // Whitelist allowed chars to keep CSS class injection impossible.
    var safe = raw.replace(/[^a-z0-9-]/gi, '');
    var i = document.createElement('i');
    i.className = 'ti ti-' + (safe || 'point');
    i.classList.add('gui-icon');
    if (props.size != null) {
      var sz = typeof props.size === 'number' ? props.size + 'px' : String(props.size);
      i.style.fontSize = sz;
    }
    if (props.color) i.style.color = String(props.color);
    if (props.title) i.title = String(props.title);
    return i;
  },

  Stat: function(el, props, children, store) {
    var div = document.createElement('div');
    div.className = 'gui-stat';
    var val = props.value != null ? String(props.value) : '';
    // Format
    if (props.format === 'currency' && !isNaN(parseFloat(val))) {
      val = '$' + parseFloat(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (props.format === 'percent') {
      val = val + '%';
    } else if (props.format === 'number' && !isNaN(parseFloat(val))) {
      val = parseFloat(val).toLocaleString();
    }
    div.innerHTML =
      '<div class="gui-stat-value">' + escHtml(val) + '</div>' +
      '<div class="gui-stat-label">' + escHtml(props.label || '') + '</div>';
    if (props.trend) {
      var up = props.trend > 0;
      div.innerHTML += '<div class="gui-stat-trend ' + (up ? 'up' : 'down') + '">' +
        '<i class="ti ti-trending-' + (up ? 'up' : 'down') + '"></i> ' +
        escHtml(String(Math.abs(props.trend))) + '%</div>';
    }
    // Optional sparkline: props.series = [n,n,n,...] — inline SVG path under the value.
    // Width auto-fills card; height fixed at 32px. Trend color drives stroke.
    if (Array.isArray(props.series) && props.series.length > 1) {
      var nums = props.series.map(function(n) { return Number(n); })
                              .filter(function(n) { return isFinite(n); });
      if (nums.length > 1) {
        var w = 140, h = 32, pad = 2;
        var min = Math.min.apply(null, nums);
        var max = Math.max.apply(null, nums);
        var range = max - min || 1;
        var step = (w - pad * 2) / (nums.length - 1);
        var pts = nums.map(function(v, i) {
          var x = pad + i * step;
          var y = pad + (h - pad * 2) * (1 - (v - min) / range);
          return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        var dirUp = nums[nums.length - 1] >= nums[0];
        var stroke = props.trend != null
          ? (props.trend > 0 ? 'var(--success)' : 'var(--error)')
          : (dirUp ? 'var(--success)' : 'var(--error)');
        div.insertAdjacentHTML(
          'beforeend',
          '<svg class="gui-stat-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
            '<polyline fill="none" stroke="' + stroke + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="' + pts + '"/>' +
          '</svg>'
        );
      }
    }
    return div;
  },

  Alert: function(el, props, children, store) {
    var div = document.createElement('div');
    var variant = props.variant || props.type || 'info';
    div.className = 'gui-alert gui-alert-' + variant;
    var icons = { info: 'ti-info-circle', success: 'ti-circle-check', warning: 'ti-alert-triangle', error: 'ti-alert-circle' };
    div.innerHTML = '<i class="ti ' + (icons[variant] || 'ti-info-circle') + ' gui-alert-icon"></i>' +
      '<div class="gui-alert-body">' +
        (props.title ? '<div class="gui-alert-title">' + escHtml(props.title) + '</div>' : '') +
        (props.message ? '<div class="gui-alert-msg">' + escHtml(props.message) + '</div>' : '') +
      '</div>';
    children.forEach(function(c) { div.appendChild(c); });
    return div;
  },

  Button: function(el, props, children, store) {
    var btn = document.createElement('button');
    var variant = props.variant || 'default';
    btn.className = 'gui-btn gui-btn-' + variant;
    if (props.disabled || props.loading) btn.disabled = true;
    if (props.loading) {
      btn.innerHTML = '<i class="ti ti-loader-2 gui-spin"></i> ' + escHtml(props.label || '');
    } else if (props.icon) {
      btn.innerHTML = '<i class="ti ' + escHtml(props.icon) + '"></i> ' + escHtml(props.label || '');
    } else {
      btn.textContent = props.label || props.text || 'Button';
    }
    if (props.action) {
      btn.addEventListener('click', function() {
        // Re-resolve actionParams from the RAW spec at click time, not the
        // render-time snapshot. Lets a Submit button read whatever is in
        // form state right now (Input/Checkbox/etc. with $bindState).
        var rawParams = (el && el.props && el.props.actionParams) || {};
        var freshParams = _genUiResolve(rawParams, store) || {};
        _genUiDispatch(props.action, freshParams, store, null);
      });
    }
    return btn;
  },

  Divider: function(el, props, children, store) {
    var hr = document.createElement('hr');
    hr.className = 'gui-divider';
    if (props.label) {
      var wrap = document.createElement('div');
      wrap.className = 'gui-divider-labeled';
      wrap.innerHTML = '<span>' + escHtml(props.label) + '</span>';
      return wrap;
    }
    return hr;
  },

  KeyValue: function(el, props, children, store) {
    var div = document.createElement('div');
    div.className = 'gui-kv';
    div.innerHTML =
      '<span class="gui-kv-key">' + escHtml(props.key || props.label || '') + '</span>' +
      '<span class="gui-kv-value">' + escHtml(props.value != null ? String(props.value) : '') + '</span>';
    return div;
  },

  Table: function(el, props, children, store) {
    var wrap = document.createElement('div');
    wrap.className = 'gui-table-wrap';
    var tbl = document.createElement('table');
    tbl.className = 'gui-table';
    if (props.columns && Array.isArray(props.columns)) {
      var thead = document.createElement('thead');
      var tr = document.createElement('tr');
      props.columns.forEach(function(col) {
        var th = document.createElement('th');
        th.textContent = typeof col === 'string' ? col : (col.header || col.label || '');
        if (col.width) th.style.width = col.width;
        if (col.align) th.style.textAlign = col.align;
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      tbl.appendChild(thead);
    }
    if (props.rows && Array.isArray(props.rows)) {
      var tbody = document.createElement('tbody');
      props.rows.forEach(function(row) {
        var tr2 = document.createElement('tr');
        (Array.isArray(row) ? row : Object.values(row)).forEach(function(cell, ci) {
          var td = document.createElement('td');
          if (props.columns && props.columns[ci] && props.columns[ci].align) td.style.textAlign = props.columns[ci].align;
          td.textContent = cell != null ? String(cell) : '';
          tr2.appendChild(td);
        });
        tbody.appendChild(tr2);
      });
      tbl.appendChild(tbody);
    }
    wrap.appendChild(tbl);
    return wrap;
  },

  List: function(el, props, children, store) {
    var tag = props.ordered ? 'ol' : 'ul';
    var list = document.createElement(tag);
    list.className = 'gui-list' + (props.ordered ? ' gui-list-ordered' : '');
    var items = props.items || [];
    items.forEach(function(item) {
      var li = document.createElement('li');
      li.textContent = typeof item === 'string' ? item : (item.label || item.text || JSON.stringify(item));
      if (typeof item === 'object' && item.description) {
        var sub = document.createElement('span');
        sub.className = 'gui-list-desc';
        sub.textContent = item.description;
        li.appendChild(sub);
      }
      list.appendChild(li);
    });
    children.forEach(function(c) { list.appendChild(c); });
    return list;
  },

  Progress: function(el, props, children, store) {
    var div = document.createElement('div');
    div.className = 'gui-progress-wrap';
    var pct = Math.min(100, Math.max(0, parseFloat(props.value) || 0));
    var label = props.label || '';
    var showPct = props.showPercent !== false;
    if (label) {
      div.innerHTML = '<div class="gui-progress-header"><span>' + escHtml(label) + '</span>' +
        (showPct ? '<span>' + pct + '%</span>' : '') + '</div>';
    }
    var bar = document.createElement('div');
    bar.className = 'gui-progress-bar';
    var fill = document.createElement('div');
    fill.className = 'gui-progress-fill';
    fill.style.width = pct + '%';
    var variant = props.variant || 'default';
    if (variant !== 'default') fill.classList.add('gui-progress-' + variant);
    bar.appendChild(fill);
    div.appendChild(bar);
    return div;
  },

  Code: function(el, props, children, store) {
    var lang = props.language || props.lang || '';
    var pre = document.createElement('pre');
    pre.className = 'gui-code-block';
    var code = document.createElement('code');
    code.className = lang ? 'language-' + lang : '';
    var raw = props.code || props.content || '';
    try {
      if (lang && typeof hljs !== 'undefined' && hljs.getLanguage(lang)) {
        code.innerHTML = hljs.highlight(raw, { language: lang }).value;
      } else if (typeof hljs !== 'undefined') {
        code.innerHTML = hljs.highlightAuto(raw).value;
      } else {
        code.textContent = raw;
      }
    } catch(_) { code.textContent = raw; }
    pre.appendChild(code);
    return pre;
  },

  Image: function(el, props, children, store) {
    var img = document.createElement('img');
    img.className = 'gui-image';
    img.alt = props.alt || '';
    if (props.src && /^https?:\/\/|^data:image\//.test(props.src)) img.src = _guiResolveImageUrl(props.src);
    if (props.width) img.style.width = typeof props.width === 'number' ? props.width + 'px' : props.width;
    if (props.height) img.style.height = typeof props.height === 'number' ? props.height + 'px' : props.height;
    img.style.maxWidth = '100%';
    return img;
  },

  SVG: function(el, props, children, store) {
    var wrap = document.createElement('div');
    wrap.className = 'gui-svg-wrap';
    if (props.width) wrap.style.width = typeof props.width === 'number' ? props.width + 'px' : props.width;
    if (props.height) wrap.style.height = typeof props.height === 'number' ? props.height + 'px' : props.height;
    wrap.style.maxWidth = '100%';
    var markup = props.markup || props.svg || '';
    if (!markup) {
      wrap.textContent = '(no SVG markup)';
      return wrap;
    }
    // Sanitize: strip <script> tags and on* event attributes
    var safe = markup
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\bon\w+\s*=\s*(["'])[^\1]*?\1/gi, '')
      .replace(/\bon\w+\s*=\s*[^\s>\/]+/gi, '')
      .replace(/href\s*=\s*(["'])javascript:[^\1]*?\1/gi, 'href="#"')
      .replace(/xlink:href\s*=\s*(["'])javascript:[^\1]*?\1/gi, 'xlink:href="#"');
    // Force viewBox/width/height overrides if provided
    if (props.viewBox || props.width || props.height) {
      safe = safe.replace(/<svg(\s[^>]*)?>/, function(m, attrs) {
        var a = attrs || '';
        if (props.viewBox) a = a.replace(/viewBox\s*=\s*(["'])[^\1]*?\1/i, '') + ' viewBox="' + props.viewBox + '"';
        if (props.width)   a = a.replace(/\bwidth\s*=\s*(["'])[^\1]*?\1/i, '') + ' width="' + (typeof props.width === 'number' ? props.width + 'px' : props.width) + '"';
        if (props.height)  a = a.replace(/\bheight\s*=\s*(["'])[^\1]*?\1/i, '') + ' height="' + (typeof props.height === 'number' ? props.height + 'px' : props.height) + '"';
        return '<svg' + a + '>';
      });
    }
    wrap.innerHTML = safe;
    // Ensure the inline SVG scales to container
    var svgEl = wrap.querySelector('svg');
    if (svgEl) {
      svgEl.style.maxWidth = '100%';
      svgEl.style.height = 'auto';
      svgEl.style.display = 'block';
    }
    return wrap;
  },

  Select: function(el, props, children, store) {
    var wrap = document.createElement('div');
    wrap.className = 'gui-select-wrap';
    if (props.label) {
      var lbl = document.createElement('label');
      lbl.className = 'gui-select-label';
      lbl.textContent = props.label;
      wrap.appendChild(lbl);
    }
    var sel = document.createElement('select');
    sel.className = 'gui-select';
    var options = props.options || [];
    options.forEach(function(opt) {
      var o = document.createElement('option');
      if (typeof opt === 'string') { o.value = opt; o.textContent = opt; }
      else { o.value = opt.value != null ? opt.value : opt.label; o.textContent = opt.label || opt.value; }
      sel.appendChild(o);
    });
    // Bind to state
    if (props.value && props.value.$bindState) {
      var sp = props.value.$bindState;
      var initial = store.get(sp);
      if (initial != null) sel.value = String(initial);
      sel.addEventListener('change', function() { store.set(sp, sel.value); });
    } else if (props.value != null) {
      sel.value = String(props.value);
    }
    if (props.error) sel.classList.add('gui-field-invalid');
    wrap.appendChild(sel);
    if (props.error) {
      var errEl = document.createElement('div');
      errEl.className = 'gui-field-error';
      errEl.textContent = String(props.error);
      wrap.appendChild(errEl);
    } else if (props.hint) {
      var hintEl = document.createElement('div');
      hintEl.className = 'gui-field-hint';
      hintEl.textContent = String(props.hint);
      wrap.appendChild(hintEl);
    }
    return wrap;
  },

  Input: function(el, props, children, store) {
    var wrap = document.createElement('div');
    wrap.className = 'gui-input-wrap';
    if (props.label) {
      var lbl = document.createElement('label');
      lbl.className = 'gui-input-label';
      lbl.textContent = props.label;
      wrap.appendChild(lbl);
    }
    var inp = document.createElement('input');
    inp.className = 'gui-input';
    inp.type = props.type || 'text';
    inp.placeholder = props.placeholder || '';
    if (props.value && props.value.$bindState) {
      var sp = props.value.$bindState;
      inp.value = store.get(sp) != null ? String(store.get(sp)) : '';
      inp.addEventListener('input', function() { store.set(sp, inp.value); });
    } else if (props.value != null) {
      inp.value = String(props.value);
    }
    if (props.error) inp.classList.add('gui-field-invalid');
    wrap.appendChild(inp);
    if (props.error) {
      var errEl2 = document.createElement('div');
      errEl2.className = 'gui-field-error';
      errEl2.textContent = String(props.error);
      wrap.appendChild(errEl2);
    } else if (props.hint) {
      var hintEl2 = document.createElement('div');
      hintEl2.className = 'gui-field-hint';
      hintEl2.textContent = String(props.hint);
      wrap.appendChild(hintEl2);
    }
    return wrap;
  },

  Textarea: function(el, props, children, store) {
    // Multiline text input. {label, placeholder, rows, value, error, hint}
    var wrap = document.createElement('div');
    wrap.className = 'gui-input-wrap';
    if (props.label) {
      var lbl = document.createElement('label');
      lbl.className = 'gui-input-label';
      lbl.textContent = props.label;
      wrap.appendChild(lbl);
    }
    var ta = document.createElement('textarea');
    ta.className = 'gui-input gui-textarea';
    ta.placeholder = props.placeholder || '';
    ta.rows = parseInt(props.rows, 10) || 4;
    // Read raw spec value (not resolved props.value) to detect $bindState.
    var rawVal = el && el.props ? el.props.value : null;
    if (rawVal && rawVal.$bindState) {
      var sp = rawVal.$bindState;
      ta.value = store.get(sp) != null ? String(store.get(sp)) : '';
      ta.addEventListener('input', function() { store.set(sp, ta.value); });
    } else if (props.value != null) {
      ta.value = String(props.value);
    }
    if (props.error) ta.classList.add('gui-field-invalid');
    wrap.appendChild(ta);
    if (props.error) {
      var taErr = document.createElement('div');
      taErr.className = 'gui-field-error';
      taErr.textContent = String(props.error);
      wrap.appendChild(taErr);
    } else if (props.hint) {
      var taHint = document.createElement('div');
      taHint.className = 'gui-field-hint';
      taHint.textContent = String(props.hint);
      wrap.appendChild(taHint);
    }
    return wrap;
  },

  Checkbox: function(el, props, children, store) {
    // Single boolean. {label, value:$bindState, hint}
    var wrap = document.createElement('label');
    wrap.className = 'gui-check-wrap';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'gui-check';
    var rawVal = el && el.props ? el.props.value : null;
    if (rawVal && rawVal.$bindState) {
      var sp = rawVal.$bindState;
      box.checked = !!store.get(sp);
      box.addEventListener('change', function() { store.set(sp, box.checked); });
    } else {
      box.checked = !!props.value;
    }
    wrap.appendChild(box);
    if (props.label) {
      var lbl = document.createElement('span');
      lbl.className = 'gui-check-label';
      lbl.textContent = props.label;
      wrap.appendChild(lbl);
    }
    if (props.hint) {
      var hintEl = document.createElement('div');
      hintEl.className = 'gui-field-hint gui-check-hint';
      hintEl.textContent = String(props.hint);
      wrap.appendChild(hintEl);
    }
    return wrap;
  },

  RadioGroup: function(el, props, children, store) {
    // Single choice from a small set. Better UX than Select for 3-5 options.
    // {label, options:[strings | {label,value}], value:$bindState}
    var wrap = document.createElement('div');
    wrap.className = 'gui-radio-wrap';
    if (props.label) {
      var lbl = document.createElement('div');
      lbl.className = 'gui-input-label';
      lbl.textContent = props.label;
      wrap.appendChild(lbl);
    }
    var opts = Array.isArray(props.options) ? props.options : [];
    var rawVal = el && el.props ? el.props.value : null;
    var bindPath = rawVal && rawVal.$bindState ? rawVal.$bindState : null;
    // Unique name so multiple RadioGroups don't conflict.
    var groupName = 'gui-r-' + Math.random().toString(36).slice(2, 9);
    var current = bindPath ? store.get(bindPath) : props.value;
    opts.forEach(function(opt) {
      var optVal = typeof opt === 'string' ? opt : (opt.value != null ? opt.value : opt.label);
      var optLbl = typeof opt === 'string' ? opt : (opt.label != null ? opt.label : opt.value);
      var row = document.createElement('label');
      row.className = 'gui-radio-row';
      var r = document.createElement('input');
      r.type = 'radio';
      r.name = groupName;
      r.value = String(optVal);
      r.className = 'gui-radio';
      if (current != null && String(current) === String(optVal)) r.checked = true;
      if (bindPath) {
        r.addEventListener('change', function() {
          if (r.checked) store.set(bindPath, optVal);
        });
      }
      row.appendChild(r);
      var t = document.createElement('span');
      t.className = 'gui-radio-label';
      t.textContent = optLbl;
      row.appendChild(t);
      wrap.appendChild(row);
    });
    if (props.error) {
      var rerr = document.createElement('div');
      rerr.className = 'gui-field-error';
      rerr.textContent = String(props.error);
      wrap.appendChild(rerr);
    } else if (props.hint) {
      var rhint = document.createElement('div');
      rhint.className = 'gui-field-hint';
      rhint.textContent = String(props.hint);
      wrap.appendChild(rhint);
    }
    return wrap;
  },

  Slider: function(el, props, children, store) {
    // Numeric range input. {label, min, max, step, value:$bindState, showValue}
    var wrap = document.createElement('div');
    wrap.className = 'gui-input-wrap gui-slider-wrap';
    if (props.label) {
      var lbl = document.createElement('label');
      lbl.className = 'gui-input-label';
      lbl.textContent = props.label;
      wrap.appendChild(lbl);
    }
    var row = document.createElement('div');
    row.className = 'gui-slider-row';
    var s = document.createElement('input');
    s.type = 'range';
    s.className = 'gui-slider';
    s.min = props.min != null ? String(props.min) : '0';
    s.max = props.max != null ? String(props.max) : '100';
    s.step = props.step != null ? String(props.step) : '1';
    var rawVal = el && el.props ? el.props.value : null;
    var bindPath = rawVal && rawVal.$bindState ? rawVal.$bindState : null;
    var initial = bindPath ? store.get(bindPath) : props.value;
    if (initial != null) s.value = String(initial);
    var readout = document.createElement('span');
    readout.className = 'gui-slider-value';
    readout.textContent = s.value;
    if (bindPath) {
      s.addEventListener('input', function() {
        var n = parseFloat(s.value);
        store.set(bindPath, isFinite(n) ? n : s.value);
        readout.textContent = s.value;
      });
    } else {
      s.addEventListener('input', function() { readout.textContent = s.value; });
    }
    row.appendChild(s);
    if (props.showValue !== false) row.appendChild(readout);
    wrap.appendChild(row);
    if (props.hint) {
      var sh = document.createElement('div');
      sh.className = 'gui-field-hint';
      sh.textContent = String(props.hint);
      wrap.appendChild(sh);
    }
    return wrap;
  },

  Rating: function(el, props, children, store) {
    // Star rating display. {value, max=5, count?}
    // Half-star not supported — rounds to nearest int for visual.
    var max = Math.max(1, parseInt(props.max, 10) || 5);
    var raw = parseFloat(props.value);
    var val = isFinite(raw) ? Math.max(0, Math.min(max, raw)) : 0;
    var filled = Math.round(val);
    var wrap = document.createElement('div');
    wrap.className = 'gui-rating';
    var stars = document.createElement('span');
    stars.className = 'gui-rating-stars';
    for (var i = 0; i < max; i++) {
      var star = document.createElement('i');
      star.className = 'ti ' + (i < filled ? 'ti-star-filled gui-rating-on' : 'ti-star gui-rating-off');
      stars.appendChild(star);
    }
    wrap.appendChild(stars);
    if (props.showValue !== false && isFinite(raw)) {
      var num = document.createElement('span');
      num.className = 'gui-rating-value';
      num.textContent = (raw % 1 === 0 ? raw.toFixed(1) : String(raw));
      wrap.appendChild(num);
    }
    if (props.count != null) {
      var c = document.createElement('span');
      c.className = 'gui-rating-count';
      var n = parseFloat(props.count);
      var label = isFinite(n) ? '(' + n.toLocaleString() + ')' : '(' + String(props.count) + ')';
      c.textContent = label;
      wrap.appendChild(c);
    }
    return wrap;
  },

  Stepper: function(el, props, children, store) {
    // Discrete progress indicator. props.steps = [{label, done?, current?}, ...]
    // Use for shipping status, onboarding flows, multi-step wizards.
    var steps = Array.isArray(props.steps) ? props.steps : [];
    var wrap = document.createElement('div');
    wrap.className = 'gui-stepper';
    steps.forEach(function(s, i) {
      var item = document.createElement('div');
      item.className = 'gui-step';
      if (s && s.done) item.classList.add('gui-step-done');
      if (s && s.current) item.classList.add('gui-step-current');
      var dot = document.createElement('span');
      dot.className = 'gui-step-dot';
      // Show check inside done dots, number inside others.
      if (s && s.done) {
        dot.innerHTML = '<i class="ti ti-check"></i>';
      } else {
        dot.textContent = String(i + 1);
      }
      item.appendChild(dot);
      var lbl = document.createElement('span');
      lbl.className = 'gui-step-label';
      lbl.textContent = (s && s.label) || '';
      item.appendChild(lbl);
      wrap.appendChild(item);
      if (i < steps.length - 1) {
        var bar = document.createElement('span');
        bar.className = 'gui-step-bar';
        if (s && s.done) bar.classList.add('gui-step-bar-done');
        wrap.appendChild(bar);
      }
    });
    return wrap;
  },

  Tabs: function(el, props, children, store) {
    var wrap = document.createElement('div');
    wrap.className = 'gui-tabs';
    var tabs = props.tabs || [];
    var statePath = props.statePath || ('__tabs_' + Math.random().toString(36).slice(2));
    if (store.get(statePath) == null) store.set(statePath, tabs[0] && tabs[0].id || tabs[0] || '');
    var bar = document.createElement('div');
    bar.className = 'gui-tab-bar';
    var content = document.createElement('div');
    content.className = 'gui-tab-content';
    function render() {
      var active = store.get(statePath);
      bar.innerHTML = '';
      tabs.forEach(function(tab) {
        var id = typeof tab === 'string' ? tab : tab.id;
        var label = typeof tab === 'string' ? tab : (tab.label || tab.id);
        var btn = document.createElement('button');
        btn.className = 'gui-tab-btn' + (active === id ? ' active' : '');
        btn.textContent = label;
        btn.addEventListener('click', function() { store.set(statePath, id); });
        bar.appendChild(btn);
      });
      // show matching child
      Array.from(content.children).forEach(function(c, i) {
        var tabId = tabs[i] && (typeof tabs[i] === 'string' ? tabs[i] : tabs[i].id);
        c.style.display = tabId === active ? '' : 'none';
      });
    }
    // children map to tabs in order
    children.forEach(function(c) { content.appendChild(c); });
    store.subscribe(function() { render(); });
    render();
    wrap.appendChild(bar);
    wrap.appendChild(content);
    return wrap;
  },

  // ── Carousel ── cycle through any child elements ──────────────────────
  Carousel: function(el, props, children, store) {
    if (!children.length) return document.createTextNode('');
    var wrap = document.createElement('div');
    wrap.className = 'gui-carousel';
    var sp = props.statePath || ('__carousel_' + Math.random().toString(36).slice(2));
    if (store.get(sp) == null) store.set(sp, 0);

    var track = document.createElement('div');
    track.className = 'gui-carousel-track';
    children.forEach(function(c) {
      var slide = document.createElement('div');
      slide.className = 'gui-carousel-slide';
      slide.appendChild(c);
      track.appendChild(slide);
    });

    var navRow = document.createElement('div');
    navRow.className = 'gui-carousel-nav';

    var prevBtn = document.createElement('button');
    prevBtn.className = 'gui-carousel-arrow';
    prevBtn.innerHTML = '<i class="ti ti-chevron-left"></i>';

    var dots = document.createElement('div');
    dots.className = 'gui-carousel-dots';

    var nextBtn = document.createElement('button');
    nextBtn.className = 'gui-carousel-arrow';
    nextBtn.innerHTML = '<i class="ti ti-chevron-right"></i>';

    function syncCarousel() {
      var idx = store.get(sp) || 0;
      var n = children.length;
      Array.from(track.children).forEach(function(s, i) { s.classList.toggle('active', i === idx); });
      dots.innerHTML = '';
      for (var i = 0; i < n; i++) {
        var dot = document.createElement('button');
        dot.className = 'gui-carousel-dot' + (i === idx ? ' active' : '');
        (function(i) { dot.addEventListener('click', function() { store.set(sp, i); }); })(i);
        dots.appendChild(dot);
      }
      prevBtn.disabled = !props.loop && idx === 0;
      nextBtn.disabled = !props.loop && idx === n - 1;
    }

    prevBtn.addEventListener('click', function() {
      var idx = store.get(sp) || 0, n = children.length;
      store.set(sp, props.loop ? (idx - 1 + n) % n : Math.max(0, idx - 1));
    });
    nextBtn.addEventListener('click', function() {
      var idx = store.get(sp) || 0, n = children.length;
      store.set(sp, props.loop ? (idx + 1) % n : Math.min(n - 1, idx + 1));
    });

    store.subscribe(syncCarousel);
    syncCarousel();

    navRow.appendChild(prevBtn);
    navRow.appendChild(dots);
    navRow.appendChild(nextBtn);
    wrap.appendChild(track);
    wrap.appendChild(navRow);
    return wrap;
  },

  // ── MediaPlayer ── YouTube / video / audio / image ────────────────────
  MediaPlayer: function(el, props, children, store) {
    var wrap = document.createElement('div');
    wrap.className = 'gui-player';
    var src  = props.src  || '';
    var type = props.type || _guiDetectMediaType(src);

    if (props.title) {
      var titleEl = document.createElement('div');
      titleEl.className = 'gui-player-title';
      var titleText = document.createElement('span');
      titleText.textContent = props.title;
      titleEl.appendChild(titleText);
      titleEl.appendChild(_guiMakeAskBtn(
        'Tell me about "' + props.title + '"',
        'Ask about this ' + (type === 'audio' ? 'audio' : type === 'image' ? 'image' : 'video')
      ));
      wrap.appendChild(titleEl);
    }

    var mediaWrap = document.createElement('div');
    mediaWrap.className = 'gui-player-media';
    mediaWrap.appendChild(_guiBuildMediaEl(src, type, {
      poster: props.poster,
      autoplay: props.autoplay,
      alt: props.alt || props.title
    }));
    wrap.appendChild(mediaWrap);
    return wrap;
  },

  // ── Playlist ── browsable list of video / audio / image items ─────────
  Playlist: function(el, props, children, store) {
    var items = props.items || [];
    if (!items.length) return document.createTextNode('(empty playlist)');

    var wrap    = document.createElement('div');
    wrap.className = 'gui-playlist';
    var sp      = props.statePath || ('__playlist_' + Math.random().toString(36).slice(2));
    var spList  = sp + '__list';   // tracks list open/closed
    if (store.get(sp)     == null) store.set(sp,     0);
    if (store.get(spList) == null) store.set(spList, true);

    // ── Header (title + hide/show toggle) ─────────────────────────────
    var toggleBtn = null;
    if (props.title) {
      var headerEl = document.createElement('div');
      headerEl.className = 'gui-playlist-header';
      var titleSpan = document.createElement('span');
      titleSpan.innerHTML = '<i class="ti ti-playlist"></i> ' + escHtml(props.title);
      headerEl.appendChild(titleSpan);
      toggleBtn = document.createElement('button');
      toggleBtn.className = 'gui-playlist-toggle';
      toggleBtn.title = 'Hide list';
      toggleBtn.innerHTML = '<i class="ti ti-chevron-up"></i>';
      toggleBtn.addEventListener('click', function() {
        store.set(spList, !store.get(spList));
      });
      // Ask about entire playlist
      var plAskBtn = _guiMakeAskBtn(function() {
        var titles = items.map(function(it) { return it.title || it.src || 'Untitled'; });
        return 'Tell me about the "' + props.title + '" playlist (' + items.length + ' items: ' + titles.slice(0, 5).map(function(t) { return '"' + t + '"'; }).join(', ') + (titles.length > 5 ? '…' : '') + ')';
      }, 'Ask about this playlist');
      plAskBtn.classList.add('gui-ask-btn-header');
      headerEl.appendChild(plAskBtn);
      headerEl.appendChild(toggleBtn);
      wrap.appendChild(headerEl);
    }

    var playerArea = document.createElement('div');
    playerArea.className = 'gui-playlist-player';

    var listArea = document.createElement('div');
    listArea.className = 'gui-playlist-list';

    // Controls live OUTSIDE the player area so they don't shift with media height
    var controlsEl = document.createElement('div');
    controlsEl.className = 'gui-playlist-controls gui-playlist-controls-footer';

    function getItemType(item) {
      return item.type || _guiDetectMediaType(item.src || '');
    }

    function renderPlayer(idx) {
      playerArea.innerHTML = '';
      var item = items[idx];
      if (!item) return;
      var type = getItemType(item);

      // Now-playing label
      var nowPlaying = document.createElement('div');
      nowPlaying.className = 'gui-playlist-now-playing';
      nowPlaying.innerHTML = '<i class="ti ' + _guiMediaIcon(type) + '"></i> ' + escHtml(item.title || item.src || '');
      playerArea.appendChild(nowPlaying);

      // Media element
      var mediaEl = _guiBuildMediaEl(item.src || '', type, {
        poster: item.poster,
        autoplay: idx > 0 || !!props.autoplay,
        alt: item.title,
        onEnded: function() {
          store.set(sp, (idx + 1) % items.length);
        }
      });
      playerArea.appendChild(mediaEl);

      if (props.showStats !== false) {
        var statsEl = _guiRenderPlaylistStats(item.stats || item.metrics || props.stats || props.metrics);
        if (statsEl) playerArea.appendChild(statsEl);
      }

      if (props.showFacts !== false) {
        var factsEl = _guiRenderPlaylistFacts(
          item.facts || item.additionalFacts || props.facts || props.additionalFacts,
          store,
          sp + '/item_' + idx
        );
        if (factsEl) playerArea.appendChild(factsEl);
      }

      // Rebuild controls content (the element itself stays fixed in the DOM)
      controlsEl.innerHTML = '';
      var prevBtn = document.createElement('button');
      prevBtn.className = 'gui-playlist-btn';
      prevBtn.innerHTML = '<i class="ti ti-chevron-left"></i>';
      prevBtn.title = 'Previous';
      (function(i) {
        prevBtn.addEventListener('click', function() {
          store.set(sp, (i - 1 + items.length) % items.length);
        });
      })(idx);
      var counter = document.createElement('span');
      counter.className = 'gui-playlist-counter';
      counter.textContent = (idx + 1) + ' / ' + items.length;
      var nextBtn = document.createElement('button');
      nextBtn.className = 'gui-playlist-btn';
      nextBtn.innerHTML = '<i class="ti ti-chevron-right"></i>';
      nextBtn.title = 'Next';
      (function(i) {
        nextBtn.addEventListener('click', function() {
          store.set(sp, (i + 1) % items.length);
        });
      })(idx);
      controlsEl.appendChild(prevBtn);
      controlsEl.appendChild(counter);
      controlsEl.appendChild(nextBtn);
    }

    function renderList() {
      var active = store.get(sp) || 0;
      listArea.innerHTML = '';
      items.forEach(function(item, i) {
        var row = document.createElement('div');
        row.className = 'gui-playlist-item' + (i === active ? ' active' : '');
        var type = getItemType(item);

        // Thumbnail
        var thumbEl;
        if (type === 'youtube') {
          var ytId = _guiExtractYouTubeId(item.src || '');
          var ytThumb = _guiSafeThumbnailUrl(item.thumbnail) || _guiYouTubeThumbnailUrl(ytId);
          if (ytId && ytThumb) {
            thumbEl = document.createElement('img');
            thumbEl.className = 'gui-playlist-thumb';
            thumbEl.src = ytThumb;
            thumbEl.alt = '';
            thumbEl.onerror = function() {
              var fallback = _guiBuildMediaFallback(type);
              if (this.parentNode) this.parentNode.replaceChild(fallback, this);
            };
          } else {
            thumbEl = _guiBuildMediaFallback(type);
          }
        } else if ((type === 'image' || item.thumbnail) && (_guiSafeThumbnailUrl(item.thumbnail) || !_guiIsPlaceholderMediaValue(item.src))) {
          thumbEl = document.createElement('img');
          thumbEl.className = 'gui-playlist-thumb';
          thumbEl.src = _guiResolveImageUrl(_guiSafeThumbnailUrl(item.thumbnail) || item.src);
          thumbEl.alt = '';
          thumbEl.onerror = function() {
            var fallback = _guiBuildMediaFallback(type);
            if (this.parentNode) this.parentNode.replaceChild(fallback, this);
          };
        } else if (type === 'video') {
          thumbEl = _guiBuildVideoThumbnail(item.src || '', type);
        } else {
          thumbEl = _guiBuildMediaFallback(type);
        }
        row.appendChild(thumbEl);

        var info = document.createElement('div');
        info.className = 'gui-playlist-item-info';
        info.innerHTML =
          '<div class="gui-playlist-item-title">' + escHtml(item.title || item.src || 'Untitled') + '</div>' +
          (item.description ? '<div class="gui-playlist-item-desc">' + escHtml(item.description) + '</div>' : '') +
          (item.duration    ? '<div class="gui-playlist-item-dur">'  + escHtml(item.duration)    + '</div>' : '');
        row.appendChild(info);

        // Ask button for individual item
        var askBtn = _guiMakeAskBtn(
          'Tell me about "' + (item.title || item.src || 'this item') + '"',
          'Ask about this item'
        );
        row.appendChild(askBtn);

        (function(i) { row.addEventListener('click', function(e) { if (!e.target.closest('.gui-ask-btn')) store.set(sp, i); }); })(i);
        listArea.appendChild(row);
      });
    }

    function syncListVisibility() {
      var open = store.get(spList) !== false;
      listArea.style.display = open ? '' : 'none';
      if (toggleBtn) {
        toggleBtn.querySelector('i').className = 'ti ' + (open ? 'ti-chevron-up' : 'ti-chevron-down');
        toggleBtn.title = open ? 'Hide list' : 'Show list';
      }
    }

    store.subscribe(function() {
      renderPlayer(store.get(sp) || 0);
      renderList();
      syncListVisibility();
    });

    renderPlayer(0);
    renderList();
    syncListVisibility();

    var body = document.createElement('div');
    var hasVideoItems = items.some(function(item) {
      var itemType = getItemType(item);
      return itemType === 'video' || itemType === 'youtube';
    });
    var layout = props.layout || (hasVideoItems ? 'side' : 'stack');
    body.className = 'gui-playlist-body' + (layout === 'side' ? ' side' : layout === 'grid' ? ' grid' : '');
    body.appendChild(playerArea);
    body.appendChild(listArea);
    wrap.appendChild(body);
    wrap.appendChild(controlsEl);
    return wrap;
  }
};

// ── Tree renderer ─────────────────────────────────────────────────────────

function _genUiRenderElement(id, elements, store, depth) {
  if (depth > 20) return document.createTextNode(''); // guard against cycles
  var el = elements[id];
  if (!el) return document.createTextNode('');

  // Visibility
  if (!_genUiVisible(el, store)) {
    var placeholder = document.createElement('span');
    placeholder.style.display = 'none';
    placeholder.dataset.guiId = id;
    // Re-render on state changes
    store.subscribe(function() {
      var vis = _genUiVisible(el, store);
      if (vis && placeholder.parentNode) {
        var rendered = _genUiRenderElement(id, elements, store, depth);
        placeholder.parentNode.replaceChild(rendered, placeholder);
      }
    });
    return placeholder;
  }

  var props = _genUiProps(el.props, store);
  var children = (el.children || []).map(function(cid) {
    return _genUiRenderElement(cid, elements, store, depth + 1);
  });

  var renderer = _genUiComponents[el.type];
  if (!renderer) {
    // Unknown component — render as a dimmed label
    var unknown = document.createElement('div');
    unknown.className = 'gui-unknown';
    unknown.textContent = '[' + (el.type || '?') + ']';
    return unknown;
  }
  var rendered = renderer(el, props, children, store);
  // Universal grid-cell sizing: props.span / props.rowSpan apply
  // grid-column / grid-row span on the rendered node. No-op when the
  // parent isn't a CSS grid, so it's safe to set unconditionally.
  if (rendered && rendered.style) {
    var sp = parseInt(props.span, 10);
    if (isFinite(sp) && sp > 1) rendered.style.gridColumn = 'span ' + sp;
    var rsp = parseInt(props.rowSpan, 10);
    if (isFinite(rsp) && rsp > 1) rendered.style.gridRow = 'span ' + rsp;
  }
  return rendered;
}

// ── Public API ────────────────────────────────────────────────────────────

// Renders a gen-ui spec into a container element
function renderGenUI(spec, container) {
  var store = _genUiCreateState(spec.state || {});
  // Per-spec theme override: spec.theme = { accent?, font?, surface? }
  // Maps to CSS custom props on the container so child .gui-* classes can
  // pick them up via var(--gui-accent, fallback). Only safe values reach
  // CSS — colors are whitelisted to css color tokens, font names to a
  // conservative charset.
  var theme = spec.theme && typeof spec.theme === 'object' ? spec.theme : null;
  if (theme) {
    var safeColor = /^(#[0-9a-f]{3,8}|rgb\(|rgba\(|hsl\(|hsla\(|var\(--[a-z0-9-]+\)|[a-z]+)$/i;
    var safeFont = /^[a-z0-9 ,_'"-]{1,80}$/i;
    if (theme.accent  && safeColor.test(String(theme.accent)))  container.style.setProperty('--gui-accent',  String(theme.accent));
    if (theme.surface && safeColor.test(String(theme.surface))) container.style.setProperty('--gui-surface', String(theme.surface));
    if (theme.font    && safeFont.test(String(theme.font)))     container.style.setProperty('--gui-font',    String(theme.font));
  }
  try {
    var root = _genUiRenderElement(spec.root, spec.elements || {}, store, 0);
    container.appendChild(root);
  } catch (e) {
    container.innerHTML = '<div class="gui-error"><i class="ti ti-alert-circle"></i> Render error: ' + escHtml(e.message) + '</div>';
    return;
  }
  // Make uniform N×1fr Grids reflow based on available width. Authors
  // pick a column count assuming the chat bubble (~820px), but the same
  // spec can be opened in a wide browser tab, a narrow split pane, or a
  // collapsed sidebar. Rewriting only uniform 1fr tracks preserves any
  // intentional non-uniform layout (e.g. '240px 1fr' sidebars).
  _genUiReflowGrids(container);
}

function _genUiReflowGrids(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  var grids = root.querySelectorAll('.gui-grid');
  for (var i = 0; i < grids.length; i++) {
    var g = grids[i];
    var cur = g.style.gridTemplateColumns || '';
    var m = cur.match(/^repeat\((\d+)\s*,\s*1fr\)$/);
    if (!m) continue;
    var n = parseInt(m[1], 10);
    if (!(n >= 2)) continue;
    // min(100%, 260px) keeps cells from overflowing on phones while
    // still asking for ~260px before wrapping on desktop. auto-fit lets
    // the grid use *more* columns than the author asked for when the
    // container is wide enough (browser tab, big monitor) and *fewer*
    // when it's narrower (split pane, mobile).
    g.style.gridTemplateColumns =
      'repeat(auto-fit, minmax(min(100%, 260px), 1fr))';
    g.dataset.guiOriginalCols = String(n);
  }
}

// ── Derive a human-readable title from a spec ─────────────────────────────

function _genUiSpecTitle(spec) {
  // Try root element props.title, then first Heading text, then root type
  var root = spec.elements && spec.elements[spec.root];
  if (!root) return 'UI Component';
  if (root.props && root.props.title) return root.props.title;
  // Walk children for first Heading
  var all = Object.values(spec.elements);
  for (var i = 0; i < all.length; i++) {
    if (all[i].type === 'Heading' && all[i].props && all[i].props.text) return all[i].props.text;
  }
  return root.type || 'UI Component';
}

// ── Post-stream extractor ─────────────────────────────────────────────────
// Called after streaming completes (and on history load) to find all
// gen-ui placeholders and replace them with live rendered UI.

function extractAndRenderGenUI(buffer, msgEl, isHistoryLoad) {
  var blocks = msgEl.querySelectorAll('pre[data-special-lang="gen-ui"]');
  if (!blocks.length) return;
  if (_genUiShouldSuppressForShellMessage(msgEl)) {
    blocks.forEach(function(pre) {
      pre.remove();
    });
    return;
  }
  blocks.forEach(function(pre) {
    var code = pre.querySelector('code');
    var raw = code ? code.textContent : pre.textContent;
    var spec;
    var specJson = raw.trim();
    try {
      spec = JSON.parse(specJson);
    } catch (e) {
      // Recovery: LLMs frequently embed literal newlines/tabs inside string
      // values (e.g. multi-line SVG markup). JSON disallows raw control chars
      // in strings — escape them and retry. If that still fails, try once
      // more with stray-quote escaping (handles \`"text": "She said "hi""\`).
      try {
        specJson = _sanitizeJsonControlChars(specJson);
        spec = JSON.parse(specJson);
      } catch (e2) {
        try {
          specJson = _escapeStrayQuotes(_sanitizeJsonControlChars(raw.trim()));
          spec = JSON.parse(specJson);
        } catch (e3) {
          // Final recovery: parse only the first complete JSON value when
          // trailing non-JSON text was appended after the object.
          var leading = _extractLeadingJsonValue(raw.trim());
          if (leading) {
            var leadCandidates = [
              leading,
              _sanitizeJsonControlChars(leading),
              _escapeStrayQuotes(_sanitizeJsonControlChars(leading))
            ];
            for (var li = 0; li < leadCandidates.length; li++) {
              try {
                specJson = leadCandidates[li];
                spec = JSON.parse(specJson);
                break;
              } catch (_) {}
            }
          }
          if (!spec) {
            var errEl = document.createElement('div');
            errEl.className = 'gui-parse-error';
            errEl.innerHTML = '<i class="ti ti-alert-circle"></i> <strong>gen-ui:</strong> JSON parse error — ' + escHtml(e.message);
            pre.replaceWith(errEl);
            return;
          }
        }
      }
    }
    if (!spec || !spec.root || !spec.elements) {
      // Tolerate a bare component shorthand: { type, props, children }
      if (spec && spec.type) {
        spec = { root: '__root__', elements: { '__root__': spec } };
      } else {
        var warnEl = document.createElement('div');
        warnEl.className = 'gui-parse-error';
        warnEl.textContent = 'gen-ui: spec must have root + elements (or a single type/props object)';
        pre.replaceWith(warnEl);
        return;
      }
    }

    var wrapper = document.createElement('div');
    wrapper.className = 'gui-root';
    renderGenUI(spec, wrapper);

    // ── "Add to Project" footer ──────────────────────────────────────────
    var footer = document.createElement('div');
    footer.className = 'gui-footer';
    var title = _genUiSpecTitle(spec);

    // Stash the parsed spec + derived title on the wrapper so the
    // message-level "View in Browser" button can collect every gen-ui
    // block in this assistant message and share them together.
    wrapper._genUiSpec = spec;
    wrapper._genUiTitle = title;

    var saveBtn = document.createElement('button');
    saveBtn.className = 'gui-footer-btn';
    saveBtn.innerHTML = '<i class="ti ti-folder-plus"></i> Add to Project';
    saveBtn.addEventListener('click', function() {
      if (typeof saveGenUIToProject === 'function') {
        saveGenUIToProject(specJson, title);
      }
    });
    footer.appendChild(saveBtn);

    wrapper.appendChild(footer);

    pre.replaceWith(wrapper);
  });

  // Once all blocks are materialised, surface a single message-level
  // "View in Browser" button next to Copy / Regen. An assistant message
  // can render several gen-ui blocks (e.g. a hero card + a stat strip +
  // a table) and the user wants to mirror the *whole* set in one tab,
  // not one card at a time.
  _genUiEnsureMsgShareButton(msgEl);

  // ── Hoist schematic/SVG gen-ui blocks to the END of the message body ──
  // Models frequently emit the gen-ui block before the prose analysis even
  // when instructed otherwise, which buries the written summary below a
  // large diagram. When a gen-ui wrapper contains an SVG (typical for
  // circuit schematics rendered via fauna_render_circuit), move it to be
  // the last child of .msg-body so the prose analysis reads first.
  try {
    var body = msgEl.querySelector('.msg-body') || msgEl;
    var guis = body.querySelectorAll(':scope > .gui-root, :scope .gui-root');
    guis.forEach(function(wrap) {
      if (!wrap.querySelector('svg')) return;
      // Skip if it's already the last meaningful child of the body.
      var parent = wrap.parentNode;
      if (!parent) return;
      // Only hoist within the top-level message body, not nested containers.
      if (parent !== body) return;
      if (parent.lastElementChild === wrap) return;
      parent.appendChild(wrap);
    });
  } catch (_) { /* non-fatal */ }
}

function _genUiShouldSuppressForShellMessage(msgEl) {
  if (!msgEl) return false;
  return !!msgEl.querySelector('.shell-exec-block, code.language-shell-exec, code.language-shell_exec');
}

// ── Share to browser ─────────────────────────────────────────────────────
// Ensures the assistant message bubble has a single "View in Browser"
// action button alongside Copy / Regen. Called every time gen-ui blocks
// are (re-)materialised inside the message. Idempotent: if the button
// already exists it stays put; if all gen-ui wrappers are gone we yank
// the button so it doesn't lie about what's renderable.
function _genUiEnsureMsgShareButton(msgEl) {
  if (!msgEl || !msgEl.classList || !msgEl.classList.contains('ai')) return;
  var actions = msgEl.querySelector('.msg-actions');
  if (!actions) return;
  var wrappers = _genUiCollectMsgWrappers(msgEl);
  var existing = actions.querySelector('.msg-view-browser-btn');
  if (!wrappers.length) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  var btn = document.createElement('button');
  btn.className = 'msg-action-btn msg-view-browser-btn';
  btn.innerHTML = '<i class="ti ti-external-link"></i> View in Browser';
  btn.title = 'Open this message\u2019s UI in a browser tab · Shift-click to copy link';
  btn.addEventListener('click', function(evt) {
    _genUiShareMsgToBrowser(msgEl, btn, !!evt.shiftKey);
  });
  actions.appendChild(btn);
}

function _genUiCollectMsgWrappers(msgEl) {
  var body = msgEl.querySelector('.msg-body') || msgEl;
  var nodes = body.querySelectorAll('.gui-root');
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i]._genUiSpec) out.push(nodes[i]);
  }
  return out;
}

// Gather every gen-ui spec inside this assistant message and POST them
// as a single share payload. The message element remembers the assigned
// share id, so each subsequent click updates the same URL — any open
// browser tab refreshes live over SSE. Shift-click copies the URL
// instead of opening it.
function _genUiShareMsgToBrowser(msgEl, btnEl, copyOnly) {
  var wrappers = _genUiCollectMsgWrappers(msgEl);
  if (!wrappers.length) {
    _genUiShareToast('No gen-ui to share in this message.', true);
    return;
  }
  var payload;
  var title;
  if (wrappers.length === 1) {
    payload = wrappers[0]._genUiSpec;
    title = wrappers[0]._genUiTitle || 'Shared UI';
  } else {
    // Multi-spec share — send the array as-is; the server validates each
    // entry and the standalone page renders them stacked.
    payload = wrappers.map(function(w) { return w._genUiSpec; });
    title = (wrappers[0]._genUiTitle || 'Shared UI') + ' + ' + (wrappers.length - 1) + ' more';
  }
  _genUiShareToBrowser(payload, title, msgEl, btnEl, copyOnly);
}

// POST the parsed spec to /api/genui/share and either open the returned
// URL in the user's default browser (Electron `shell.openExternal` when
// available, falling back to `window.open`) or copy the URL when the user
// shift-clicked. The target element (a .gui-root wrapper *or* a .msg
// bubble) remembers the assigned share id, so every click after the
// first reuses the same id — that way the open browser tab updates live
// over SSE instead of being orphaned.
function _genUiShareToBrowser(spec, title, targetEl, btnEl, copyOnly) {
  var existingId = targetEl && targetEl.dataset ? targetEl.dataset.shareId : '';
  var origLabel = btnEl ? btnEl.innerHTML : '';
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = '<i class="ti ti-loader-2"></i> Sharing…';
  }
  var body = { spec: spec, title: title };
  if (existingId) body.id = existingId;
  fetch('/api/genui/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(j) { throw new Error(j.error || ('HTTP ' + r.status)); });
      return r.json();
    })
    .then(function(data) {
      if (targetEl && targetEl.dataset) targetEl.dataset.shareId = data.id;
      if (copyOnly) {
        return _genUiCopyText(data.url).then(function() {
          _genUiShareToast('Link copied: ' + data.url);
        });
      }
      // Prefer Electron shell.openExternal so the URL actually lands in
      // the user's default browser (not inside Fauna's BrowserWindow).
      try {
        if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
          window.electronAPI.openExternal(data.url);
        } else if (window.fauna && typeof window.fauna.openExternal === 'function') {
          window.fauna.openExternal(data.url);
        } else {
          window.open(data.url, '_blank', 'noopener');
        }
      } catch (_) {
        window.open(data.url, '_blank', 'noopener');
      }
      _genUiShareToast('Opened in browser · ' + data.url);
    })
    .catch(function(e) {
      _genUiShareToast('Share failed: ' + e.message, true);
    })
    .then(function() {
      if (btnEl) {
        btnEl.disabled = false;
        // After the first share, swap the label to make the live-link
        // intent obvious. We keep the icon to avoid layout jitter.
        if (targetEl && targetEl.dataset && targetEl.dataset.shareId) {
          btnEl.innerHTML = '<i class="ti ti-refresh"></i> Update Browser View';
          btnEl.title = 'Push latest spec to the open browser tab · Shift-click to copy link';
        } else {
          btnEl.innerHTML = origLabel;
        }
      }
    });
}

function _genUiCopyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise(function(resolve, reject) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      ok ? resolve() : reject(new Error('execCommand copy failed'));
    } catch (e) { reject(e); }
  });
}

// Reuse the chat-app's toast if it exists; otherwise fall back to a tiny
// inline pill so this works on pages that don't load chat.js.
function _genUiShareToast(msg, isErr) {
  if (typeof _showToast === 'function') { _showToast(msg, !!isErr); return; }
  var t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = [
    'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
    'background:' + (isErr ? '#5a1f1f' : '#202329'), 'color:#fff',
    'padding:10px 16px', 'border-radius:8px', 'font-size:12px',
    'box-shadow:0 8px 24px rgba(0,0,0,0.4)', 'z-index:99999',
    'max-width:80vw', 'overflow:hidden', 'text-overflow:ellipsis',
    'white-space:nowrap',
  ].join(';');
  document.body.appendChild(t);
  setTimeout(function() { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 2600);
  setTimeout(function() { t.remove(); }, 3100);
}

// ── Catalog prompt (for system prompt injection) ──────────────────────────
// Returns a markdown description of available components for the AI.

var GEN_UI_CATALOG_PROMPT = `
## Output format decision — artifact pane vs inline gen-ui vs plain text

Use this decision table every time you produce structured or visual output. Pick **exactly one** format.

### Use \`\`\`artifact:<type>:<title>\`\`\` (artifact pane) when:
- The output is a **file or document** the user will save, copy, or reuse (code, HTML, Markdown, JSON, CSV)
- The output is **long** (more than ~40 lines of content)
- The user's request contains words like *create*, *write*, *generate*, *build*, *draft* referencing a file or doc
- The output is runnable/executable (shell script, HTML page, full component)
- Artifact types: \`html\`, \`markdown\`, \`json\`, \`csv\`, \`code\`, \`text\`, \`files\`, \`summary\`

### Use a \`\`\`gen-ui\`\`\` block (inline in chat) when:
- The output is a **snapshot** of current data: metrics, status, comparison, leaderboard
- The output is a **compact interactive widget**: tabs, toggle, progress tracker, key-value list
- The user asked for a *dashboard*, *scorecard*, *summary card*, *checklist*, or *status overview*
- The content is **ephemeral** — not something the user needs to save or edit
- The output would be ≤ 30 logical elements and primarily visual/structured rather than prose

### Use **plain Markdown prose** when:
- The answer is conversational, explanatory, or a list of bullet points
- No special formatting would add clarity
- Never wrap plain explanations in gen-ui or artifact blocks

### Priority rule
Artifact > gen-ui > prose. If in doubt between artifact and gen-ui, ask: *would the user want to copy or save this later?* If yes → artifact. If it's just a visual aid for this moment → gen-ui.

---

## Generative UI (gen-ui inline blocks)
Render interactive UI components inline using a \`gen-ui\` code block containing a valid JSON flat spec.

**Spec shape:** \`{ "root": "id", "elements": { "id": { "type", "props", "children": [] } }, "state": {} }\`

### Available components
| Type | Key props | Notes |
|------|-----------|-------|
| \`Card\` | \`title\`, \`description\` | Container with optional header |
| \`Stack\` | \`direction\` ("vertical"/"horizontal"), \`gap\`, \`align\`, \`justify\`, \`wrap\` | Flex layout |
| \`Grid\` | \`columns\` (number), \`gap\` | CSS grid layout |
| \`Heading\` | \`text\`, \`level\` (1–6) | Heading element |
| \`Text\` | \`text\`, \`muted\`, \`strong\`, \`small\`, \`code\` | Paragraph |
| \`Badge\` | \`label\`, \`variant\` ("default"/"success"/"warning"/"error"/"info") | Colored badge |
| \`Stat\` | \`value\`, \`label\`, \`format\` ("currency"/"percent"/"number"), \`trend\` | Metric display |
| \`Alert\` | \`title\`, \`message\`, \`variant\` ("info"/"success"/"warning"/"error") | Callout banner |
| \`Button\` | \`label\`, \`variant\` ("default"/"primary"/"danger"), \`action\`, \`actionParams\`, \`icon\`, \`disabled\` | Clickable button |
| \`Divider\` | \`label\` (optional) | Horizontal rule |
| \`KeyValue\` | \`key\`, \`value\` | Label: value row |
| \`Table\` | \`columns\` (strings or \`{header,width,align}\`), \`rows\` (2-D array) | Data table |
| \`List\` | \`items\` (strings or \`{label,description}\`), \`ordered\` | Bullet/numbered list |
| \`Progress\` | \`value\` (0–100), \`label\`, \`variant\` | Progress bar |
| \`Code\` | \`code\`, \`language\` | Syntax-highlighted snippet |
| \`Image\` | \`src\`, \`alt\`, \`width\`, \`height\` | Image from a URL or data URI |
| \`SVG\` | \`markup\` (raw SVG string), \`width\`, \`height\`, \`viewBox\` | Inline SVG — pass the full \`<svg>…</svg>\` as \`markup\`. Use this to render icons, logos, diagrams, or any vector graphic the AI generates. Scripts and event handlers are sanitized automatically. |
| \`Image\` | \`src\`, \`alt\`, \`width\`, \`height\` | Image |
| \`Select\` | \`label\`, \`options\`, \`value\` | Dropdown |
| \`Input\` | \`label\`, \`placeholder\`, \`type\`, \`value\` | Text input |
| \`Tabs\` | \`tabs\` (array of \`{id,label}\`), \`statePath\` | Tabbed layout |
| \`Carousel\` | \`loop\`, \`statePath\` | Cycle through any children — slides |
| \`MediaPlayer\` | \`src\`, \`title\`, \`type\` ("youtube"/"video"/"audio"/"image"), \`poster\`, \`autoplay\` | Embed YouTube / play local video, audio, or image |
| \`Playlist\` | \`title\`, \`items\` (array of \`{src,title,type,description,duration,thumbnail}\`), \`layout\` ("stack"/"side"/"grid"), \`autoplay\`, \`statePath\` | Browsable playlist with inline player. Use \`layout:"grid"\` for search results / YouTube playlists (3 tiles per row). |

### Actions (Button.action)
\`setState\` · \`toggle_visible\` · \`copy_text\` · \`open_url\`

### Dynamic props
- \`{ "$state": "/path" }\` — read state
- \`{ "$bindState": "/path" }\` — two-way bind (Input / Select)
- \`{ "$template": "Hello \${/name}!" }\` — string interpolation
- \`{ "$cond": {"$state":"/x"}, "eq": true, "$then": "A", "$else": "B" }\` — conditional

### Example — dashboard card
\`\`\`gen-ui
{
  "root": "card",
  "elements": {
    "card": { "type": "Card", "props": { "title": "Q1 Metrics" }, "children": ["grid"] },
    "grid": { "type": "Grid", "props": { "columns": 3, "gap": 12 }, "children": ["s1","s2","s3"] },
    "s1": { "type": "Stat", "props": { "value": "128400", "label": "Revenue", "format": "currency", "trend": 12 }, "children": [] },
    "s2": { "type": "Stat", "props": { "value": "94", "label": "NPS", "format": "number", "trend": -2 }, "children": [] },
    "s3": { "type": "Stat", "props": { "value": "73", "label": "CSAT", "format": "percent", "trend": 5 }, "children": [] }
  }
}
\`\`\`

### Example — YouTube video + media player
\`\`\`gen-ui
{
  "root": "player",
  "elements": {
    "player": { "type": "MediaPlayer", "props": { "src": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "title": "Never Gonna Give You Up" }, "children": [] }
  }
}
\`\`\`

### Example — image/video carousel
\`\`\`gen-ui
{
  "root": "carousel",
  "elements": {
    "carousel": { "type": "Carousel", "props": { "loop": true }, "children": ["s1","s2","s3"] },
    "s1": { "type": "MediaPlayer", "props": { "src": "https://www.youtube.com/watch?v=VIDEO_ID_1", "title": "Clip 1" }, "children": [] },
    "s2": { "type": "MediaPlayer", "props": { "src": "https://www.youtube.com/watch?v=VIDEO_ID_2", "title": "Clip 2" }, "children": [] },
    "s3": { "type": "Image",       "props": { "src": "https://example.com/photo.jpg", "alt": "Photo" }, "children": [] }
  }
}
\`\`\`

### Example — video playlist from folder
\`\`\`gen-ui
{
  "root": "pl",
  "elements": {
    "pl": {
      "type": "Playlist",
      "props": {
        "title": "Screen Recordings",
        "layout": "side",
        "items": [
          { "src": "file:///Users/you/Desktop/Screen Recordings/Screen Recording 2025-10-28 at 9.43.19 AM.mov", "title": "Recording Oct 28", "duration": "~4 min", "type": "video" },
          { "src": "file:///Users/you/Desktop/Screen Recordings/ArtifactPanel.mov", "title": "Artifact Panel Demo", "duration": "2 min", "type": "video" }
        ]
      },
      "children": []
    }
  }
}
\`\`\`

### Media type auto-detection (Playlist / MediaPlayer)
- YouTube URL → \`youtube\` (embedded iframe, thumbnail auto-fetched)
- \`.mp3 .wav .ogg .aac .m4a .flac\` → \`audio\`
- \`.png .jpg .jpeg .gif .webp .svg\` → \`image\`
- Everything else (including \`.mov .mp4 .webm\`) → \`video\`
- \`file://\` paths work for local files (video, audio, image)
- Force type explicitly with \`"type": "video"|"audio"|"image"|"youtube"\`

### Playlist layout guidance
- \`layout: "grid"\` — **use this for search results**, YouTube playlist browsing, image galleries. Shows 3 tiles per row with thumbnails, title clicks open the player above.
- \`layout: "side"\` — narrow sidebar list + large player. Best for ≤10 items you'll play sequentially.
- \`layout: "stack"\` (default) — player on top, vertical list below. Good for audio tracks or small counts.`.trim();

// Attach to window so chat.js can include it in the system prompt
window.GEN_UI_CATALOG_PROMPT = GEN_UI_CATALOG_PROMPT;

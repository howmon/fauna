function toggleBrowserMCP() {
  state.playwrightMCPEnabled = !state.playwrightMCPEnabled;
  localStorage.setItem('fauna-playwright-mcp', state.playwrightMCPEnabled ? 'true' : 'false');
  // Optionally, update UI badge or status here if needed
  showToast('Browser MCP ' + (state.playwrightMCPEnabled ? 'enabled' : 'disabled'));
  // Optionally, call backend endpoint if needed:
  // fetch('/api/playwright-mcp/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: state.playwrightMCPEnabled }) });
}
// ── Debug logger ──────────────────────────────────────────────────────────
var _debugLogs = [];
function dbg(msg, type) {
  var ts = new Date().toISOString().slice(11,23);
  var colors = { info:'#58a6ff', ok:'#3fb950', warn:'#d29922', err:'#f85149', cmd:'#bc8cff' };
  var color = colors[type] || '#8b949e';
  var entry = { ts, msg, color };
  _debugLogs.push(ts + ' ' + msg);
  var el = document.getElementById('debug-log');
  if (el) {
    var row = document.createElement('div');
    row.style.cssText = 'color:' + color + ';word-break:break-all';
    row.textContent = ts + '  ' + msg;
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
  }
  console.debug('[dbg]', msg);
}
function toggleDebugLog() {
  var p = document.getElementById('debug-panel');
  var isVisible = p.style.display !== 'none' && p.style.display !== '';
  p.style.display = isVisible ? 'none' : 'flex';
}

// ── Topbar overflow menu ──────────────────────────────────────────────────
function toggleTopbarMenu(e) {
  if (e) e.stopPropagation();
  var menu = document.getElementById('topbar-menu');
  if (!menu) return;
  var isOpen = menu.style.display !== 'none';
  if (isOpen) { menu.style.display = 'none'; return; }
  menu.style.display = 'flex';
  // Close on next outside click
  setTimeout(function() {
    document.addEventListener('click', closeTopbarMenu, { once: true });
  }, 0);
}
function closeTopbarMenu() {
  var menu = document.getElementById('topbar-menu');
  if (menu) menu.style.display = 'none';
}
function copyDebugLog() {
  navigator.clipboard.writeText(_debugLogs.join('\n')).then(function() {
    var btn = document.querySelector('#debug-panel button');
    if (btn) { var old = btn.textContent; btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = old; }, 1500); }
  });
}
function clearDebugLog() {
  _debugLogs = [];
  var el = document.getElementById('debug-log');
  if (el) el.innerHTML = '';
}

// ── Theme toggle (light / dark / system) + color presets ───────────────────
function getPreferredTheme() {
  var stored = localStorage.getItem('fauna-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// Available color presets (must match the [data-preset] blocks in styles.css).
var FAUNA_PRESETS = [
  { id: 'cyber',   name: 'Cyber',   hint: 'Emerald · JetBrains Mono', swatch: 'oklch(0.720 0.160 155)' },
  { id: 'minimal', name: 'Minimal', hint: 'Blue-gray · Space Grotesk', swatch: 'oklch(0.720 0.160 258)' },
  { id: 'ember',   name: 'Ember',   hint: 'Warm amber',                swatch: 'oklch(0.760 0.150 55)'  },
  { id: 'violet',  name: 'Violet',  hint: 'Royal purple',              swatch: 'oklch(0.740 0.160 295)' }
];
var FAUNA_DEFAULT_PRESET = 'cyber';

function getPreferredPreset() {
  var stored = localStorage.getItem('fauna-preset');
  if (stored && FAUNA_PRESETS.some(function (p) { return p.id === stored; })) return stored;
  return FAUNA_DEFAULT_PRESET;
}

function applyPreset(preset) {
  if (!FAUNA_PRESETS.some(function (p) { return p.id === preset; })) preset = FAUNA_DEFAULT_PRESET;
  document.documentElement.setAttribute('data-preset', preset);
  localStorage.setItem('fauna-preset', preset);
  renderPresetPicker();
  // Preset switch reseats every --color-* / --viz-* token. Re-apply the
  // user's chroma scaling on the next frame so the override layer wraps
  // the new palette.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(function () { applyChroma(getPreferredChroma()); });
  } else {
    applyChroma(getPreferredChroma());
  }
}

// Build / refresh the preset swatch grid in Settings → Appearance.
function renderPresetPicker() {
  var grid = document.getElementById('preset-grid');
  if (!grid) return;
  var active = getPreferredPreset();
  grid.innerHTML = FAUNA_PRESETS.map(function (p) {
    return '<button type="button" class="preset-card' + (p.id === active ? ' active' : '') + '"' +
      ' data-preset-id="' + p.id + '" onclick="applyPreset(\'' + p.id + '\')" title="' + p.hint + '">' +
      '<span class="preset-swatch" style="background:' + p.swatch + '"></span>' +
      '<span class="preset-meta"><span class="preset-name">' + p.name + '</span>' +
      '<span class="preset-hint">' + p.hint + '</span></span>' +
      '<i class="ti ti-check preset-check"></i></button>';
  }).join('');
}

// Available interface fonts. 'default' follows the active color preset.
var FAUNA_FONTS = [
  { id: 'default', name: 'Theme default', hint: 'Follows color theme', stack: '' },
  { id: 'inter',   name: 'Inter',         hint: 'Clean modern UI',     stack: "'Inter', 'Segoe UI Variable', 'Segoe UI', -apple-system, system-ui, sans-serif" },
  { id: 'system',  name: 'System',        hint: 'Classic Fauna',       stack: "'Segoe UI Variable', 'Segoe UI', -apple-system, system-ui, sans-serif" },
  { id: 'grotesk', name: 'Space Grotesk', hint: 'Geometric sans',      stack: "'Space Grotesk', 'Segoe UI', system-ui, sans-serif" },
  { id: 'mono',    name: 'JetBrains Mono', hint: 'Monospace / terminal', stack: "'JetBrains Mono', ui-monospace, 'Cascadia Code', monospace" }
];
var FAUNA_DEFAULT_FONT = 'system';

function getPreferredFont() {
  var stored = localStorage.getItem('fauna-font');
  if (stored && FAUNA_FONTS.some(function (f) { return f.id === stored; })) return stored;
  return FAUNA_DEFAULT_FONT;
}

function applyFont(font) {
  var entry = FAUNA_FONTS.filter(function (f) { return f.id === font; })[0];
  if (!entry) { entry = FAUNA_FONTS[0]; font = FAUNA_DEFAULT_FONT; }
  if (entry.stack) {
    document.documentElement.style.setProperty('--theme-font', entry.stack);
  } else {
    document.documentElement.style.removeProperty('--theme-font');
  }
  localStorage.setItem('fauna-font', font);
  renderFontPicker();
}

// Build / refresh the font picker grid in Settings → Appearance.
function renderFontPicker() {
  var grid = document.getElementById('font-grid');
  if (!grid) return;
  var active = getPreferredFont();
  grid.innerHTML = FAUNA_FONTS.map(function (f) {
    var previewFont = f.stack || "var(--theme-font, sans-serif)";
    return '<button type="button" class="preset-card' + (f.id === active ? ' active' : '') + '"' +
      ' data-font-id="' + f.id + '" onclick="applyFont(\'' + f.id + '\')" title="' + f.hint + '">' +
      '<span class="font-swatch" style="font-family:' + previewFont.replace(/"/g, '&quot;') + '">Ag</span>' +
      '<span class="preset-meta"><span class="preset-name" style="font-family:' + previewFont.replace(/"/g, '&quot;') + '">' + f.name + '</span>' +
      '<span class="preset-hint">' + f.hint + '</span></span>' +
      '<i class="ti ti-check preset-check"></i></button>';
  }).join('');
}

// ── Chroma slider ────────────────────────────────────────────────────────
// Matches the OKLCH theme generator: slider directly sets a target brand
// chroma (0.04 → 0.24). Every --color-* and --viz-1 token in the active
// preset gets its OKLCH chroma scaled by `target / CHROMA_BASELINE` and
// re-emitted as an inline override on documentElement. Re-runs whenever
// the user switches theme or preset.
var FAUNA_CHROMA_TOKENS = [
  '--color-background', '--color-pageBackground', '--color-surface',
  '--color-text', '--color-muted', '--color-primary', '--color-primaryHover',
  '--color-primaryText', '--color-border', '--color-borderStrong',
  '--color-success', '--color-warning', '--color-danger',
  '--color-subtleSurface', '--color-subtleText',
  '--color-pageText', '--color-pageMuted',
  '--color-inputSurface', '--color-inputText',
  '--color-tabSurface', '--color-tabText',
  '--color-tabActiveSurface', '--color-tabActiveText',
  '--viz-1'
];
var FAUNA_CHROMA_BASELINE = 0.16; // reference chroma the presets are tuned around
var FAUNA_CHROMA_MIN      = 0.04;
var FAUNA_CHROMA_MAX      = 0.24;
var FAUNA_CHROMA_DEFAULT  = 0.04;

function getPreferredChroma() {
  var stored = parseFloat(localStorage.getItem('fauna-chroma'));
  if (isFinite(stored) && stored >= FAUNA_CHROMA_MIN && stored <= FAUNA_CHROMA_MAX) return stored;
  return FAUNA_CHROMA_DEFAULT;
}

// Parse oklch(L C H [/ A]) and return { L, C, H, A, suffix } or null.
function _parseOklch(raw) {
  if (!raw) return null;
  var m = String(raw).match(/oklch\(\s*([\d.+\-eE%]+)\s+([\d.+\-eE%]+)\s+([\d.+\-eE%]+)\s*(\/\s*[\d.+\-eE%]+)?\s*\)/i);
  if (!m) return null;
  function num(s) {
    if (typeof s !== 'string') return NaN;
    s = s.trim();
    if (s.charAt(s.length - 1) === '%') return parseFloat(s) / 100;
    return parseFloat(s);
  }
  var L = num(m[1]);
  var C = num(m[2]);
  var H = num(m[3]);
  if (!isFinite(L) || !isFinite(C) || !isFinite(H)) return null;
  return { L: L, C: C, H: H, alpha: m[4] || '' };
}

function _formatOklch(parsed) {
  var alpha = parsed.alpha ? (' ' + parsed.alpha.trim()) : '';
  var fmt = function (n, d) {
    if (!isFinite(n)) return '0';
    var s = n.toFixed(d || 3);
    // Trim trailing zeros but keep at least one decimal place
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return s;
  };
  return 'oklch(' + fmt(parsed.L, 3) + ' ' + fmt(Math.max(0, parsed.C), 4) + ' ' + fmt(parsed.H, 1) + alpha + ')';
}

function applyChroma(value) {
  var v = parseFloat(value);
  if (!isFinite(v)) v = FAUNA_CHROMA_DEFAULT;
  if (v < FAUNA_CHROMA_MIN) v = FAUNA_CHROMA_MIN;
  if (v > FAUNA_CHROMA_MAX) v = FAUNA_CHROMA_MAX;
  localStorage.setItem('fauna-chroma', String(v));

  var root  = document.documentElement;
  var scale = v / FAUNA_CHROMA_BASELINE;

  // First clear any prior inline overrides so getComputedStyle reflects the
  // raw preset values, not our previous scaling.
  for (var i = 0; i < FAUNA_CHROMA_TOKENS.length; i++) {
    root.style.removeProperty(FAUNA_CHROMA_TOKENS[i]);
  }

  // Force layout to flush the removal before re-reading.
  // (getComputedStyle is synchronous, but inline-style removal is
  // immediate-visible without a reflow.)
  var styles = getComputedStyle(root);
  for (var j = 0; j < FAUNA_CHROMA_TOKENS.length; j++) {
    var name = FAUNA_CHROMA_TOKENS[j];
    var raw  = styles.getPropertyValue(name).trim();
    if (!raw) continue;
    var p = _parseOklch(raw);
    if (!p) continue;
    p.C = p.C * scale;
    root.style.setProperty(name, _formatOklch(p));
  }

  // Update the visible slider value indicator if present.
  var label = document.getElementById('chroma-value');
  if (label) label.textContent = v.toFixed(2);
  var slider = document.getElementById('chroma-slider');
  if (slider && parseFloat(slider.value) !== v) slider.value = String(v);
}

function renderChromaSlider() {
  var slider = document.getElementById('chroma-slider');
  if (!slider) return;
  var v = getPreferredChroma();
  slider.min   = String(FAUNA_CHROMA_MIN);
  slider.max   = String(FAUNA_CHROMA_MAX);
  slider.step  = '0.01';
  slider.value = String(v);
  var label = document.getElementById('chroma-value');
  if (label) label.textContent = v.toFixed(2);
  if (!slider._chromaBound) {
    slider.addEventListener('input', function (ev) {
      applyChroma(parseFloat(ev.target.value));
    });
    slider._chromaBound = true;
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Swap highlight.js stylesheet
  var hljsLink = document.getElementById('hljs-theme');
  if (hljsLink) {
    hljsLink.href = theme === 'light'
      ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css'
      : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css';
  }
  // Update toggle button icon
  var btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    var icon = btn.querySelector('i');
    if (icon) {
      icon.className = theme === 'light' ? 'ti ti-sun' : 'ti ti-moon';
    }
    btn.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  }
  if (theme === 'light' || theme === 'dark') localStorage.setItem('fauna-theme', theme);
  // Theme switch reseats every --color-* token (dark vs light palette).
  // Re-apply chroma overrides so they wrap the new palette.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(function () { applyChroma(getPreferredChroma()); });
  } else {
    applyChroma(getPreferredChroma());
  }
}

function toggleTheme() {
  document.documentElement.classList.add('theme-transition');
  var current = document.documentElement.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('fauna-theme', next);
  applyTheme(next);
  setTimeout(function() { document.documentElement.classList.remove('theme-transition'); }, 250);
}

// Apply theme + color preset on load
applyTheme(getPreferredTheme());
applyPreset(getPreferredPreset());
applyFont(getPreferredFont());
applyChroma(getPreferredChroma());

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function() {
  if (!localStorage.getItem('fauna-theme')) applyTheme(getPreferredTheme());
});


var allModels = [];

function getSupportedModelFallback(_preferred) {
  if (!allModels.length) return 'gpt-4.1';
  return allModels[0].id;
}

// Kept for back-compat with call sites; no longer rewrites unknown ids,
// just returns them as-is. /api/models is now the source of truth and only
// returns chat-compatible models, so client-side coercion was causing
// spurious "switched to X" behavior.
function normalizeSupportedModel(id, _opts) {
  return id || getSupportedModelFallback('');
}

async function loadModels() {
  try {
    const r = await fetch('/api/models');
    const d = await r.json();
    allModels = d.models || [];
  } catch (e) {}
  if (!allModels.length) allModels = [
    { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', vendor: 'Anthropic' },
    { id: 'gpt-4.1',           name: 'GPT-4.1',           vendor: 'OpenAI' },
    { id: 'gpt-4.1-mini',      name: 'GPT-4.1 mini',      vendor: 'OpenAI' },
    { id: 'gemini-2.0-flash',  name: 'Gemini 2.0 Flash',  vendor: 'Google' },
  ];
  // Append local models if a local-LLM backend is configured.
  await _mergeLocalModelsInto(allModels);
  // Only fall back if saved model is genuinely missing from the picker.
  if (!state.model || !allModels.find(function(m) { return m.id === state.model; })) {
    state.model = getSupportedModelFallback(state.model);
    localStorage.setItem('fauna-model', state.model);
  }
  populateModelSelect();
}

// Fetches /api/llm/config + /api/llm/models and pushes each local model into
// `arr` tagged with `local: true`, `providerId`, `baseURL`, and `apiKey` so
// chat.js can echo them back in the request body. Vendor is forced to 'Local'
// so the picker groups them at the bottom.
async function _mergeLocalModelsInto(arr) {
  try {
    var cfgR = await fetch('/api/llm/config');
    var cfgD = await cfgR.json();
    var cfg  = cfgD.config;
    if (!cfg || cfg.providerId === 'copilot') return;
    var mR = await fetch('/api/llm/models');
    var mD = await mR.json();
    var localModels = (mD.models || []).map(function(m) {
      return {
        id:     m.id,
        name:   m.name || m.id,
        vendor: 'Custom',
        local:  true,
        providerId: cfg.providerId,
        baseURL:    cfg.baseURL,
        apiKey:     cfg.apiKey,
        // Conservative defaults — picker shows no vision/tools badge unless
        // user explicitly turned the override on.
        vision: !!(cfg.overrides && cfg.overrides.vision),
        tools:  !!(cfg.overrides && cfg.overrides.tools),
        contextWindow: m.contextWindow || m.context_length || m.context_window || undefined,
      };
    });
    // If the user typed a default model that the endpoint didn't return,
    // still surface it so it can be selected.
    if (cfg.defaultModel && !localModels.find(function(m) { return m.id === cfg.defaultModel; })) {
      localModels.unshift({
        id: cfg.defaultModel, name: cfg.defaultModel, vendor: 'Custom',
        local: true, providerId: cfg.providerId, baseURL: cfg.baseURL, apiKey: cfg.apiKey,
        vision: !!(cfg.overrides && cfg.overrides.vision),
        tools:  !!(cfg.overrides && cfg.overrides.tools),
      });
    }
    arr.push.apply(arr, localModels);
  } catch (e) {
    console.warn('[local-llm] merge failed', e);
  }
}

function populateModelSelect() {
  var sel = document.getElementById('model-select');
  sel.innerHTML = '';

  // Group by vendor (Anthropic, OpenAI, Google, …) in a stable order.
  var order = ['Anthropic', 'OpenAI', 'Google', 'xAI', 'Minimax', 'Custom'];
  var byVendor = {};
  allModels.forEach(function(m) {
    var v = m.vendor || 'Other';
    (byVendor[v] = byVendor[v] || []).push(m);
  });
  var vendors = Object.keys(byVendor).sort(function(a, b) {
    var ai = order.indexOf(a), bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  vendors.forEach(function(v) {
    var grp = document.createElement('optgroup');
    grp.label = v;
    byVendor[v].forEach(function(m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name + (m.fast ? ' ·' : '');
      opt.selected = m.id === state.model;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  });

  // Sync toolbar label
  var cur = allModels.find(function(m) { return m.id === state.model; });
  var lbl = document.getElementById('tb-model-label');
  if (lbl) {
    var suffix = cur && cur.local ? ' · custom' : '';
    lbl.textContent = (cur ? cur.name : (state.model || 'Model')) + suffix;
  }
}

function onModelChange(id) {
  state.model = id;
  localStorage.setItem('fauna-model', id);
  if (state.currentId && typeof getConv === 'function') {
    var conv = getConv(state.currentId);
    if (conv) {
      conv.model = id;
      saveConversations();
    }
  }
  var m = allModels.find(function(mm) { return mm.id === id; });
  if (m && typeof showToast === 'function') showToast('Model: ' + m.name + (m.local ? ' (custom)' : ''));
  // Sync hidden select + toolbar label
  var sel = document.getElementById('model-select');
  if (sel) sel.value = id;
  var lbl = document.getElementById('tb-model-label');
  if (lbl) lbl.textContent = (m ? m.name : id) + (m && m.local ? ' · custom' : '');
}

// ── Auth & Settings ───────────────────────────────────────────────────────

var settingsOpen = false;

function toggleSettings() {
  if (settingsOpen) {
    if (typeof closeSettingsPanelPage === 'function') closeSettingsPanelPage();
    if (typeof closeAppPage === 'function') closeAppPage();
    return;
  }
  if (typeof openSettingsPage === 'function') openSettingsPage('general');
}

function closeSettingsPanelPage() {
  if (!settingsOpen) return;
  settingsOpen = false;
  var panel = document.getElementById('settings-panel');
  if (panel) panel.classList.remove('open');
}

window.closeSettingsPanelPage = closeSettingsPanelPage;

// ── More overflow menu ────────────────────────────────────────────────────
function toggleMoreMenu(e) {
  if (e) e.stopPropagation();
  var m = document.getElementById('more-menu');
  var vis = m.style.display !== 'none';
  m.style.display = vis ? 'none' : '';
  if (!vis) {
    // Close on next click anywhere
    setTimeout(function() {
      document.addEventListener('click', _closeMoreOnce, { once: true });
    }, 0);
  }
}
function hideMoreMenu() {
  document.getElementById('more-menu').style.display = 'none';
}
function _closeMoreOnce() { hideMoreMenu(); }

// ── Mobile QR pairing (in Settings panel) ────────────────────────────────
async function loadMobilePairQR() {
  var canvas = document.getElementById('mobile-qr-canvas');
  var status = document.getElementById('mobile-qr-status');
  var info = document.getElementById('mobile-pair-info');
  if (!canvas) return;
  status.textContent = 'Loading…';
  try {
    var res = await fetch('/api/mobile/pair');
    var data = await res.json();
    var url = data.primaryQr;
    if (!url) { status.textContent = 'No network interfaces found'; return; }
    // Use server-generated QR data URL (works offline in Electron)
    if (data.qrImage) {
      // Replace canvas with img if needed
      var img = document.getElementById('mobile-qr-img');
      if (!img) {
        img = document.createElement('img');
        img.id = 'mobile-qr-img';
        img.style.cssText = 'width:200px;height:200px;border-radius:8px;image-rendering:pixelated';
        canvas.parentNode.insertBefore(img, canvas);
        canvas.style.display = 'none';
      }
      img.src = data.qrImage;
    } else if (typeof QRCode !== 'undefined' && QRCode.toCanvas) {
      // Fallback to client-side rendering if CDN loaded
      await QRCode.toCanvas(canvas, url, { width: 200, margin: 2, color: { dark: '#000', light: '#fff' } });
    } else {
      status.textContent = 'QR generation failed';
      return;
    }
    status.textContent = 'Scan with Fauna mobile app';
    // Show connection info
    var ipList = (data.ips || []).map(function(ip) { return ip + ':' + data.port; }).join(', ');
    var tunnelLine = data.tunnelUrl ? '<br><strong>Tunnel:</strong> <span style="color:var(--teal)">' + data.tunnelUrl + '</span>' : '';
    info.innerHTML = '<strong>Server:</strong> ' + (data.hostname || 'unknown') + '<br>' +
      '<strong>Address:</strong> ' + ipList + tunnelLine + '<br>' +
      '<strong>Token:</strong> <code style="font-size:10px;background:var(--fau-surface3);padding:1px 4px;border-radius:3px">' + data.token.slice(0,8) + '…</code>';
    // Update tunnel button state
    _updateTunnelBtn(!!data.tunnelUrl, data.tunnelUrl);
  } catch (e) {
    status.textContent = 'Failed to load pairing info';
  }
}

async function resetMobilePairToken() {
  if (!confirm('Reset pairing token? All connected mobile devices will need to re-pair.')) return;
  try {
    await fetch('/api/mobile/pair/reset', { method: 'POST' });
    loadMobilePairQR();
  } catch (e) {
    alert('Failed: ' + e.message);
  }
}

// ── Tunnel (remote access) ───────────────────────────────────────────────
function _updateTunnelBtn(active, url) {
  var label = document.getElementById('tunnel-btn-label');
  var status = document.getElementById('tunnel-status');
  if (label) label.textContent = active ? 'Disable Remote Access' : 'Enable Remote Access';
  if (status) {
    status.style.display = active ? 'block' : 'none';
    status.textContent = active ? 'Tunnel active: ' + url : '';
  }
}

async function toggleTunnel() {
  var label = document.getElementById('tunnel-btn-label');
  var isActive = label && label.textContent.includes('Disable');
  label.textContent = isActive ? 'Stopping…' : 'Starting…';
  try {
    if (isActive) {
      await fetch('/api/tunnel/stop', { method: 'POST' });
      _updateTunnelBtn(false);
    } else {
      var res = await fetch('/api/tunnel/start', { method: 'POST' });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start tunnel');
      _updateTunnelBtn(true, data.url);
    }
    // Refresh QR to include/remove tunnel URL
    loadMobilePairQR();
  } catch (e) {
    alert('Tunnel error: ' + e.message);
    _updateTunnelBtn(false);
  }
}

async function loadSettingsState() {
  // Sync auto-run checkbox
  var cb = document.getElementById('autorun-toggle');
  if (cb) cb.checked = state.autoRunShell;

  // Sync bypass permissions checkbox
  var bpCb = document.getElementById('bypass-perms-toggle');
  if (bpCb) bpCb.checked = state.bypassCommandPermissions;

  // Sync dynamic widgets (experimental) checkbox
  var dwCb = document.getElementById('dynamic-widgets-toggle');
  if (dwCb) dwCb.checked = !!state.enableDynamicWidgets;

  // Sync transcript export (experimental) checkbox and apply visibility
  var ceCb = document.getElementById('conv-export-toggle');
  if (ceCb) ceCb.checked = !!state.enableConvExport;
  if (typeof _applyConvExportVisibility === 'function') _applyConvExportVisibility();

  // Sync auto-compact checkbox
  var acCb = document.getElementById('auto-compact-toggle');
  if (acCb) acCb.checked = !!state.autoCompact;

  // Sync inline AI autocomplete checkbox
  var aiCb = document.getElementById('ai-autocomplete-toggle');
  if (aiCb && typeof aiAutocompleteIsEnabled === 'function') aiCb.checked = aiAutocompleteIsEnabled();

  // Sync thinking budget
  var tb = document.getElementById('thinking-budget-select');
  if (tb) tb.value = state.thinkingBudget;
  var hint = document.getElementById('thinking-budget-hint');
  if (hint) hint.textContent = _thinkingHints[state.thinkingBudget] || '';

  // Sync max context turns
  var range = document.getElementById('max-turns-range');
  if (range) range.value = state.maxContextTurns;
  var lbl = document.getElementById('max-turns-label');
  if (lbl) lbl.textContent = state.maxContextTurns === 100 ? 'Max' : state.maxContextTurns;

  // Load current PAT status
  const tokenRes = await fetch('/api/token').catch(() => ({}));
  const tokenData = tokenRes.ok ? await tokenRes.json() : {};
  if (tokenData.hasPat) {
    document.getElementById('pat-input').placeholder = 'Saved: ' + tokenData.preview;
    document.getElementById('clear-pat-btn').style.display = '';
  } else {
    document.getElementById('pat-input').placeholder = 'ghp_… or github_pat_…';
    document.getElementById('clear-pat-btn').style.display = 'none';
  }
  checkAuth();
  loadProviderStatus();
  loadMobilePairQR();
  loadEnterpriseAuthStatus();
  loadWorkiqStatus();
}async function checkAuth() {
  var pill  = document.getElementById('auth-pill');
  var badge = document.getElementById('auth-badge');
  try {
    var r = await fetch('/api/auth');
    var d = await r.json();
    if (d.authenticated) {
      const sourceLabel = { pat: 'PAT', keychain: 'Keychain', env: 'Env', direct: 'API Key' }[d.source] || d.source || '';
      const directInfo = d.directProviders && d.directProviders.length ? ' + ' + d.directProviders.join(', ') : '';
      if (pill) {
        pill.className = 'ok';
        pill.innerHTML = '<i class="ti ti-circle-check"></i> ' + (sourceLabel || 'Auth OK');
      }
      if (badge) {
        badge.className = 'auth-source-badge ok';
        badge.innerHTML = '<i class="ti ti-check"></i> ' + sourceLabel + directInfo + (d.source !== 'direct' && d.preview ? ' · ' + d.preview : '');
      }
    } else {
      if (pill) {
        pill.className = 'err';
        pill.innerHTML = '<i class="ti ti-alert-circle"></i> Not authenticated';
      }
      if (badge) {
        badge.className = 'auth-source-badge err';
        badge.innerHTML = '<i class="ti ti-x"></i> ' + (d.error || 'Not authenticated');
      }
    }
  } catch (e) {
    if (pill) {
      pill.className = 'dim';
      pill.innerHTML = '<i class="ti ti-wifi-off"></i> Offline';
    }
    if (badge) { badge.className = 'auth-source-badge err'; badge.innerHTML = '<i class="ti ti-x"></i> Server offline'; }
  }
}

// No-op stubs — real implementations injected by /js/private-auth.js if present
async function loadEnterpriseAuthStatus() {}
async function enterpriseSignIn() {}
async function enterpriseSignOut() {}
async function loadWorkiqStatus() {}
async function workiqConnect() {}
async function workiqSignOut() {}

async function savePat() {
  var input  = document.getElementById('pat-input');
  var status = document.getElementById('pat-status');
  var pat    = input.value.trim();
  if (!pat) { status.className = 'settings-status err'; status.textContent = 'Please enter a token.'; return; }

  status.className = 'settings-status'; status.textContent = 'Saving…';

  try {
    var r = await fetch('/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pat })
    });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'Failed');

    status.className = 'settings-status ok';
    status.innerHTML = '<i class="ti ti-check"></i> Token saved (' + d.preview + ')';
    input.value = '';
    input.placeholder = 'Saved: ' + d.preview;
    document.getElementById('clear-pat-btn').style.display = '';
    checkAuth();
    showToast('Token saved');
  } catch (err) {
    status.className = 'settings-status err';
    status.innerHTML = '<i class="ti ti-x"></i> ' + err.message;
  }
}

async function clearPat() {
  await fetch('/api/token', { method: 'DELETE' });
  document.getElementById('pat-input').placeholder = 'ghp_… or github_pat_…';
  document.getElementById('pat-input').value = '';
  document.getElementById('clear-pat-btn').style.display = 'none';
  document.getElementById('pat-status').textContent = '';
  checkAuth();
  showToast('Token removed');
}

function togglePatVisibility() {
  var input = document.getElementById('pat-input');
  input.type = input.type === 'password' ? 'text' : 'password';
}

function openGithubTokenPage() {
  // Works in Electron (opens in default browser via main.js handler) and normal browser
  window.open('https://github.com/settings/tokens/new?scopes=&description=Fauna', '_blank');
}

// ── Direct provider key management ────────────────────────────────────────

async function loadProviderStatus() {
  try {
    var r = await fetch('/api/providers');
    var d = await r.json();
    (d.providers || []).forEach(function(p) {
      var status = document.getElementById('provider-' + p.id + '-status');
      var clear  = document.getElementById('provider-' + p.id + '-clear');
      var input  = document.getElementById('provider-' + p.id + '-input');
      if (p.configured) {
        if (status) { status.className = 'settings-status ok'; status.innerHTML = '<i class="ti ti-check"></i> Configured (' + p.preview + ')'; }
        if (clear)  clear.style.display = '';
        if (input)  input.placeholder = 'Saved: ' + p.preview;
      } else {
        if (status) { status.className = 'settings-status'; status.textContent = ''; }
        if (clear)  clear.style.display = 'none';
      }
    });
  } catch (_) {}
}

async function saveProviderKey(provider) {
  var input  = document.getElementById('provider-' + provider + '-input');
  var status = document.getElementById('provider-' + provider + '-status');
  var key    = input.value.trim();
  if (!key) { status.className = 'settings-status err'; status.textContent = 'Please enter an API key.'; return; }
  status.className = 'settings-status'; status.textContent = 'Saving…';
  try {
    var r = await fetch('/api/providers/' + provider + '/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key })
    });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'Failed');
    status.className = 'settings-status ok';
    status.innerHTML = '<i class="ti ti-check"></i> Saved (' + d.preview + ')';
    input.value = '';
    input.placeholder = 'Saved: ' + d.preview;
    document.getElementById('provider-' + provider + '-clear').style.display = '';
    showToast(provider.charAt(0).toUpperCase() + provider.slice(1) + ' key saved');
    checkAuth();
    refreshModelList();
  } catch (err) {
    status.className = 'settings-status err';
    status.innerHTML = '<i class="ti ti-x"></i> ' + err.message;
  }
}

async function clearProviderKey(provider) {
  await fetch('/api/providers/' + provider + '/key', { method: 'DELETE' });
  var input = document.getElementById('provider-' + provider + '-input');
  input.placeholder = input.dataset.defaultPlaceholder || '';
  input.value = '';
  document.getElementById('provider-' + provider + '-clear').style.display = 'none';
  document.getElementById('provider-' + provider + '-status').textContent = '';
  showToast(provider.charAt(0).toUpperCase() + provider.slice(1) + ' key removed');
  checkAuth();
  refreshModelList();
}

function toggleProviderKeyVisibility(provider) {
  var input = document.getElementById('provider-' + provider + '-input');
  input.type = input.type === 'password' ? 'text' : 'password';
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('auth-tab-cli').style.display = tab === 'cli' ? '' : 'none';
  document.getElementById('auth-tab-keys').style.display = tab === 'keys' ? '' : 'none';
  var localPane = document.getElementById('auth-tab-local');
  if (localPane) localPane.style.display = tab === 'local' ? '' : 'none';
  event.target.classList.add('active');
  if (tab === 'local' && typeof initLocalLLMSettings === 'function') initLocalLLMSettings();
}

async function refreshModelList() {
  // Re-fetch model list from server and update the dropdown
  await loadModels();
}


// ── DOM helpers ───────────────────────────────────────────────────────────

function createMessageEl(role, agentInfo) {
  var div = document.createElement('div');
  div.className = 'msg ' + role;
  var avatar, name;
  if (role === 'user') {
    avatar = '<i class="ti ti-user"></i>';
    name = 'You';
  } else if (agentInfo && agentInfo.displayName) {
    avatar = '<i class="ti ' + escHtml(agentInfo.icon || 'ti-robot') + '"></i>';
    name = escHtml(agentInfo.displayName);
    div.dataset.agentName = agentInfo.name || '';
  } else {
    avatar = '<i class="ti ti-sparkles"></i>';
    name = 'Fauna';
  }
  var time   = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML =
    '<div class="msg-header">' +
      '<div class="msg-avatar">' + avatar + '</div>' +
      '<span class="msg-name">' + name + '</span>' +
      '<span class="msg-time">' + time + '</span>' +
      '<div class="msg-actions">' +
        '<button class="msg-action-btn" onclick="copyMsg(this)">Copy</button>' +
        (role === 'assistant' ? '<button class="msg-action-btn" onclick="regenMsg(this)">↺ Regen</button>' : '') +
      '</div>' +
    '</div>' +
    '<div class="msg-body"></div>';
  return div;
}

// Renders / updates a condensed plan checklist inside an assistant message
// bubble. Idempotent — if a .plan-panel already exists it is reused so
// status flips don't blow away animation state. Status icons:
//   completed   → ti-circle-check  (green)
//   in-progress → spinner (loader animation)
//   cancelled   → ti-x (muted)
//   not-started → empty circle (muted)
// `isLive` controls whether the panel shows a "working" label vs a final
// "Plan" header. Exposed on window for chat.js + ui.js history rehydrate.
window.renderPlanPanel = function renderPlanPanel(msgEl, plan, isLive) {
  if (!msgEl || !plan || !Array.isArray(plan.items)) return;
  var items = plan.items;
  var panel = msgEl.querySelector('.plan-panel');
  var bodyAnchor = msgEl.querySelector('.msg-body');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'plan-panel';
    panel.dataset.open = '1';
    var headerBtn = document.createElement('button');
    headerBtn.className = 'plan-toggle';
    headerBtn.type = 'button';
    headerBtn.innerHTML =
      '<i class="ti ti-list-check plan-header-icon"></i>' +
      '<span class="plan-label">Plan</span>' +
      '<span class="plan-summary"></span>' +
      '<i class="ti ti-chevron-down plan-chevron"></i>';
    var listEl = document.createElement('ul');
    listEl.className = 'plan-list';
    panel.appendChild(headerBtn);
    panel.appendChild(listEl);
    headerBtn.addEventListener('click', function() {
      panel.dataset.open = panel.dataset.open === '1' ? '0' : '1';
    });
    if (bodyAnchor) msgEl.insertBefore(panel, bodyAnchor);
    else msgEl.appendChild(panel);
  }
  // Stash the latest plan ref on the panel so per-item click handlers (which
  // capture only the initial closure) can re-trigger a render to surface
  // archived substeps after the plan finishes streaming.
  panel._planRef = plan;
  var listEl2 = panel.querySelector('.plan-list');
  var summaryEl = panel.querySelector('.plan-summary');
  // Diff render — keep existing rows where ids match so we don't trash DOM.
  var existingById = {};
  Array.from(listEl2.children).forEach(function(li) {
    var id = li.getAttribute('data-id');
    if (id) existingById[id] = li;
  });
  var seen = {};
  items.forEach(function(it, idx) {
    var id = String(it.id != null ? it.id : (idx + 1));
    seen[id] = true;
    var li = existingById[id];
    if (!li) {
      li = document.createElement('li');
      li.className = 'plan-item';
      li.setAttribute('data-id', id);
      li.innerHTML =
        '<div class="plan-item-row">' +
          '<span class="plan-icon"></span>' +
          '<span class="plan-text"></span>' +
          '<i class="ti ti-chevron-down plan-item-chevron"></i>' +
        '</div>' +
        '<ul class="plan-substeps"></ul>';
      // Click toggles substep visibility for this step. Re-invoke
      // renderPlanPanel inline so an expand click after the plan has
      // finished still surfaces the archived substep history (no
      // plan_update will fire again once streaming is done).
      var row = li.querySelector('.plan-item-row');
      row.addEventListener('click', function(e) {
        e.stopPropagation();
        li.dataset.expanded = li.dataset.expanded === '1' ? '0' : '1';
        var cachedPlan = panel._planRef;
        if (cachedPlan) window.renderPlanPanel(msgEl, cachedPlan, panel.dataset.live === '1');
      });
      listEl2.appendChild(li);
    }
    var prevStatus = li.dataset.status;
    li.dataset.status = it.status || 'not-started';
    var iconEl = li.querySelector('.plan-icon');
    var textEl = li.querySelector('.plan-text');
    var iconHtml = '';
    if (it.status === 'completed') {
      iconHtml = '<i class="ti ti-circle-check-filled"></i>';
    } else if (it.status === 'in-progress') {
      iconHtml = '<i class="ti ti-loader-2 plan-spin"></i>';
    } else if (it.status === 'cancelled') {
      iconHtml = '<i class="ti ti-circle-x"></i>';
    } else {
      iconHtml = '<i class="ti ti-circle"></i>';
    }
    iconEl.innerHTML = iconHtml;
    textEl.textContent = it.title || '';

    // ── Substeps: live shows only latest under in-progress; completed collapses ──
    var subs = Array.isArray(it.substeps) ? it.substeps : [];
    var subsEl = li.querySelector('.plan-substeps');
    var hasSubs = subs.length > 0;
    li.dataset.hasSubsteps = hasSubs ? '1' : '0';
    // Auto-collapse expanded view when status flips to completed (transient → archived).
    if (prevStatus === 'in-progress' && it.status === 'completed') li.dataset.expanded = '0';
    if (hasSubs) {
      // Render either ALL substeps (when user expanded the step) or just the LATEST
      // (when item is in-progress, condensed live view). Completed items hide subs
      // entirely unless expanded.
      var expanded = li.dataset.expanded === '1';
      var toShow;
      if (expanded) toShow = subs.slice();
      else if (it.status === 'in-progress') toShow = subs.slice(-1);
      else toShow = []; // completed/cancelled/not-started → hide unless expanded
      // Re-render only when content changes to avoid blowing animations.
      var signature = (expanded ? 'A:' : 'L:') + toShow.length + ':' + (toShow[toShow.length-1] || '');
      if (subsEl.dataset.signature !== signature) {
        subsEl.dataset.signature = signature;
        subsEl.innerHTML = toShow.map(function(s, i) {
          var isLast = i === toShow.length - 1;
          var dot = (isLast && it.status === 'in-progress')
            ? '<i class="ti ti-loader-2 plan-spin plan-substep-dot"></i>'
            : '<i class="ti ti-point-filled plan-substep-dot"></i>';
          return '<li class="plan-substep">' + dot + '<span>' + escHtml(s) + '</span></li>';
        }).join('');
      }
    } else {
      subsEl.innerHTML = '';
      subsEl.dataset.signature = '';
    }
  });
  // Drop rows for items no longer in the plan.
  Object.keys(existingById).forEach(function(id) {
    if (!seen[id]) existingById[id].remove();
  });
  var done = items.filter(function(x){ return x.status === 'completed'; }).length;
  var total = items.length;
  if (summaryEl) summaryEl.textContent = total ? (done + '/' + total) : '';
  panel.dataset.live = isLive ? '1' : '0';
};

function appendMessageDOM(role, content, attachments, animate, agentInfo, isHTML, reasoning, widgets, plan) {
  var el     = createMessageEl(role, agentInfo);
  var body   = el.querySelector('.msg-body');
  if (!animate) el.style.animation = 'none';

  if (attachments && attachments.length) {
    var chips = attachments.map(a => {
      if (a.type === 'image') {
        var nm  = a.name || 'image';
        var src = a.base64 ? ('data:' + (a.mime||'image/png') + ';base64,' + a.base64) : '';
        var thumb = src
          ? '<img class="attach-img-thumb" src="' + src + '" title="' + escHtml(nm) + ' — click to view" onclick="openImageLightbox(this.src,\'' + escHtml(nm).replace(/'/g, '&#39;') + '\')">'
          : '<i class="ti ti-photo"></i>';
        return '<span class="attach-chip attach-chip-image">' + thumb + '<span>' + escHtml(nm) + '</span></span>';
      }
      var icon = a.type === 'url' ? '<i class="ti ti-link"></i>'
               : (a.type === 'figma_file' || a.extSource === 'figma') ? '<i class="ti ti-vector-triangle"></i>'
               : '<i class="ti ti-paperclip"></i>';
      return '<span class="attach-chip"><span class="chip-icon">' + icon + '</span>' + escHtml(a.name) + '</span>';
    }).join('');
    body.innerHTML = '<div class="msg-attachments">' + chips + '</div>';
  }

  if (role === 'user') {
    // Show ONLY what the user actually typed. Strip every runtime context
    // injection (browser tab dumps, planner coercion prose, system-context
    // fences, date stamps) — the model still sees those because they live in
    // the saved `m.content`, but the bubble shouldn't expose them.
    var rawForDisplay = content;
    if (typeof window.sanitizeUserDisplayContent === 'function') {
      rawForDisplay = window.sanitizeUserDisplayContent(content);
    }
    // Split off attachment fences for display
    var display = rawForDisplay.split(/\n\n```\n\/\/ (File|URL):/)[0].trim();
    body.innerHTML += (display ? escHtml(display).replace(/\n/g, '<br>') : '');
  } else if (isHTML) {
    body.innerHTML += content;
  } else {
    // Sanitize write-file blocks — re-populates _wfContentStore from saved message content
    var renderContent = sanitizeWriteFileBlocks(content);
    body.innerHTML += renderMarkdown(renderContent);
    extractAndRenderFigmaExec(content, el, false); // history load — never auto-run old actions
    extractAndRenderShellExec(content, el, true); // history load — never auto-run old commands
    extractAndRenderBrowserActions(content, el, true);
    if (typeof extractAndRenderBrowserExtActions === 'function') extractAndRenderBrowserExtActions(content, el, true);
    extractAndRenderWriteFile(el, true);
    extractAndRenderSaveInstruction(content, el, true);
    extractArtifactsFromBuffer(content, el, false);
    if (typeof extractAndRenderGenUI === 'function') extractAndRenderGenUI(content, el, true);
    (typeof wrapInActivityDetails === 'function' ? wrapInActivityDetails : wrapInChainOfThought)(el);
    if (typeof compactProcessClusters === 'function') compactProcessClusters(el);
    if (typeof compactLongAssistantMessage === 'function') compactLongAssistantMessage(el, content);
    if (typeof extractAndRenderSuggestions === 'function') extractAndRenderSuggestions(content, el, true);
    if (typeof ensureAssistantBubbleNotEmpty === 'function') ensureAssistantBubbleNotEmpty(el);
  }

  // Inject committed compact thinking status for historical AI messages.
  if (role === 'assistant' && reasoning) {
    var rPanel = document.createElement('div');
    rPanel.className = 'reasoning-panel';
    rPanel.dataset.completed = '1';
    rPanel.dataset.open = '0';
    var rLabel = reasoning.durationSeconds != null ? 'Thought for ' + reasoning.durationSeconds + 's' : 'Thought briefly';
    rPanel.innerHTML =
      '<button class="reasoning-toggle" type="button">' +
        '<i class="ti ti-brain"></i>' +
        '<span class="reasoning-label">' + escHtml(rLabel) + '</span>' +
      '</button>';
    el.insertBefore(rPanel, body);
  }

  getConvInner(state.currentId).appendChild(el);

  // Remount the plan checklist if this historical message had one.
  if (role === 'assistant' && plan && plan.items && plan.items.length && typeof window.renderPlanPanel === 'function') {
    try { window.renderPlanPanel(el, plan, false); } catch (_) {}
  }

  // Remount any dynamic widgets that were emitted in this historical message.
  // We mount AFTER the element is in the DOM so the iframe sizes correctly.
  if (role === 'assistant' && widgets && widgets.length && window.faunaDynamicWidgets) {
    widgets.forEach(function(w) {
      if (!w || !w.widgetId || !w.bundle) return;
      try { window.faunaDynamicWidgets.mountWidget(w, el); }
      catch (e) { try { dbg('widget remount failed: ' + (e && e.message), 'warn'); } catch (_) {} }
    });
  }
}

function sendButtonAction() {
  var conv = getConv(state.currentId);
  var sendBtn = document.getElementById('send-btn');
  if (_hasActiveConversationWork() || (sendBtn && sendBtn.classList.contains('is-stopping'))) stopGeneration();
  else sendMessage();
}

var _busyClearTimer = null;

function _hasActiveConversationWork() {
  var activeConv = getConv(state.currentId);
  var hasStream = !!(activeConv && activeConv._streaming);
  var hasShellWork = typeof hasActiveShellWorkForCurrentConversation === 'function' && hasActiveShellWorkForCurrentConversation();
  var hasPendingShellVerification = typeof hasPendingShellVerificationForCurrentConversation === 'function' && hasPendingShellVerificationForCurrentConversation();
  var hasDelegation = typeof window._delegStop === 'function';
  return hasStream || hasShellWork || hasPendingShellVerification || hasDelegation;
}

function setBusy(busy) {
  if (_busyClearTimer) {
    clearTimeout(_busyClearTimer);
    _busyClearTimer = null;
  }
  if (!busy) {
    _busyClearTimer = setTimeout(function() {
      _busyClearTimer = null;
      if (_hasActiveConversationWork()) return;
      _applyBusyState(false);
      // Now that the stop button is no longer red, retry rendering suggestions
      // on the latest assistant message — they were suppressed earlier while
      // an auto-feed chain or shell verification was still in flight.
      try {
        var conv = getConv(state.currentId);
        var convInner = (typeof getConvInner === 'function')
          ? getConvInner(state.currentId)
          : document.querySelector('[data-conv-messages]');
        var lastMsg = convInner && (
          convInner.querySelector('.msg.assistant:last-of-type') ||
          Array.from(convInner.querySelectorAll('.msg.assistant')).pop()
        );
        if (conv && lastMsg && typeof extractAndRenderSuggestions === 'function') {
          var lastAssistant = (conv.messages || []).slice().reverse().find(function(m) {
            return m && m.role === 'assistant' && typeof m.content === 'string';
          });
          if (lastAssistant) extractAndRenderSuggestions(lastAssistant.content, lastMsg, true);
        }
      } catch (_) {}
    }, 650);
    return;
  }
  _applyBusyState(true);
}

function _applyBusyState(busy) {
  if (!busy && _hasActiveConversationWork()) busy = true;
  var sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.classList.toggle('is-stopping', !!busy);
    sendBtn.title = busy ? 'Stop generation' : 'Send (⌘↵ or ⏎)';
    sendBtn.setAttribute('aria-label', busy ? 'Stop generation' : 'Send message');
    sendBtn.innerHTML = busy
      ? '<span class="send-stop-icon" aria-hidden="true"></span>'
      : '<i class="ti ti-send"></i>';
  }
  // Mirror the busy flag onto #input-wrap so the rotating-gradient border
  // animation can run while the model is generating. Same visual language
  // as the AI-running cards on the Kanban board.
  var wrap = document.getElementById('input-wrap');
  if (wrap) wrap.classList.toggle('is-busy', !!busy);
  var stopEl = document.getElementById('stop-btn');
  if (stopEl) stopEl.className = '';
}

function reconcileBusyState() {
  _applyBusyState(_hasActiveConversationWork());
}

function showMessages() {
  if (typeof closeAppPage === 'function') closeAppPage();
  if (typeof setAppRailActive === 'function') setAppRailActive('conversations');
  var empty = document.getElementById('empty-state');
  if (empty) {
    empty.classList.add('hidden');
    empty.style.display = 'none';
  }
  document.getElementById('messages').style.display = 'block';
}

function showEmpty() {
  if (typeof closeAppPage === 'function') closeAppPage();
  if (typeof setAppRailActive === 'function') setAppRailActive('conversations');
  if (typeof renderPromptStarters === 'function') renderPromptStarters();
  var empty = document.getElementById('empty-state');
  if (empty) {
    empty.classList.remove('hidden');
    empty.style.display = 'flex';
  }
  document.getElementById('messages').style.display = 'none';
}

var _userScrolledUp = false;
(function () {
  function _onMsgScroll() {
    var el = document.getElementById('messages');
    if (!el) return;
    // Consider "at bottom" if within 80px
    _userScrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
  }
  document.addEventListener('DOMContentLoaded', function () {
    var el = document.getElementById('messages');
    if (el) el.addEventListener('scroll', _onMsgScroll, { passive: true });
  });
})();

function scrollBottom() {
  if (_userScrolledUp) return;
  var el = document.getElementById('messages');
  el.scrollTop = el.scrollHeight;
}

function forceScrollBottom() {
  _userScrolledUp = false;
  var el = document.getElementById('messages');
  if (el) el.scrollTop = el.scrollHeight;
}

// ── Copy & Regen ──────────────────────────────────────────────────────────

function copyMsg(btn) {
  var body = btn.closest('.msg').querySelector('.msg-body').innerText;
  navigator.clipboard.writeText(body).then(() => showToast('Copied!'));
}

function regenMsg(btn) {
  var conv = getConv(state.currentId);
  if (!conv || conv._streaming) return;
  // Remove last AI message
  var lastAI = conv.messages.findLastIndex ? conv.messages.findLastIndex(m => m.role === 'assistant') : -1;
  if (lastAI < 0) {
    for (var i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'assistant') { lastAI = i; break; }
    }
  }
  if (lastAI >= 0) {
    conv.messages.splice(lastAI, 1);
    saveConversations();
    // Remove from DOM
    var convInner = getConvInner(state.currentId);
    var allMsgEls = convInner.querySelectorAll('.msg.ai');
    var last = allMsgEls[allMsgEls.length - 1];
    if (last) last.remove();
    streamResponse(conv);
  }
}

function copyCode(btn) {
  var code = btn.closest('pre').querySelector('code').innerText;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
}

// ── File attachment ───────────────────────────────────────────────────────

function openFileAttach() {
  var fi = document.getElementById('file-input');
  if (!fi) return;
  // Force multi-select every time in case anything (extension, drag-drop
  // handler, native module) cleared the attribute.
  try { fi.multiple = true; fi.setAttribute('multiple', 'multiple'); } catch(_) {}
  fi.click();
}

function _toBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var chunk = 0x8000;
  var binary = '';
  for (var i = 0; i < bytes.length; i += chunk) {
    var part = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, part);
  }
  return btoa(binary);
}

function _readFileAsDataUrl(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(ev) { resolve(String(ev.target.result || '')); };
    reader.onerror = function() { reject(reader.error || new Error('Failed to read image')); };
    reader.readAsDataURL(file);
  });
}

function _loadImageElement(src) {
  return new Promise(function(resolve, reject) {
    var img = new Image();
    img.onload = function() { resolve(img); };
    img.onerror = function() { reject(new Error('Failed to decode image')); };
    img.src = src;
  });
}

async function _normalizeImageAttachment(file, preferredName) {
  var mime = file.type || 'image/png';
  var name = preferredName || file.name || ('image-' + Date.now() + '.png');
  var originalSize = file.size || 0;
  var rawUrl = await _readFileAsDataUrl(file);
  var rawBase64 = rawUrl.split(',')[1] || '';

  // Keep already-small images as-is to avoid unnecessary quality loss.
  if (originalSize && originalSize <= 1024 * 1024) {
    return { type: 'image', name: name, base64: rawBase64, mime: mime, size: originalSize };
  }

  try {
    var img = await _loadImageElement(rawUrl);
    var maxDim = 1280;
    var scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    var width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    var height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(img, 0, 0, width, height);

    var outputMime = /image\/(png|webp|jpeg|jpg)/i.test(mime) ? 'image/jpeg' : mime;
    var qualities = outputMime === 'image/jpeg' ? [0.72, 0.6, 0.5, 0.42] : [undefined];
    var bestUrl = rawUrl;
    for (var i = 0; i < qualities.length; i++) {
      var candidate = qualities[i] === undefined ? canvas.toDataURL(outputMime) : canvas.toDataURL(outputMime, qualities[i]);
      bestUrl = candidate;
      var candidateBytes = Math.ceil(((candidate.split(',')[1] || '').length * 3) / 4);
      if (candidateBytes <= 700 * 1024) break;
    }

    return {
      type: 'image',
      name: name.replace(/\.(png|webp|jpe?g)$/i, '') + '.jpg',
      base64: bestUrl.split(',')[1] || rawBase64,
      mime: outputMime,
      size: Math.ceil((((bestUrl.split(',')[1] || '').length) * 3) / 4)
    };
  } catch (_) {
    return { type: 'image', name: name, base64: rawBase64, mime: mime, size: originalSize };
  }
}

function _readTextFile(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) { resolve((e.target.result || '').slice(0, 80000)); };
    reader.onerror = function() { reject(reader.error || new Error('Failed to read file')); };
    reader.readAsText(file);
  });
}

async function _extractDocumentText(file) {
  var name = file.name || ('document-' + Date.now());
  var mime = file.type || 'application/octet-stream';
  var ref = 'attachment://' + encodeURIComponent(name);

  // Fast path for plain text files
  if ((mime && mime.indexOf('text/') === 0) || /\.(txt|md|js|jsx|ts|tsx|py|go|rs|java|c|cpp|h|css|html|htm|json|yaml|yml|toml|xml|csv|log|sql|graphql|sh|env)$/i.test(name)) {
    var text = await _readTextFile(file);
    return { text: text, ref: ref, mime: mime, size: file.size || 0, warning: '' };
  }

  // Video/audio files — don't try to extract text (expensive & unsupported).
  // Store as metadata-only attachment.
  if ((mime && (mime.indexOf('video/') === 0 || mime.indexOf('audio/') === 0)) || /\.(mov|mp4|webm|mkv|avi|flv|m4v|3gp|ogv|mp3|wav|flac|m4a|aac|opus|ogg|oga|wma)$/i.test(name)) {
    return {
      text: '[' + (mime.indexOf('video/') === 0 ? 'Video' : 'Audio') + ' file — text extraction not supported; file stored for reference]',
      ref: ref,
      mime: mime,
      size: file.size || 0,
      warning: 'Video/audio files are stored for context but cannot have text extracted'
    };
  }

  var ab = await file.arrayBuffer();
  var payload = {
    name: name,
    mime: mime,
    base64: _toBase64(ab)
  };

  var r = await fetch('/api/extract-attachment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  var d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || 'Failed to extract document');
  return {
    text: d.text || '',
    ref: d.ref || ref,
    mime: d.mime || mime,
    size: d.size || file.size || 0,
    warning: d.warning || ''
  };
}

async function _processSingleAttachment(file) {
  // Resolve absolute filesystem path when available (drag-drop from Finder,
  // file picker). Lets the model use native edit/read tools directly instead
  // of burning a turn searching for the file by name.
  var absPath = '';
  try {
    if (window.faunaApp && typeof window.faunaApp.getPathForFile === 'function') {
      absPath = window.faunaApp.getPathForFile(file) || '';
    } else if (file && typeof file.path === 'string') {
      absPath = file.path;
    }
  } catch (_) { absPath = ''; }

  // Guard against massive files that would freeze the browser during base64 encoding.
  // Limit general uploads to 100 MB; video/audio/binary to 500 MB (will still be stored but not extracted as text).
  var MAX_SIZE_MB = (file.type && (file.type.indexOf('video/') === 0 || file.type.indexOf('audio/') === 0)) ? 500 : 100;
  if (file.size && file.size > MAX_SIZE_MB * 1024 * 1024) {
    addAttachment({
      type: 'file',
      name: file.name,
      content: '[Attachment note] File too large (' + (file.size / (1024*1024)).toFixed(1) + ' MB, limit ' + MAX_SIZE_MB + ' MB)',
      path: absPath || undefined,
      sourceUri: absPath ? ('file://' + absPath) : ('attachment://' + encodeURIComponent(file.name || ('file-' + Date.now()))),
      size: file.size || 0,
      mime: file.type || 'application/octet-stream',
      warning: 'File exceeds ' + MAX_SIZE_MB + ' MB size limit'
    });
    return;
  }

  if (file.type && file.type.startsWith('image/')) {
    var img = await _normalizeImageAttachment(file);
    if (absPath) { img.path = absPath; img.sourceUri = 'file://' + absPath; }
    addAttachment(img);
    return;
  }

  try {
    var extracted = await _extractDocumentText(file);
    var body = extracted.text;
    if (!body && extracted.warning) {
      body = '[Attachment note] ' + extracted.warning;
    }
    addAttachment({
      type: 'file',
      name: file.name,
      content: body,
      path: absPath || undefined,
      sourceUri: absPath ? ('file://' + absPath) : extracted.ref,
      size: extracted.size,
      mime: extracted.mime,
      warning: extracted.warning
    });
  } catch (err) {
    addAttachment({
      type: 'file',
      name: file.name,
      content: '[Attachment note] Failed to extract text: ' + err.message,
      path: absPath || undefined,
      sourceUri: absPath ? ('file://' + absPath) : ('attachment://' + encodeURIComponent(file.name || ('file-' + Date.now()))),
      size: file.size || 0,
      mime: file.type || 'application/octet-stream',
      warning: err.message
    });
  }
}

async function handleFiles(files) {
  var list = Array.from(files || []);
  // Process in parallel so one slow / hung extraction (e.g. a large pptx
  // running through LibreOffice) doesn't make the user think only the first
  // file was accepted. Each file is independently try/caught so one failure
  // never blocks the rest.
  await Promise.all(list.map(function(f) {
    return _processSingleAttachment(f).catch(function(err) {
      try { console.warn('[attach] failed to add', f && f.name, err); } catch(_) {}
      try {
        addAttachment({
          type: 'file',
          name: (f && f.name) || 'attachment',
          content: '[Attachment note] Failed to add: ' + (err && err.message || err),
          size: (f && f.size) || 0,
          mime: (f && f.type) || 'application/octet-stream',
          warning: String(err && err.message || err),
        });
      } catch(_) {}
    });
  }));
  var fi = document.getElementById('file-input');
  if (fi) fi.value = '';
}

function addAttachment(att) {
  // Defensive cap — prevents unbounded growth (e.g. repeated browser-extension
  // snapshots, paste loops) from ballooning memory and freezing the renderer.
  // Base64 images can be hundreds of KB each; without a cap, hundreds of items
  // stall renderAttachBar and saveConversations.
  var MAX_PENDING = 24;
  if (state.pendingAttachments.length >= MAX_PENDING) {
    // Drop the oldest non-user-added attachment first (extension-sourced), else
    // fall back to dropping the absolute oldest.
    var dropIdx = -1;
    for (var i = 0; i < state.pendingAttachments.length; i++) {
      if (state.pendingAttachments[i] && state.pendingAttachments[i].extSource) { dropIdx = i; break; }
    }
    if (dropIdx < 0) dropIdx = 0;
    state.pendingAttachments.splice(dropIdx, 1);
  }
  state.pendingAttachments.push(att);
  renderAttachBar();
}

function removeAttachment(idx) {
  state.pendingAttachments.splice(idx, 1);
  renderAttachBar();
}

function clearAttachments(opts) {
  // After a message is sent we want browser-tab attachments to stick (the
  // user explicitly attached them to keep the page context alive across a
  // multi-turn task — same UX as an active agent chip). The chip's X button
  // still removes them manually.
  if (opts && opts.preservePersistent) {
    var keep = (state.pendingAttachments || []).filter(function(att) {
      var isBrowserPinned = typeof _isBrowserTabReferenceAttachment === 'function' && _isBrowserTabReferenceAttachment(att);
      var isFigmaPinned = !!(att && (att.type === 'figma_file' || att.extSource === 'figma') && att.fileKey);
      return isBrowserPinned || isFigmaPinned;
    });
    state.pendingAttachments = keep;
  } else {
    state.pendingAttachments = [];
  }
  _attachBarExpanded = false;
  renderAttachBar();
}

// ── Image lightbox ────────────────────────────────────────────────
function openImageLightbox(src, caption) {
  if (!src) return;
  var box = document.getElementById('img-lightbox');
  if (!box) return;
  var img = document.getElementById('img-lightbox-img');
  var cap = document.getElementById('img-lightbox-caption');
  var dl  = document.getElementById('img-lightbox-download');
  img.src = src;
  img.alt = caption || '';
  if (cap) { cap.textContent = caption || ''; cap.style.display = caption ? '' : 'none'; }
  if (dl)  { dl.href = src; dl.setAttribute('download', (caption || 'image').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'image'); }
  box.classList.add('show');
  // Esc to close
  if (!box._escBound) {
    box._escBound = true;
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && box.classList.contains('show')) closeImageLightbox();
    });
  }
}
window.openImageLightbox = openImageLightbox;

function closeImageLightbox(e) {
  // Backdrop click: only close when the click landed on the overlay itself,
  // not on the inner image or controls.
  if (e && e.target && e.target.id !== 'img-lightbox' && e.target.id !== 'img-lightbox-img' /* allow clicks on image to not close */) {
    // For close button / download we want to allow their handlers; if click was on close (X), still close.
    if (e.target.closest && e.target.closest('#img-lightbox-download')) return; // let download proceed
  }
  if (e && e.target && (e.target.id === 'img-lightbox-img' || (e.target.closest && e.target.closest('#img-lightbox-download')))) return;
  var box = document.getElementById('img-lightbox');
  if (!box) return;
  box.classList.remove('show');
  var img = document.getElementById('img-lightbox-img');
  if (img) img.src = '';
}
window.closeImageLightbox = closeImageLightbox;

var _attachBarExpanded = false;
var ATTACH_BAR_MAX = 3;

function renderAttachBar() {
  var bar = document.getElementById('attach-bar');
  var atts = state.pendingAttachments;
  if (!atts.length) { bar.innerHTML = ''; return; }

  var showAll = _attachBarExpanded || atts.length <= ATTACH_BAR_MAX;
  var visible = showAll ? atts : atts.slice(0, ATTACH_BAR_MAX);
  var html = visible.map(function(att, i) {
    return _renderChip(att, i);
  }).join('');

  if (!showAll) {
    var remaining = atts.length - ATTACH_BAR_MAX;
    html += '<button class="attach-overflow-btn" onclick="_attachBarExpanded=true;renderAttachBar()" title="Show all ' + atts.length + ' attachments">+' + remaining + ' more</button>';
  } else if (atts.length > ATTACH_BAR_MAX) {
    html += '<button class="attach-overflow-btn" onclick="_attachBarExpanded=false;renderAttachBar()" title="Collapse">show less</button>';
  }

  if (atts.length > 1) {
    html += '<button class="attach-clear-btn" onclick="clearAttachments()" title="Remove all"><i class="ti ti-x"></i> Clear all</button>';
  }

  bar.innerHTML = html;
}

function _renderChip(att, i) {
  var isFigmaAttachment = !!(att && (att.type === 'figma_file' || att.extSource === 'figma'));
  var extCls = (att.extSource && !isFigmaAttachment) ? ' pending-chip-ext' : '';
  if (isFigmaAttachment) extCls += ' pending-chip-figma';
  var isBrowserPersistent = typeof _isBrowserTabReferenceAttachment === 'function' && _isBrowserTabReferenceAttachment(att);
  var isFigmaPersistent = !!(isFigmaAttachment && att.fileKey);
  var isPersistent = isBrowserPersistent || isFigmaPersistent;
  if (isPersistent) extCls += ' pending-chip-pinned';
  var pinnedTitle = isPersistent ? ' title="Pinned to this conversation — stays attached until you remove it"' : '';
  if (att.type === 'image') {
    var src  = att.base64 ? ('data:' + (att.mime || 'image/png') + ';base64,' + att.base64) : '';
    var name = att.name || 'image';
    var thumb = src
      ? '<img class="pending-img-thumb" src="' + src + '" title="' + escHtml(name) + ' — click to view" onclick="event.stopPropagation();openImageLightbox(this.src,\'' + escHtml(name).replace(/'/g, '&#39;') + '\')">'
      : '<span class="pending-img-thumb pending-img-thumb-fallback" title="Preview unavailable"><i class="ti ti-photo"></i></span>';
    return '<div class="pending-chip pending-chip-image' + extCls + '"' + pinnedTitle + '>' +
      thumb +
      '<span class="chip-name" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(name) + '</span>' +
      (isPersistent ? '<i class="ti ti-pin chip-pin-ind" title="Pinned"></i>' : '') +
      '<button class="chip-remove" onclick="removeAttachment(' + i + ')" title="Remove"><i class="ti ti-x"></i></button>' +
    '</div>';
  }
  var icon = att.extSource === 'page'      ? '<i class="ti ti-world-www"></i>'
           : att.extSource === 'selection' ? '<i class="ti ti-text-scan-2"></i>'
           : att.extSource === 'figma'     ? '<i class="ti ti-vector-triangle"></i>'
           : att.type === 'url'            ? '<i class="ti ti-link"></i>'
           : att.type === 'figma_file'     ? '<i class="ti ti-vector-triangle"></i>'
           : '<i class="ti ti-paperclip"></i>';
  return '<div class="pending-chip' + extCls + '"' + pinnedTitle + '>' +
    '<span class="chip-icon">' + icon + '</span>' +
    '<span class="chip-name">' + escHtml(att.name) + '</span>' +
    (isPersistent ? '<i class="ti ti-pin chip-pin-ind" title="Pinned"></i>' : '') +
    '<button class="chip-remove" onclick="removeAttachment(' + i + ')" title="Remove"><i class="ti ti-x"></i></button>' +
  '</div>';
}

// ── URL modal ─────────────────────────────────────────────────────────────

function openUrlModal() {
  document.getElementById('url-modal').classList.add('show');
  document.getElementById('url-input').focus();
  document.getElementById('url-modal-status').textContent = '';
  document.getElementById('url-input').value = '';
}

function closeUrlModal(e) {
  if (e && e.target !== document.getElementById('url-modal')) return;
  document.getElementById('url-modal').classList.remove('show');
}

async function fetchUrl() {
  var url = document.getElementById('url-input').value.trim();
  if (!url) return;
  var status = document.getElementById('url-modal-status');
  status.innerHTML = '<i class="ti ti-loader"></i> Fetching…';
  status.style.color = 'var(--fau-text-dim)';
  try {
    var r = await fetch('/api/fetch-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    status.innerHTML = '<i class="ti ti-check"></i> ' + d.title + ' (' + Math.round(d.chars/1000) + 'k chars)';
    status.style.color = 'var(--success)';
    addAttachment({ type: 'url', name: d.title || url, content: `Source: ${url}\n\n${d.content}` });
    setTimeout(() => document.getElementById('url-modal').classList.remove('show'), 1200);
  } catch (err) {
    status.innerHTML = '<i class="ti ti-x"></i> ' + err.message;
    status.style.color = 'var(--error)';
  }
}

document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') fetchUrl();
  if (e.key === 'Escape') closeUrlModal();
});

document.getElementById('pat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') savePat();
});

// ── System prompt panel ───────────────────────────────────────────────────

function toggleSysPanel() {
  if (typeof openSettingsPage === 'function') {
    openSettingsPage('playbook');
    if (typeof switchPlaybookTab === 'function') switchPlaybookTab('sys-prompt');
  }
}

// Legacy — kept for any older callers
function saveSysPrompt() { saveSysPromptGlobal(); }

// Save only to the current conversation (not globally)
function saveSysPromptForConv() {
  var val = document.getElementById('sys-prompt-input').value;
  var conv = getConv(state.currentId);
  if (!conv) { showToast('No active conversation'); return; }
  conv.systemPrompt = val;
  saveConversations();
  showToast('Saved for this chat');
}

// Save globally — applies to all new chats and updates current conversation
function saveSysPromptGlobal() {
  var val = document.getElementById('sys-prompt-input').value;
  state.systemPrompt = val;
  localStorage.setItem('fauna-sys', val);
  var conv = getConv(state.currentId);
  if (conv) { conv.systemPrompt = val; saveConversations(); }
  // Sync to server for mobile
  fetch('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemPrompt: val }) }).catch(function() {});
  showToast('System prompt saved globally');
}

// Push current text into Agent Rules for permanent global enforcement
function addPromptAsRule() {
  var text = document.getElementById('sys-prompt-input').value.trim();
  if (!text) { showToast('Nothing to add — type a rule first'); return; }
  var rules = loadAgentRules();
  rules.push({ id: 'ar-' + Date.now(), text: text, enabled: true });
  saveAgentRules(rules);
  showToast('Added to global rules');
}

function clearSysPrompt() {
  document.getElementById('sys-prompt-input').value = '';
  updateSysScopeHint();
}

// Show a subtle label indicating whether the displayed text differs from global
function updateSysScopeHint() {
  var hint = document.getElementById('sys-scope-hint');
  if (!hint) return;
  var conv = getConv(state.currentId);
  var convPrompt  = conv ? (conv.systemPrompt || '') : '';
  var globalPrompt = state.systemPrompt || '';
  var current = document.getElementById('sys-prompt-input').value || '';
  if (!current) { hint.textContent = ''; hint.className = ''; return; }
  if (convPrompt && convPrompt !== globalPrompt && current === convPrompt) {
    hint.textContent = 'Custom prompt for this chat only';
    hint.className = 'conv';
  } else if (current === globalPrompt && globalPrompt) {
    hint.textContent = 'Applied to all chats';
    hint.className = 'global';
  } else {
    hint.textContent = 'Unsaved changes';
    hint.className = '';
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────

var sidebarVisible = true;
function setConversationRailVisible(visible) {
  var sb = document.getElementById('sidebar');
  if (!sb) return;
  if (visible) {
    sb.style.display = 'flex';
    sidebarVisible = true;
    sb.classList.remove('collapsed');
    if (sb.dataset.savedWidth) sb.style.width = sb.dataset.savedWidth;
    if (sb.dataset.savedMinWidth) sb.style.minWidth = sb.dataset.savedMinWidth;
  } else {
    sb.style.display = 'none';
  }
}

function toggleSidebar() {
  var sb = document.getElementById('sidebar');
  if (sb && sb.style.display === 'none') {
    if (typeof openConversationsRail === 'function') openConversationsRail();
    else setConversationRailVisible(true);
    return;
  }
  sidebarVisible = !sidebarVisible;
  if (!sidebarVisible) {
    // Store current inline width so we can restore it
    sb.dataset.savedWidth = sb.style.width || '';
    sb.dataset.savedMinWidth = sb.style.minWidth || '';
    sb.style.width = '';
    sb.style.minWidth = '';
    sb.classList.add('collapsed');
  } else {
    sb.classList.remove('collapsed');
    if (sb.dataset.savedWidth) sb.style.width = sb.dataset.savedWidth;
    if (sb.dataset.savedMinWidth) sb.style.minWidth = sb.dataset.savedMinWidth;
  }
}

// ── Sidebar resize ───────────────────────────────────────────────────────
(function() {
  var SIDEBAR_MIN = 160, SIDEBAR_MAX = 600, SIDEBAR_DEFAULT = 230;
  var STORAGE_KEY = 'fauna-sidebar-width';

  function applySidebarWidth(w) {
    var sb = document.getElementById('sidebar');
    if (!sb) return;
    document.documentElement.style.setProperty('--fau-sidebar-w', w + 'px');
    sb.style.width = w + 'px';
    sb.style.minWidth = w + 'px';
  }

  document.addEventListener('DOMContentLoaded', function() {
    var saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    if (saved && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) applySidebarWidth(saved);

    var handle = document.getElementById('sidebar-resize-handle');
    if (!handle) return;
    var sb = document.getElementById('sidebar');

    window.installPaneResize({
      handle: handle,
      classTarget: sb,
      getStartWidth: function () { return sb.getBoundingClientRect().width; },
      onMove: function (dx, startW) {
        var w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + dx));
        applySidebarWidth(w);
      },
      onEnd: function () {
        localStorage.setItem(STORAGE_KEY, Math.round(sb.getBoundingClientRect().width));
      },
    });

    handle.addEventListener('dblclick', function() {
      applySidebarWidth(SIDEBAR_DEFAULT);
      localStorage.removeItem(STORAGE_KEY);
    });
  });
}());

// ── Empty state prompts ───────────────────────────────────────────────────

var promptMap = {
  'What\'s using my disk?':  'What\'s using the most disk space on my Mac? Check my home folder and show the top offenders.',
  'Show Q1 metrics':         'Show me a dashboard card with these Q1 metrics: Revenue $128,400 (up 12%), NPS 94 (down 2), CSAT 73% (up 5%). Use the gen-ui components to render it inline.',
  'Design a circuit':        'Design an RC low-pass filter with a 1 kHz cutoff driven by a 5V square wave. Render the schematic, validate it, then simulate the transient response and tell me the actual cutoff frequency and -3 dB point.',
  'Build a dashboard':       'Build an interactive dashboard as an HTML artifact. It should include a chart and some stats. The data is:\n\n',
  'Explain code':            'Please explain the following code:\n\n```\n// Paste your code here\n```',
  'Teach me something':      'Create an interactive whiteboard lesson that teaches: ',
  'Make a podcast':          'Make a two-host podcast about: ',
  'Run a Harness team':      '@21-code-reviewer-orchestrator review the following code across style, security, performance, and architecture. Delegate to each specialist in parallel, then synthesize a unified verdict.\n\n```\n// Paste code here\n```',
};

function _promptStarterDefaults() {
  return [
    { title: 'What\'s using my disk?', sub: 'Find large files and free up space', prompt: promptMap['What\'s using my disk?'] },
    { title: 'Show Q1 metrics', sub: 'Revenue, NPS and CSAT as a live dashboard card', prompt: promptMap['Show Q1 metrics'] },
    { title: 'Design a circuit', sub: 'Schematic + SPICE simulation', prompt: promptMap['Design a circuit'] },
    { title: 'Build a dashboard', sub: 'Generate an interactive HTML artifact', prompt: promptMap['Build a dashboard'] },
    { title: 'Explain code', sub: 'Paste code and get a clear explanation', prompt: promptMap['Explain code'] },
    { title: 'Teach me something', sub: 'Interactive whiteboard lesson with narration', prompt: promptMap['Teach me something'] },
    { title: 'Make a podcast', sub: 'Multi-voice dialogue from an article or topic', prompt: promptMap['Make a podcast'] },
    { title: 'Run a Harness team', sub: 'Multi-agent code review', prompt: promptMap['Run a Harness team'] }
  ];
}

function _promptStarterRecentProjects(limit) {
  var convs = (state && state.conversations) || [];
  return ((state && state.projects) || []).slice().map(function(p) {
    var projectConvs = convs.filter(function(c) { return c.projectId === p.id; });
    return {
      project: p,
      count: projectConvs.length,
      score: (p.lastActiveAt || p.updatedAt || p.createdAt || 0) + projectConvs.length * 86400000
    };
  }).sort(function(a, b) { return b.score - a.score; }).slice(0, limit).map(function(item) {
    var name = item.project.name || 'this project';
    return {
      title: 'Continue ' + name,
      sub: item.count ? item.count + ' chats in this project' : 'Pick up this project',
      prompt: 'Help me continue work on the project "' + name + '". Review the current context, recent conversations, and likely next tasks, then suggest the best next step.'
    };
  });
}

function _promptStarterRecentTasks(limit) {
  var tasks = (typeof _tasksCache !== 'undefined' && Array.isArray(_tasksCache)) ? _tasksCache : [];
  return tasks.slice().filter(function(t) {
    return t && t.title && t.status !== 'completed' && t.status !== 'failed';
  }).sort(function(a, b) {
    return (b.updatedAt || b.createdAt || b.nextRunAt || 0) - (a.updatedAt || a.createdAt || a.nextRunAt || 0);
  }).slice(0, limit).map(function(t) {
    return {
      title: 'Work on ' + t.title,
      sub: t.status ? 'Automation is ' + t.status : 'Automation follow-up',
      prompt: 'Help me review and continue the automation task "' + t.title + '". Check what it is supposed to do, what state it is in, and recommend the next action.'
    };
  });
}

function _promptStarterRecentConversationPatterns(limit) {
  var seen = Object.create(null);
  var skip = /^(new conversation|new chat|conversation|untitled)$/i;
  return ((state && state.conversations) || []).slice().sort(function(a, b) {
    return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
  }).filter(function(c) {
    var title = (c && c.title || '').trim();
    if (!title || skip.test(title)) return false;
    var key = title.toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  }).slice(0, limit).map(function(c) {
    return {
      title: 'Revisit ' + c.title,
      sub: c.projectId ? 'Recent project conversation' : 'Recent quick chat',
      prompt: 'Start from the thread "' + c.title + '" and help me continue with the most useful next step.'
    };
  });
}

function _dedupePromptStarters(items) {
  var seen = Object.create(null);
  return items.filter(function(item) {
    if (!item || !item.title || !item.prompt) return false;
    var key = item.title.toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function renderPromptStarters() {
  var grid = document.querySelector('#empty-state .empty-grid');
  if (!grid) return;
  var items = _dedupePromptStarters([].concat(
    _promptStarterRecentProjects(3),
    _promptStarterRecentTasks(2),
    _promptStarterRecentConversationPatterns(2),
    _promptStarterDefaults()
  )).slice(0, 8);
  grid.innerHTML = items.map(function(item) {
    return '<div class="empty-card" onclick="usePrompt(this)" data-prompt="' + escHtml(item.prompt) + '"><strong>' + escHtml(item.title) + '</strong>' + escHtml(item.sub || '') + '</div>';
  }).join('');
}

function usePrompt(card) {
  var title = card.querySelector('strong').textContent;
  var text  = card.dataset.prompt || promptMap[title] || '';
  var input = document.getElementById('msg-input');
  input.value = text;
  resizeTextarea(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  if (!state.currentId) newConversation();
  showMessages();
}

// ── Toast ─────────────────────────────────────────────────────────────────

var toastTimer = null;
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ── Generic Prompt / Confirm dialogs (Electron-safe) ──────────────────────

var _dlgResolveFn = null;
var _dlgMode = 'prompt'; // 'prompt' or 'confirm'

function _dlgResolve(val) {
  var modal = document.getElementById('dlg-modal');
  modal.classList.remove('show');
  if (_dlgResolveFn) { _dlgResolveFn(val); _dlgResolveFn = null; }
}

function _dlgOk() {
  if (_dlgMode === 'confirm') {
    _dlgResolve(true);
  } else {
    _dlgResolve(document.getElementById('dlg-modal-input').value);
  }
}

function showPrompt(title, defaultVal) {
  return new Promise(function(resolve) {
    _dlgResolveFn = resolve;
    _dlgMode = 'prompt';
    var modal = document.getElementById('dlg-modal');
    document.getElementById('dlg-modal-title').textContent = title;
    document.getElementById('dlg-modal-msg').style.display = 'none';
    var inp = document.getElementById('dlg-modal-input');
    inp.style.display = '';
    inp.value = defaultVal || '';
    inp.onkeydown = function(e) { if (e.key === 'Enter') _dlgOk(); };
    document.getElementById('dlg-modal-ok').textContent = 'OK';
    modal.classList.add('show');
    inp.focus();
    inp.select();
  });
}

function showConfirm(message) {
  return new Promise(function(resolve) {
    _dlgResolveFn = resolve;
    _dlgMode = 'confirm';
    var modal = document.getElementById('dlg-modal');
    document.getElementById('dlg-modal-title').textContent = message;
    document.getElementById('dlg-modal-msg').style.display = 'none';
    document.getElementById('dlg-modal-input').style.display = 'none';
    document.getElementById('dlg-modal-ok').textContent = 'OK';
    modal.classList.add('show');
    document.getElementById('dlg-modal-ok').focus();
  });
}

// ── Context meter ─────────────────────────────────────────────────────────

var MODEL_CONTEXT_LIMITS = {
  'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4-turbo': 128000,
  'gpt-4': 8192, 'gpt-3.5-turbo': 16385, 'gpt-4.1': 1000000,
  'o1': 200000, 'o1-mini': 128000, 'o1-pro': 200000, 'o3': 200000, 'o3-mini': 200000, 'o4-mini': 200000,
  'gpt-5': 1000000,
  'claude-sonnet-4-20250514': 200000, 'claude-opus-4-20250514': 200000,
  'claude-3.5-sonnet': 200000, 'claude-3-opus': 200000, 'claude-3-haiku': 200000,
};

function getModelLimit(model) {
  // Prefer the live capability reported by /api/models (GitHub Copilot's
  // capabilities.limits.max_context_window_tokens, or the local provider's
  // context_length) so non-hardcoded models (Gemini 1M, Qwen 256k, etc.) get
  // an accurate meter instead of the 128k default.
  try {
    var live = (allModels || []).find(function(m) { return m && m.id === model; });
    if (live && Number(live.contextWindow) > 0) return Number(live.contextWindow);
  } catch (_) {}
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];
  // Fuzzy match
  for (var key in MODEL_CONTEXT_LIMITS) {
    if (model.indexOf(key) !== -1) return MODEL_CONTEXT_LIMITS[key];
  }
  return 128000; // safe default
}

function formatTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return '' + n;
}

function updateContextMeter(data) {
  var meter = document.getElementById('ctx-meter');
  var fill = document.getElementById('ctx-meter-fill');
  var label = document.getElementById('ctx-meter-label');
  if (!meter || !fill || !label) return;

  var limit = getModelLimit(data.model || '');
  var promptTokens, completionTokens;

  if (data.usage) {
    promptTokens = data.usage.prompt_tokens || 0;
    completionTokens = data.usage.completion_tokens || 0;
  } else {
    // Estimate: ~4 chars per token
    promptTokens = Math.round((data.sysChars + data.msgChars) / 4);
    completionTokens = data.outputTokens || 0;
  }

  var totalUsed = promptTokens + completionTokens;
  var pct = Math.min((totalUsed / limit) * 100, 100);

  // Circular ring: r=9, circumference≈56.55
  // Use inline style (not attribute) because CSS .ctx-ring-arc sets
  // stroke-dashoffset: 56.55 which overrides SVG presentation attrs.
  var offset = (56.55 * (1 - pct / 100)).toFixed(2);
  fill.style.strokeDashoffset = offset;
  var hue = Math.max(0, 140 - (pct * 1.4));
  var sat = 70 + Math.min(20, pct * 0.2);
  var lit = 50 + Math.min(8, pct * 0.08);
  fill.style.stroke = 'hsl(' + hue.toFixed(0) + ',' + sat.toFixed(0) + '%,' + lit.toFixed(0) + '%)';
  var cls = 'ctx-ring-arc';
  if (pct > 90) cls += ' ctx-meter-critical';
  else if (pct > 80) cls += ' ctx-meter-danger';
  else if (pct > 50) cls += ' ctx-meter-warn';
  fill.setAttribute('class', cls);

  var popover = document.getElementById('ctx-meter-popover');
  var labelText = 'in:' + formatTokens(promptTokens) + ' + out:' + formatTokens(completionTokens) + ' = ' + formatTokens(totalUsed) + '/' + formatTokens(limit) + (data.usage ? '' : ' (est.)');
  if (data.billed && data.billed.total && data.iterations > 1) {
    labelText += ' · billed:' + formatTokens(data.billed.total) + ' across ' + data.iterations + ' calls';
  }
  if (popover) popover.textContent = labelText;
  // Inline label next to the ring so users can see usage at a glance
  // (formerly the function bailed early when this element was missing).
  label.textContent = formatTokens(totalUsed) + '/' + formatTokens(limit);
  meter.setAttribute('title', '');
  meter.setAttribute('data-ctx-tip', labelText);
  meter.style.display = 'flex';
}

// ── Textarea resize ───────────────────────────────────────────────────────

var input = document.getElementById('msg-input');
function resizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}
input.addEventListener('input', () => { resizeTextarea(input); _promptHistIdx = -1; });
input.addEventListener('paste', function(e) {
  var items = (e.clipboardData || {}).items;
  if (!items) return;
  for (var i = 0; i < items.length; i++) {
    if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
      e.preventDefault();
      var blob = items[i].getAsFile();
      var mime = items[i].type;
      var ext  = mime.split('/')[1] || 'png';
      var name = 'image-' + Date.now() + '.' + ext;
      _normalizeImageAttachment(blob, name).then(addAttachment).catch(function() {});
      return;
    }
  }
});


// ── Drag-and-drop files onto the input wrap ──────────────────────────────
(function() {
  var overlay = document.getElementById('app-drop-overlay');
  var dragCounter = 0;

  function hasFileItem(dt) {
    if (!dt) return false;
    if (dt.types && (dt.types.indexOf('Files') !== -1 || dt.types.indexOf('files') !== -1)) return true;
    if (dt.items) {
      for (var i = 0; i < dt.items.length; i++) {
        if (dt.items[i].kind === 'file') return true;
      }
    }
    return false;
  }

  document.addEventListener('dragenter', function(e) {
    if (!hasFileItem(e.dataTransfer)) return;
    e.preventDefault();
    dragCounter++;
    if (overlay) overlay.classList.add('active');
  });
  document.addEventListener('dragleave', function(e) {
    // Only count leaves that exit the window entirely
    if (e.relatedTarget) return;
    dragCounter = 0;
    if (overlay) overlay.classList.remove('active');
  });
  document.addEventListener('dragover', function(e) {
    if (!hasFileItem(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', function(e) {
    e.preventDefault();
    dragCounter = 0;
    if (overlay) overlay.classList.remove('active');
    if (hasFileItem(e.dataTransfer)) handleFiles(e.dataTransfer.files);
  });
})();

function openImageAttach() {
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.multiple = true;
  inp.onchange = function() {
    Array.from(inp.files).forEach(function(file) {
      _normalizeImageAttachment(file).then(addAttachment).catch(function() {});
    });
  };
  inp.click();
}

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _promptHistIdx = -1; _promptHistDraft = ''; sendMessage(); return; }

  // Arrow-up/down prompt history cycling (only when cursor is at start/end)
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    var handled = handlePromptHistory(e.key, input);
    if (handled) { e.preventDefault(); return; }
  }

  if (e.key === 'Escape') {
    if (document.getElementById('sys-panel').classList.contains('open'))      toggleSysPanel();
    else if (document.getElementById('settings-panel').classList.contains('open')) toggleSettings();
  }
});

function handlePromptHistory(key, input) {
  // Only cycle when autocomplete dropdowns are closed
  if (typeof slashAutocompleteOpen !== 'undefined' && slashAutocompleteOpen) return false;
  if (typeof agentAutocompleteOpen !== 'undefined' && agentAutocompleteOpen) return false;

  var conv = getConv(state.currentId);
  if (!conv) return false;

  // Collect user messages in order (oldest first) — exclude auto-feed/browser-feed
  var userMsgs = conv.messages.filter(function(m) { return m.role === 'user' && !m._isBrowserFeed && !m._isAutoFeed; });
  if (!userMsgs.length) return false;

  if (key === 'ArrowUp') {
    // Only trigger when cursor is at position 0 (or input is empty)
    if (input.selectionStart !== 0 && input.value.length > 0) return false;

    if (_promptHistIdx === -1) {
      // Stash current draft
      _promptHistDraft = input.value;
      _promptHistIdx = userMsgs.length - 1; // most recent
    } else if (_promptHistIdx > 0) {
      _promptHistIdx--;
    } else {
      return true; // already at oldest, consume the key
    }
  } else { // ArrowDown
    if (_promptHistIdx === -1) return false; // not in history mode

    // Only trigger when cursor is at end
    if (input.selectionStart !== input.value.length && input.value.length > 0) return false;

    if (_promptHistIdx < userMsgs.length - 1) {
      _promptHistIdx++;
    } else {
      // Back to draft
      _promptHistIdx = -1;
      input.value = _promptHistDraft;
      resizeTextarea(input);
      _restoreHistoryAttachments(null);
      return true;
    }
  }

  var msg = userMsgs[_promptHistIdx];
  // Use stored display text if available, else strip appended file/url fences and system context
  var displayText = msg._displayText || msg.content.split(/\n\n(```\n\/\/ (File|URL):|\[System context)/)[0].trim();
  input.value = displayText;
  resizeTextarea(input);

  // Restore attachments if any
  _restoreHistoryAttachments(msg.attachments);

  // Place cursor at start for ArrowUp, end for ArrowDown
  if (key === 'ArrowUp') {
    input.selectionStart = input.selectionEnd = 0;
  } else {
    input.selectionStart = input.selectionEnd = input.value.length;
  }
  return true;
}

function _restoreHistoryAttachments(attachments) {
  // Clear current attachments and restore from history message
  state.pendingAttachments = [];
  if (attachments && attachments.length) {
    attachments.forEach(function(a) {
      state.pendingAttachments.push({
        type: a.type,
        name: a.name,
        base64: a.base64 || undefined,
        mime: a.mime || undefined,
        content: a.content || undefined,
        sourceUri: a.sourceUri || undefined,
        extSource: a.extSource || undefined,
        browser: a.browser || undefined,
        tabId: a.tabId || undefined,
        clientId: a.clientId || undefined,
        fileKey: a.fileKey || undefined,
        currentPage: a.currentPage || undefined,
        timestamp: a.timestamp || undefined,
        figmaDisconnected: !!a.figmaDisconnected,
        size: a.size || undefined,
        warning: a.warning || undefined
      });
    });
  }
  renderAttachBar();
}

// ── Figma integration ─────────────────────────────────────────────────────

// ── Desktop Organizer Card ────────────────────────────────────────────────
// When AI responds to a desktop task but leaves code blocks empty,
// inject a ready-to-use organizer action card.

async function injectOrganizerCard(msgEl, buffer) {
  // Only inject if the response specifically describes a desktop file organization plan
  var isOrgPlan = /\b(organis|organiz)[ez]?\s+(your|the|these)?\s*(desktop|files|folder|downloads)/i.test(buffer)
    || /\bmov(e|ing)\s+(files?|screenshots?|images?)\s+(to|into)\s+/i.test(buffer);
  if (!isOrgPlan) return;

  // Fetch a dry-run preview from the server
  var preview;
  try {
    var r = await fetch('/api/organize-desktop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true })
    });
    preview = await r.json();
  } catch (_) { return; }

  if (!preview.ok || !preview.moves || !preview.moves.length) return;

  // Build folder summary
  var byFolder = {};
  preview.moves.forEach(function(m) {
    byFolder[m.folder] = (byFolder[m.folder] || 0) + 1;
  });
  var summaryHtml = Object.entries(byFolder)
    .map(function(e) { return '<b>' + escHtml(e[0]) + '</b> — ' + e[1] + ' file' + (e[1] > 1 ? 's' : ''); })
    .join('<br>');

  var cardId = 'org-' + Date.now();
  var card   = document.createElement('div');
  card.className = 'organizer-card';
  card.id = cardId;
  card.innerHTML =
    '<div class="organizer-card-header">' +
      '<i class="ti ti-folders"></i> Desktop Organizer — Ready to Run' +
    '</div>' +
    '<div class="organizer-preview">' +
      summaryHtml +
      '<br><span style="color:var(--fau-text-muted);font-size:11px">' + preview.moves.length + ' files · ' + (preview.skipped || []).length + ' folders/unmatched skipped</span>' +
    '</div>' +
    '<div class="organizer-actions">' +
      '<button class="organizer-btn primary" onclick="runOrganizerCard(\'' + cardId + '\')"><i class="ti ti-player-play"></i> Organise Now</button>' +
      '<button class="organizer-btn secondary" onclick="previewOrganizerCard(\'' + cardId + '\')"><i class="ti ti-list"></i> Preview files</button>' +
    '</div>' +
    '<div class="organizer-result" id="' + cardId + '-result"></div>';

  card.dataset.preview = JSON.stringify(preview);
  msgEl.querySelector('.msg-body').appendChild(card);

  // Also replace any empty code blocks in this message
  msgEl.querySelectorAll('pre').forEach(function(pre) {
    var code = pre.querySelector('code');
    if (code && !code.textContent.trim()) pre.style.display = 'none';
  });

  scrollBottom();
}

async function runOrganizerCard(cardId) {
  var card   = document.getElementById(cardId);
  var result = document.getElementById(cardId + '-result');
  var btn    = card.querySelector('.organizer-btn.primary');
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Organising…';
  result.style.display = 'block'; result.textContent = 'Moving files…';

  try {
    var r = await fetch('/api/organize-desktop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: false })
    });
    var d = await r.json();
    if (d.ok) {
      result.innerHTML =
        '<span style="color:#1ec882"><i class="ti ti-check"></i> Done — ' + d.moved + ' files organised.</span>' +
        (d.errors && d.errors.length ? '<br><span style="color:#f97316">' + d.errors.length + ' errors: ' + d.errors.map(function(e){ return escHtml(e.file); }).join(', ') + '</span>' : '') +
        '<br><span style="color:#6e7681;font-size:11px"><a href="#" onclick="feedOrgResult(this);return false" style="color:var(--accent2)">Feed result to AI</a></span>';
      result.dataset.summary = JSON.stringify(d);
      btn.innerHTML = '<i class="ti ti-check"></i> Done';
      showToast('Desktop organised!');
    } else {
      result.innerHTML = '<span style="color:#f87171">Error: ' + escHtml(d.error || 'Unknown') + '</span>';
      btn.disabled = false; btn.innerHTML = '<i class="ti ti-player-play"></i> Organise Now';
    }
  } catch (e) {
    result.innerHTML = '<span style="color:#f87171">' + escHtml(e.message) + '</span>';
    btn.disabled = false; btn.innerHTML = '<i class="ti ti-player-play"></i> Organise Now';
  }
  scrollBottom();
}

function previewOrganizerCard(cardId) {
  var card    = document.getElementById(cardId);
  var preview = JSON.parse(card.dataset.preview || '{}');
  var result  = document.getElementById(cardId + '-result');
  if (!preview.moves) return;
  result.style.display = 'block';
  result.innerHTML = preview.moves.map(function(m) {
    return '<span style="color:#6e7681">→ </span>' + escHtml(m.file) + ' <span style="color:#6e7681">→ ' + escHtml(m.folder) + '</span>';
  }).join('<br>');
  scrollBottom();
}

async function feedOrgResult(a) {
  var result = a.closest('.organizer-result');
  var d = result.dataset.summary ? JSON.parse(result.dataset.summary) : null;
  if (!d) return;
  var lines = ['Desktop organised successfully: ' + d.moved + ' files moved.'];
  if (d.errors && d.errors.length) lines.push(d.errors.length + ' errors: ' + d.errors.map(function(e){ return e.file + ': ' + e.error; }).join(', '));
  if (d.done) {
    var byFolder = {};
    d.done.forEach(function(m) { byFolder[m.folder] = (byFolder[m.folder]||[]).concat(m.file); });
    Object.entries(byFolder).forEach(function(e) { lines.push(e[0] + ': ' + e[1].join(', ')); });
  }
  document.getElementById('msg-input').value = lines.join('\n');
  await sendMessage();
}
async function feedCodeResult(a) {
  var resultEl = a.closest('.code-run-result');
  if (!resultEl || !resultEl.dataset.result) return;
  var d = JSON.parse(resultEl.dataset.result);
  var lines = ['**Command result:**', '```', '$ ' + d.command, ''];
  if (d.stdout && d.stdout.trim()) lines.push(d.stdout.trimEnd());
  if (d.stderr && d.stderr.trim()) lines.push('[stderr] ' + d.stderr.trimEnd());
  lines.push('exit ' + d.exitCode);
  lines.push('```', 'Please continue based on this output.');
  document.getElementById('msg-input').value = lines.join('\n');
  await sendMessage();
}

// Toggle auto-run from Settings (called by settings checkbox)
function setAutoRunShell(val) {
  state.autoRunShell = val;
  localStorage.setItem('fauna-autorun-shell', val ? 'true' : 'false');
}

// Toggle bypass command permissions from Settings
function setBypassCommandPermissions(val) {
  state.bypassCommandPermissions = val;
  localStorage.setItem('fauna-bypass-cmd-perms', val ? 'true' : 'false');
}

// Toggle the experimental Dynamic Widgets feature from Settings
function setEnableDynamicWidgets(val) {
  state.enableDynamicWidgets = val;
  localStorage.setItem('fauna-dynamic-widgets', val ? 'true' : 'false');
  if (typeof showToast === 'function') {
    showToast('Dynamic widgets ' + (val ? 'enabled' : 'disabled'));
  }
}

// Toggle the diagnostic transcript export UI (hidden by default — when off,
// the topbar menu item and per-conv download icon are not rendered).
function setEnableConvExport(val) {
  state.enableConvExport = !!val;
  localStorage.setItem('fauna-conv-export', val ? 'true' : 'false');
  _applyConvExportVisibility();
  if (typeof renderConvList === 'function') renderConvList();
  if (typeof showToast === 'function') {
    showToast('Transcript export ' + (val ? 'enabled' : 'disabled'));
  }
}

function _applyConvExportVisibility() {
  var btn = document.getElementById('topbar-export-conv-btn');
  if (btn) btn.style.display = (state && state.enableConvExport) ? '' : 'none';
}

// Toggle automatic context compaction (server summarizes older turns when
// the conversation exceeds the model's body-token budget).
function setAutoCompact(val) {
  state.autoCompact = !!val;
  localStorage.setItem('fauna-auto-compact', val ? 'true' : 'false');
  if (typeof showToast === 'function') {
    showToast('Auto-compaction ' + (val ? 'enabled' : 'disabled'));
  }
}

// Toggle inline AI autocomplete (ghost text) in the composer. The engine owns
// the persisted setting; this just forwards the new value.
function setAiAutocomplete(val) {
  if (typeof aiAutocompleteSetEnabled === 'function') aiAutocompleteSetEnabled(!!val);
}

var _thinkingHints = {
  auto:   'Scales the thinking budget to each question — low for quick Q&A, high for complex or agentic work.',
  off:    'Model will not use extended thinking.',
  low:    'Quick reasoning pass (~1K tokens). Faster and cheaper.',
  medium: 'Balanced thinking (~5K tokens). Good for most tasks.',
  high:   'Deep analysis (~10K tokens). Best for complex problems.',
  max:    'Exhaustive reasoning (~32K tokens). Slowest and most expensive.'
};
function setThinkingBudget(val) {
  state.thinkingBudget = val;
  localStorage.setItem('fauna-thinking-budget', val);
  var hint = document.getElementById('thinking-budget-hint');
  if (hint) hint.textContent = _thinkingHints[val] || '';
}
function setMaxTurns(val) {
  state.maxContextTurns = val;
  localStorage.setItem('fauna-max-turns', String(val));
  var lbl = document.getElementById('max-turns-label');
  if (lbl) lbl.textContent = val === 100 ? 'Max' : val;
}

// ── Windows platform detection + window controls ──────────────────────────
(function() {
  var isWin = navigator.userAgent.includes('Windows') ||
              (typeof process !== 'undefined' && process.platform === 'win32');
  if (isWin) {
    document.body.classList.add('win-platform');
    var wc = document.getElementById('win-controls');
    if (wc) wc.style.display = 'flex';
  }
})();

function winCtrl(action) {
  fetch('/api/window/' + action, { method: 'POST' }).catch(function() {});
}


// ── Onboarding / Permissions ──────────────────────────────────────────────

var PERMISSIONS_DEF_MAC = [
  {
    id: 'auth',
    icon: '<i class="ti ti-key"></i>',
    name: 'Authentication',
    desc: 'Required to send messages. Use a GitHub PAT (via gh CLI or manual entry) or add a direct API key in Settings.',
    required: true,
  },
  {
    id: 'fullDiskAccess',
    icon: '<i class="ti ti-folders"></i>',
    name: 'Full Disk Access',
    desc: 'Read and write files anywhere — Desktop, Documents, external drives.',
    required: true,
    action: 'settings',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    actionLabel: 'Open Settings',
  },
  {
    id: 'screenRecording',
    icon: '<i class="ti ti-screenshot"></i>',
    name: 'Screen Recording',
    desc: 'Capture screenshots and screen content of other apps.',
    required: false,
    action: 'request-screen',
    actionLabel: 'Enable',
  },
  {
    id: 'accessibility',
    icon: '<i class="ti ti-accessible"></i>',
    name: 'Accessibility',
    desc: 'Control the mouse, simulate keyboard input, and navigate other apps.',
    required: false,
    action: 'settings',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    actionLabel: 'Open Settings',
  },
  {
    id: 'osascriptAccessibility',
    icon: '<i class="ti ti-script"></i>',
    name: 'AppleScript UI Access',
    desc: 'Required when shell commands use osascript to control System Events. macOS may require /usr/bin/osascript separately from Fauna.',
    required: false,
    action: 'settings',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    actionLabel: 'Open Settings',
  },
  {
    id: 'automation',
    icon: '<i class="ti ti-robot"></i>',
    name: 'Automation',
    desc: 'Switch between apps and control Finder via AppleScript. Prompted on first use — no action needed.',
    required: false,
    action: 'info',
    actionLabel: 'Auto-prompted',
  },
];

var PERMISSIONS_DEF_WIN = [
  {
    id: 'auth',
    icon: '<i class="ti ti-key"></i>',
    name: 'Authentication',
    desc: 'Required to send messages. Use a GitHub PAT (via gh CLI or manual entry) or add a direct API key in Settings.',
    required: true,
  },
];

var PERMISSIONS_DEF = navigator.userAgent.includes('Windows') ? PERMISSIONS_DEF_WIN : PERMISSIONS_DEF_MAC;

function openOnboarding() {
  // Permissions now live in Settings → Permissions page
  if (typeof openSettingsPage === 'function') {
    openSettingsPage('permissions');
  }
}

function closeOnboarding() {
  localStorage.setItem('fauna-chat-onboarding-done', '1');
}

async function refreshPermissions() {
  document.getElementById('ob-checking-hint').textContent = 'Checking…';
  try {
    var [permsRes, authRes] = await Promise.all([
      fetch('/api/permissions'),
      fetch('/api/auth'),
    ]);
    var perms = await permsRes.json();
    var auth  = await authRes.json();
    perms.auth = auth.authenticated ? 'granted' : 'denied';
    renderPermissions(perms);
    var allReqOk = PERMISSIONS_DEF
      .filter(p => p.required)
      .every(p => perms[p.id] === 'granted');
    document.getElementById('ob-checking-hint').textContent =
      allReqOk ? 'All required permissions granted' : 'Some permissions need your attention'; // plain text hint
    document.getElementById('ob-checking-hint').style.color =
      allReqOk ? 'var(--success)' : 'var(--fau-text-muted)';
    // Automatically mark onboarding as done if all required permissions are granted
    if (allReqOk) {
      localStorage.setItem('fauna-chat-onboarding-done', '1');
    }
  } catch (e) {
    document.getElementById('ob-checking-hint').textContent = 'Could not check permissions';
  }
}

function renderPermissions(perms) {
  var list = document.getElementById('permission-list');
  list.innerHTML = PERMISSIONS_DEF.map(function(p) {
    var raw = perms[p.id];

    // Normalise status
    var statusKey, statusLabel;
    if (raw === 'granted') {
      statusKey = 'ok'; statusLabel = '<i class="ti ti-check"></i> Granted';
    } else if (raw === 'denied' || raw === 'not-determined') {
      statusKey = 'err'; statusLabel = '<i class="ti ti-x"></i> Not granted';
    } else if (raw === 'auto-prompted') {
      statusKey = 'dim'; statusLabel = '<i class="ti ti-refresh"></i> On first use';
    } else {
      statusKey = 'warn'; statusLabel = '? Unknown';
    }

    var rowClass = raw === 'granted' ? 'granted' : (raw === 'denied' || raw === 'not-determined') ? 'denied' : '';
    var badgeClass = p.required ? 'req' : 'opt';
    var badgeLabel = p.required ? 'Required' : 'Optional';

    // Auth row: show inline PAT form when not granted
    if (p.id === 'auth') {
      var patForm = '';
      if (raw !== 'granted') {
        patForm =
          '<div class="perm-pat-form">' +
            '<div class="perm-pat-form-row">' +
              '<input class="perm-pat-input" id="ob-pat-input" type="password" ' +
                'placeholder="ghp_…  or  github_pat_…" autocomplete="off" spellcheck="false" ' +
                'onkeydown="if(event.key===\'Enter\')savePatFromOnboarding()">' +
              '<button class="perm-pat-save" id="ob-pat-save" onclick="savePatFromOnboarding()">' +
                '<i class="ti ti-check"></i> Save' +
              '</button>' +
            '</div>' +
            '<div class="perm-pat-status" id="ob-pat-status"></div>' +
            '<div class="perm-pat-hint">' +
              'Already logged in via <code>gh auth login</code>? Click ' +
              '<a href="#" onclick="refreshPermissions();return false">Check again</a>.<br>' +
              'Or generate a PAT at ' +
              '<a href="#" onclick="window.open(\'https://github.com/settings/tokens\');return false">' +
                'github.com/settings/tokens' +
              '</a> with the <strong>copilot</strong> scope.' +
            '</div>' +
          '</div>';
      }
      return '<div class="perm-row auth-row ' + rowClass + '">' +
        '<div class="perm-icon">' + p.icon + '</div>' +
        '<div class="perm-info">' +
          '<div class="perm-name">' + escHtml(p.name) +
            '<span class="perm-req-badge ' + badgeClass + '">' + badgeLabel + '</span>' +
          '</div>' +
          '<div class="perm-desc">' + escHtml(p.desc) + '</div>' +
        '</div>' +
        '<div class="perm-status ' + statusKey + '">' + statusLabel + '</div>' +
        (raw === 'granted'
          ? '<button class="perm-action" disabled><i class="ti ti-check"></i> Done</button>'
          : '') +
        patForm +
      '</div>';
    }

    // Action button for other rows
    var btnHtml = '';
    if (raw === 'granted') {
      btnHtml = '<button class="perm-action" disabled><i class="ti ti-check"></i> Done</button>';
    } else if (p.action === 'settings') {
      btnHtml = '<button class="perm-action" onclick="window.open(\'' + p.settingsUrl + '\')">' + escHtml(p.actionLabel) + '</button>';
    } else if (p.action === 'request-screen') {
      btnHtml = '<button class="perm-action primary" onclick="requestScreenPermission(this)">Enable</button>';
    } else if (p.action === 'info') {
      btnHtml = '<button class="perm-action" disabled>' + escHtml(p.actionLabel) + '</button>';
    }

    return '<div class="perm-row ' + rowClass + '">' +
      '<div class="perm-icon">' + p.icon + '</div>' +
      '<div class="perm-info">' +
        '<div class="perm-name">' + escHtml(p.name) +
          '<span class="perm-req-badge ' + badgeClass + '">' + badgeLabel + '</span>' +
        '</div>' +
        '<div class="perm-desc">' + escHtml(p.desc) + '</div>' +
      '</div>' +
      '<div class="perm-status ' + statusKey + '">' + statusLabel + '</div>' +
      btnHtml +
    '</div>';
  }).join('');
}

async function savePatFromOnboarding() {
  var input  = document.getElementById('ob-pat-input');
  var btn    = document.getElementById('ob-pat-save');
  var status = document.getElementById('ob-pat-status');
  if (!input || !input.value.trim()) return;

  var pat = input.value.trim();
  btn.disabled = true;
  status.className = 'perm-pat-status';
  status.textContent = 'Saving…';

  try {
    var r = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pat })
    });
    var d = await r.json();
    if (d.ok) {
      status.className = 'perm-pat-status ok';
      status.innerHTML = '<i class="ti ti-check"></i> Saved — checking auth…';
      input.value = '';
      // Sync to the settings panel too
      document.getElementById('pat-input').placeholder = 'Saved: ' + d.preview;
      document.getElementById('clear-pat-btn').style.display = '';
      await refreshPermissions();
    } else {
      status.className = 'perm-pat-status err';
      status.textContent = d.error || 'Failed to save token';
      btn.disabled = false;
    }
  } catch (e) {
    status.className = 'perm-pat-status err';
    status.textContent = e.message;
    btn.disabled = false;
  }
}

async function requestScreenPermission(btn) {
  btn.disabled = true; btn.textContent = 'Requesting…';
  try {
    var r = await fetch('/api/permissions/request-screen', { method: 'POST' });
    var d = await r.json();
    if (d.status === 'granted') {
      btn.innerHTML = '<i class="ti ti-check"></i> Granted';
    } else {
      // macOS shows the system prompt; after user grants, they can click Check again
      btn.disabled = false; btn.textContent = 'Open Settings';
      btn.onclick = function() {
        window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      };
    }
  } catch (_) { btn.disabled = false; btn.textContent = 'Enable'; }
  refreshPermissions();
}

// Auto-show on first launch
document.addEventListener('DOMContentLoaded', function() {
  if (!localStorage.getItem('fauna-chat-onboarding-done')) {
    // Short delay so the main UI is visible behind the overlay
    setTimeout(openOnboarding, 600);
  }
});

// ── Companion "Ask Fauna" handoff ────────────────────────────────────
// Triggered by the widget (Ctrl/Cmd+Shift+J or the ⚡ Ask button) via
// main.js → renderer dispatch. Starts a fresh conversation pre-loaded
// with the user's text and (optionally) instructs the agent to call
// fauna_screen_context first.
window.addEventListener('fauna:ask-prompt', function (e) {
  try {
    const text = String(e?.detail?.text || '').trim();
    if (!text) return;
    const withContext = e?.detail?.withContext !== false;
    if (typeof newConversation === 'function') newConversation();
    const $input = document.getElementById('msg-input');
    if ($input) {
      const prefix = withContext
        ? '[Companion mode] First call fauna_screen_context to see what app/window I am looking at, then answer:\n\n'
        : '';
      $input.value = prefix + text;
      $input.focus();
      // Trigger autoresize if the app uses one
      $input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (typeof sendMessage === 'function') {
      setTimeout(() => { try { sendMessage(); } catch (_) {} }, 80);
    }
  } catch (err) {
    console.warn('[fauna:ask-prompt] handler failed:', err.message);
  }
});

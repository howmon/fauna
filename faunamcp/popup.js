'use strict';
/* global mcp */

// ── State ─────────────────────────────────────────────────────────────────
let st        = {};   // last full status snapshot
let curTab    = 'browser';
const stdioCache = { browser: '', figma: '' };

// ── Tab switching ─────────────────────────────────────────────────────────
function switchTab(which) {
  curTab = which;
  document.getElementById('tabBrowser').classList.toggle('active', which === 'browser');
  document.getElementById('tabFigma')  .classList.toggle('active', which === 'figma');
  document.getElementById('panelBrowser').classList.toggle('active', which === 'browser');
  document.getElementById('panelFigma')  .classList.toggle('active', which === 'figma');
}

// ── Relay start / stop ────────────────────────────────────────────────────
function toggleRelay(which) {
  const running = which === 'browser' ? st.browserRunning : st.figmaRunning;
  if (running) mcp.stopRelay(which);
  else         mcp.startRelay(which);
}

function toggleEnabled(which) {
  const enabled = which === 'browser' ? st.browserEnabled : st.figmaEnabled;
  mcp.setEnabled(which, !enabled).then(applyEnabledState);
}

function applyEnabledState(s) {
  if (!s) return;
  setToggle('enableBrowser', s.browserEnabled);
  setToggle('enableFigma',   s.figmaEnabled);
  if ('browserEnabled' in s) st.browserEnabled = s.browserEnabled;
  if ('figmaEnabled'   in s) st.figmaEnabled   = s.figmaEnabled;
  // Disable start/stop when relay not enabled
  const bBtn = document.getElementById('toggleBrowser');
  const fBtn = document.getElementById('toggleFigma');
  if (bBtn) bBtn.disabled = !s.browserEnabled;
  if (fBtn) fBtn.disabled = !s.figmaEnabled;
}

// ── Render full status ────────────────────────────────────────────────────
function applyStatus(s) {
  st = s;

  // Logo
  const logoEl = document.getElementById('logo');
  if (logoEl && s.iconUrl) logoEl.src = s.iconUrl;

  // Version
  const ver = document.getElementById('version');
  if (ver) ver.textContent = s.version ? `v${s.version}` : '';

  // Login
  setToggle('loginSwitch', s.loginItem);

  // Browser panel
  renderRelayPanel('browser', {
    running:   s.browserRunning,
    enabled:   s.browserEnabled,
    wsUrl:     s.browserWsUrl,
    httpUrl:   s.browserHttpUrl,
    stdio:     s.browserStdio,
    assetPath: s.browserExtPath,
  });

  // Figma panel
  renderRelayPanel('figma', {
    running:   s.figmaRunning,
    enabled:   s.figmaEnabled,
    wsUrl:     s.figmaWsUrl,
    httpUrl:   s.figmaHttpUrl,
    stdio:     s.figmaStdio,
    assetPath: null,
  });

  // Tab badges
  renderBadge('badgeBrowser', s.browserRunning, s.browserEnabled);
  renderBadge('badgeFigma',   s.figmaRunning,   s.figmaEnabled);
}

function renderBadge(id, running, enabled) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'tab-badge ' + (enabled === false ? 'disabled' : running ? 'running' : 'stopped');
}

function renderRelayPanel(which, { running, enabled, wsUrl, httpUrl, stdio, assetPath }) {
  const pfx = which === 'browser' ? 'b' : 'f';

  // Dot
  const dot = document.getElementById('dot' + cap(which));
  if (dot) {
    dot.className = 'dot ' + (enabled === false ? 'disabled' : running ? 'running' : 'stopped');
  }

  // Status text
  const statusEl = document.getElementById('status' + cap(which));
  if (statusEl) {
    statusEl.textContent = enabled === false ? 'Disabled' : running ? 'Running' : 'Stopped';
  }

  // Toggle button
  const btn = document.getElementById('toggle' + cap(which));
  if (btn) {
    btn.textContent  = running ? 'Stop' : 'Start';
    btn.className    = 'toggle-btn ' + (running ? 'stop' : 'start');
    btn.disabled     = enabled === false;
  }

  // Enable switch
  setToggle('enable' + cap(which), enabled !== false);

  // URL fields
  setText(pfx + 'WsUrl',   wsUrl   || '');
  setText(pfx + 'HttpUrl', httpUrl || '');

  // Stdio
  if (stdio) {
    stdioCache[which] = stdio;
    const pre = document.getElementById(pfx + 'Stdio');
    if (pre) pre.textContent = stdio;
  }

  // Extension path (browser only)
  if (assetPath) {
    const el = document.getElementById(pfx + 'ExtPath');
    if (el) { el.textContent = assetPath; el.dataset.path = assetPath; }
  }
}

// ── Log rendering ─────────────────────────────────────────────────────────
function appendLog(which, entry) {
  const listId = which === 'browser' ? 'bLogList' : 'fLogList';
  const list   = document.getElementById(listId);
  if (!list) return;

  // Remove placeholder
  const empty = list.querySelector('.log-empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className  = 'log-entry ' + (entry.level || 'info');
  el.textContent = entry.text || '';
  el.title       = entry.text || '';
  list.appendChild(el);

  // Keep last 80 entries
  while (list.children.length > 80) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}

function renderLogs(which, logs) {
  const listId = which === 'browser' ? 'bLogList' : 'fLogList';
  const list   = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = '';
  if (!logs || !logs.length) {
    list.innerHTML = '<div class="log-entry log-empty">No entries yet</div>';
    return;
  }
  for (const e of logs) appendLog(which, e);
}

// ── Copy helpers ──────────────────────────────────────────────────────────
function flash(el) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 800);
}

function cpId(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  mcp.copy(el.textContent);
  if (btn) flash(btn);
}

function cpText(text) {
  if (!text) return;
  mcp.copy(text);
}

function cpSnippet(which, btn) {
  mcp.copy(stdioCache[which] || '');
  if (btn) flash(btn);
}

// ── Login toggle ──────────────────────────────────────────────────────────
function toggleLogin() {
  const on = !st.loginItem;
  mcp.setLogin(on).then(val => {
    st.loginItem = val;
    setToggle('loginSwitch', val);
  });
}

// ── Asset actions ─────────────────────────────────────────────────────────
function saveExtension() {
  mcp.saveExtension().then(r => {
    if (r && r.ok) flashBtn('bExtSaveBtn');
  });
}
function revealExt() { mcp.revealExtension(); }

function savePlugin() {
  mcp.savePlugin().then(r => {
    if (r && r.ok) flashBtn('fPluginSaveBtn');
  });
}
function revealPlugin() { mcp.revealPlugin(); }

function flashBtn(id) {
  const el = document.getElementById(id);
  if (el) flash(el);
}

// ── Utility ───────────────────────────────────────────────────────────────
function cap(str) { return str ? str[0].toUpperCase() + str.slice(1) : ''; }

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setToggle(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('on', !!on);
}

// ── Init ─────────────────────────────────────────────────────────────────
document.getElementById('closeBtn').addEventListener('click', () => mcp.close());

mcp.onLog(d => appendLog(d.which, d.entry));

mcp.onStatus(d => {
  if (d.which) {
    // Partial update from relay
    if (d.which === 'browser') st.browserRunning = d.running;
    if (d.which === 'figma')   st.figmaRunning   = d.running;
    renderBadge('badgeBrowser', st.browserRunning, st.browserEnabled);
    renderBadge('badgeFigma',   st.figmaRunning,   st.figmaEnabled);
    renderRelayPanel(d.which, {
      running:   d.which === 'browser' ? st.browserRunning : st.figmaRunning,
      enabled:   d.which === 'browser' ? st.browserEnabled : st.figmaEnabled,
      wsUrl:     d.which === 'browser' ? st.browserWsUrl   : st.figmaWsUrl,
      httpUrl:   d.which === 'browser' ? st.browserHttpUrl : st.figmaHttpUrl,
      stdio:     null,
      assetPath: null,
    });
  } else {
    applyStatus(d);
  }
});

mcp.getStatus().then(s => {
  applyStatus(s);
  renderLogs('browser', s.browserLogs);
  renderLogs('figma',   s.figmaLogs);
});

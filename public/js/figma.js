var figmaRulesOpen   = false;
var figmaSectionOpen = false;
var figmaLogsOpen    = false;
var figmaStatus      = { relayConnected: false, figmaConnected: false, fileInfo: null, activeSystem: null, mcpRunning: false };
var figmaRules       = [];
var figmaLogsLastTs  = 0;
var figmaMCPStatus        = { connected: false, tools: [] };
var figmaMCPChecking      = true; // suppress the "unavailable" flash on first load
var figmaMCPFailStreak    = 0;    // consecutive fetch failures — only disable after 3
var figmaMCPWasConnected  = false; // track whether we ever had a confirmed connection

// Initialise figmaMCPEnabled — loaded from localStorage in state declaration above
async function checkFigmaMCPStatus() {
  try {
    var r = await fetch('/api/figma-mcp/status');
    var d = await r.json();
    figmaMCPStatus      = d;
    figmaMCPChecking    = false;
    figmaMCPFailStreak  = 0; // reset on success
    if (d.connected) figmaMCPWasConnected = true;
    // Never auto-enable — only update the badge appearance
    updateFigmaMCPBadge();
  } catch (_) {
    figmaMCPFailStreak++;
    figmaMCPChecking = false;
    // Only disable after 3 consecutive fetch failures AND we previously had a real connection
    // This prevents a transient network hiccup / startup race from silently killing Figma MCP
    if (figmaMCPFailStreak >= 3 && figmaMCPWasConnected && state.figmaMCPEnabled) {
      figmaMCPStatus = { connected: false, tools: [] };
      state.figmaMCPEnabled = false;
      localStorage.setItem('fauna-figma-mcp', 'false');
      showToast('Figma MCP disconnected — context disabled');
    }
    updateFigmaMCPBadge();
  }
}

function updateFigmaMCPBadge() {
  var badge   = document.getElementById('figma-mcp-badge');
  var banner  = document.getElementById('figma-mode-banner');
  var secStat = document.getElementById('figma-mcp-section-status');
  if (!badge) return;
  var connected = !!figmaMCPStatus.connected;
  var enabled   = !!state.figmaMCPEnabled;

  if (banner) banner.style.display = (connected && enabled) ? 'flex' : 'none';

  // Section header status label
  if (secStat) {
    secStat.textContent = enabled ? '● ON' : '○ OFF';
    secStat.style.color = enabled ? '#62d794' : 'var(--fau-text-muted)';
  }

  if (figmaMCPChecking) {
    badge.textContent = '◌ Figma';
    badge.title = 'Checking Figma MCP…';
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 7px;border-radius:10px;background:var(--fau-surface2);color:var(--fau-text-muted);border:1px solid var(--fau-border);cursor:default;transition:all .2s';
    badge.onclick = null;
    return;
  }

  badge.onclick = toggleFigmaMCP;

  if (enabled && connected) {
    badge.textContent = '✦ Figma MCP';
    badge.title = 'Figma MCP active (' + (figmaMCPStatus.toolCount || 0) + ' tools) — click to disable';
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 7px;border-radius:10px;background:rgba(98,215,148,.15);color:#62d794;border:1px solid rgba(98,215,148,.35);cursor:pointer;font-weight:600;transition:all .2s';
  } else if (enabled && !connected) {
    badge.textContent = '⚠ Figma MCP';
    badge.title = 'Figma MCP enabled but Figma Desktop / Dev Mode MCP not running — click to disable';
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 7px;border-radius:10px;background:rgba(255,200,80,.12);color:#f0b429;border:1px solid rgba(255,200,80,.3);cursor:pointer;transition:all .2s';
  } else if (!enabled && connected) {
    badge.textContent = '◎ Figma MCP';
    badge.title = 'Figma MCP available (' + (figmaMCPStatus.toolCount || 0) + ' tools) — click to enable';
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 7px;border-radius:10px;background:var(--fau-surface2);color:var(--fau-text-secondary,#8b8b9e);border:1px solid var(--fau-border);cursor:pointer;transition:all .2s';
  } else {
    badge.textContent = '◌ Figma MCP';
    badge.title = 'Figma MCP off — click to enable';
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 7px;border-radius:10px;background:var(--fau-surface2);color:var(--fau-text-muted);border:1px solid var(--fau-border);cursor:pointer;opacity:.6;transition:all .2s';
  }
}

function setFigmaSectionVisible(show) {
  figmaSectionOpen = show;
  var body    = document.getElementById('figma-section-body');
  var section = document.getElementById('figma-section');
  if (!body || !section) return;
  body.style.display = show ? 'block' : 'none';
  section.classList.toggle('open', show);
  if (show) pollFigmaStatus();
}

async function toggleFigmaMCP() {
  // Agent sandbox: check Figma permission
  if (typeof isAgentActive === 'function' && isAgentActive() && !state.figmaMCPEnabled) {
    var perm = checkAgentPermission('figma');
    if (!perm.allowed) { showSandboxBlock(perm.reason); return; }
  }
  state.figmaMCPEnabled = !state.figmaMCPEnabled;
  localStorage.setItem('fauna-figma-mcp', state.figmaMCPEnabled ? 'true' : 'false');
  updateFigmaMCPBadge();

  if (state.figmaMCPEnabled) {
    // Enable: show Figma section + start relay server if not already running
    setFigmaSectionVisible(true);
    if (!figmaStatus.mcpRunning) {
      var r = await fetch('/api/figma/mcp-start', { method: 'POST' }).catch(() => null);
      var d = r ? await r.json().catch(() => ({})) : {};
      if (d && !d.ok && d.error) showToast('Relay: ' + d.error);
      setTimeout(pollFigmaStatus, 600);
    }
    checkFigmaMCPStatus();
    showToast('✦ Figma MCP enabled');
  } else {
    // Disable: hide Figma section + stop relay server
    setFigmaSectionVisible(false);
    if (figmaStatus.mcpRunning) {
      await fetch('/api/figma/mcp-stop', { method: 'POST' }).catch(() => null);
      setTimeout(pollFigmaStatus, 600);
    }
    showToast('○ Figma MCP disabled');
  }
}

async function pollFigmaStatus() {
  try {
    var r = await fetch('/api/figma/status');
    var d = await r.json();
    figmaStatus = d;
    updateFigmaStatusUI();
    if (figmaLogsOpen) refreshMcpLogs();
  } catch (_) {}
}

function updateFigmaStatusUI() {
  var dot        = document.getElementById('figma-dot');
  var fname      = document.getElementById('figma-file-name');
  var fmeta      = document.getElementById('figma-file-meta');
  var badge      = document.getElementById('figma-system-badge');
  var serverDot  = document.getElementById('figma-server-dot');
  var serverBtn  = document.getElementById('figma-server-btn');
  if (!dot) return;

  // MCP server row
  if (figmaStatus.mcpRunning) {
    serverDot.className = 'figma-dot on'; serverDot.style.cssText += '';
    serverBtn.textContent = 'Stop';
    serverBtn.className = 'figma-btn figma-server-toggle running';
  } else {
    serverDot.className = 'figma-dot off';
    serverBtn.textContent = 'Start';
    serverBtn.className = 'figma-btn figma-server-toggle';
  }

  // Figma plugin connection
  if (figmaStatus.figmaConnected && figmaStatus.fileInfo) {
    dot.className = 'figma-dot on';
    fname.textContent = figmaStatus.fileInfo.fileName || 'Untitled';
    fmeta.textContent = figmaStatus.fileInfo.currentPage ? 'Page: ' + figmaStatus.fileInfo.currentPage : '';
    if (figmaStatus.activeSystem) {
      badge.textContent = figmaStatus.activeSystem.name;
      badge.style.display = '';
    } else { badge.style.display = 'none'; }
  } else if (figmaStatus.relayConnected) {
    dot.className = 'figma-dot relay';
    fname.textContent = 'Relay ready';
    fmeta.textContent = 'Open FaunaMCP plugin in Figma';
    badge.style.display = 'none';
  } else if (figmaStatus.mcpRunning) {
    dot.className = 'figma-dot relay';
    fname.textContent = 'Server starting…';
    fmeta.textContent = 'Connecting to relay';
    badge.style.display = 'none';
  } else {
    dot.className = 'figma-dot off';
    fname.textContent = 'Server not running';
    fmeta.textContent = 'Click Start to launch';
    badge.style.display = 'none';
  }
}

function toggleFigmaSection() {
  figmaSectionOpen = !figmaSectionOpen;
  var body    = document.getElementById('figma-section-body');
  var section = document.getElementById('figma-section');
  body.style.display = figmaSectionOpen ? 'block' : 'none';
  section.classList.toggle('open', figmaSectionOpen);
  if (figmaSectionOpen) pollFigmaStatus();
}

async function figmaConnect() {
  await fetch('/api/figma/connect', { method: 'POST' }).catch(() => {});
  setTimeout(pollFigmaStatus, 800);
}

// Renamed so the sidebar button calls figmaWsConnect (not confused with auto-connect)
function figmaWsConnect() { figmaConnect(); }

async function toggleMcpServer() {
  var btn = document.getElementById('figma-server-btn');
  btn.disabled = true;
  try {
    if (figmaStatus.mcpRunning) {
      await fetch('/api/figma/mcp-stop', { method: 'POST' });
    } else {
      var r = await fetch('/api/figma/mcp-start', { method: 'POST' });
      var d = await r.json();
      if (!d.ok && d.error) showToast(d.error);
    }
    setTimeout(pollFigmaStatus, 600);
  } finally {
    btn.disabled = false;
  }
}

var figmaLogsInterval = null;

function toggleMcpLogs() {
  figmaLogsOpen = !figmaLogsOpen;
  var box = document.getElementById('figma-logs-box');
  var btn = document.getElementById('figma-logs-btn');
  box.style.display = figmaLogsOpen ? 'block' : 'none';
  btn.style.background = figmaLogsOpen ? 'var(--fau-surface3)' : '';
  if (figmaLogsOpen) {
    refreshMcpLogs();
    figmaLogsInterval = setInterval(refreshMcpLogs, 1500);
  } else {
    clearInterval(figmaLogsInterval);
  }
}

async function refreshMcpLogs() {
  try {
    var r = await fetch('/api/figma/mcp-logs?since=' + figmaLogsLastTs);
    var lines = await r.json();
    if (!lines.length) return;
    var box = document.getElementById('figma-logs-box');
    for (var l of lines) {
      figmaLogsLastTs = Math.max(figmaLogsLastTs, l.t);
      var d = document.createElement('div');
      d.textContent = l.msg;
      d.style.color = l.msg.includes('error') || l.msg.includes('Error') ? 'var(--error)'
                    : l.msg.includes('connected') || l.msg.includes('Identified') ? 'var(--success)'
                    : '';
      box.appendChild(d);
    }
    box.scrollTop = box.scrollHeight;
  } catch (_) {}
}

// Poll status every 4 seconds when sidebar section is open
setInterval(function() { if (figmaSectionOpen) pollFigmaStatus(); }, 4000);
pollFigmaStatus(); // Initial check
checkFigmaMCPStatus(); // Check Figma Dev Mode MCP
setInterval(checkFigmaMCPStatus, 10000); // Re-check every 10 s

// Restore Figma section visibility from previous session
if (state.figmaMCPEnabled) setFigmaSectionVisible(true);

// ── Figma Rules ───────────────────────────────────────────────────────────

function toggleFigmaRules() {
  figmaRulesOpen = !figmaRulesOpen;
  document.getElementById('figma-rules-panel').classList.toggle('open', figmaRulesOpen);
  if (figmaRulesOpen) loadFigmaRules();
}

async function loadFigmaRules() {
  try {
    var r = await fetch('/api/figma/rules');
    figmaRules = await r.json();
    renderFigmaRules();
  } catch (_) {}
}

function renderFigmaRules() {
  var list = document.getElementById('figma-rules-list');
  if (!figmaRules.length) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--fau-text-muted);font-size:12px">No rules yet.<br>Add some below to guide the AI.</div>';
    return;
  }
  list.innerHTML = figmaRules.map(function(r) {
    var isOn = r.enabled !== false;
    return '<div class="rule-row' + (isOn ? '' : ' disabled') + '" data-id="' + escHtml(r.id) + '">' +
      '<button class="rule-toggle ' + (isOn ? 'on' : '') + '" onclick="toggleRule(\'' + r.id + '\')" title="' + (isOn ? 'Disable' : 'Enable') + '"></button>' +
      '<span class="rule-text">' + escHtml(r.text) + '</span>' +
      '<button class="rule-delete" onclick="deleteRule(\'' + r.id + '\')" title="Delete"><i class="ti ti-trash"></i></button>' +
    '</div>';
  }).join('');
}

async function addFigmaRule() {
  var input = document.getElementById('figma-rule-input');
  var text  = input.value.trim();
  if (!text) return;
  try {
    var r = await fetch('/api/figma/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, enabled: true })
    });
    var rule = await r.json();
    figmaRules.push(rule);
    input.value = '';
    renderFigmaRules();
  } catch (_) {}
}

async function toggleRule(id) {
  var rule = figmaRules.find(function(r) { return r.id === id; });
  if (!rule) return;
  rule.enabled = !(rule.enabled !== false);
  await fetch('/api/figma/rules/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: rule.enabled })
  }).catch(() => {});
  renderFigmaRules();
}

async function deleteRule(id) {
  figmaRules = figmaRules.filter(function(r) { return r.id !== id; });
  await fetch('/api/figma/rules/' + id, { method: 'DELETE' }).catch(() => {});
  renderFigmaRules();
}

// Build Figma context string to inject into the system prompt
function getFigmaContext() {
  if (!figmaStatus.figmaConnected) return '';
  var lines = [];
  if (figmaStatus.fileInfo) {
    lines.push('## Figma Context');
    lines.push('Connected file: ' + figmaStatus.fileInfo.fileName);
    if (figmaStatus.fileInfo.currentPage) lines.push('Current page: ' + figmaStatus.fileInfo.currentPage);
    if (figmaStatus.activeSystem) lines.push('Active design system: ' + figmaStatus.activeSystem.name + ' [' + figmaStatus.activeSystem.id + ']');
  }
  var activeRules = figmaRules.filter(function(r) { return r.enabled !== false; });
  if (activeRules.length) {
    lines.push('');
    lines.push('## Figma Design Rules (follow these strictly)');
    activeRules.forEach(function(r, i) { lines.push((i + 1) + '. ' + r.text); });
  }
  if (lines.length) {
    lines.push('');
    lines.push('**Execution**: Use the `figma_execute` MCP tool to run Figma Plugin API JavaScript. Call `get_design_context` first if you need current node IDs or structure, then immediately call `figma_execute` — do NOT describe what you\'re about to do, just call the tool.');
  }
  return lines.join('\n');
}

// ── Figma-exec block execution ────────────────────────────────────────────

function extractAndRenderFigmaExec(html, messageEl) {
  // After markdown rendering, replace <code class="language-figma-exec"> blocks
  // with interactive execution widgets
  var container = messageEl.querySelector('.prose') || messageEl;
  var codeBlocks = container.querySelectorAll('code.language-figma-exec');
  codeBlocks.forEach(function(code) {
    var pre = code.parentElement;
    var rawCode = code.textContent;
    var widget = document.createElement('div');
    widget.className = 'figma-exec-block';
    var execId = 'fe-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    widget.innerHTML =
      '<div class="figma-exec-header">' +
        '<span><i class="ti ti-bolt"></i> Figma Action</span>' +
        '<button class="figma-exec-run" onclick="runFigmaExec(\'' + execId + '\')"><i class="ti ti-player-play"></i> Run</button>' +
      '</div>' +
      '<div class="figma-exec-code">' + escHtml(rawCode) + '</div>' +
      '<div class="figma-exec-result" id="' + execId + '" style="display:none"></div>';
    widget.dataset.code = rawCode;
    pre.parentNode.replaceChild(widget, pre);
  });
}

async function runFigmaExec(execId) {
  var widget = document.getElementById(execId).parentElement;
  var code   = widget.dataset.code;
  var resultEl = document.getElementById(execId);
  resultEl.style.display = 'block';
  resultEl.className = 'figma-exec-result running';
  resultEl.innerHTML = '<i class="ti ti-loader"></i> Running…';

  try {
    var r = await fetch('/api/figma/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    var d = await r.json();
    if (d.ok && !d.error) {
      resultEl.className = 'figma-exec-result ok';
      var resultText = d.result !== undefined ? JSON.stringify(d.result, null, 2) : 'Done';
      resultEl.innerHTML = '<i class="ti ti-check"></i> ' + resultText;
      // Auto-feed success back to AI so it can verify
      _autoFeedFigmaResult(code, true, resultText);
    } else {
      resultEl.className = 'figma-exec-result err';
      var errText = d.error || 'Execution failed';
      resultEl.innerHTML = '<i class="ti ti-x"></i> ' + errText;
      // Auto-feed error back to AI so it can fix
      _autoFeedFigmaResult(code, false, errText);
    }
  } catch (e) {
    resultEl.className = 'figma-exec-result err';
    resultEl.innerHTML = '<i class="ti ti-x"></i> ' + e.message;
    _autoFeedFigmaResult(code, false, e.message);
  }
}

function _autoFeedFigmaResult(code, success, detail) {
  var targetConv = typeof getConv === 'function' ? getConv(state.currentId) : null;
  if (!targetConv) return;
  // Cap auto-feed depth to prevent loops
  var depth = targetConv._autoFeedDepth || 0;
  if (depth >= 10) return;
  targetConv._autoFeedDepth = depth + 1;
  var preview = (detail || '').substring(0, 2000);
  var msg = success
    ? '**Figma execution result:** ✓ Success\n```\n' + preview + '\n```\nVerify the result is correct. If more Figma operations are needed, continue. If done, summarize what was created.'
    : '**Figma execution result:** ✗ Error\n```\n' + preview + '\n```\nThe Figma operation failed. Diagnose the error and fix it.';
  setTimeout(function() {
    if (typeof sendDirectMessage === 'function') {
      sendDirectMessage(msg, { fromAutoFeed: true, isAutoFeed: true, targetConvId: state.currentId });
    }
  }, 600);
}

// ── Write-file block: direct file write without shell ────────────────────

// ── Figma Setup / Help panel ──────────────────────────────────────────────

var figmaSetupOpen   = false;
var figmaPluginState = { installed: false, installDir: null };

function toggleFigmaSetup() {
  figmaSetupOpen = !figmaSetupOpen;
  document.getElementById('figma-setup-panel').classList.toggle('open', figmaSetupOpen);
  if (figmaSetupOpen) loadFigmaSetupState();
}

async function loadFigmaSetupState() {
  // Plugin install status
  try {
    var r = await fetch('/api/figma/plugin-info');
    var d = await r.json();
    figmaPluginState = d;
    var icon = document.getElementById('figma-plugin-status-icon');
    var text = document.getElementById('figma-plugin-status-text');
    var installBtn   = document.getElementById('figma-install-btn');
    var openFolderBtn = document.getElementById('figma-open-folder-btn');
    var pathEl = document.getElementById('figma-plugin-path');

    if (d.installed) {
      icon.innerHTML = '<i class="ti ti-circle-check" style="color:var(--success)"></i>';
      text.textContent = 'Plugin installed at ' + d.installDir;
      installBtn.innerHTML = '<i class="ti ti-refresh"></i> Reinstall';
      openFolderBtn.style.display = '';
      if (pathEl) pathEl.textContent = d.installDir + '/manifest.json';
    } else {
      icon.innerHTML = '<i class="ti ti-circle-x" style="color:var(--warn)"></i>';
      text.textContent = 'Not yet installed — click Install below';
      openFolderBtn.style.display = 'none';
    }
  } catch (_) {}

  // MCP server status
  try {
    var r2 = await fetch('/api/figma/status');
    var d2 = await r2.json();
    var mcpIcon = document.getElementById('setup-mcp-icon');
    var mcpText = document.getElementById('setup-mcp-text');
    if (d2.mcpRunning) {
      mcpIcon.innerHTML = '<i class="ti ti-circle-check" style="color:var(--success)"></i>'; mcpText.textContent = 'MCP server is running (PID ' + (d2.mcpPid || '?') + ')';
    } else {
      mcpIcon.innerHTML = '<i class="ti ti-circle-x" style="color:var(--warn)"></i>'; mcpText.textContent = 'MCP server not running — expand Figma panel and click Start';
    }
  } catch (_) {}

  // Browser extension status
  loadBrowserExtState();

  // Collapse instruction sections by default
  var fb = document.getElementById('figma-instructions-body');
  var bb = document.getElementById('browser-ext-instructions-body');
  if (fb) fb.style.display = 'none';
  if (bb) bb.style.display = 'none';
}

async function installFigmaPlugin() {
  var btn    = document.getElementById('figma-install-btn');
  var result = document.getElementById('figma-install-result');
  btn.disabled = true; btn.textContent = 'Installing…';
  result.className = 'setup-inline-result'; result.textContent = '';
  try {
    var r = await fetch('/api/figma/plugin-install', { method: 'POST' });
    var d = await r.json();
    if (d.ok) {
      result.className = 'setup-inline-result ok';
      result.innerHTML = '<i class="ti ti-check"></i> Installed to ' + d.installDir;
      document.getElementById('figma-open-folder-btn').style.display = '';
      document.getElementById('figma-plugin-path').textContent = d.installDir + '/manifest.json';
      figmaPluginState = { installed: true, installDir: d.installDir };
      showToast('Plugin installed');
      loadFigmaSetupState();
    } else {
      result.className = 'setup-inline-result err';
      result.innerHTML = '<i class="ti ti-x"></i> ' + d.error;
    }
  } catch (e) {
    result.className = 'setup-inline-result err';
    result.innerHTML = '<i class="ti ti-x"></i> ' + e.message;
  }
  btn.disabled = false; btn.innerHTML = '<i class="ti ti-refresh"></i> Reinstall';
}

async function openPluginFolder() {
  var dir = figmaPluginState.installDir;
  if (!dir) return;
  await fetch('/api/open-folder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath: dir })
  }).catch(() => {});
}

function copyPluginPath() {
  var pathEl = document.getElementById('figma-plugin-path');
  navigator.clipboard.writeText(pathEl.textContent).then(function() {
    showToast('Path copied');
  });
}

async function downloadFigmaPlugin() {
  var btn = document.getElementById('figma-download-btn');
  var result = document.getElementById('figma-install-result');
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Choosing folder…';
  result.className = 'setup-inline-result'; result.textContent = '';
  try {
    var r = await fetch('/api/figma/plugin-download', { method: 'POST' });
    var d = await r.json();
    if (d.ok) {
      result.className = 'setup-inline-result ok';
      result.innerHTML = '<i class="ti ti-check"></i> Saved to ' + d.downloadDir;
      document.getElementById('figma-plugin-path').textContent = d.downloadDir + '/manifest.json';
      showToast('Plugin saved to ' + d.downloadDir);
    } else if (d.cancelled) {
      // user cancelled the dialog
    } else {
      result.className = 'setup-inline-result err';
      result.innerHTML = '<i class="ti ti-x"></i> ' + (d.error || 'Unknown error');
    }
  } catch (e) {
    result.className = 'setup-inline-result err';
    result.innerHTML = '<i class="ti ti-x"></i> ' + e.message;
  }
  btn.disabled = false; btn.innerHTML = '<i class="ti ti-file-download"></i> Save to Folder…';
}

// ── Browser Extension install / download ──────────────────────────────────

var browserExtState = { installed: false, installDir: null };

async function loadBrowserExtState() {
  try {
    var r = await fetch('/api/browser-ext/info');
    var d = await r.json();
    browserExtState = d;
    var icon = document.getElementById('browser-ext-status-icon');
    var text = document.getElementById('browser-ext-status-text');
    var installBtn = document.getElementById('browser-ext-install-btn');
    var openBtn = document.getElementById('browser-ext-open-folder-btn');
    var pathEl = document.getElementById('browser-ext-path');

    if (d.installed) {
      icon.innerHTML = '<i class="ti ti-circle-check" style="color:var(--success)"></i>';
      text.textContent = 'Extension installed at ' + d.installDir;
      installBtn.innerHTML = '<i class="ti ti-refresh"></i> Reinstall';
      openBtn.style.display = '';
      if (pathEl) pathEl.textContent = d.installDir;
    } else {
      icon.innerHTML = '<i class="ti ti-circle-x" style="color:var(--warn)"></i>';
      text.textContent = 'Not yet installed — click Install below';
      openBtn.style.display = 'none';
    }
  } catch (_) {}
}

async function installBrowserExt() {
  var btn = document.getElementById('browser-ext-install-btn');
  var result = document.getElementById('browser-ext-install-result');
  btn.disabled = true; btn.textContent = 'Installing…';
  result.className = 'setup-inline-result'; result.textContent = '';
  try {
    var r = await fetch('/api/browser-ext/install', { method: 'POST' });
    var d = await r.json();
    if (d.ok) {
      result.className = 'setup-inline-result ok';
      result.innerHTML = '<i class="ti ti-check"></i> Installed to ' + d.installDir;
      document.getElementById('browser-ext-open-folder-btn').style.display = '';
      document.getElementById('browser-ext-path').textContent = d.installDir;
      browserExtState = { installed: true, installDir: d.installDir };
      showToast('Browser extension installed');
      loadBrowserExtState();
    } else {
      result.className = 'setup-inline-result err';
      result.innerHTML = '<i class="ti ti-x"></i> ' + d.error;
    }
  } catch (e) {
    result.className = 'setup-inline-result err';
    result.innerHTML = '<i class="ti ti-x"></i> ' + e.message;
  }
  btn.disabled = false; btn.innerHTML = '<i class="ti ti-refresh"></i> Reinstall';
}

async function openBrowserExtFolder() {
  var dir = browserExtState.installDir;
  if (!dir) return;
  await fetch('/api/open-folder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath: dir })
  }).catch(function() {});
}

function copyBrowserExtPath() {
  var pathEl = document.getElementById('browser-ext-path');
  navigator.clipboard.writeText(pathEl.textContent).then(function() {
    showToast('Path copied');
  });
}

async function downloadBrowserExt() {
  var btn = document.getElementById('browser-ext-download-btn');
  var result = document.getElementById('browser-ext-install-result');
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Choosing folder…';
  result.className = 'setup-inline-result'; result.textContent = '';
  try {
    var r = await fetch('/api/browser-ext/download', { method: 'POST' });
    var d = await r.json();
    if (d.ok) {
      result.className = 'setup-inline-result ok';
      result.innerHTML = '<i class="ti ti-check"></i> Saved to ' + d.downloadDir;
      document.getElementById('browser-ext-path').textContent = d.downloadDir;
      showToast('Extension saved to ' + d.downloadDir);
    } else if (d.cancelled) {
      // user cancelled
    } else {
      result.className = 'setup-inline-result err';
      result.innerHTML = '<i class="ti ti-x"></i> ' + (d.error || 'Unknown error');
    }
  } catch (e) {
    result.className = 'setup-inline-result err';
    result.innerHTML = '<i class="ti ti-x"></i> ' + e.message;
  }
  btn.disabled = false; btn.innerHTML = '<i class="ti ti-file-download"></i> Save to Folder…';
}

// ── Collapsible setup instructions toggle ─────────────────────────────────

function toggleSetupInstructions(which) {
  var bodyId = which === 'figma' ? 'figma-instructions-body' : 'browser-ext-instructions-body';
  var cardId = which === 'figma' ? 'figma-instructions-card' : 'browser-ext-instructions-card';
  var body = document.getElementById(bodyId);
  var card = document.getElementById(cardId);
  if (!body || !card) return;
  var open = card.classList.toggle('expanded');
  body.style.display = open ? '' : 'none';
  var icon = card.querySelector('.setup-collapse-toggle i');
  if (icon) icon.className = open ? 'ti ti-chevron-down' : 'ti ti-chevron-right';
}

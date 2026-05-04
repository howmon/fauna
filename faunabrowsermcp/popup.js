let running   = false;
let loginItem = false;
let stdioText = '';

const dot         = document.getElementById('dot');
const statusText  = document.getElementById('statusText');
const toggleBtn   = document.getElementById('toggleBtn');
const logList     = document.getElementById('logList');
const loginSwitch = document.getElementById('loginSwitch');

// ── Init ──────────────────────────────────────────────────────────────────
window.mcp.getStatus().then(s => {
  applyStatus(s.running);
  document.getElementById('wsUrl').textContent   = s.wsUrl   || 'ws://localhost:3340';
  document.getElementById('httpUrl').textContent = s.httpUrl || 'http://localhost:3341/mcp';
  if (s.stdioConfig) {
    document.getElementById('stdioSnippet').textContent = s.stdioConfig;
    stdioText = s.stdioConfig;
  }
  if (s.extensionPath) {
    document.getElementById('extPath').textContent    = s.extensionPath;
    document.getElementById('extPath').dataset.path   = s.extensionPath;
  }
  setLogin(s.loginItem);
  if (s.iconUrl) document.getElementById('logo').src = s.iconUrl;
  if (s.version) document.getElementById('version').textContent = 'v' + s.version;
  if (s.logs) s.logs.forEach(e => addLogEntry(e));
});

window.mcp.onStatus(s => {
  applyStatus(s.running);
  if (s.extensionPath) {
    document.getElementById('extPath').textContent  = s.extensionPath;
    document.getElementById('extPath').dataset.path = s.extensionPath;
  }
});
window.mcp.onLog(e => addLogEntry(e));

// ── Status ────────────────────────────────────────────────────────────────
function applyStatus(r) {
  running = r;
  dot.className = 'dot ' + (r ? 'running' : 'stopped');
  statusText.textContent = r ? 'Running' : 'Stopped';
  toggleBtn.className = 'toggle-btn ' + (r ? 'stop' : 'start');
  toggleBtn.textContent = r ? 'Stop' : 'Start';
}

function toggleRelay() {
  dot.className = 'dot starting';
  statusText.textContent = running ? 'Stopping…' : 'Starting…';
  if (running) window.mcp.stopRelay(); else window.mcp.startRelay();
}

// ── Log ───────────────────────────────────────────────────────────────────
function addLogEntry(e) {
  const empty = logList.querySelector('.log-empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'log-entry ' + (e.level === 'ok' ? 'ok' : e.level === 'err' ? 'err' : '');
  const t = new Date(e.ts || Date.now()).toLocaleTimeString('en', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  el.textContent = t + '  ' + e.text;
  el.title = e.text;
  logList.appendChild(el);
  if (logList.children.length > 60) logList.removeChild(logList.firstChild);
  logList.scrollTop = logList.scrollHeight;
}

// ── Copy helpers ──────────────────────────────────────────────────────────
function cp(text, btn) {
  window.mcp.copy(text);
  flash(btn, 'Copy');
}

function cpSnippet(btn) {
  window.mcp.copy(stdioText);
  flash(btn, 'Copy');
}

function flash(btn, resetLabel) {
  btn.classList.add('flash');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.classList.remove('flash'); btn.textContent = resetLabel; }, 1400);
}

// ── Extension save / reveal ───────────────────────────────────────────────
async function saveExtension() {
  const btn = document.getElementById('extSaveBtn');
  btn.textContent = '…';
  const r = await window.mcp.saveExtension();
  if (r && r.ok) {
    btn.classList.add('flash');
    btn.textContent = '✓ Saved!';
    setTimeout(() => { btn.classList.remove('flash'); btn.textContent = '⬇ Save to…'; }, 2500);
  } else if (r && !r.canceled) {
    btn.textContent = '✗ Error';
    setTimeout(() => { btn.textContent = '⬇ Save to…'; }, 2000);
  } else {
    btn.textContent = '⬇ Save to…';
  }
}

// ── Login item ────────────────────────────────────────────────────────────
function setLogin(on) {
  loginItem = !!on;
  loginSwitch.className = 'toggle-switch' + (loginItem ? ' on' : '');
}

function toggleLogin() {
  window.mcp.setLogin(!loginItem).then(on => setLogin(on));
}

// ── Event listeners ───────────────────────────────────────────────────────
document.getElementById('closeBtn').addEventListener('click', () => window.mcp.close());
toggleBtn.addEventListener('click', toggleRelay);
loginSwitch.addEventListener('click', toggleLogin);
document.getElementById('extSaveBtn').addEventListener('click', saveExtension);
document.getElementById('extRevealBtn').addEventListener('click', () => window.mcp.revealExtension());
document.getElementById('extPath').addEventListener('click', function() {
  window.mcp.copy(this.dataset.path || this.textContent);
});
document.getElementById('snippetCopyBtn').addEventListener('click', function() { cpSnippet(this); });

// Copy WS / HTTP buttons
document.getElementById('copyWs').addEventListener('click', function() {
  cp(document.getElementById('wsUrl').textContent, this);
});
document.getElementById('copyHttp').addEventListener('click', function() {
  cp(document.getElementById('httpUrl').textContent, this);
});

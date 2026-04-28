/**
 * Fauna Browser Bridge — sidebar panel script
 * Stays alive as long as the panel is open.
 */

const pill         = document.getElementById('status-pill');
const statusText   = document.getElementById('status-text');
const tabTitleEl   = document.getElementById('tab-title');
const tabUrlEl     = document.getElementById('tab-url');
const feedbackEl   = document.getElementById('feedback');
const offlineSec   = document.getElementById('offline-section');
const btnSendPage  = document.getElementById('btn-send-page');
const btnSnapshot  = document.getElementById('btn-snapshot');
const btnExtForms  = document.getElementById('btn-extract-forms');
const btnPickEl    = document.getElementById('btn-pick-element');
const btnReconnect = document.getElementById('btn-reconnect');
const logList      = document.getElementById('log-list');
const logEmpty     = document.getElementById('log-empty');
const pickedSec    = document.getElementById('picked-section');
const pickedTag    = document.getElementById('picked-tag');
const pickedSel    = document.getElementById('picked-selector');
const pickedText   = document.getElementById('picked-text');
const btnSendPicked= document.getElementById('btn-send-picked');

const LOG_MAX = 30; // keep last N entries

// ── Status ────────────────────────────────────────────────────────────────

function setStatus(online) {
  pill.className     = 'status-pill ' + (online ? 'online' : 'offline');
  statusText.textContent = online ? 'Connected' : 'Offline';
  offlineSec.style.display = online ? 'none' : '';
}

// ── Feedback ──────────────────────────────────────────────────────────────

let feedbackTimer = null;
function showFeedback(msg, type = '') {
  clearTimeout(feedbackTimer);
  feedbackEl.textContent = msg;
  feedbackEl.className   = 'feedback ' + type;
  if (type !== 'err') {
    feedbackTimer = setTimeout(() => {
      feedbackEl.textContent = '';
      feedbackEl.className   = 'feedback';
    }, 2500);
  }
}

// ── Active tab info ───────────────────────────────────────────────────────

async function refreshTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      tabTitleEl.textContent = tab.title || '(no title)';
      tabUrlEl.textContent   = tab.url   || '(no url)';
    }
  } catch (_) {}
}

// ── Activity log ──────────────────────────────────────────────────────────

const EVENT_ICONS = {
  'tab:activated':    '▸',
  'page:loaded':      '○',
  'user:selection':   '[ ]',
  'user:send-page':   '→',
  'user:snapshot':    '□',
};

function addLogEntry(eventType, data) {
  logEmpty.style.display = 'none';

  const item = document.createElement('div');
  item.className = 'log-item';

  const icon   = EVENT_ICONS[eventType] || '·';
  const detail = data?.title || data?.url || data?.text?.slice(0, 60) || '—';
  const time   = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  item.innerHTML = `
    <span class="log-icon">${icon}</span>
    <span class="log-body">
      <div class="log-event">${eventType}</div>
      <div class="log-detail">${escHtml(detail)}</div>
    </span>
    <span class="log-time">${time}</span>
  `;

  logList.insertBefore(item, logList.firstChild);

  // Trim old entries
  while (logList.querySelectorAll('.log-item').length > LOG_MAX) {
    const last = logList.querySelector('.log-item:last-child');
    if (last) logList.removeChild(last);
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────

(async () => {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => ({ connected: false }));
  setStatus(status?.connected || false);
  await refreshTabInfo();

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'fauna:status') {
      setStatus(msg.connected);
    }
    if (msg.type === 'fauna:event') {
      addLogEntry(msg.event, msg.data);
      // Also refresh tab info on navigation events
      if (msg.event === 'page:loaded' || msg.event === 'tab:activated') {
        refreshTabInfo();
      }
    }
    if (msg.type === 'fauna:picker-selected') {
      showPickedElement(msg.data);
      showFeedback('Element picked!', 'ok');
      btnPickEl.classList.remove('picking');
      btnPickEl.disabled = false;
    }
    if (msg.type === 'fauna:picker-cancelled') {
      btnPickEl.classList.remove('picking');
      btnPickEl.disabled = false;
      showFeedback('Picker cancelled');
    }
  });

  // Keep tab info fresh when the active tab changes
  chrome.tabs.onActivated.addListener(() => refreshTabInfo());
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === 'complete') refreshTabInfo();
  });
})();

// ── Actions ───────────────────────────────────────────────────────────────

btnSendPage.addEventListener('click', async () => {
  btnSendPage.disabled = true;
  showFeedback('Sending page…');
  await chrome.runtime.sendMessage({ type: 'send-page-to-fauna' }).catch(() => null);
  showFeedback('Page sent to Fauna!', 'ok');
  btnSendPage.disabled = false;
});

btnSnapshot.addEventListener('click', async () => {
  btnSnapshot.disabled = true;
  showFeedback('Taking snapshot…');
  await chrome.runtime.sendMessage({ type: 'snapshot-to-fauna' }).catch(() => null);
  showFeedback('Snapshot sent to Fauna!', 'ok');
  btnSnapshot.disabled = false;
});

btnExtForms.addEventListener('click', async () => {
  btnExtForms.disabled = true;
  showFeedback('Extracting forms…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { showFeedback('No active tab', 'err'); btnExtForms.disabled = false; return; }

    let data;
    try {
      data = await chrome.tabs.sendMessage(tab.id, { action: 'extract-forms' });
    } catch (_) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      data = await chrome.tabs.sendMessage(tab.id, { action: 'extract-forms' });
    }

    const count = data?.fields?.length || 0;
    await chrome.runtime.sendMessage({
      type: 'send-page-to-fauna',
      overrideData: JSON.stringify(data, null, 2)
    }).catch(() => {});

    showFeedback('Found ' + count + ' field' + (count === 1 ? '' : 's') + ' → sent', 'ok');
  } catch (e) {
    showFeedback('Error: ' + e.message, 'err');
  }
  btnExtForms.disabled = false;
});

btnReconnect.addEventListener('click', async () => {
  showFeedback('Connecting…');
  await chrome.runtime.sendMessage({ type: 'connect' }).catch(() => {});
  setTimeout(async () => {
    const s = await chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => ({ connected: false }));
    setStatus(s?.connected || false);
    showFeedback(
      s?.connected ? 'Connected!' : 'Could not connect — is Fauna running?',
      s?.connected ? 'ok' : 'err'
    );
  }, 800);
});

// ── Element Picker ────────────────────────────────────────────────────────

let _lastPickedData = null;

function showPickedElement(data) {
  _lastPickedData = data;
  pickedTag.textContent  = '<' + (data.tag || '?') + (data.id ? '#' + data.id : '') + '>';
  pickedSel.textContent  = data.selector || '—';
  pickedText.textContent = data.text ? data.text.slice(0, 120) : '(no text)';
  pickedSec.style.display = '';
  addLogEntry('user:element-picked', { text: data.selector });
}

btnPickEl.addEventListener('click', async () => {
  if (btnPickEl.classList.contains('picking')) {
    // Cancel active pick
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) chrome.tabs.sendMessage(tab.id, { action: 'picker:stop' }).catch(() => {});
    btnPickEl.classList.remove('picking');
    btnPickEl.disabled = false;
    showFeedback('Picker cancelled');
    return;
  }
  btnPickEl.classList.add('picking');
  btnPickEl.disabled = false; // keep clickable for cancel
  showFeedback('Click any element on the page… (Esc to cancel)');
  const result = await chrome.runtime.sendMessage({ type: 'pick-element' }).catch(() => null);
  if (result && !result.ok) {
    btnPickEl.classList.remove('picking');
    showFeedback('Could not activate picker: ' + (result.error || 'unknown'), 'err');
  }
});

btnSendPicked.addEventListener('click', async () => {
  if (!_lastPickedData) return;
  btnSendPicked.disabled = true;
  showFeedback('Sending element to Fauna…');
  const payload = JSON.stringify({
    type: 'element-scope',
    selector: _lastPickedData.selector,
    tag:      _lastPickedData.tag,
    text:     _lastPickedData.text,
    html:     _lastPickedData.html,
    rect:     _lastPickedData.rect,
    url:      _lastPickedData.url,
    pageTitle: _lastPickedData.pageTitle,
  }, null, 2);
  await chrome.runtime.sendMessage({ type: 'send-page-to-fauna', overrideData: payload }).catch(() => {});
  showFeedback('Element sent to Fauna!', 'ok');
  btnSendPicked.disabled = false;
});

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
const btnReconnect = document.getElementById('btn-reconnect');
const logList      = document.getElementById('log-list');
const logEmpty     = document.getElementById('log-empty');

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

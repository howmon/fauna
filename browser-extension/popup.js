/**
 * Fauna Browser Bridge — popup script
 */

const pill         = document.getElementById('status-pill');
const statusText   = document.getElementById('status-text');
const tabTitle     = document.getElementById('tab-title');
const tabUrl       = document.getElementById('tab-url');
const feedbackEl   = document.getElementById('feedback');
const offlineSec   = document.getElementById('offline-section');
const btnSendPage  = document.getElementById('btn-send-page');
const btnSnapshot  = document.getElementById('btn-snapshot');
const btnExtForms  = document.getElementById('btn-extract-forms');
const btnReconnect = document.getElementById('btn-reconnect');

function setStatus(online) {
  pill.className = 'status-pill ' + (online ? 'online' : 'offline');
  statusText.textContent = online ? 'Connected' : 'Offline';
  offlineSec.style.display = online ? 'none' : 'block';
}

function showFeedback(msg, type = '') {
  feedbackEl.textContent = msg;
  feedbackEl.className   = 'feedback ' + type;
  if (type !== 'err') setTimeout(() => { feedbackEl.textContent = ''; feedbackEl.className = 'feedback'; }, 2500);
}

// ── Init ──────────────────────────────────────────────────────────────────

(async () => {
  // Get current status from background
  const status = await chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => ({ connected: false }));
  setStatus(status?.connected || false);

  // Populate tab info
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
  if (tab) {
    tabTitle.textContent = tab.title || '(no title)';
    tabUrl.textContent   = tab.url   || '(no url)';
  }

  // Listen for status updates from background while popup is open
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'fauna:status') setStatus(msg.connected);
  });
})();

// ── Actions ───────────────────────────────────────────────────────────────

btnSendPage.addEventListener('click', async () => {
  btnSendPage.disabled = true;
  showFeedback('Sending page…');
  const res = await chrome.runtime.sendMessage({ type: 'send-page-to-fauna' }).catch(() => null);
  showFeedback('Page sent to Fauna!', 'ok');
  btnSendPage.disabled = false;
});

btnSnapshot.addEventListener('click', async () => {
  btnSnapshot.disabled = true;
  showFeedback('Taking snapshot…');
  const res = await chrome.runtime.sendMessage({ type: 'snapshot-to-fauna' }).catch(() => null);
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
    // Push as an event so Fauna can pick it up
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
    showFeedback(s?.connected ? 'Connected!' : 'Could not connect — is Fauna running?', s?.connected ? 'ok' : 'err');
  }, 800);
});

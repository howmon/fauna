// ── Heartbeat, Workflows, Teams, Capture — Settings UI controllers ────────────

// ── Screen Capture ────────────────────────────────────────────────────

async function triggerCapture() {
  showToast('Select a region to capture…');
  try {
    var res = await fetch('/api/capture-region', { method: 'POST' });
    var result = await res.json();
    if (result.base64) {
      addAttachment({
        type: 'image',
        name: 'capture-' + Date.now() + '.png',
        base64: result.base64,
        mime: 'image/png',
      });
      showToast('Capture attached');
    } else if (result.cancelled) {
      showToast('Capture cancelled');
    } else {
      showToast('Capture failed');
    }
  } catch (e) {
    showToast('Capture error: ' + e.message);
  }
}

// ── Heartbeat ──────────────────────────────────────────────────────────

var _hbLoaded = false;

async function loadHeartbeatSettings() {
  try {
    var res = await fetch('/api/heartbeat/settings');
    var s = await res.json();
    document.getElementById('hb-enabled').checked = s.enabled;
    document.getElementById('hb-interval').value = s.intervalMinutes || 30;
    document.getElementById('hb-prompt').value = s.prompt || '';
    document.getElementById('hb-start-hour').value = s.schedule?.startHour ?? 9;
    document.getElementById('hb-end-hour').value = s.schedule?.endHour ?? 17;
    // Set day checkboxes
    var days = s.schedule?.days || [1,2,3,4,5];
    document.querySelectorAll('#hb-schedule-days input[data-day]').forEach(function(cb) {
      cb.checked = days.includes(parseInt(cb.dataset.day));
    });
    _hbLoaded = true;
    loadHeartbeatLog();
  } catch (e) {
    console.error('Failed to load heartbeat settings:', e);
  }
}

async function saveHeartbeatSettings() {
  var days = [];
  document.querySelectorAll('#hb-schedule-days input[data-day]:checked').forEach(function(cb) {
    days.push(parseInt(cb.dataset.day));
  });
  var body = {
    enabled: document.getElementById('hb-enabled').checked,
    intervalMinutes: parseInt(document.getElementById('hb-interval').value) || 30,
    prompt: document.getElementById('hb-prompt').value,
    schedule: {
      days: days,
      startHour: parseInt(document.getElementById('hb-start-hour').value) || 9,
      endHour: parseInt(document.getElementById('hb-end-hour').value) || 17,
    },
  };
  try {
    await fetch('/api/heartbeat/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    showToast('Failed to save: ' + e.message);
  }
}

async function loadHeartbeatLog() {
  try {
    var res = await fetch('/api/heartbeat/log');
    var log = await res.json();
    var el = document.getElementById('hb-log');
    if (!log.length) {
      el.innerHTML = '<div style="color:var(--fau-text-dim);padding:8px">No heartbeat runs yet.</div>';
      return;
    }
    el.innerHTML = log.map(function(e) {
      var time = new Date(e.timestamp).toLocaleString();
      var icon = e.status === 'urgent' ? '🔴' : e.status === 'error' ? '❌' : '🟢';
      var dur = e.durationMs ? (e.durationMs / 1000).toFixed(1) + 's' : '';
      return '<div style="padding:6px 0;border-bottom:1px solid var(--fau-border-subtle)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<span>' + icon + ' <strong>' + e.status + '</strong></span>' +
          '<span style="color:var(--fau-text-dim);font-size:11px">' + time + ' · ' + dur + '</span>' +
        '</div>' +
        (e.urgent ? '<div style="color:var(--warning);margin-top:2px">⚠ ' + escHtml(e.urgent.summary) + '</div>' : '') +
        '<div style="color:var(--fau-text-dim);margin-top:2px;white-space:pre-wrap;max-height:60px;overflow:hidden">' + escHtml((e.response || '').slice(0, 200)) + '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    document.getElementById('hb-log').innerHTML = '<div style="color:var(--fau-text-dim)">Failed to load log.</div>';
  }
}

async function runHeartbeatNow() {
  showToast('Running heartbeat…');
  try {
    var res = await fetch('/api/heartbeat/run-now', { method: 'POST' });
    var result = await res.json();
    showToast('Heartbeat: ' + (result.status || result.skipped ? 'skipped (' + result.reason + ')' : result.status));
    loadHeartbeatLog();
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

async function clearHeartbeatLog() {
  await fetch('/api/heartbeat/clear-log', { method: 'POST' });
  loadHeartbeatLog();
  showToast('Log cleared');
}

// ── Workflows ──────────────────────────────────────────────────────────

var _wfLoaded = false;

async function loadWorkflows() {
  try {
    var res = await fetch('/api/workflows');
    var wfs = await res.json();
    _wfLoaded = true;
    renderWorkflowList(wfs);
  } catch (e) {
    document.getElementById('wf-list').innerHTML = '<div style="color:var(--fau-text-dim)">Failed to load.</div>';
  }
}

function renderWorkflowList(wfs) {
  var list = document.getElementById('wf-list');
  if (!wfs.length) {
    list.innerHTML = '<div style="color:var(--fau-text-dim);font-size:12px;padding:12px">No workflows yet. Create one to get started.</div>';
    return;
  }
  list.innerHTML = wfs.map(function(wf) {
    var lastRun = wf.lastRunAt ? new Date(wf.lastRunAt).toLocaleString() : 'never';
    var statusDot = wf.enabled ? '🟢' : '⚪';
    return '<div class="pb-row" style="margin-bottom:8px">' +
      '<div class="pb-row-head">' +
        '<span class="pb-row-title">' + statusDot + ' ' + escHtml(wf.name) + '</span>' +
        '<div class="pb-row-actions">' +
          '<span style="font-size:10px;color:var(--fau-text-dim);margin-right:6px">' + escHtml(wf.scheduleText || '') + '</span>' +
          '<button title="Run Now" onclick="runWorkflowNow(\'' + wf.id + '\')"><i class="ti ti-player-play"></i></button>' +
          '<button title="' + (wf.enabled ? 'Disable' : 'Enable') + '" onclick="toggleWorkflow(\'' + wf.id + '\',' + !wf.enabled + ')"><i class="ti ti-' + (wf.enabled ? 'toggle-right' : 'toggle-left') + '"></i></button>' +
          '<button title="Delete" onclick="deleteWorkflowUI(\'' + wf.id + '\')"><i class="ti ti-trash"></i></button>' +
        '</div>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--fau-text-dim);padding:0 8px">' +
        wf.steps.length + ' steps · Last run: ' + lastRun +
      '</div>' +
    '</div>';
  }).join('');
}

function showNewWorkflowForm() {
  document.getElementById('wf-new-form').style.display = 'block';
  document.getElementById('wf-new-name').focus();
}

async function createNewWorkflow() {
  var name = document.getElementById('wf-new-name').value.trim();
  var schedule = document.getElementById('wf-new-schedule').value.trim();
  var stepsText = document.getElementById('wf-new-steps').value.trim();
  if (!name) { showToast('Name is required'); return; }
  var steps = stepsText.split('\n').filter(function(s) { return s.trim(); }).map(function(s) { return { prompt: s.trim() }; });
  if (!steps.length) { showToast('Add at least one step'); return; }
  try {
    await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, schedule: schedule || 'daily at 9am', steps: steps }),
    });
    document.getElementById('wf-new-form').style.display = 'none';
    document.getElementById('wf-new-name').value = '';
    document.getElementById('wf-new-schedule').value = '';
    document.getElementById('wf-new-steps').value = '';
    showToast('Workflow created');
    loadWorkflows();
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

async function runWorkflowNow(id) {
  showToast('Running workflow…');
  try {
    var res = await fetch('/api/workflows/' + id + '/run-now', { method: 'POST' });
    var result = await res.json();
    showToast('Workflow ' + (result.ok ? 'completed' : 'failed: ' + (result.error || '')));
    loadWorkflows();
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

async function toggleWorkflow(id, enabled) {
  await fetch('/api/workflows/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: enabled }),
  });
  loadWorkflows();
}

async function deleteWorkflowUI(id) {
  if (!confirm('Delete this workflow?')) return;
  await fetch('/api/workflows/' + id, { method: 'DELETE' });
  showToast('Workflow deleted');
  loadWorkflows();
}

// ── Teams Bridge ──────────────────────────────────────────────────────

var _teamsLoaded = false;

async function loadTeamsSettings() {
  try {
    var res = await fetch('/api/teams/settings');
    var s = await res.json();
    document.getElementById('teams-enabled').checked = s.enabled;
    document.getElementById('teams-interval').value = s.pollIntervalSeconds || 10;
    document.getElementById('teams-status').textContent = s.status || 'disconnected';
    // Don't pre-fill token for security
    _teamsLoaded = true;
  } catch (e) {
    console.error('Failed to load teams settings:', e);
  }
}

async function saveTeamsSettings() {
  var body = {
    enabled: document.getElementById('teams-enabled').checked,
    pollIntervalSeconds: parseInt(document.getElementById('teams-interval').value) || 10,
  };
  var token = document.getElementById('teams-token').value;
  if (token) body.accessToken = token;
  try {
    var res = await fetch('/api/teams/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var result = await res.json();
    document.getElementById('teams-status').textContent = result.status || 'disconnected';
    showToast('Settings saved');
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

async function testTeamsConnection() {
  showToast('Testing connection…');
  try {
    var res = await fetch('/api/teams/test', { method: 'POST' });
    var result = await res.json();
    document.getElementById('teams-status').textContent = result.status || 'error';
    showToast('Status: ' + (result.status || result.error || 'unknown'));
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

// ── Settings page loading hooks ────────────────────────────────────────
// Called when switchSettingsPage opens a new page

var _origSwitchSettingsPage = typeof switchSettingsPage === 'function' ? switchSettingsPage : null;

function _hookSettingsPageLoad(page) {
  if (page === 'heartbeat' && !_hbLoaded) loadHeartbeatSettings();
  if (page === 'workflows' && !_wfLoaded) loadWorkflows();
  if (page === 'teams' && !_teamsLoaded) loadTeamsSettings();
}

// Hook into the existing switchSettingsPage function
(function() {
  var interval = setInterval(function() {
    if (typeof switchSettingsPage === 'function' && switchSettingsPage !== _hookedSwitchSettings) {
      var original = switchSettingsPage;
      _hookedSwitchSettings = function(page, btn) {
        original(page, btn);
        _hookSettingsPageLoad(page);
      };
      window.switchSettingsPage = _hookedSwitchSettings;
      clearInterval(interval);
    }
  }, 100);
})();
var _hookedSwitchSettings = null;

// ── Self-tool event handlers (from server via IPC/webContents.send) ────

if (typeof window !== 'undefined' && window.electronAPI) {
  // These events are sent from self-tools.js via sendToRenderer
  window.electronAPI?.on?.('self-tool:switch-model', function(model) {
    if (typeof onModelChange === 'function') onModelChange(model);
  });
  window.electronAPI?.on?.('self-tool:set-thinking-budget', function(budget) {
    state.thinkingBudget = budget;
    localStorage.setItem('fauna-thinking-budget', budget);
    var sel = document.getElementById('thinking-budget-select');
    if (sel) sel.value = budget;
  });
  window.electronAPI?.on?.('self-tool:save-instruction', function(data) {
    if (typeof addPlaybookFromAI === 'function') {
      addPlaybookFromAI(data.title, data.body, data.tags);
    }
  });
}

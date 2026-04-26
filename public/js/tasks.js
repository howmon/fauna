// ── Tasks Panel — Task Management UI ─────────────────────────────────────
// Renders the task management panel, handles CRUD, polling, and live updates.

var tasksPanelOpen = false;
var _tasksCache = [];
var _tasksPoller = null;
var _taskSSE = null;

function toggleTasksPanel() {
  tasksPanelOpen = !tasksPanelOpen;
  document.getElementById('tasks-panel').classList.toggle('open', tasksPanelOpen);
  if (tasksPanelOpen) {
    fetchTasks();
    _startTaskPolling();
    _connectTaskSSE();
  } else {
    _stopTaskPolling();
    _disconnectTaskSSE();
  }
}

// ── Fetch & Render ───────────────────────────────────────────────────────

async function fetchTasks() {
  try {
    var r = await fetch('/api/tasks');
    _tasksCache = await r.json();
    renderTasks();
  } catch (e) {
    console.warn('[tasks] fetch failed:', e.message);
  }
}

function renderTasks() {
  var list = document.getElementById('tasks-list');
  if (!list) return;
  if (!_tasksCache.length) {
    list.innerHTML = '<div class="tasks-empty">' +
      '<i class="ti ti-checklist" style="font-size:28px;opacity:.3"></i>' +
      '<div>No tasks yet</div>' +
      '<div style="font-size:11px;color:var(--text-dim)">Create a task or ask the AI to schedule one</div>' +
      '</div>';
    return;
  }

  // Sort: running first, then scheduled, then pending, then completed/failed
  var order = { running: 0, scheduled: 1, pending: 2, paused: 3, failed: 4, completed: 5 };
  var sorted = _tasksCache.slice().sort(function(a, b) {
    return (order[a.status] || 9) - (order[b.status] || 9);
  });

  list.innerHTML = sorted.map(function(t) {
    var icon = _taskStatusIcon(t.status);
    var statusClass = 'task-status-' + t.status;
    var agents = t.agents || (t.agent ? [t.agent] : []);
    var agentLabel = agents.length ? agents.map(function(a) { return '<span class="task-agent">' + escHtml(a) + '</span>'; }).join(' ') : '';
    var permBadges = _permBadges(t.permissions);
    var schedLabel = _scheduleLabel(t);
    var runningInfo = '';
    if (t._running) {
      runningInfo = '<div class="task-progress">' +
        '<div class="task-progress-bar task-progress-indeterminate"></div>' +
        '</div>' +
        '<div class="task-step">Step ' + t._running.step + '</div>';
    }
    var resultInfo = '';
    if ((t.status === 'completed' || t.status === 'failed') && t.result) {
      resultInfo = _renderTaskSummary(t);
    }
    var timeAgo = t.updatedAt ? _timeAgo(new Date(t.updatedAt)) : '';

    return '<div class="task-row ' + statusClass + '" data-task-id="' + t.id + '">' +
      '<div class="task-row-head">' +
        '<span class="task-icon">' + icon + '</span>' +
        '<span class="task-title">' + escHtml(t.title) + '</span>' +
        '<span class="task-time">' + timeAgo + '</span>' +
      '</div>' +
      '<div class="task-row-meta">' +
        agentLabel + permBadges + schedLabel +
      '</div>' +
      runningInfo +
      resultInfo +
      _renderSteerInput(t) +
      _renderReasoning(t) +
      _renderTaskLog(t) +
      '<div class="task-row-actions">' +
        _taskActions(t) +
      '</div>' +
    '</div>';
  }).join('');
}

function _taskStatusIcon(status) {
  switch (status) {
    case 'running':   return '<i class="ti ti-loader-2 spin" style="color:var(--accent)"></i>';
    case 'scheduled': return '<i class="ti ti-clock" style="color:var(--warn)"></i>';
    case 'pending':   return '<i class="ti ti-circle-dashed" style="color:var(--text-dim)"></i>';
    case 'completed': return '<i class="ti ti-circle-check" style="color:var(--success)"></i>';
    case 'failed':    return '<i class="ti ti-circle-x" style="color:var(--error)"></i>';
    case 'paused':    return '<i class="ti ti-player-pause" style="color:var(--text-muted)"></i>';
    default:          return '<i class="ti ti-circle-dashed"></i>';
  }
}

function _scheduleLabel(t) {
  if (!t.schedule) return '';
  if (t.schedule.type === 'manual') return '<span class="task-sched">manual</span>';
  if (t.schedule.type === 'once' && t.schedule.at) {
    var d = new Date(t.schedule.at);
    return '<span class="task-sched">' + d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</span>';
  }
  if (t.schedule.type === 'recurring' && t.schedule.cron) {
    return '<span class="task-sched">⟳ ' + escHtml(t.schedule.cron) + '</span>';
  }
  return '';
}

function _taskActions(t) {
  var btns = [];
  if (t.status === 'pending' || t.status === 'scheduled' || t.status === 'paused' || t.status === 'failed' || t.status === 'completed') {
    btns.push('<button class="task-btn run" onclick="taskRun(\'' + t.id + '\')" title="' + (t.status === 'completed' ? 'Re-run' : 'Run now') + '"><i class="ti ti-player-play"></i></button>');
  }
  if (t.status === 'running') {
    btns.push('<button class="task-btn stop" onclick="taskStop(\'' + t.id + '\')" title="Stop"><i class="ti ti-player-stop"></i></button>');
    btns.push('<button class="task-btn pause" onclick="taskPause(\'' + t.id + '\')" title="Pause"><i class="ti ti-player-pause"></i></button>');
  }
  if (t.history && t.history.length) {
    btns.push('<button class="task-btn" onclick="taskToggleLog(\'' + t.id + '\')" title="Toggle log"><i class="ti ti-list-details"></i></button>');
  }
  if (t.result && t.result.reasoning && t.result.reasoning.length) {
    btns.push('<button class="task-btn" onclick="taskToggleReasoning(\'' + t.id + '\')" title="Reasoning chain"><i class="ti ti-brain"></i></button>');
  }
  btns.push('<button class="task-btn edit" onclick="taskEdit(\'' + t.id + '\')" title="Edit"><i class="ti ti-pencil"></i></button>');
  btns.push('<button class="task-btn del" onclick="taskDelete(\'' + t.id + '\')" title="Delete"><i class="ti ti-trash"></i></button>');
  return btns.join('');
}

// ── Steering (inject message into running task) ──────────────────────────

function _renderSteerInput(t) {
  if (t.status !== 'running') return '';
  return '<div class="task-steer">' +
    '<input type="text" class="task-steer-input" placeholder="Steer: add instruction…" ' +
      'onkeydown="if(event.key===\'Enter\')taskSteer(\'' + t.id + '\',this)">' +
    '<button class="task-steer-btn" onclick="taskSteer(\'' + t.id + '\',this.previousElementSibling)" title="Send">' +
      '<i class="ti ti-send-2"></i></button>' +
  '</div>';
}

async function taskSteer(id, inputEl) {
  var msg = inputEl.value.trim();
  if (!msg) return;
  inputEl.value = '';
  inputEl.disabled = true;
  try {
    var r = await fetch('/api/tasks/' + id + '/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    var data = await r.json();
    if (!data.ok) showToast('Steer failed: ' + (data.error || 'unknown'));
    else showToast('Steering sent');
  } catch (e) {
    showToast('Failed to steer: ' + e.message);
  }
  inputEl.disabled = false;
  inputEl.focus();
}

function _timeAgo(d) {
  var s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// ── Task Actions ─────────────────────────────────────────────────────────

async function taskRun(id) {
  try {
    await fetch('/api/tasks/' + id + '/run', { method: 'POST' });
    fetchTasks();
  } catch (e) { showToast('Failed to run task: ' + e.message); }
}

async function taskPause(id) {
  try {
    await fetch('/api/tasks/' + id + '/pause', { method: 'POST' });
    fetchTasks();
  } catch (e) { showToast('Failed to pause task: ' + e.message); }
}

async function taskStop(id) {
  try {
    await fetch('/api/tasks/' + id + '/stop', { method: 'POST' });
    fetchTasks();
  } catch (e) { showToast('Failed to stop task: ' + e.message); }
}

async function taskDelete(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await fetch('/api/tasks/' + id, { method: 'DELETE' });
    fetchTasks();
  } catch (e) { showToast('Failed to delete task: ' + e.message); }
}

function taskEdit(id) {
  var t = _tasksCache.find(function(x) { return x.id === id; });
  if (!t) return;
  // Populate the create form with existing values for editing
  document.getElementById('task-title-input').value = t.title;
  document.getElementById('task-desc-input').value = t.description || '';
  document.getElementById('task-context-input').value = t.context || '';
  _setAgentPickerSelections((t.agents || (t.agent ? [t.agent] : [])));
  // Permissions
  var perms = t.permissions || {};
  document.getElementById('task-perm-shell').checked = perms.shell !== false;
  document.getElementById('task-perm-browser').checked = !!perms.browser;
  document.getElementById('task-perm-figma').checked = !!perms.figma;
  _onBrowserPermChange();
  if (perms.browser && typeof perms.browser === 'object' && perms.browser.tabs) {
    document.getElementById('task-browser-tabs').value = perms.browser.tabs.join(', ');
    // Once tabs load from extension, select the matching ones
    setTimeout(function() { _setTabPickerSelections(perms.browser.tabs); }, 600);
  } else {
    document.getElementById('task-browser-tabs').value = '';
  }
  document.getElementById('task-schedule-type').value = t.schedule?.type || 'manual';
  document.getElementById('task-schedule-at').value = t.schedule?.at ? t.schedule.at.slice(0, 16) : '';
  document.getElementById('task-schedule-cron').value = t.schedule?.cron || '';
  _onScheduleTypeChange();
  // Mark as editing
  var form = document.getElementById('task-create-form');
  form.dataset.editId = id;
  document.getElementById('task-create-btn').innerHTML = '<i class="ti ti-check"></i> Update Task';
  // Show form
  form.style.display = 'flex';
}

// ── Create / Update ──────────────────────────────────────────────────────

function toggleTaskCreateForm() {
  var form = document.getElementById('task-create-form');
  if (form.style.display === 'flex') {
    form.style.display = 'none';
    _resetTaskForm();
  } else {
    form.style.display = 'flex';
    document.getElementById('task-title-input').focus();
  }
}

function _resetTaskForm() {
  document.getElementById('task-title-input').value = '';
  document.getElementById('task-desc-input').value = '';
  document.getElementById('task-context-input').value = '';
  _clearAgentPicker();
  document.getElementById('task-perm-shell').checked = true;
  document.getElementById('task-perm-browser').checked = false;
  document.getElementById('task-perm-figma').checked = false;
  document.getElementById('task-browser-tabs').value = '';
  var picker = document.getElementById('task-tab-picker');
  if (picker) picker.innerHTML = '<div class="task-tab-picker-empty">Enable Browser above to pick tabs</div>';
  _onBrowserPermChange();
  document.getElementById('task-schedule-type').value = 'manual';
  document.getElementById('task-schedule-at').value = '';
  document.getElementById('task-schedule-cron').value = '';
  _onScheduleTypeChange();
  var form = document.getElementById('task-create-form');
  delete form.dataset.editId;
  document.getElementById('task-create-btn').innerHTML = '<i class="ti ti-plus"></i> Create Task';
}

function _onScheduleTypeChange() {
  var type = document.getElementById('task-schedule-type').value;
  document.getElementById('task-schedule-at-row').style.display = type === 'once' ? 'flex' : 'none';
  document.getElementById('task-schedule-cron-row').style.display = type === 'recurring' ? 'flex' : 'none';
}

async function submitTask() {
  var title = document.getElementById('task-title-input').value.trim();
  if (!title) { showToast('Task title is required'); return; }

  var payload = {
    title: title,
    description: document.getElementById('task-desc-input').value.trim(),
    context: document.getElementById('task-context-input').value.trim(),
    agents: _getSelectedAgents(),
    permissions: {
      shell: document.getElementById('task-perm-shell').checked,
      browser: _getBrowserPermission(),
      figma: document.getElementById('task-perm-figma').checked,
    },
    schedule: {
      type: document.getElementById('task-schedule-type').value,
      at: document.getElementById('task-schedule-at').value ? new Date(document.getElementById('task-schedule-at').value).toISOString() : null,
      cron: document.getElementById('task-schedule-cron').value.trim() || null,
    },
  };

  var form = document.getElementById('task-create-form');
  var editId = form.dataset.editId;

  try {
    if (editId) {
      await fetch('/api/tasks/' + editId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    form.style.display = 'none';
    _resetTaskForm();
    fetchTasks();
  } catch (e) {
    showToast('Failed to save task: ' + e.message);
  }
}

// ── Polling & SSE ────────────────────────────────────────────────────────

function _startTaskPolling() {
  _stopTaskPolling();
  _tasksPoller = setInterval(fetchTasks, 5000);
}

function _stopTaskPolling() {
  if (_tasksPoller) { clearInterval(_tasksPoller); _tasksPoller = null; }
}

function _connectTaskSSE() {
  _disconnectTaskSSE();
  try {
    _taskSSE = new EventSource('/api/tasks/stream');
    _taskSSE.onmessage = function(e) {
      try {
        var evt = JSON.parse(e.data);
        if (evt.event === 'completed' || evt.event === 'failed' || evt.event === 'started') {          // Auto-expand log on failure so user sees what went wrong
          if (evt.event === 'failed' && evt.taskId) _expandedLogs.add(evt.taskId);          fetchTasks(); // refresh list on major events
        }
        if (evt.event === 'step') {
          // Update progress inline without full refresh
          var row = document.querySelector('[data-task-id="' + evt.taskId + '"]');
          if (row) {
            var stepEl = row.querySelector('.task-step');
            if (stepEl) stepEl.textContent = 'Step ' + evt.step;
          }
        }
      } catch (_) {}
    };
    _taskSSE.onerror = function() {
      _disconnectTaskSSE();
      // Reconnect after 5s
      setTimeout(function() { if (tasksPanelOpen) _connectTaskSSE(); }, 5000);
    };
  } catch (_) {}
}

function _disconnectTaskSSE() {
  if (_taskSSE) { _taskSSE.close(); _taskSSE = null; }
}

// ── Quick task from chat (AI creates tasks via task-create blocks) ────────

function createTaskFromAI(taskData) {
  fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(taskData),
  }).then(function() {
    showToast('Task created: ' + (taskData.title || 'Untitled'));
    if (tasksPanelOpen) fetchTasks();
  }).catch(function(e) {
    showToast('Failed to create task: ' + e.message);
  });
}

// ── Permission helpers ───────────────────────────────────────────────────

function _getBrowserPermission() {
  if (!document.getElementById('task-perm-browser').checked) return false;
  // Collect checked tabs from picker
  var picked = [];
  document.querySelectorAll('#task-tab-picker .task-tab-item input:checked').forEach(function(cb) {
    picked.push(cb.dataset.url);
  });
  // Also include manually typed URLs
  var manual = document.getElementById('task-browser-tabs').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  var tabs = picked.concat(manual);
  if (tabs.length) return { tabs: tabs };
  return true; // enabled but no specific tabs = any tab / active tab
}

function _onBrowserPermChange() {
  var checked = document.getElementById('task-perm-browser').checked;
  document.getElementById('task-browser-tabs-row').style.display = checked ? 'flex' : 'none';
  if (checked) _refreshExtTabs();
}

function _permBadges(perms) {
  if (!perms) return '';
  var badges = [];
  if (perms.shell !== false) badges.push('<span class="task-perm-badge"><i class="ti ti-terminal-2"></i></span>');
  if (perms.browser) badges.push('<span class="task-perm-badge"><i class="ti ti-world-www"></i></span>');
  if (perms.figma) badges.push('<span class="task-perm-badge"><i class="ti ti-brand-figma"></i></span>');
  return badges.join(' ');
}

// ── Task log / history rendering ─────────────────────────────────────────

var _expandedLogs = new Set(); // task IDs with log expanded

function taskToggleLog(id) {
  if (_expandedLogs.has(id)) _expandedLogs.delete(id);
  else _expandedLogs.add(id);
  renderTasks();
}

// Strip fenced code blocks and trim result text for display
function _cleanResultText(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || text.slice(0, 120);
}

// ── Task Summary Card (with % success) ───────────────────────────────────

function _renderTaskSummary(t) {
  var r = t.result || {};
  var isOk = t.status === 'completed';
  var stats = r.stats || {};
  var total = stats.actionsTotal || 0;
  var ok = stats.actionsOk || 0;
  var failed = stats.actionsFailed || 0;
  var pct = total > 0 ? Math.round((ok / total) * 100) : (isOk ? 100 : 0);
  var duration = r.duration ? _formatDuration(r.duration) : '';
  var steps = r.totalSteps || 0;

  var pctClass = pct >= 80 ? 'task-pct-good' : (pct >= 50 ? 'task-pct-mid' : 'task-pct-bad');
  var statusText = isOk
    ? escHtml(_cleanResultText(r.summary || 'Completed'))
    : escHtml(_cleanResultText(r.error || 'Failed'));

  return '<div class="task-summary ' + (isOk ? 'ok' : 'fail') + '">' +
    '<div class="task-summary-head">' +
      '<span class="task-summary-pct ' + pctClass + '">' + pct + '%</span>' +
      '<span class="task-summary-text">' + statusText + '</span>' +
    '</div>' +
    '<div class="task-summary-stats">' +
      (steps ? '<span><i class="ti ti-arrow-iteration"></i> ' + steps + ' steps</span>' : '') +
      (total ? '<span><i class="ti ti-check"></i> ' + ok + '/' + total + ' actions ok</span>' : '') +
      (failed ? '<span class="task-summary-fail-count"><i class="ti ti-x"></i> ' + failed + ' failed</span>' : '') +
      (duration ? '<span><i class="ti ti-clock"></i> ' + duration + '</span>' : '') +
    '</div>' +
  '</div>';
}

function _formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  var s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  s = s % 60;
  return m + 'm ' + s + 's';
}

// ── Reasoning Chain ──────────────────────────────────────────────────────

var _expandedReasoning = new Set();

function taskToggleReasoning(id) {
  if (_expandedReasoning.has(id)) _expandedReasoning.delete(id);
  else _expandedReasoning.add(id);
  renderTasks();
}

function _renderReasoning(t) {
  var r = t.result || {};
  var reasoning = r.reasoning;
  if (!reasoning || !reasoning.length) return '';

  var toggleBtn = '<div class="task-reasoning-toggle" onclick="taskToggleReasoning(\'' + t.id + '\')">' +
    '<i class="ti ti-' + (_expandedReasoning.has(t.id) ? 'chevron-down' : 'chevron-right') + '"></i> ' +
    '<i class="ti ti-brain"></i> Reasoning (' + reasoning.length + ' steps)' +
  '</div>';

  if (!_expandedReasoning.has(t.id)) return toggleBtn;

  var entries = reasoning.map(function(entry) {
    var actionBadges = (entry.actions || []).map(function(a) {
      return '<span class="task-reason-action ' + (a.ok ? 'ok' : 'fail') + '">' +
        escHtml(a.action || a.type) + '</span>';
    }).join('');
    return '<div class="task-reason-entry">' +
      '<div class="task-reason-step">Step ' + entry.step + '</div>' +
      '<div class="task-reason-intent">' + escHtml(entry.intent || '').slice(0, 200) + '</div>' +
      (actionBadges ? '<div class="task-reason-actions">' + actionBadges + '</div>' : '') +
      '<div class="task-reason-outcome">' + escHtml(entry.outcome || '') + '</div>' +
    '</div>';
  }).join('');

  return toggleBtn +
    '<div class="task-reasoning-list">' + entries + '</div>';
}

function _renderTaskLog(t) {
  if (!t.history || !t.history.length) return '';
  if (!_expandedLogs.has(t.id)) return '';

  var entries = t.history.map(function(h) {
    var time = new Date(h.timestamp);
    var ts = time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var icon = _logEventIcon(h.event);
    var detail = h.detail ? escHtml(h.detail) : '';
    // For step events, show truncated AI response
    if (h.event === 'step' && detail.length > 200) detail = detail.slice(0, 200) + '…';
    return '<div class="task-log-entry task-log-' + h.event + '">' +
      '<span class="task-log-ts">' + ts + '</span>' +
      '<span class="task-log-icon">' + icon + '</span>' +
      '<span class="task-log-event">' + h.event + '</span>' +
      (detail ? '<span class="task-log-detail">' + detail + '</span>' : '') +
    '</div>';
  });

  return '<div class="task-log">' +
    '<div class="task-log-header" onclick="taskToggleLog(\'' + t.id + '\')">' +
      '<i class="ti ti-list-details"></i> Log (' + t.history.length + ' entries)' +
    '</div>' +
    '<div class="task-log-entries">' + entries.join('') + '</div>' +
  '</div>';
}

function _logEventIcon(event) {
  switch (event) {
    case 'created':     return '<i class="ti ti-circle-plus" style="color:var(--text-dim)"></i>';
    case 'started':     return '<i class="ti ti-player-play" style="color:var(--accent)"></i>';
    case 'step':        return '<i class="ti ti-arrow-right" style="color:var(--text-muted)"></i>';
    case 'completed':   return '<i class="ti ti-circle-check" style="color:var(--success)"></i>';
    case 'failed':      return '<i class="ti ti-circle-x" style="color:var(--error)"></i>';
    case 'paused':      return '<i class="ti ti-player-pause" style="color:var(--warn)"></i>';
    case 'scheduled':   return '<i class="ti ti-clock" style="color:var(--warn)"></i>';
    case 'rescheduled': return '<i class="ti ti-clock-play" style="color:var(--warn)"></i>';
    case 'retry':       return '<i class="ti ti-reload" style="color:var(--warn)"></i>';
    case 'steered':     return '<i class="ti ti-message-forward" style="color:var(--accent)"></i>';
    default:            return '<i class="ti ti-point"></i>';
  }
}

// ── Agent Picker (searchable multi-select) ───────────────────────────────

var _selectedAgents = []; // array of agent name strings

function _getSelectedAgents() { return _selectedAgents.slice(); }

function _clearAgentPicker() {
  _selectedAgents = [];
  _renderAgentSelections();
  var search = document.getElementById('task-agent-search');
  if (search) search.value = '';
  var dd = document.getElementById('task-agent-dropdown');
  if (dd) dd.style.display = 'none';
}

function _setAgentPickerSelections(names) {
  _selectedAgents = (names || []).filter(Boolean);
  _renderAgentSelections();
}

function _renderAgentSelections() {
  var el = document.getElementById('task-agent-selected');
  if (!el) return;
  if (!_selectedAgents.length) { el.innerHTML = ''; return; }
  el.innerHTML = _selectedAgents.map(function(name) {
    var agent = (typeof getAllAgents === 'function') ? getAllAgents().find(function(a) { return a.name === name; }) : null;
    var icon = agent ? agent.icon || 'ti-robot' : 'ti-robot';
    var display = agent ? (agent.displayName || agent.name) : name;
    return '<span class="task-agent-chip">' +
      '<i class="ti ' + icon + '"></i> ' + escHtml(display) +
      '<button type="button" onclick="_removeAgent(\'' + escHtml(name) + '\')" title="Remove">&times;</button>' +
    '</span>';
  }).join('');
}

function _removeAgent(name) {
  _selectedAgents = _selectedAgents.filter(function(n) { return n !== name; });
  _renderAgentSelections();
  _refreshAgentDropdown();
}

function _showAgentPicker() {
  _filterAgentPicker(document.getElementById('task-agent-search')?.value || '');
}

function _filterAgentPicker(query) {
  var dd = document.getElementById('task-agent-dropdown');
  if (!dd) return;
  var agents = (typeof getAllAgents === 'function') ? getAllAgents() : [];
  var q = query.toLowerCase().trim();
  var filtered = agents.filter(function(a) {
    // Exclude already selected
    if (_selectedAgents.indexOf(a.name) >= 0) return false;
    if (!q) return true;
    return (a.name.toLowerCase().indexOf(q) >= 0) ||
           ((a.displayName || '').toLowerCase().indexOf(q) >= 0) ||
           ((a.description || '').toLowerCase().indexOf(q) >= 0) ||
           ((a.category || '').toLowerCase().indexOf(q) >= 0);
  });

  if (!filtered.length) {
    dd.innerHTML = '<div class="task-agent-dd-empty">No agents found</div>';
    dd.style.display = 'block';
    return;
  }

  dd.innerHTML = filtered.slice(0, 15).map(function(a) {
    var icon = a.icon || 'ti-robot';
    var display = a.displayName || a.name;
    var cat = a.category ? '<span class="task-agent-dd-cat">' + escHtml(a.category) + '</span>' : '';
    return '<div class="task-agent-dd-item" onclick="_pickAgent(\'' + escHtml(a.name) + '\')">' +
      '<i class="ti ' + icon + '"></i>' +
      '<div class="task-agent-dd-info">' +
        '<span class="task-agent-dd-name">' + escHtml(display) + '</span>' +
        '<span class="task-agent-dd-desc">' + escHtml((a.description || '').slice(0, 60)) + '</span>' +
      '</div>' +
      cat +
    '</div>';
  }).join('');
  dd.style.display = 'block';
}

function _refreshAgentDropdown() {
  var search = document.getElementById('task-agent-search');
  if (search && document.getElementById('task-agent-dropdown')?.style.display === 'block') {
    _filterAgentPicker(search.value || '');
  }
}

function _pickAgent(name) {
  if (_selectedAgents.indexOf(name) < 0) _selectedAgents.push(name);
  _renderAgentSelections();
  var search = document.getElementById('task-agent-search');
  if (search) search.value = '';
  _filterAgentPicker('');
}

// Close dropdown on outside click
document.addEventListener('click', function(e) {
  var wrap = document.querySelector('.task-agent-picker-wrap');
  var dd = document.getElementById('task-agent-dropdown');
  if (dd && wrap && !wrap.contains(e.target)) dd.style.display = 'none';
});

// ── Browser tab picker (from Chrome extension) ───────────────────────────

var _extTabsCache = [];

function _filterTabPicker(query) {
  var q = query.toLowerCase().trim();
  var items = document.querySelectorAll('#task-tab-picker .task-tab-item');
  items.forEach(function(item) {
    var title = (item.querySelector('.task-tab-title')?.textContent || '').toLowerCase();
    var url = (item.querySelector('input')?.dataset.url || '').toLowerCase();
    item.style.display = (!q || title.indexOf(q) >= 0 || url.indexOf(q) >= 0) ? '' : 'none';
  });
}

async function _refreshExtTabs() {
  var picker = document.getElementById('task-tab-picker');
  if (!picker) return;
  picker.innerHTML = '<div class="task-tab-picker-empty"><i class="ti ti-loader-2 spin"></i> Loading tabs…</div>';
  try {
    var r = await fetch('/api/ext/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'tab:list' }),
    });
    var data = await r.json();
    if (!data.ok || !data.tabs || !data.tabs.length) {
      picker.innerHTML = '<div class="task-tab-picker-empty">No extension tabs available — is the extension connected?</div>';
      _extTabsCache = [];
      return;
    }
    _extTabsCache = data.tabs;
    _renderTabPicker(data.tabs);
  } catch (e) {
    picker.innerHTML = '<div class="task-tab-picker-empty">Extension not connected</div>';
    _extTabsCache = [];
  }
}

function _renderTabPicker(tabs) {
  var picker = document.getElementById('task-tab-picker');
  if (!picker) return;
  // Get currently selected URLs (for edit mode)
  var selectedUrls = new Set();
  document.querySelectorAll('#task-tab-picker .task-tab-item input:checked').forEach(function(cb) {
    selectedUrls.add(cb.dataset.url);
  });
  picker.innerHTML = tabs.map(function(tab) {
    var favicon = 'https://www.google.com/s2/favicons?sz=16&domain=' + encodeURIComponent(new URL(tab.url).hostname);
    var checked = selectedUrls.has(tab.url) ? ' checked' : '';
    var activeTag = tab.active ? '<span class="task-tab-active">active</span>' : '';
    return '<label class="task-tab-item" title="' + escHtml(tab.url) + '">' +
      '<input type="checkbox" data-url="' + escHtml(tab.url) + '" data-tab-id="' + tab.id + '"' + checked + '>' +
      '<img src="' + favicon + '" width="14" height="14" onerror="this.style.display=\'none\'">' +
      '<span class="task-tab-title">' + escHtml((tab.title || '').slice(0, 50)) + '</span>' +
      activeTag +
    '</label>';
  }).join('');
}

function _setTabPickerSelections(urls) {
  if (!urls || !urls.length) return;
  var urlSet = new Set(urls);
  document.querySelectorAll('#task-tab-picker .task-tab-item input').forEach(function(cb) {
    cb.checked = urlSet.has(cb.dataset.url);
  });
}

// ── Extract task-create blocks from AI response ──────────────────────────

function extractAndRenderTaskCreate(buffer, msgEl) {
  var re = /```task-create\n([\s\S]*?)```/g;
  var m;
  while ((m = re.exec(buffer))) {
    try {
      var data = JSON.parse(m[1].trim());
      if (data.title) {
        createTaskFromAI(data);
        // Replace the code block with a confirmation card
        var card = document.createElement('div');
        card.className = 'task-created-card';
        card.innerHTML = '<i class="ti ti-checklist" style="color:var(--accent)"></i> ' +
          '<strong>Task scheduled:</strong> ' + escHtml(data.title) +
          (data.schedule && data.schedule.type !== 'manual'
            ? ' <span style="color:var(--warn);font-size:11px">(' + (data.schedule.type === 'once' ? data.schedule.at : '⟳ ' + data.schedule.cron) + ')</span>'
            : '');
        msgEl.querySelector('.msg-body')?.appendChild(card);
      }
    } catch (e) {
      console.warn('[tasks] Failed to parse task-create block:', e.message);
    }
  }
}

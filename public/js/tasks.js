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
    var agentLabel = t.agent ? '<span class="task-agent">' + escHtml(t.agent) + '</span>' : '';
    var schedLabel = _scheduleLabel(t);
    var runningInfo = '';
    if (t._running) {
      var pct = Math.min(100, Math.round((t._running.step / (t.maxSteps || 20)) * 100));
      runningInfo = '<div class="task-progress">' +
        '<div class="task-progress-bar" style="width:' + pct + '%"></div>' +
        '</div>' +
        '<div class="task-step">Step ' + t._running.step + '/' + (t.maxSteps || 20) + '</div>';
    }
    var resultInfo = '';
    if (t.status === 'completed' && t.result) {
      resultInfo = '<div class="task-result ok">' + escHtml((t.result.summary || '').slice(0, 100)) + '</div>';
    }
    if (t.status === 'failed' && t.result) {
      resultInfo = '<div class="task-result fail">' + escHtml((t.result.error || '').slice(0, 100)) + '</div>';
    }
    var timeAgo = t.updatedAt ? _timeAgo(new Date(t.updatedAt)) : '';

    return '<div class="task-row ' + statusClass + '" data-task-id="' + t.id + '">' +
      '<div class="task-row-head">' +
        '<span class="task-icon">' + icon + '</span>' +
        '<span class="task-title">' + escHtml(t.title) + '</span>' +
        '<span class="task-time">' + timeAgo + '</span>' +
      '</div>' +
      '<div class="task-row-meta">' +
        agentLabel + schedLabel +
      '</div>' +
      runningInfo +
      resultInfo +
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
  if (t.status === 'pending' || t.status === 'scheduled' || t.status === 'paused' || t.status === 'failed') {
    btns.push('<button class="task-btn run" onclick="taskRun(\'' + t.id + '\')" title="Run now"><i class="ti ti-player-play"></i></button>');
  }
  if (t.status === 'running') {
    btns.push('<button class="task-btn pause" onclick="taskPause(\'' + t.id + '\')" title="Pause"><i class="ti ti-player-pause"></i></button>');
  }
  btns.push('<button class="task-btn edit" onclick="taskEdit(\'' + t.id + '\')" title="Edit"><i class="ti ti-pencil"></i></button>');
  btns.push('<button class="task-btn del" onclick="taskDelete(\'' + t.id + '\')" title="Delete"><i class="ti ti-trash"></i></button>');
  return btns.join('');
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
  document.getElementById('task-agent-input').value = t.agent || '';
  document.getElementById('task-schedule-type').value = t.schedule?.type || 'manual';
  document.getElementById('task-schedule-at').value = t.schedule?.at ? t.schedule.at.slice(0, 16) : '';
  document.getElementById('task-schedule-cron').value = t.schedule?.cron || '';
  _onScheduleTypeChange();
  // Mark as editing
  var form = document.getElementById('task-create-form');
  form.dataset.editId = id;
  document.getElementById('task-create-btn').innerHTML = '<i class="ti ti-check"></i> Update Task';
  // Show form
  form.style.display = 'block';
}

// ── Create / Update ──────────────────────────────────────────────────────

function toggleTaskCreateForm() {
  var form = document.getElementById('task-create-form');
  if (form.style.display === 'block') {
    form.style.display = 'none';
    _resetTaskForm();
  } else {
    form.style.display = 'block';
    document.getElementById('task-title-input').focus();
  }
}

function _resetTaskForm() {
  document.getElementById('task-title-input').value = '';
  document.getElementById('task-desc-input').value = '';
  document.getElementById('task-context-input').value = '';
  document.getElementById('task-agent-input').value = '';
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
    agent: document.getElementById('task-agent-input').value.trim() || null,
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
        if (evt.event === 'completed' || evt.event === 'failed' || evt.event === 'started') {
          fetchTasks(); // refresh list on major events
        }
        if (evt.event === 'step') {
          // Update progress inline without full refresh
          var row = document.querySelector('[data-task-id="' + evt.taskId + '"]');
          if (row) {
            var stepEl = row.querySelector('.task-step');
            if (stepEl) stepEl.textContent = 'Step ' + evt.step + '/' + (evt.maxSteps || 20);
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

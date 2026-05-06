// ── Automations Panel — Two-Panel UI with draft state + auto-save ─────────
// Left: list (Active / Paused sections)
// Right: detail / create form with RRULE schedule picker

var tasksPanelOpen = false;
var _tasksCache = [];
var _tasksPoller = null;
var _taskSSE = null;

// ── Draft state ──────────────────────────────────────────────────────────
var _draft = null;           // currently open automation (null = none)
var _draftSaveTimer = null;
var _draftDirty = false;
var _draftSaveStatus = '';   // 'saving' | 'saved' | 'error' | ''
var _draftAutoSaveEnabled = false;

function _blankDraft() {
  return {
    id:          null,
    kind:        'cron',
    title:       '',
    description: '',
    schedule: { type: 'manual', rrule: '', at: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    targetConvId: null,
    pipeline:    null,
    agents:      [],
    context:     '',
    permissions: { shell: true, browser: false, figma: false },
    model:       null,
    maxRetries:  2,
    timeout:     300000,
    maxSteps:    20,
  };
}

function _taskToDraft(t) {
  return {
    id:          t.id,
    kind:        t.kind || 'cron',
    title:       t.title || '',
    description: t.description || '',
    schedule:    Object.assign({ type: 'manual', rrule: '', at: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, t.schedule || {}),
    targetConvId: t.targetConvId || null,
    pipeline:    t.pipeline || null,
    agents:      (t.agents || []).slice(),
    context:     t.context || '',
    permissions: Object.assign({ shell: true, browser: false, figma: false }, t.permissions || {}),
    model:       t.model || null,
    maxRetries:  t.maxRetries ?? 2,
    timeout:     t.timeout ?? 300000,
    maxSteps:    t.maxSteps ?? 20,
  };
}

function _draftChange(key, val) {
  if (!_draft) return;
  if (key.indexOf('.') >= 0) {
    var parts = key.split('.');
    var obj = _draft;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = val;
  } else {
    _draft[key] = val;
  }
  _draftDirty = true;
  if (_draft.id && _draftAutoSaveEnabled) {
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(_autoSave, 600);
    _setDraftStatus('saving');
  }
  _renderDetailKindRows();
}

function _setDraftStatus(status) {
  _draftSaveStatus = status;
  var el = document.getElementById('auto-detail-save-status');
  if (!el) return;
  if (status === 'saving') { el.textContent = 'Saving...'; el.className = 'auto-detail-save-status saving'; }
  else if (status === 'saved') { el.textContent = 'Saved'; el.className = 'auto-detail-save-status saved'; }
  else if (status === 'error') { el.textContent = 'Save failed'; el.className = 'auto-detail-save-status error'; }
  else { el.textContent = ''; el.className = 'auto-detail-save-status'; }
}

async function _autoSave() {
  if (!_draft || !_draft.id) return;
  try {
    var r = await fetch('/api/tasks/' + _draft.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_draftToPayload()),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    _draftDirty = false;
    _setDraftStatus('saved');
    fetchTasks();
  } catch (e) {
    _setDraftStatus('error');
  }
}

function _draftToPayload() {
  if (!_draft) return {};
  return {
    kind:        _draft.kind,
    title:       _draft.title.trim(),
    description: _draft.description,
    schedule:    _draft.schedule,
    targetConvId: _draft.targetConvId,
    pipeline:    _draft.pipeline,
    agents:      _draft.agents,
    context:     _draft.context,
    permissions: _draft.permissions,
    model:       _draft.model || null,
    maxRetries:  _draft.maxRetries,
    timeout:     _draft.timeout,
    maxSteps:    _draft.maxSteps,
    projectId:   typeof state !== 'undefined' && state.activeProjectId ? state.activeProjectId : undefined,
  };
}

// ── Heartbeat bridge ─────────────────────────────────────────────────────
var _heartbeatTimer = null;

function _startHeartbeatBridge() {
  _stopHeartbeatBridge();
  _heartbeatTimer = setInterval(_checkHeartbeats, 20000);
}

function _stopHeartbeatBridge() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

function _checkHeartbeats() {
  var heartbeats = _tasksCache.filter(function(t) {
    return t.kind === 'heartbeat' && t.status === 'scheduled' && t.targetConvId;
  });
  heartbeats.forEach(function(t) {
    if (_isConvEligible(t.targetConvId)) {
      fetch('/api/tasks/' + t.id + '/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'heartbeat', convId: t.targetConvId }),
      }).catch(function() {});
    }
  });
}

function _isConvEligible(convId) {
  // Eligibility: conv exists, not currently streaming, last message is from assistant
  if (!convId) return false;
  if (typeof state === 'undefined') return false;
  var convs = state.conversations || [];
  var conv = convs.find(function(c) { return c.id === convId; });
  if (!conv) return false;                                   // missing_conv
  if (state.streamingConvId === convId) return false;       // streaming
  if (state.activeConvId === convId) {
    // Check last message role
    var msgs = state.messages || [];
    if (!msgs.length) return false;                          // no_turns
    var last = msgs[msgs.length - 1];
    if (last.role !== 'assistant') return false;             // last_turn_user
  }
  return true;
}

// ── Panel open/close ─────────────────────────────────────────────────────

function toggleTasksPanel() {
  tasksPanelOpen = !tasksPanelOpen;
  document.getElementById('tasks-panel').classList.toggle('open', tasksPanelOpen);
  if (tasksPanelOpen) {
    _initAutoResizeHandle();
    fetchTasks();
    _startTaskPolling();
    _connectTaskSSE();
    _startHeartbeatBridge();
  } else {
    _stopTaskPolling();
    _disconnectTaskSSE();
    _stopHeartbeatBridge();
    _draft = null;
    _renderDetail();
  }
}

var _autoResizeHandleInited = false;
function _initAutoResizeHandle() {
  if (_autoResizeHandleInited) return;
  _autoResizeHandleInited = true;
  var handle = document.getElementById('auto-resize-handle');
  var navCol = document.getElementById('auto-nav-col');
  var panel  = document.getElementById('tasks-panel');
  if (!handle || !navCol || !panel) return;

  var savedW = parseInt(localStorage.getItem('fauna-auto-nav-w'), 10);
  if (savedW && savedW >= 160 && savedW <= 520) navCol.style.width = savedW + 'px';

  var startX, startW;
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    startX = e.clientX;
    startW = navCol.offsetWidth;
    panel.classList.add('resizing');
    function onMove(e) {
      var w = Math.min(Math.max(startW + e.clientX - startX, 160), 520);
      navCol.style.width = w + 'px';
    }
    function onUp() {
      panel.classList.remove('resizing');
      localStorage.setItem('fauna-auto-nav-w', navCol.offsetWidth);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
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
  _renderList();
  _renderDetail();
}

// ── List panel ───────────────────────────────────────────────────────────

function _renderList() {
  var list = document.getElementById('tasks-list');
  if (!list) return;

  var tasks = _tasksCache;
  if (typeof state !== 'undefined' && state.activeProjectId) {
    var proj = tasks.filter(function(t) { return t.projectId === state.activeProjectId; });
    if (proj.length) tasks = proj;
  }

  if (!tasks.length) {
    list.innerHTML = _suggestedTasksHtml();
    return;
  }

  var active = tasks.filter(function(t) { return t.status !== 'paused' && t.status !== 'completed' && t.status !== 'failed'; });
  var paused = tasks.filter(function(t) { return t.status === 'paused'; });
  var done   = tasks.filter(function(t) { return t.status === 'completed' || t.status === 'failed'; });

  // Sort active: running first, then scheduled, then pending
  var order = { running: 0, scheduled: 1, pending: 2 };
  active.sort(function(a, b) { return (order[a.status] || 9) - (order[b.status] || 9); });

  var html = '';
  if (active.length) {
    html += '<div class="auto-group-label">Active</div>';
    html += active.map(_automationRow).join('');
  }
  if (paused.length) {
    html += '<div class="auto-group-label">Paused</div>';
    html += paused.map(_automationRow).join('');
  }
  if (done.length) {
    html += '<div class="auto-group-label">Recent</div>';
    html += done.slice(0, 10).map(_automationRow).join('');
  }

  list.innerHTML = html;
}

function _automationRow(t) {
  var isSelected = _draft && _draft.id === t.id;
  var running = _tasksCache.find && t._running;

  // Status dot
  var dotClass = { running: 'pulse', scheduled: 'teal', pending: 'muted', paused: 'muted', completed: 'green', failed: 'red' }[t.status] || 'muted';

  // Human schedule label
  var schedHuman = _autoScheduleLabel(t);

  // Next run
  var nextRun = '';
  if (t.nextRunAt && t.status === 'scheduled') {
    var diff = new Date(t.nextRunAt).getTime() - Date.now();
    nextRun = diff > 0 ? '<span class="auto-row-next">in ' + _formatCountdown(diff) + '</span>' : '<span class="auto-row-next now">now</span>';
  }

  // Heartbeat badge
  var hbBadge = '';
  if (t.kind === 'heartbeat' && t.targetConvId && t.status === 'scheduled') {
    var eligible = _isConvEligible(t.targetConvId);
    hbBadge = '<span class="auto-hb-badge ' + (eligible ? 'eligible' : 'waiting') + '">' +
      (eligible ? 'thread idle' : 'waiting for idle thread') + '</span>';
  }

  // Kind badge
  var kindBadge = '<span class="auto-kind-badge ' + (t.kind || 'cron') + '">' + (t.kind || 'cron') + '</span>';

  return '<div class="auto-row' + (isSelected ? ' selected' : '') + '" data-task-id="' + t.id + '" onclick="openAutomationDetail(\'' + t.id + '\')">' +
    '<div class="auto-row-top">' +
      '<span class="auto-row-dot ' + dotClass + '"></span>' +
      '<span class="auto-row-name">' + escHtml(t.title) + '</span>' +
      kindBadge +
    '</div>' +
    '<div class="auto-row-sub">' +
      schedHuman + hbBadge + nextRun +
    '</div>' +
    (running ? '<div class="auto-row-progress"><div class="auto-row-progress-bar"></div></div>' : '') +
    '<div class="auto-row-btns" onclick="event.stopPropagation()">' +
      (t.status !== 'running' ? '<button class="auto-row-btn" onclick="taskRun(\'' + t.id + '\')" title="Run now"><i class="ti ti-player-play"></i></button>' : '') +
      (t.status === 'running' ? '<button class="auto-row-btn" onclick="taskStop(\'' + t.id + '\')" title="Stop"><i class="ti ti-player-stop"></i></button>' : '') +
      (t.status === 'scheduled' || t.status === 'running' ? '<button class="auto-row-btn" onclick="taskPause(\'' + t.id + '\')" title="Pause"><i class="ti ti-player-pause"></i></button>' : '') +
      (t.status === 'paused' ? '<button class="auto-row-btn" onclick="automationResume(\'' + t.id + '\')" title="Resume"><i class="ti ti-player-play"></i></button>' : '') +
      '<button class="auto-row-btn del" onclick="taskDelete(\'' + t.id + '\')" title="Delete"><i class="ti ti-trash"></i></button>' +
    '</div>' +
  '</div>';
}

function _autoScheduleLabel(t) {
  if (!t.schedule) return '<span class="auto-row-sched">manual</span>';
  var s = t.schedule;
  if (s.rrule) return '<span class="auto-row-sched">' + escHtml(_humanizeRruleFE(s.rrule)) + '</span>';
  if (s.type === 'once' && s.at) {
    var d = new Date(s.at);
    return '<span class="auto-row-sched">' + d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</span>';
  }
  if (s.type === 'recurring' && s.cron) return '<span class="auto-row-sched">' + escHtml(s.cron) + '</span>';
  if (t.kind === 'heartbeat') return '<span class="auto-row-sched">heartbeat</span>';
  if (t.kind === 'pipeline')  return '<span class="auto-row-sched">pipeline</span>';
  return '<span class="auto-row-sched">manual</span>';
}

function _humanizeRruleFE(rruleStr) {
  // Mirrors server humanizeRrule — simple client-side version
  if (typeof scheduleBuilder !== 'undefined') return scheduleBuilder.humanize(rruleStr);
  return rruleStr;
}

function _formatCountdown(ms) {
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60); m = m % 60;
  return h + 'h ' + (m ? m + 'm' : '');
}

function _suggestedTasksHtml() {
  var suggestions = [
    { title: 'Daily standup summary',  desc: 'Summarize recent activity and blockers', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',   kind: 'cron' },
    { title: 'Weekly code review',     desc: 'Review open PRs and flag any blockers',  rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0', kind: 'cron' },
    { title: 'Nightly test run',       desc: 'Run test suite and summarize failures',  rrule: 'FREQ=DAILY;BYHOUR=23;BYMINUTE=0',  kind: 'cron' },
    { title: 'Watch thread and continue', desc: 'Resume work when conversation is idle', rrule: '', kind: 'heartbeat' },
  ];

  // Assign stable IDs so we can retrieve seed data from a Map instead of
  // inlining JSON in onclick attributes (which causes SyntaxErrors with
  // any JSON that contains quotes, apostrophes, or special chars).
  var _seeds = window._autoSuggestionSeeds = window._autoSuggestionSeeds || {};
  var rows = suggestions.map(function(s, idx) {
    var seedId = 'auto-seed-' + idx;
    _seeds[seedId] = s;
    return '<div class="auto-suggest-row">' +
      '<div class="auto-suggest-info">' +
        '<div class="auto-suggest-name">' + escHtml(s.title) + '</div>' +
        '<div class="auto-suggest-desc">' + escHtml(s.desc) + '</div>' +
      '</div>' +
      '<div class="auto-suggest-sub">' +
        '<span class="auto-suggest-sched">' + (s.rrule ? _humanizeRruleFE(s.rrule) : s.kind) + '</span>' +
        '<button class="auto-suggest-btn" data-seed-id="' + seedId + '" onclick="event.stopPropagation();openNewAutomation(window._autoSuggestionSeeds[this.dataset.seedId])">Create</button>' +
      '</div>' +
    '</div>';
  }).join('');

  return '<div class="auto-empty">' +
    '<i class="ti ti-clock-play" style="font-size:28px;opacity:.25"></i>' +
    '<div class="auto-empty-title">No automations yet</div>' +
    '<div class="auto-empty-sub">Automations run prompts on a schedule, watch threads, or execute node pipelines.</div>' +
    '<div class="auto-suggestions">' + rows + '</div>' +
    '</div>';
}

// ── Detail panel ─────────────────────────────────────────────────────────

function openAutomationDetail(id) {
  var t = _tasksCache.find(function(x) { return x.id === id; });
  if (!t) return;
  _draft = _taskToDraft(t);
  _draftDirty = false;
  _draftAutoSaveEnabled = true;
  _setDraftStatus('');
  _selectedAgents = (_draft.agents || []).slice();
  _renderList();    // refresh selection highlight
  _renderDetail();
  // Init schedule picker after render
  setTimeout(function() {
    if (_draft && _draft.kind === 'cron') _initSchedulePicker();
  }, 0);
}

function openNewAutomation(seedJson) {
  _draft = _blankDraft();
  _draftDirty = false;
  _draftAutoSaveEnabled = false;
  _setDraftStatus('');
  _selectedAgents = [];
  if (seedJson) {
    try {
      var seed = typeof seedJson === 'string' ? JSON.parse(seedJson) : seedJson;
      if (seed.title) _draft.title = seed.title;
      if (seed.desc)  _draft.description = seed.desc;
      if (seed.rrule) { _draft.schedule.rrule = seed.rrule; _draft.schedule.type = 'recurring'; }
      if (seed.kind)  _draft.kind = seed.kind;
    } catch (_) {}
  }
  _renderList();
  _renderDetail();
  setTimeout(function() {
    var titleIn = document.getElementById('auto-detail-title');
    if (titleIn) titleIn.focus();
    if (_draft && _draft.kind === 'cron') _initSchedulePicker();
  }, 0);
}

function closeAutomationDetail() {
  if (_draftDirty && _draft && _draft.id) _autoSave();
  _draft = null;
  _draftAutoSaveEnabled = false;
  _renderList();
  _renderDetail();
}

function _initSchedulePicker() {
  if (typeof scheduleBuilder === 'undefined') return;
  var rrule = (_draft && _draft.schedule && _draft.schedule.rrule) || '';
  scheduleBuilder.render('auto-sched-picker', rrule, function(newRrule, human) {
    if (!_draft) return;
    _draft.schedule.rrule = newRrule;
    _draft.schedule.type  = newRrule ? 'recurring' : 'manual';
    _draftDirty = true;
    if (_draft.id && _draftAutoSaveEnabled) {
      clearTimeout(_draftSaveTimer);
      _draftSaveTimer = setTimeout(_autoSave, 600);
      _setDraftStatus('saving');
    }
  });
}

function _renderDetail() {
  var panel = document.getElementById('auto-detail-panel');
  if (!panel) return;

  if (!_draft) {
    panel.innerHTML = '<div class="auto-detail-empty">' +
      '<i class="ti ti-clock-plus" style="font-size:26px;opacity:.2"></i>' +
      '<div>Select an automation or create a new one</div>' +
    '</div>';
    return;
  }

  var isNew = !_draft.id;
  var running = _draft.id && _tasksCache.find(function(t) { return t.id === _draft.id && t._running; });

  // Conv list for heartbeat picker
  var convOptions = '';
  if (typeof state !== 'undefined' && state.conversations) {
    convOptions = state.conversations.slice(0, 50).map(function(c) {
      var sel = _draft.targetConvId === c.id ? ' selected' : '';
      return '<option value="' + c.id + '"' + sel + '>' + escHtml((c.title || c.id).slice(0, 60)) + '</option>';
    }).join('');
  }

  panel.innerHTML =
    '<div class="auto-detail-header">' +
      '<div class="auto-detail-title-wrap">' +
        '<input id="auto-detail-title" class="auto-detail-title-input" type="text" placeholder="Automation name" ' +
          'value="' + escHtml(_draft.title) + '" ' +
          'oninput="_draftChange(\'title\',this.value)">' +
      '</div>' +
      '<button class="auto-detail-close" onclick="closeAutomationDetail()" title="Close"><i class="ti ti-x"></i></button>' +
    '</div>' +
    '<div class="auto-detail-body">' +
      // Kind selector
      '<div class="auto-field-row">' +
        '<label class="auto-field-lbl">Kind</label>' +
        '<div class="auto-kind-tabs">' +
          _kindTab('cron',      'ti-clock',       'Cron') +
          _kindTab('heartbeat', 'ti-heart-rate-monitor', 'Heartbeat') +
          _kindTab('pipeline',  'ti-git-branch',  'Pipeline') +
        '</div>' +
      '</div>' +
      // Description
      '<div class="auto-field-row">' +
        '<label class="auto-field-lbl">Prompt</label>' +
        '<textarea id="auto-detail-desc" class="auto-detail-textarea" rows="4" placeholder="What should this automation do?" ' +
          'oninput="_draftChange(\'description\',this.value)">' + escHtml(_draft.description) + '</textarea>' +
      '</div>' +
      // Kind-specific rows (rendered separately via _renderDetailKindRows)
      '<div id="auto-kind-rows"></div>' +
      // Permissions
      '<div class="auto-field-row">' +
        '<label class="auto-field-lbl">Permissions</label>' +
        '<div class="auto-perms">' +
          _permToggle('shell',   'ti-terminal-2', 'Shell', _draft.permissions.shell !== false) +
          _permToggle('browser', 'ti-world-www',  'Browser', !!_draft.permissions.browser) +
          _permToggle('figma',   'ti-brand-figma','Figma', !!_draft.permissions.figma) +
        '</div>' +
      '</div>' +
      // Agent picker
      '<div class="auto-field-row">' +
        '<label class="auto-field-lbl">Agents</label>' +
        '<div class="task-agent-picker-wrap">' +
          '<div id="task-agent-selected"></div>' +
          '<input id="task-agent-search" class="task-agent-search" type="text" placeholder="Add agent…" ' +
            'onfocus="_showAgentPicker()" oninput="_filterAgentPicker(this.value)">' +
          '<div id="task-agent-dropdown" class="task-agent-dropdown" style="display:none"></div>' +
        '</div>' +
      '</div>' +
      // Context
      '<div class="auto-field-row">' +
        '<label class="auto-field-lbl">Context</label>' +
        '<textarea class="auto-detail-textarea" rows="2" placeholder="Extra context or variables…" ' +
          'oninput="_draftChange(\'context\',this.value)">' + escHtml(_draft.context) + '</textarea>' +
      '</div>' +
    '</div>' +
    // Footer
    '<div class="auto-detail-footer">' +
      '<span id="auto-detail-save-status" class="auto-detail-save-status"></span>' +
      '<div class="auto-detail-footer-btns">' +
        (isNew
          ? '<button class="auto-footer-btn primary" onclick="submitAutomation()"><i class="ti ti-plus"></i> Create</button>'
          : '<button class="auto-footer-btn primary" onclick="submitAutomation()"><i class="ti ti-check"></i> Save</button>') +
        (!isNew ? '<button class="auto-footer-btn danger" onclick="taskDelete(\'' + _draft.id + '\')"><i class="ti ti-trash"></i> Delete</button>' : '') +
      '</div>' +
    '</div>';

  // Re-init agent picker display
  _selectedAgents = (_draft.agents || []).slice();
  _renderAgentSelections();

  // Render kind-specific rows
  _renderDetailKindRows();
}

function _kindTab(kind, icon, label) {
  var active = (_draft && _draft.kind === kind) ? ' active' : '';
  return '<button class="auto-kind-tab' + active + '" onclick="_setDraftKind(\'' + kind + '\')">' +
    '<i class="ti ' + icon + '"></i> ' + label + '</button>';
}

function _permToggle(key, icon, label, checked) {
  return '<label class="auto-perm-toggle">' +
    '<input type="checkbox"' + (checked ? ' checked' : '') + ' onchange="_draftChange(\'permissions.' + key + '\',this.checked)">' +
    '<i class="ti ' + icon + '"></i>' +
    '<span>' + label + '</span>' +
  '</label>';
}

function _setDraftKind(kind) {
  if (!_draft) return;
  _draft.kind = kind;
  _draftDirty = true;
  _renderDetail();
  if (kind === 'cron') setTimeout(_initSchedulePicker, 0);
}

function _renderDetailKindRows() {
  var el = document.getElementById('auto-kind-rows');
  if (!el || !_draft) return;

  var html = '';

  if (_draft.kind === 'cron') {
    // Schedule picker
    html += '<div class="auto-field-row auto-field-row-col">' +
      '<label class="auto-field-lbl">Schedule</label>' +
      '<div id="auto-sched-picker" class="auto-sched-picker"></div>' +
    '</div>';
  }

  if (_draft.kind === 'heartbeat') {
    // Conversation selector
    html += '<div class="auto-field-row">' +
      '<label class="auto-field-lbl">Watch thread</label>' +
      '<select class="auto-select" onchange="_draftChange(\'targetConvId\',this.value || null)">' +
        '<option value="">Select conversation…</option>';
    if (typeof state !== 'undefined' && state.conversations) {
      var convs = state.conversations.slice(0, 60);
      convs.forEach(function(c) {
        var sel = _draft.targetConvId === c.id ? ' selected' : '';
        html += '<option value="' + c.id + '"' + sel + '>' + escHtml((c.title || c.id).slice(0, 60)) + '</option>';
      });
    }
    html += '</select></div>';
    if (_draft.targetConvId) {
      var eligible = _isConvEligible(_draft.targetConvId);
      html += '<div class="auto-hb-status ' + (eligible ? 'eligible' : 'waiting') + '">' +
        '<i class="ti ' + (eligible ? 'ti-circle-check' : 'ti-clock') + '"></i> ' +
        (eligible ? 'Thread is idle — will fire immediately when saved as ACTIVE'
                  : 'Thread not currently eligible (streaming or last turn is user)') +
      '</div>';
    }
  }

  if (_draft.kind === 'pipeline') {
    var nodeCount = _draft.pipeline ? (_draft.pipeline.nodes || []).length : 0;
    html += '<div class="auto-field-row">' +
      '<label class="auto-field-lbl">Pipeline</label>' +
      '<div class="auto-pipeline-row">' +
        '<span class="auto-pipeline-info">' + (nodeCount ? nodeCount + ' node' + (nodeCount !== 1 ? 's' : '') : 'No nodes yet') + '</span>' +
        '<button class="auto-footer-btn" onclick="openPipelineBuilder(' + (_draft.id ? '\'' + _draft.id + '\'' : 'null') + ')">' +
          '<i class="ti ti-git-branch"></i> Open Builder' +
        '</button>' +
      '</div>' +
    '</div>';
  }

  el.innerHTML = html;

  if (_draft.kind === 'cron') _initSchedulePicker();
}

// ── Create / Update ──────────────────────────────────────────────────────

async function submitAutomation() {
  if (!_draft) return;
  var title = _draft.title.trim();
  if (!title) { showToast('Name is required'); return; }

  var payload = _draftToPayload();
  // Sync agents from picker
  payload.agents = _getSelectedAgents();

  try {
    if (_draft.id) {
      await fetch('/api/tasks/' + _draft.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      var r = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var created = await r.json();
      _draft.id = created.id;
      _draftAutoSaveEnabled = true;
    }
    _draftDirty = false;
    _setDraftStatus('saved');
    showToast(_draft.id ? 'Automation saved' : 'Automation created');
    fetchTasks();
  } catch (e) {
    showToast('Failed to save: ' + e.message);
    _setDraftStatus('error');
  }
}

// ── Resume ───────────────────────────────────────────────────────────────

async function automationResume(id) {
  try {
    await fetch('/api/tasks/' + id + '/resume', { method: 'POST' });
    fetchTasks();
  } catch (e) { showToast('Failed to resume: ' + e.message); }
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
          if (evt.event === 'failed' && evt.taskId) _expandedLogs.add(evt.taskId);
          fetchTasks();
        }
        if (evt.event === 'step') {
          var row = document.querySelector('[data-task-id="' + evt.taskId + '"] .auto-row-progress-bar');
          if (row) {
            row.style.width = Math.min(100, (evt.step / 20) * 100) + '%';
          }
        }
      } catch (_) {}
    };
    _taskSSE.onerror = function() {
      _disconnectTaskSSE();
      setTimeout(function() { if (tasksPanelOpen) _connectTaskSSE(); }, 5000);
    };
  } catch (_) {}
}

function _disconnectTaskSSE() {
  if (_taskSSE) { _taskSSE.close(); _taskSSE = null; }
}

// ── Quick task from chat ──────────────────────────────────────────────────

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

// ── Task Actions (retained for buttons in list rows) ─────────────────────

async function taskRun(id) {
  try {
    await fetch('/api/tasks/' + id + '/run', { method: 'POST' });
    fetchTasks();
  } catch (e) { showToast('Failed to run: ' + e.message); }
}

async function taskPause(id) {
  try {
    await fetch('/api/tasks/' + id + '/pause', { method: 'POST' });
    fetchTasks();
  } catch (e) { showToast('Failed to pause: ' + e.message); }
}

async function taskStop(id) {
  try {
    await fetch('/api/tasks/' + id + '/stop', { method: 'POST' });
    fetchTasks();
  } catch (e) { showToast('Failed to stop: ' + e.message); }
}

async function taskDelete(id) {
  if (!confirm('Delete this automation?')) return;
  if (_draft && _draft.id === id) { _draft = null; _renderDetail(); }
  try {
    await fetch('/api/tasks/' + id, { method: 'DELETE' });
    fetchTasks();
  } catch (e) { showToast('Failed to delete: ' + e.message); }
}

// Legacy stubs for any inline HTML that still calls these
function taskEdit(id)          { openAutomationDetail(id); }
function toggleTaskCreateForm() { openNewAutomation(null); }
function submitTask()           { submitAutomation(); }

function _timeAgo(d) {
  var s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// ── Permission helpers ───────────────────────────────────────────────────

function _getBrowserPermission() {
  if (!_draft || !_draft.permissions.browser) return false;
  var picked = [];
  document.querySelectorAll('#task-tab-picker .task-tab-item input:checked').forEach(function(cb) {
    picked.push(cb.dataset.url);
  });
  if (picked.length) return { tabs: picked };
  return true;
}

function _onBrowserPermChange() {
  var checked = _draft && _draft.permissions.browser;
  var row = document.getElementById('task-browser-tabs-row');
  if (row) row.style.display = checked ? 'flex' : 'none';
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

// Legacy list-row helpers (still referenced by old inline HTML / log area)
function _taskStatusIcon(status) {
  switch (status) {
    case 'running':   return '<i class="ti ti-loader-2 spin" style="color:var(--accent)"></i>';
    case 'scheduled': return '<i class="ti ti-clock" style="color:var(--warn)"></i>';
    case 'pending':   return '<i class="ti ti-circle-dashed" style="color:var(--fau-text-dim)"></i>';
    case 'completed': return '<i class="ti ti-circle-check" style="color:var(--success)"></i>';
    case 'failed':    return '<i class="ti ti-circle-x" style="color:var(--error)"></i>';
    case 'paused':    return '<i class="ti ti-player-pause" style="color:var(--fau-text-muted)"></i>';
    default:          return '<i class="ti ti-circle-dashed"></i>';
  }
}

function _scheduleLabel(t) {
  if (!t.schedule) return '';
  if (t.schedule.rrule) return '<span class="task-sched">' + escHtml(_humanizeRruleFE(t.schedule.rrule)) + '</span>';
  if (t.schedule.type === 'manual') return '<span class="task-sched">manual</span>';
  if (t.schedule.type === 'once' && t.schedule.at) {
    var d = new Date(t.schedule.at);
    return '<span class="task-sched">' + d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</span>';
  }
  if (t.schedule.type === 'recurring' && t.schedule.cron) return '<span class="task-sched">⟳ ' + escHtml(t.schedule.cron) + '</span>';
  return '';
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
    case 'created':     return '<i class="ti ti-circle-plus" style="color:var(--fau-text-dim)"></i>';
    case 'started':     return '<i class="ti ti-player-play" style="color:var(--accent)"></i>';
    case 'step':        return '<i class="ti ti-arrow-right" style="color:var(--fau-text-muted)"></i>';
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
    var faviconImg = '';
    try {
      var u = new URL(tab.url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        faviconImg = '<img src="https://www.google.com/s2/favicons?sz=16&domain=' + encodeURIComponent(u.hostname) + '" width="14" height="14" onerror="this.style.display=\'none\'">';
      }
    } catch(_) {}
    var checked = selectedUrls.has(tab.url) ? ' checked' : '';
    var activeTag = tab.active ? '<span class="task-tab-active">active</span>' : '';
    return '<label class="task-tab-item" title="' + escHtml(tab.url) + '">' +
      '<input type="checkbox" data-url="' + escHtml(tab.url) + '" data-tab-id="' + tab.id + '"' + checked + '>' +
      faviconImg +
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

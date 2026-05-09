// Workflow Workbench
// Compact UI for GitHub/review workflow, local tasks, MCP registry, plugins,
// sessions, and prompt debugging APIs.

var workflowWorkbench = (function() {
  var _tab = 'overview';
  var _data = { features: {}, tasks: [], mcp: [], plugins: [], sessions: [], github: null, debug: null };
  var _loading = false;

  function _root() { return document.getElementById('workflow-workbench-root'); }
  function _cwd() {
    if (typeof _convCwd === 'undefined' || typeof state === 'undefined' || !state.currentId) return '';
    return _convCwd[state.currentId] || '';
  }
  function _esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function(ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch];
    });
  }
  async function _api(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    var res = await fetch(path, opts);
    var json = await res.json().catch(function() { return { ok: false, error: 'Invalid JSON response' }; });
    if (!res.ok || json.ok === false) throw new Error(json.error || ('HTTP ' + res.status));
    return json;
  }
  function _toast(message) {
    if (typeof showToast === 'function') showToast(message);
  }

  async function load() {
    if (_loading) return;
    _loading = true;
    render();
    try {
      var cwd = _cwd();
      var results = await Promise.allSettled([
        _api('GET', '/api/features'),
        _api('GET', '/api/workflow/tasks' + (cwd ? '?repo=' + encodeURIComponent(cwd) : '')),
        _api('GET', '/api/mcp/servers'),
        _api('GET', '/api/plugins/search'),
        _api('GET', '/api/sessions' + (cwd ? '?repo=' + encodeURIComponent(cwd) : '')),
        _api('GET', '/api/github/repo' + (cwd ? '?cwd=' + encodeURIComponent(cwd) : '')),
      ]);
      if (results[0].status === 'fulfilled') _data.features = results[0].value.features || {};
      if (results[1].status === 'fulfilled') _data.tasks = results[1].value.tasks || [];
      if (results[2].status === 'fulfilled') _data.mcp = results[2].value.servers || [];
      if (results[3].status === 'fulfilled') _data.plugins = results[3].value.results || [];
      if (results[4].status === 'fulfilled') _data.sessions = results[4].value.sessions || [];
      _data.github = results[5].status === 'fulfilled' ? results[5].value.repo : null;
    } catch (e) {
      _toast('Workflow load failed: ' + e.message);
    } finally {
      _loading = false;
      render();
    }
  }

  function open(tab) {
    if (tab) _tab = tab;
    if (typeof openSettingsPage === 'function') openSettingsPage('workflow');
    load();
  }

  function switchTab(tab) {
    _tab = tab;
    render();
  }

  function render() {
    var el = _root();
    if (!el) return;
    var tabs = [
      ['overview', 'ti-dashboard', 'Overview'],
      ['tasks', 'ti-list-check', 'Tasks'],
      ['github', 'ti-brand-github', 'GitHub'],
      ['mcp', 'ti-plug', 'MCP'],
      ['plugins', 'ti-puzzle', 'Plugins'],
      ['sessions', 'ti-git-branch', 'Sessions'],
      ['debug', 'ti-bug', 'Debug'],
    ];
    el.innerHTML =
      '<div class="workflow-toolbar">' +
        '<div class="workflow-tabs">' + tabs.map(function(t) {
          return '<button class="workflow-tab' + (_tab === t[0] ? ' active' : '') + '" onclick="workflowWorkbench.switchTab(\'' + t[0] + '\')"><i class="ti ' + t[1] + '"></i> ' + t[2] + '</button>';
        }).join('') + '</div>' +
        '<button class="settings-row-btn" onclick="workflowWorkbench.load()"><i class="ti ti-refresh"></i> Refresh</button>' +
      '</div>' +
      (_loading ? '<div class="workflow-loading">Loading...</div>' : '') +
      '<div class="workflow-content">' + _renderActive() + '</div>';
  }

  function _renderActive() {
    if (_tab === 'tasks') return _renderTasks();
    if (_tab === 'github') return _renderGithub();
    if (_tab === 'mcp') return _renderMcp();
    if (_tab === 'plugins') return _renderPlugins();
    if (_tab === 'sessions') return _renderSessions();
    if (_tab === 'debug') return _renderDebug();
    return _renderOverview();
  }

  function _renderOverview() {
    var enabled = Object.keys(_data.features).filter(function(k) { return _data.features[k].enabled !== false; }).length;
    return '<div class="workflow-grid">' +
      _metric('Features', enabled + ' enabled', 'ti-toggle-right') +
      _metric('Tasks', _data.tasks.length + ' tracked', 'ti-list-check') +
      _metric('MCP', _data.mcp.length + ' servers', 'ti-plug') +
      _metric('Plugins', _data.plugins.length + ' installed', 'ti-puzzle') +
      _metric('Sessions', _data.sessions.length + ' saved', 'ti-git-branch') +
      _metric('Repository', _data.github ? _data.github.owner + '/' + _data.github.repo : 'not detected', 'ti-brand-github') +
    '</div>' +
    '<div class="settings-section"><div class="settings-section-title">Feature Flags</div>' +
      Object.keys(_data.features).map(function(name) {
        var feature = _data.features[name];
        return '<div class="workflow-row"><span><strong>' + _esc(name) + '</strong><small>' + _esc(feature.stage || '') + '</small></span>' +
          '<button class="settings-row-btn" onclick="workflowWorkbench.toggleFeature(\'' + _esc(name) + '\',' + (feature.enabled === false ? 'true' : 'false') + ')">' + (feature.enabled === false ? 'Enable' : 'Disable') + '</button></div>';
      }).join('') + '</div>';
  }

  function _metric(label, value, icon) {
    return '<div class="workflow-metric"><i class="ti ' + icon + '"></i><span>' + _esc(label) + '</span><strong>' + _esc(value) + '</strong></div>';
  }

  function _renderTasks() {
    return '<div class="settings-section"><div class="settings-section-title">Create Task</div>' +
      '<textarea id="wf-task-prompt" class="settings-input workflow-textarea" placeholder="Describe the task to queue"></textarea>' +
      '<div class="settings-input-row"><input id="wf-task-repo" class="settings-input" placeholder="Repository path" value="' + _esc(_cwd()) + '">' +
      '<button class="settings-row-btn" onclick="workflowWorkbench.createTask()"><i class="ti ti-plus"></i> Queue</button></div></div>' +
      '<div class="settings-section"><div class="settings-section-title">Tasks</div>' + _list(_data.tasks, function(task) {
        return '<div class="workflow-row"><span><strong>' + _esc(task.prompt || task.id) + '</strong><small>' + _esc(task.status || '') + ' · ' + _esc(task.branch || task.repo || '') + '</small></span>' +
          '<div class="workflow-row-actions"><button class="settings-row-btn" onclick="workflowWorkbench.retryTask(\'' + task.id + '\')">Retry</button><button class="settings-row-btn danger" onclick="workflowWorkbench.rejectTask(\'' + task.id + '\')">Reject</button></div></div>';
      }) + '</div>';
  }

  function _renderGithub() {
    return '<div class="settings-section"><div class="settings-section-title">Repository</div>' +
      (_data.github ? '<div class="workflow-row"><span><strong>' + _esc(_data.github.owner + '/' + _data.github.repo) + '</strong><small>' + _esc(_data.github.branch || '') + '</small></span><button class="settings-row-btn" onclick="workflowWorkbench.openRepo()"><i class="ti ti-external-link"></i> Open</button></div>' : '<div class="workflow-empty">No GitHub remote detected for the active chat path.</div>') +
      '</div><div class="settings-section"><div class="settings-section-title">PR Actions</div>' +
      '<div class="settings-input-row"><input id="wf-pr-number" class="settings-input" placeholder="PR number"><button class="settings-row-btn" onclick="workflowWorkbench.reviewPr()"><i class="ti ti-shield-check"></i> Review</button><button class="settings-row-btn" onclick="workflowWorkbench.checkoutPr()"><i class="ti ti-git-pull-request"></i> Checkout</button></div>' +
      '</div>';
  }

  function _renderMcp() {
    return '<div class="settings-section"><div class="settings-section-title">Add HTTP MCP Server</div>' +
      '<div class="settings-input-row"><input id="wf-mcp-name" class="settings-input" placeholder="Name"><input id="wf-mcp-url" class="settings-input" placeholder="https://server/mcp"><button class="settings-row-btn" onclick="workflowWorkbench.addMcp()"><i class="ti ti-plus"></i> Add</button></div></div>' +
      '<div class="settings-section"><div class="settings-section-title">Registry</div>' + _list(_data.mcp, function(server) {
        return '<div class="workflow-row"><span><strong>' + _esc(server.name) + '</strong><small>' + _esc(server.type) + ' · ' + _esc(server.url || server.command || '') + '</small></span><span class="workflow-pill">' + (server.running ? 'running' : 'stopped') + '</span></div>';
      }) + '</div>';
  }

  function _renderPlugins() {
    return '<div class="settings-section"><div class="settings-section-title">Install Manifest</div>' +
      '<textarea id="wf-plugin-json" class="settings-input workflow-textarea" placeholder="{ &quot;name&quot;: &quot;sample&quot;, &quot;type&quot;: &quot;prompt-pack&quot;, &quot;version&quot;: &quot;1.0.0&quot; }"></textarea>' +
      '<button class="settings-row-btn" onclick="workflowWorkbench.installPlugin()"><i class="ti ti-download"></i> Install disabled</button></div>' +
      '<div class="settings-section"><div class="settings-section-title">Installed</div>' + _list(_data.plugins, function(plugin) {
        return '<div class="workflow-row"><span><strong>' + _esc(plugin.name) + '</strong><small>' + _esc(plugin.type) + ' · ' + _esc(plugin.version) + '</small></span><button class="settings-row-btn" onclick="workflowWorkbench.togglePlugin(\'' + plugin.id + '\',' + (plugin.enabled ? 'false' : 'true') + ')">' + (plugin.enabled ? 'Disable' : 'Enable') + '</button></div>';
      }) + '</div>';
  }

  function _renderSessions() {
    return '<div class="settings-section"><div class="settings-section-title">Create Session Metadata</div>' +
      '<div class="settings-input-row"><input id="wf-session-title" class="settings-input" placeholder="Session title"><button class="settings-row-btn" onclick="workflowWorkbench.createSession()"><i class="ti ti-plus"></i> Create</button></div></div>' +
      '<div class="settings-section"><div class="settings-section-title">Sessions</div>' + _list(_data.sessions, function(session) {
        return '<div class="workflow-row"><span><strong>' + _esc(session.title || session.id) + '</strong><small>' + _esc(session.branch || session.repo || session.cwd || '') + '</small></span><div class="workflow-row-actions"><button class="settings-row-btn" onclick="workflowWorkbench.forkSession(\'' + session.id + '\')">Fork</button><button class="settings-row-btn" onclick="workflowWorkbench.resumeSession(\'' + session.id + '\')">Resume</button></div></div>';
      }) + '</div>';
  }

  function _renderDebug() {
    var blocks = _data.debug && _data.debug.blocks ? _data.debug.blocks : [];
    return '<div class="settings-section"><div class="settings-section-title">Prompt Inspector</div>' +
      '<textarea id="wf-debug-prompt" class="settings-input workflow-textarea" placeholder="Prompt to inspect"></textarea>' +
      '<button class="settings-row-btn" onclick="workflowWorkbench.inspectPrompt()"><i class="ti ti-search"></i> Inspect</button></div>' +
      '<div class="settings-section"><div class="settings-section-title">Blocks</div>' + (blocks.length ? blocks.map(function(block) {
        return '<details class="workflow-detail"><summary>' + _esc(block.name) + '</summary><pre>' + _esc(block.content || '') + '</pre></details>';
      }).join('') : '<div class="workflow-empty">Run an inspection to see prompt blocks.</div>') + '</div>';
  }

  function _list(items, renderer) {
    if (!items || !items.length) return '<div class="workflow-empty">Nothing here yet.</div>';
    return items.map(renderer).join('');
  }

  async function toggleFeature(name, enabled) {
    try { await _api('POST', '/api/features/' + encodeURIComponent(name) + '/' + (enabled ? 'enable' : 'disable')); _toast('Feature updated'); load(); }
    catch (e) { _toast(e.message); }
  }
  async function createTask() {
    try { await _api('POST', '/api/workflow/tasks', { prompt: document.getElementById('wf-task-prompt').value, repo: document.getElementById('wf-task-repo').value }); _toast('Task queued'); load(); }
    catch (e) { _toast(e.message); }
  }
  async function retryTask(id) { try { await _api('POST', '/api/workflow/tasks/' + id + '/retry'); load(); } catch (e) { _toast(e.message); } }
  async function rejectTask(id) { try { await _api('POST', '/api/workflow/tasks/' + id + '/reject', { reason: 'Rejected from Workflow UI' }); load(); } catch (e) { _toast(e.message); } }
  function openRepo() { if (_data.github && _data.github.htmlUrl) window.open(_data.github.htmlUrl, '_blank'); }
  function reviewPr() {
    var n = document.getElementById('wf-pr-number').value.trim();
    if (n && typeof runReviewCommand === 'function') runReviewCommand({ kind: 'pr', number: parseInt(n, 10), cwd: _cwd() });
  }
  async function checkoutPr() {
    try { await _api('POST', '/api/git/checkout-pr', { cwd: _cwd(), number: parseInt(document.getElementById('wf-pr-number').value, 10) }); _toast('PR checked out'); }
    catch (e) { _toast(e.message); }
  }
  async function addMcp() {
    try { await _api('POST', '/api/mcp/servers', { name: document.getElementById('wf-mcp-name').value, type: 'http', url: document.getElementById('wf-mcp-url').value }); _toast('MCP server added'); load(); }
    catch (e) { _toast(e.message); }
  }
  async function installPlugin() {
    try { await _api('POST', '/api/plugins/install', { manifest: JSON.parse(document.getElementById('wf-plugin-json').value), enabled: false }); _toast('Plugin installed disabled'); load(); }
    catch (e) { _toast(e.message); }
  }
  async function togglePlugin(id, enabled) { try { await _api('POST', '/api/plugins/' + id + '/' + (enabled ? 'enable' : 'disable')); load(); } catch (e) { _toast(e.message); } }
  async function createSession() { try { await _api('POST', '/api/sessions', { title: document.getElementById('wf-session-title').value || 'Workflow session', cwd: _cwd() }); load(); } catch (e) { _toast(e.message); } }
  async function forkSession(id) { try { await _api('POST', '/api/sessions/' + id + '/fork', { title: 'Forked session' }); load(); } catch (e) { _toast(e.message); } }
  async function resumeSession(id) { try { await _api('POST', '/api/sessions/' + id + '/resume', { prompt: '' }); _toast('Session marked resumed'); load(); } catch (e) { _toast(e.message); } }
  async function inspectPrompt() {
    try { _data.debug = await _api('POST', '/api/debug/prompt-input', { cwd: _cwd(), prompt: document.getElementById('wf-debug-prompt').value }); render(); }
    catch (e) { _toast(e.message); }
  }

  return {
    load: load,
    open: open,
    switchTab: switchTab,
    toggleFeature: toggleFeature,
    createTask: createTask,
    retryTask: retryTask,
    rejectTask: rejectTask,
    openRepo: openRepo,
    reviewPr: reviewPr,
    checkoutPr: checkoutPr,
    addMcp: addMcp,
    installPlugin: installPlugin,
    togglePlugin: togglePlugin,
    createSession: createSession,
    forkSession: forkSession,
    resumeSession: resumeSession,
    inspectPrompt: inspectPrompt,
  };
})();

function openWorkflowWorkbench(tab) {
  workflowWorkbench.open(tab);
}

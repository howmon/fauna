// Native project Test Explorer: discovery, focused execution, live status,
// output, and source-linked failures.
var _testsState = {
  projectId: null,
  discovery: null,
  run: null,
  output: '',
  tab: 'problems',
  expanded: Object.create(null),
  events: null,
};

function _testsEsc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
    return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch];
  });
}

function _testsJs(value) {
  return _testsEsc(JSON.stringify(String(value == null ? '' : value)));
}

function _testsProject() {
  return (state.projects || []).find(function(project) { return project.id === _testsState.projectId; }) || null;
}

function openTestsPage() {
  var body = typeof _openAppPage === 'function' ? _openAppPage('tests', 'Tests') : null;
  if (!body) return;
  var available = (state.projects || []).filter(function(project) { return !!project.rootPath; });
  if (!_testsState.projectId || !available.some(function(project) { return project.id === _testsState.projectId; })) {
    _testsState.projectId = state.activeProjectId && available.some(function(project) { return project.id === state.activeProjectId; })
      ? state.activeProjectId : (available[0] && available[0].id);
  }
  body.innerHTML = '<div class="tests-shell" id="tests-shell"></div>';
  _renderTestsPage();
  _connectTestEvents();
  if (_testsState.projectId) refreshTestsPage();
}

function _renderTestsPage() {
  var shell = document.getElementById('tests-shell');
  if (!shell) return;
  var projects = (state.projects || []).filter(function(project) { return !!project.rootPath; });
  var options = projects.map(function(project) {
    return '<option value="' + _testsEsc(project.id) + '"' + (project.id === _testsState.projectId ? ' selected' : '') + '>' + _testsEsc(project.name) + '</option>';
  }).join('');
  var run = _testsState.run;
  var running = run && run.status === 'running';
  shell.innerHTML =
    '<header class="tests-toolbar">' +
      '<div class="tests-heading"><i class="ti ti-flask"></i><div><strong>Test Explorer</strong><span>' + _testsEsc((_testsState.discovery && _testsState.discovery.framework) || 'workspace') + '</span></div></div>' +
      '<select class="tests-project-select" aria-label="Test project" onchange="selectTestsProject(this.value)">' + options + '</select>' +
      '<div class="tests-toolbar-actions">' +
        '<button class="tests-icon-btn" onclick="refreshTestsPage()" title="Refresh tests" aria-label="Refresh tests"><i class="ti ti-refresh"></i></button>' +
        (running
          ? '<button class="tests-icon-btn tests-stop" onclick="cancelTestRun()" title="Stop test run" aria-label="Stop test run"><i class="ti ti-square"></i></button>'
          : '<button class="tests-command-btn" onclick="runTests()"><i class="ti ti-player-play"></i> Run all</button>') +
      '</div>' +
    '</header>' +
    '<div class="tests-summary">' + _testsSummaryMarkup() + '</div>' +
    '<div class="tests-workspace">' +
      '<section class="tests-tree-pane" aria-label="Tests">' + _testsTreeMarkup() + '</section>' +
      '<section class="tests-detail-pane">' +
        '<div class="tests-tabs" role="tablist">' +
          '<button class="tests-tab' + (_testsState.tab === 'problems' ? ' active' : '') + '" onclick="switchTestsTab(\'problems\')">Problems' + _testsProblemBadge() + '</button>' +
          '<button class="tests-tab' + (_testsState.tab === 'output' ? ' active' : '') + '" onclick="switchTestsTab(\'output\')">Output</button>' +
          (run && run.debug ? '<button class="tests-tab' + (_testsState.tab === 'debug' ? ' active' : '') + '" onclick="switchTestsTab(\'debug\')">Debug</button>' : '') +
          (run && run.status === 'failed' ? '<button class="tests-ask-btn" onclick="troubleshootTestRun()"><i class="ti ti-sparkles"></i> Troubleshoot</button>' : '') +
        '</div>' +
        '<div class="tests-detail-body">' + (_testsState.tab === 'output' ? _testsOutputMarkup() : _testsState.tab === 'debug' ? _testsDebugMarkup() : _testsProblemsMarkup()) + '</div>' +
      '</section>' +
    '</div>';
}

function _testsSummaryMarkup() {
  var discovery = _testsState.discovery;
  var run = _testsState.run;
  var counts = run && run.result && run.result.counts;
  var status = run ? run.status : 'idle';
  return '<span class="tests-run-state state-' + _testsEsc(status) + '"><i class="ti ' + (status === 'running' ? 'ti-loader-2 spin' : status === 'passed' ? 'ti-circle-check' : status === 'failed' ? 'ti-circle-x' : 'ti-circle-dashed') + '"></i>' + _testsEsc(status) + '</span>' +
    '<span>' + Number(discovery && discovery.total || 0) + ' tests</span>' +
    (counts ? '<span class="tests-pass">' + counts.passed + ' passed</span><span class="tests-fail">' + counts.failed + ' failed</span><span>' + counts.skipped + ' skipped</span>' : '') +
    (run && run.startedAt ? '<span class="tests-elapsed">' + _testsElapsed(run) + '</span>' : '');
}

function _testsElapsed(run) {
  var end = run.finishedAt || Date.now();
  return ((end - run.startedAt) / 1000).toFixed(1) + 's';
}

function _resultForTest(test) {
  var results = _testsState.run && _testsState.run.result && _testsState.run.result.tests || [];
  var wanted = test.fullName.replace(/ > /g, ' ');
  return results.find(function(item) { return item.fullName === test.fullName || item.fullName === wanted || item.fullName.endsWith(wanted); }) || null;
}

function _testsTreeMarkup() {
  var discovery = _testsState.discovery;
  if (!discovery) return '<div class="tests-empty"><i class="ti ti-loader-2 spin"></i><span>Discovering tests…</span></div>';
  if (!discovery.files.length) return '<div class="tests-empty"><i class="ti ti-flask-off"></i><strong>No tests found</strong></div>';
  return discovery.files.map(function(file) {
    var expanded = _testsState.expanded[file.path] === true;
    var rows = expanded ? file.tests.map(function(test) {
      var result = _resultForTest(test);
      var status = result ? result.status : (_testsState.run && _testsState.run.status === 'running' ? 'queued' : 'idle');
      return '<div class="tests-tree-row test-row status-' + status + '">' +
        '<span class="tests-indent"></span><i class="ti ' + _testsStatusIcon(status) + ' tests-status-icon"></i>' +
        '<button class="tests-row-name" onclick="openTestSource(' + _testsJs(test.file) + ',' + test.line + ',' + test.column + ')" title="' + _testsEsc(test.fullName) + '">' + _testsEsc(test.name) + '</button>' +
        (result && result.duration ? '<span class="tests-duration">' + result.duration + 'ms</span>' : '') +
        '<span class="tests-row-actions">' +
          '<button onclick="runTests(' + _testsJs(test.file) + ',' + _testsJs(test.fullName) + ')" title="Run test" aria-label="Run test"><i class="ti ti-player-play"></i></button>' +
          '<button onclick="runTests(' + _testsJs(test.file) + ',' + _testsJs(test.fullName) + ',true,' + test.line + ',' + test.column + ')" title="Debug test" aria-label="Debug test"><i class="ti ti-bug"></i></button>' +
        '</span>' +
      '</div>';
    }).join('') : '';
    return '<div class="tests-file-group">' +
      '<div class="tests-tree-row file-row">' +
        '<button class="tests-chevron" onclick="toggleTestsFile(' + _testsJs(file.path) + ')" title="Toggle tests"><i class="ti ti-chevron-' + (expanded ? 'down' : 'right') + '"></i></button>' +
        '<i class="ti ti-file-type-js tests-file-icon"></i><button class="tests-row-name" onclick="openTestSource(' + _testsJs(file.path) + ',1,1)">' + _testsEsc(file.path) + '</button>' +
        '<span class="tests-file-count">' + file.tests.length + '</span>' +
        '<span class="tests-row-actions"><button onclick="runTests(' + _testsJs(file.path) + ')" title="Run file" aria-label="Run file"><i class="ti ti-player-play"></i></button><button onclick="runTests(' + _testsJs(file.path) + ',null,true)" title="Debug file" aria-label="Debug file"><i class="ti ti-bug"></i></button></span>' +
      '</div>' + rows +
    '</div>';
  }).join('');
}

function _testsStatusIcon(status) {
  if (status === 'passed') return 'ti-circle-check';
  if (status === 'failed') return 'ti-circle-x';
  if (status === 'skipped') return 'ti-circle-minus';
  if (status === 'queued') return 'ti-clock';
  return 'ti-circle-dashed';
}

function _testsProblemBadge() {
  var count = _testsState.run && _testsState.run.result && _testsState.run.result.problems && _testsState.run.result.problems.length || 0;
  return count ? '<span>' + count + '</span>' : '';
}

function _testsProblemsMarkup() {
  var problems = _testsState.run && _testsState.run.result && _testsState.run.result.problems || [];
  if (!problems.length) return '<div class="tests-empty"><i class="ti ti-circle-check"></i><strong>No problems</strong></div>';
  return problems.map(function(problem) {
    return '<button class="tests-problem" onclick="openTestSource(' + _testsJs(problem.file) + ',' + problem.line + ',' + problem.column + ')">' +
      '<i class="ti ti-circle-x"></i><span class="tests-problem-copy"><strong>' + _testsEsc(problem.message) + '</strong><small>' + _testsEsc(problem.file) + ':' + problem.line + ':' + problem.column + '</small></span>' +
    '</button>';
  }).join('');
}

function _testsOutputMarkup() {
  var output = _testsState.output || (_testsState.run && _testsState.run.output) || '';
  return output ? '<pre class="tests-output">' + _testsEsc(output) + '</pre>' : '<div class="tests-empty"><i class="ti ti-terminal-2"></i><strong>No test output</strong></div>';
}

function _testsDebugMarkup() {
  var run = _testsState.run;
  var debug = run && run.debugger;
  if (!debug) return '<div class="tests-empty"><i class="ti ti-bug"></i><strong>Debugger unavailable</strong></div>';
  if (debug.status === 'external') return '<div class="tests-empty"><i class="ti ti-brand-playwright"></i><strong>Playwright Inspector opened</strong></div>';
  var controls = '<div class="tests-debug-toolbar"><span class="tests-debug-state state-' + _testsEsc(debug.status) + '"><i class="ti ' + (debug.paused ? 'ti-player-pause' : debug.status === 'error' ? 'ti-alert-triangle' : 'ti-plug-connected') + '"></i>' + _testsEsc(debug.status) + '</span>' +
    (debug.paused
      ? '<button onclick="testDebugAction(\'resume\')" title="Continue"><i class="ti ti-player-play"></i></button><button onclick="testDebugAction(\'stepOver\')" title="Step over"><i class="ti ti-arrow-forward-up"></i></button><button onclick="testDebugAction(\'stepInto\')" title="Step into"><i class="ti ti-arrow-down"></i></button><button onclick="testDebugAction(\'stepOut\')" title="Step out"><i class="ti ti-arrow-up"></i></button>'
      : debug.status === 'running' ? '<button onclick="testDebugAction(\'pause\')" title="Pause"><i class="ti ti-player-pause"></i></button>' : '') +
    '</div>';
  if (debug.error) return controls + '<div class="tests-debug-error">' + _testsEsc(debug.error) + '</div>';
  if (!debug.paused) return controls + '<div class="tests-empty"><i class="ti ti-loader-2 spin"></i><strong>' + _testsEsc(debug.status === 'waiting' ? 'Waiting for inspector' : 'Running') + '</strong></div>';
  var frames = (debug.frames || []).map(function(frame, index) {
    return '<button class="tests-frame' + (index === 0 ? ' active' : '') + '"' + (frame.file ? ' onclick="openTestSource(' + _testsJs(frame.file) + ',' + frame.line + ',' + frame.column + ')"' : '') + '>' +
      '<i class="ti ti-stack-2"></i><span><strong>' + _testsEsc(frame.name) + '</strong><small>' + _testsEsc(frame.file || 'runtime') + (frame.file ? ':' + frame.line : '') + '</small></span></button>';
  }).join('') || '<div class="tests-debug-empty">No call frames</div>';
  var scopes = (debug.scopes || []).map(function(scope) {
    var variables = (scope.variables || []).map(function(variable) {
      return '<div class="tests-variable"><span>' + _testsEsc(variable.name) + '</span><code title="' + _testsEsc(variable.value) + '">' + _testsEsc(variable.value) + '</code><small>' + _testsEsc(variable.type) + '</small></div>';
    }).join('');
    return '<details class="tests-scope" open><summary>' + _testsEsc(scope.name || scope.type) + '<span>' + (scope.variables || []).length + '</span></summary>' + variables + '</details>';
  }).join('') || '<div class="tests-debug-empty">No scoped variables</div>';
  return controls + '<div class="tests-debug-grid"><section><h3>Call Stack</h3>' + frames + '</section><section><h3>Variables</h3>' + scopes + '</section></div>';
}

function selectTestsProject(projectId) {
  _testsState.projectId = projectId;
  _testsState.discovery = null;
  _testsState.run = null;
  _testsState.output = '';
  _renderTestsPage();
  refreshTestsPage();
}

async function refreshTestsPage() {
  if (!_testsState.projectId) return _renderTestsPage();
  try {
    var response = await fetch('/api/projects/' + encodeURIComponent(_testsState.projectId) + '/tests');
    var data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Test discovery failed.');
    _testsState.discovery = data;
    if (data.run) {
      _testsState.run = data.run;
      _testsState.output = data.run.output || '';
    }
  } catch (error) {
    if (typeof showToast === 'function') showToast(error.message, true);
    _testsState.discovery = { files: [], total: 0, framework: 'unavailable' };
  }
  _renderTestsPage();
}

async function runTests(file, fullName, debug, line, column) {
  if (!_testsState.projectId) return;
  _testsState.output = '';
  try {
    var response = await fetch('/api/projects/' + encodeURIComponent(_testsState.projectId) + '/tests/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: file || null, fullName: fullName || null, debug: debug === true, line: line || null, column: column || null }),
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to start tests.');
    _testsState.run = data.run;
    _testsState.tab = debug ? 'debug' : 'output';
    _renderTestsPage();
  } catch (error) { if (typeof showToast === 'function') showToast(error.message, true); }
}

async function testDebugAction(action) {
  if (!_testsState.run || !_testsState.projectId) return;
  try {
    var response = await fetch('/api/projects/' + encodeURIComponent(_testsState.projectId) + '/tests/runs/' + encodeURIComponent(_testsState.run.id) + '/debug', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action }),
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Debugger action failed.');
    _testsState.run = data.run;
    _renderTestsPage();
  } catch (error) { if (typeof showToast === 'function') showToast(error.message, true); }
}

async function cancelTestRun() {
  if (!_testsState.run) return;
  await fetch('/api/projects/' + encodeURIComponent(_testsState.projectId) + '/tests/runs/' + encodeURIComponent(_testsState.run.id), { method: 'DELETE' });
}

function _connectTestEvents() {
  if (_testsState.events || !window.EventSource) return;
  var source = new EventSource('/api/tests/events');
  _testsState.events = source;
  source.onmessage = function(event) {
    var message;
    try { message = JSON.parse(event.data || '{}'); } catch (_) { return; }
    if (message.type === 'output' && _testsState.run && message.runId === _testsState.run.id) {
      _testsState.output = (_testsState.output + message.text).slice(-100000);
      var pre = document.querySelector('.tests-output');
      if (pre) { pre.textContent = _testsState.output; pre.scrollTop = pre.scrollHeight; }
      return;
    }
    if (message.run && _testsProject() && message.run.root === _testsProject().rootPath) {
      _testsState.run = message.run;
      if (message.run.output) _testsState.output = message.run.output;
      _renderTestsPage();
    }
  };
  source.onerror = function() { source.close(); _testsState.events = null; setTimeout(_connectTestEvents, 2000); };
}

function toggleTestsFile(file) {
  _testsState.expanded[file] = _testsState.expanded[file] !== true;
  _renderTestsPage();
}

function switchTestsTab(tab) { _testsState.tab = tab; _renderTestsPage(); }

async function openTestSource(file, line, column) {
  if (!_testsState.projectId) return;
  await setActiveProject(_testsState.projectId, { navigate: false });
  openProjectHub('files');
  await openProjectFile('__rootpath__', file);
  var attempts = 0;
  (function reveal() {
    if (typeof _projMonacoEditor !== 'undefined' && _projMonacoEditor) {
      _projMonacoEditor.setPosition({ lineNumber: line || 1, column: column || 1 });
      _projMonacoEditor.revealLineInCenter(line || 1);
      _projMonacoEditor.focus();
    } else if (attempts++ < 30) setTimeout(reveal, 50);
  })();
}

function troubleshootTestRun() {
  var run = _testsState.run;
  if (!run) return;
  closeAppPage({ force: true });
  var input = document.getElementById('msg-input');
  if (input) {
    input.value = 'Troubleshoot the failing tests in project "' + (_testsProject() && _testsProject().name || '') + '". Run the focused failures, identify the root cause, fix it, and verify the suite.\n\nLatest output:\n' + String(run.output || '').slice(-6000);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }
}
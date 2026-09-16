var _runsRefreshTimer = null;
var _selectedRunId = null;

function _runEsc(value) {
  return typeof escHtml === 'function' ? escHtml(String(value == null ? '' : value)) : String(value == null ? '' : value);
}

function _runDuration(run) {
  var end = run.completedAt || run.updatedAt || Date.now();
  var seconds = Math.max(0, Math.round((end - run.createdAt) / 1000));
  return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
}

function openRunsPage() {
  var body = typeof _openAppPage === 'function' ? _openAppPage('runs', 'Runs') : null;
  if (!body) return;
  body.innerHTML = '<div class="runs-shell">' +
    '<header class="runs-header"><div><div class="home-kicker"><span></span>Execution traces</div><h1>Runs</h1></div>' +
    '<div class="runs-actions"><input id="runs-filter" class="runs-filter" type="search" placeholder="Filter runs" aria-label="Filter runs" oninput="renderRunsPage()">' +
    '<button class="settings-row-btn" type="button" onclick="renderRunsPage()" title="Refresh"><i class="ti ti-refresh"></i> Refresh</button></div></header>' +
    '<div id="runs-summary" class="runs-summary"></div>' +
    '<div class="runs-workspace"><div id="runs-list" class="runs-list"></div><div id="run-trace" class="run-trace"><div class="runs-empty">Select a run to inspect its trace.</div></div></div>' +
    '</div>';
  renderRunsPage();
  clearInterval(_runsRefreshTimer);
  _runsRefreshTimer = setInterval(function() {
    if (window.__faunaCurrentPage !== 'runs') return clearInterval(_runsRefreshTimer);
    renderRunsPage(true);
  }, 3000);
}

async function renderRunsPage(silent) {
  var list = document.getElementById('runs-list');
  var summaryEl = document.getElementById('runs-summary');
  if (!list || !summaryEl) return;
  if (!silent) list.innerHTML = '<div class="runs-empty"><i class="ti ti-loader-2"></i> Loading runs...</div>';
  try {
    var responses = await Promise.all([fetch('/api/agent-runs'), fetch('/api/agent-runs/analytics')]);
    if (!responses[0].ok || !responses[1].ok) throw new Error('Run data unavailable');
    var runs = await responses[0].json();
    var analytics = await responses[1].json();
    var query = ((document.getElementById('runs-filter') || {}).value || '').trim().toLowerCase();
    if (query) runs = runs.filter(function(run) { return JSON.stringify(run).toLowerCase().indexOf(query) >= 0; });
    summaryEl.innerHTML = [
      ['Runs', analytics.runs], ['Active', analytics.active], ['Completed', analytics.completed],
      ['Failed', analytics.failed], ['Tool calls', analytics.toolCalls], ['Tokens', (analytics.promptTokens || 0) + (analytics.completionTokens || 0)]
    ].map(function(item) { return '<div><span>' + item[0] + '</span><strong>' + (item[1] || 0) + '</strong></div>'; }).join('');
    list.innerHTML = runs.map(function(run) {
      return '<button class="run-row' + (run.id === _selectedRunId ? ' active' : '') + '" type="button" onclick="openRunTrace(\'' + _runEsc(run.id) + '\')">' +
        '<span class="run-status status-' + _runEsc(run.status) + '"></span><span class="run-row-main"><strong>' + _runEsc(run.agentName || run.kind || 'Run') + '</strong><small>' + _runEsc(run.id) + '</small></span>' +
        '<span class="run-row-meta"><b>' + _runEsc(run.status) + '</b><small>' + _runDuration(run) + '</small></span></button>';
    }).join('') || '<div class="runs-empty">No matching runs.</div>';
    if (_selectedRunId) openRunTrace(_selectedRunId, true);
  } catch (error) {
    list.innerHTML = '<div class="runs-empty runs-error">' + _runEsc(error.message) + '</div>';
  }
}

async function openRunTrace(runId, silent) {
  _selectedRunId = runId;
  var trace = document.getElementById('run-trace');
  if (!trace) return;
  if (!silent) trace.innerHTML = '<div class="runs-empty"><i class="ti ti-loader-2"></i> Loading trace...</div>';
  try {
    var responses = await Promise.all([
      fetch('/api/agent-runs/' + encodeURIComponent(runId)),
      fetch('/api/agent-runs/' + encodeURIComponent(runId) + '/events')
    ]);
    if (!responses[0].ok || !responses[1].ok) throw new Error('Trace unavailable');
    var summary = await responses[0].json();
    var events = await responses[1].json();
    var run = summary.run;
    trace.innerHTML = '<div class="run-trace-header"><div><span class="run-kind">' + _runEsc(run.kind) + '</span><h2>' + _runEsc(run.agentName || run.id) + '</h2><p>' + _runEsc(run.status) + ' · ' + _runDuration(run) + ' · ' + events.length + ' events</p></div>' +
      '<div class="runs-actions"><a class="settings-row-btn" href="/api/agent-runs/' + encodeURIComponent(runId) + '/export?format=json" download><i class="ti ti-download"></i> JSON</a>' +
      '<a class="settings-row-btn" href="/api/agent-runs/' + encodeURIComponent(runId) + '/export?format=otlp" download><i class="ti ti-wave-sine"></i> OTLP</a></div></div>' +
      '<div class="trace-events">' + events.map(function(event) {
        return '<details class="trace-event"><summary><span>#' + event.id + '</span><strong>' + _runEsc(event.type) + '</strong><time>' + new Date(event.ts).toLocaleTimeString() + '</time></summary>' +
          '<pre>' + _runEsc(JSON.stringify(event.data || {}, null, 2)) + '</pre></details>';
      }).join('') + '</div>';
  } catch (error) {
    trace.innerHTML = '<div class="runs-empty runs-error">' + _runEsc(error.message) + '</div>';
  }
}

(function() {
  var panel = null;
  var selectedId = null;
  var snapshot = { items: [], testCount: 0, activeCount: 0 };
  var timer = null;
  var request = null;
  var busy = false;
  var generation = 0;
  var stopError = '';
  var rows = new Map();
  var stopPending = new Set();
  var statuses = { running: 'Running', stopping: 'Stopping', passed: 'Passed',
    failed: 'Failed', stopped: 'Stopped', timed_out: 'Timed out' };

  function node(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  function active(run) { return run.status === 'running' || run.status === 'stopping'; }
  function duration(run) {
    var seconds = Math.max(0, Math.floor(((run.finishedAt || Date.now()) - run.startedAt) / 1000));
    return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's';
  }
  function memory(run) {
    if (!run.memory) return 'Resident memory unavailable';
    var bytes = run.memory.rssBytes;
    var value = bytes >= 1024 * 1024 * 1024
      ? (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
      : (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (active(run) ? 'Resident memory: ' : 'Last resident memory: ') +
      value + ' · ' + run.memory.processCount + ' processes';
  }
  async function json(url, options) {
    var response = await fetch(url, options);
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed (' + response.status + ')');
    return data;
  }
  function error(message) {
    var host = panel && panel.querySelector('.test-monitor-error');
    if (host) {
      host.textContent = message;
      host.hidden = false;
    }
  }
  function renderList() {
    if (!panel) return;
    var host = panel.querySelector('.test-monitor-list');
    var onlyTests = panel.querySelector('.test-monitor-filter input').checked;
    var items = snapshot.items.filter(function(run) { return !onlyTests || run.kind === 'test'; });
    var ids = new Set(items.map(function(run) { return run.id; }));
    rows.forEach(function(row, id) {
      if (!ids.has(id)) { row.remove(); rows.delete(id); }
    });
    var empty = host.querySelector('.test-monitor-empty');
    if (empty) empty.remove();
    if (!items.length) {
      host.appendChild(node('p', 'test-monitor-empty',
        onlyTests ? 'No test commands in this app session. Uncheck “Tests only” to see other commands.'
          : 'No commands in this app session.'));
      selectedId = null;
      panel.querySelector('.test-monitor-detail').hidden = true;
      return;
    }
    if (!ids.has(selectedId)) {
      selectedId = (items.find(active) || items[0]).id;
    }
    var detail = panel.querySelector('.test-monitor-detail');
    if (detail.dataset.runId !== selectedId) {
      detail.dataset.runId = selectedId;
      renderDetail(Object.assign({}, items.find(function(run) { return run.id === selectedId; }),
        { output: 'Loading command output…' }));
    }
    items.forEach(function(run, index) {
      var row = rows.get(run.id);
      if (!row) {
        row = node('button', 'test-monitor-row');
        row.type = 'button';
        row.dataset.runId = run.id;
        row.appendChild(node('strong', 'test-monitor-row-command'));
        row.appendChild(node('span', 'test-monitor-row-state'));
        row.addEventListener('click', function() {
          selectedId = run.id;
          renderList();
          refresh();
        });
        rows.set(run.id, row);
      }
      row.querySelector('strong').textContent = run.command;
      row.querySelector('span').textContent = (statuses[run.status] || run.status) + ' · ' + duration(run);
      row.title = run.command + '\n' + run.cwd;
      row.classList.toggle('selected', run.id === selectedId);
      row.setAttribute('aria-current', run.id === selectedId ? 'true' : 'false');
      if (host.children[index] !== row) host.insertBefore(row, host.children[index] || null);
    });
  }
  function renderDetail(run) {
    if (!panel || run.id !== selectedId) return;
    var detail = panel.querySelector('.test-monitor-detail');
    detail.hidden = false;
    detail.querySelector('.test-monitor-command').textContent = run.command;
    detail.querySelector('.test-monitor-cwd').textContent = run.cwd;
    detail.querySelector('.test-monitor-state').textContent = (statuses[run.status] || run.status) +
      ' · ' + duration(run) + ' · ' + run.source +
      (run.exitCode != null ? ' · exit ' + run.exitCode : '');
    detail.querySelector('.test-monitor-memory').textContent = memory(run);
    detail.querySelector('.test-monitor-pid').textContent = run.pid ? 'PID ' + run.pid : 'No process started';
    var stop = detail.querySelector('.test-monitor-stop');
    stop.disabled = !active(run) || run.status === 'stopping' || stopPending.has(run.id);
    stop.textContent = run.status === 'stopping' || stopPending.has(run.id) ? 'Stopping…' : 'Stop';
    var output = detail.querySelector('pre');
    var text = (run.outputTruncated ? '[Showing recent output; older output omitted]\n\n' : '') +
      (run.output || (active(run)
        ? 'Waiting for output. The command may be buffering output or writing to a file.'
        : 'The command finished without output.'));
    if (output.textContent !== text) {
      var follow = output.scrollHeight - output.scrollTop - output.clientHeight < 48;
      output.textContent = text;
      if (follow) output.scrollTop = output.scrollHeight;
    }
  }
  async function refresh() {
    if (busy) return;
    clearTimeout(timer);
    busy = true;
    var currentGeneration = generation;
    request = new AbortController();
    var timedOut = false;
    var timeout = setTimeout(function() { timedOut = true; if (request) request.abort(); }, 8000);
    try {
      var data = await json('/api/test-runs' + (panel ? '?memory=1' : ''), { signal: request.signal });
      if (currentGeneration !== generation) return;
      snapshot = data;
      var count = document.getElementById('topbar-tests-count');
      if (count) count.textContent = data.testCount ? String(data.testCount) : '';
      var trigger = document.getElementById('topbar-tests-btn');
      if (trigger) trigger.title = 'Running tests: ' + data.testCount;
      if (panel) {
        panel.querySelector('.test-monitor-error').hidden = true;
        panel.querySelector('.test-monitor-summary').textContent = data.testCount +
          (data.testCount === 1 ? ' test running · ' : ' tests running · ') +
          data.activeCount + (data.activeCount === 1 ? ' command active' : ' commands active');
        renderList();
        if (selectedId) {
          var requestedId = selectedId;
          var run = await json('/api/test-runs/' + encodeURIComponent(requestedId), { signal: request.signal });
          if (currentGeneration === generation && panel && selectedId === requestedId) renderDetail(run);
        }
        if (stopError || data.memoryError) {
          error([stopError, data.memoryError && 'Process memory unavailable: ' + data.memoryError]
            .filter(Boolean).join(' '));
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError' || timedOut) {
        error('Unable to refresh tests: ' + err.message);
        var trigger = document.getElementById('topbar-tests-btn');
        if (trigger) trigger.title = 'Unable to refresh tests: ' + err.message;
      }
    } finally {
      clearTimeout(timeout);
      busy = false;
      request = null;
      timer = setTimeout(refresh, document.hidden ? 10000 : 2000);
    }
  }
  function close() {
    generation++;
    if (request) request.abort();
    if (panel) panel.remove();
    panel = null;
    stopError = '';
    rows.clear();
    document.removeEventListener('keydown', keydown);
    var trigger = document.getElementById('topbar-tests-btn');
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    }
  }
  function keydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  }
  async function stopSelected() {
    var id = selectedId;
    var currentGeneration = generation;
    if (!id || stopPending.has(id)) return;
    stopPending.add(id);
    stopError = '';
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 8000);
    var run = snapshot.items.find(function(item) { return item.id === id; });
    if (run) renderDetail(Object.assign({}, run, { output: panel.querySelector('pre').textContent }));
    try {
      await json('/api/test-runs/' + encodeURIComponent(id) + '/stop',
        { method: 'POST', signal: controller.signal });
    } catch (err) {
      console.warn('[test-monitor] unable to stop command:', err.message);
      if (currentGeneration === generation) {
        stopError = 'Unable to stop command: ' + err.message;
        error(stopError);
      }
    } finally {
      clearTimeout(timeout);
      stopPending.delete(id);
      refresh();
    }
  }
  function open() {
    if (panel) { close(); return; }
    generation++;
    if (request) request.abort();
    panel = node('section', 'test-monitor-panel');
    panel.id = 'test-monitor-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'test-monitor-title');
    panel.innerHTML =
      '<header class="test-monitor-header"><h2 id="test-monitor-title">Running tests</h2>' +
      '<button type="button" class="topbar-btn test-monitor-refresh" aria-label="Refresh tests"><i class="ti ti-refresh"></i></button>' +
      '<button type="button" class="topbar-btn test-monitor-close" aria-label="Close running tests"><i class="ti ti-x"></i></button></header>' +
      '<div class="test-monitor-toolbar"><span class="test-monitor-summary" role="status">Loading tests…</span>' +
      '<label class="test-monitor-filter"><input type="checkbox" checked> Tests only</label></div>' +
      '<p class="test-monitor-error" role="alert" hidden></p>' +
      '<div class="test-monitor-body"><nav class="test-monitor-list" aria-label="Test commands"></nav>' +
      '<section class="test-monitor-detail" aria-label="Selected command" hidden>' +
      '<code class="test-monitor-command"></code><div class="test-monitor-cwd"></div>' +
      '<div class="test-monitor-state" role="status"></div><div class="test-monitor-memory"></div>' +
      '<div class="test-monitor-process"><span class="test-monitor-pid"></span><button type="button" class="test-monitor-stop">Stop</button></div>' +
      '<pre tabindex="0" aria-label="Live command output"></pre></section></div>' +
      '<footer>Tracks commands started by Fauna in this app session. Memory includes child processes’ resident RAM, not compressed memory or swap.</footer>';
    document.body.appendChild(panel);
    panel.querySelector('.test-monitor-close').addEventListener('click', close);
    panel.querySelector('.test-monitor-refresh').addEventListener('click', refresh);
    panel.querySelector('.test-monitor-stop').addEventListener('click', stopSelected);
    panel.querySelector('.test-monitor-filter input').addEventListener('change', function() { renderList(); refresh(); });
    document.addEventListener('keydown', keydown);
    var trigger = document.getElementById('topbar-tests-btn');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    panel.querySelector('.test-monitor-close').focus();
    refresh();
  }
  window.FaunaTestMonitor = { open: open, close: close, refresh: refresh };
  document.getElementById('topbar-tests-btn')?.addEventListener('click', open);
  refresh();
})();

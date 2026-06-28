var promptStudioState = {
  records: [],
  selectedKey: '',
  filter: '',
  kind: 'all',
};

function openPromptStudioPage() {
  var body = typeof _openAppPage === 'function' ? _openAppPage('prompt-studio', 'Prompt Studio') : null;
  if (!body) return null;
  body.innerHTML =
    '<div class="prompt-studio-shell">' +
      '<div class="prompt-studio-header">' +
        '<div>' +
          '<div class="home-kicker"><span></span>Customizations</div>' +
          '<h1>Prompt Studio</h1>' +
          '<p>Inspect prompt files, scoped instructions, custom agents, skills, hooks, and runtime policy.</p>' +
        '</div>' +
        '<button class="settings-row-btn" type="button" onclick="loadPromptStudio(true)"><i class="ti ti-refresh"></i> Refresh</button>' +
      '</div>' +
      '<div class="prompt-studio-toolbar">' +
        '<div class="prompt-studio-tabs" id="prompt-studio-tabs"></div>' +
        '<label class="prompt-studio-search"><i class="ti ti-search"></i><input id="prompt-studio-search" placeholder="Search customizations" oninput="promptStudioState.filter=this.value;renderPromptStudio()"></label>' +
      '</div>' +
      '<div class="prompt-studio-grid">' +
        '<div class="prompt-studio-list" id="prompt-studio-list"><div class="health-loading"><i class="ti ti-loader-2"></i> Loading customizations...</div></div>' +
        '<div class="prompt-studio-detail" id="prompt-studio-detail"></div>' +
      '</div>' +
    '</div>';
  loadPromptStudio(false);
  return body;
}

async function loadPromptStudio(force) {
  var list = document.getElementById('prompt-studio-list');
  if (list && !promptStudioState.records.length) list.innerHTML = '<div class="health-loading"><i class="ti ti-loader-2"></i> Loading customizations...</div>';
  try {
    var r = await fetch('/api/customizations?includeBody=1' + (force ? '&t=' + Date.now() : ''));
    var d = await r.json();
    if (!r.ok || !d) throw new Error((d && d.error) || ('HTTP ' + r.status));
    promptStudioState.records = d.customizations || [];
    if (!promptStudioState.selectedKey || !promptStudioState.records.some(function(rec) { return _promptStudioKey(rec) === promptStudioState.selectedKey; })) {
      promptStudioState.selectedKey = promptStudioState.records[0] ? _promptStudioKey(promptStudioState.records[0]) : '';
    }
    renderPromptStudio();
  } catch (e) {
    if (list) list.innerHTML = '<div class="health-empty health-fail"><i class="ti ti-alert-triangle"></i><strong>Unable to load customizations</strong><span>' + escHtml(e.message || String(e)) + '</span></div>';
  }
}

function renderPromptStudio() {
  var tabs = document.getElementById('prompt-studio-tabs');
  var list = document.getElementById('prompt-studio-list');
  var detail = document.getElementById('prompt-studio-detail');
  if (!tabs || !list || !detail) return;
  var kinds = ['all', 'prompt', 'instruction', 'agent', 'skill', 'hooks', 'agent-instructions'];
  tabs.innerHTML = kinds.map(function(kind) {
    var count = kind === 'all' ? promptStudioState.records.length : promptStudioState.records.filter(function(r) { return r.kind === kind; }).length;
    return '<button class="prompt-studio-tab' + (promptStudioState.kind === kind ? ' active' : '') + '" onclick="promptStudioState.kind=\'' + kind + '\';renderPromptStudio()">' + escHtml(_promptStudioKindLabel(kind)) + '<span>' + count + '</span></button>';
  }).join('');

  var records = _promptStudioFilteredRecords();
  list.innerHTML = records.length ? records.map(_promptStudioCard).join('') : '<div class="health-empty"><i class="ti ti-file-search"></i><strong>No customizations found</strong><span>Try another filter or add files under .github/prompts, .github/instructions, .github/agents, skills, or .github/hooks.</span></div>';
  var selected = promptStudioState.records.find(function(r) { return _promptStudioKey(r) === promptStudioState.selectedKey; }) || records[0] || null;
  if (selected) promptStudioState.selectedKey = _promptStudioKey(selected);
  detail.innerHTML = selected ? _promptStudioDetail(selected) : '<div class="prompt-studio-empty-detail"><i class="ti ti-braces"></i><span>Select a customization to inspect it.</span></div>';
}

function _promptStudioFilteredRecords() {
  var q = String(promptStudioState.filter || '').toLowerCase().trim();
  return promptStudioState.records.filter(function(r) {
    if (promptStudioState.kind !== 'all' && r.kind !== promptStudioState.kind) return false;
    if (!q) return true;
    return [r.name, r.kind, r.description, r.path, r.body].join(' ').toLowerCase().indexOf(q) !== -1;
  }).sort(function(a, b) {
    return String(a.kind || '').localeCompare(String(b.kind || '')) || String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function _promptStudioCard(r) {
  var key = _promptStudioKey(r);
  var status = r.ok === false ? 'fail' : ((r.warnings && r.warnings.length) ? 'warn' : 'ok');
  var meta = [r.scope, _promptStudioKindLabel(r.kind)].filter(Boolean).join(' · ');
  return '<button class="prompt-studio-card ' + status + (key === promptStudioState.selectedKey ? ' active' : '') + '" onclick="promptStudioState.selectedKey=' + JSON.stringify(key).replace(/"/g, '&quot;') + ';renderPromptStudio()">' +
    '<span class="prompt-studio-status"></span>' +
    '<span class="prompt-studio-card-main"><strong>' + escHtml(r.name || '(unnamed)') + '</strong><small>' + escHtml(meta) + '</small></span>' +
    '<i class="ti ti-chevron-right"></i>' +
  '</button>';
}

function _promptStudioDetail(r) {
  var status = r.ok === false ? 'fail' : ((r.warnings && r.warnings.length) ? 'warn' : 'ok');
  var tools = Array.isArray(r.tools) ? r.tools : [];
  var model = Array.isArray(r.model) ? r.model : (r.model ? [r.model] : []);
  var issues = [].concat(r.errors || [], r.warnings || []);
  var frontmatter = r.frontmatter ? JSON.stringify(r.frontmatter, null, 2) : '{}';
  var action = r.kind === 'prompt'
    ? '<div class="prompt-studio-run"><textarea id="prompt-studio-run-input" placeholder="Prompt arguments"></textarea><button class="settings-row-btn" onclick="runPromptStudioPrompt(' + JSON.stringify(r.name).replace(/"/g, '&quot;') + ')"><i class="ti ti-player-play"></i> Render Prompt</button><button class="settings-row-btn" onclick="sendPromptStudioPrompt(' + JSON.stringify(r.name).replace(/"/g, '&quot;') + ')"><i class="ti ti-send"></i> Send</button><pre id="prompt-studio-run-output"></pre></div>'
    : '';
  return '<div class="prompt-studio-detail-head ' + status + '">' +
      '<div><span class="prompt-studio-kind">' + escHtml(_promptStudioKindLabel(r.kind)) + '</span><h2>' + escHtml(r.name || '(unnamed)') + '</h2><p>' + escHtml(r.description || 'No description.') + '</p></div>' +
      '<span class="prompt-studio-pill">' + (status === 'ok' ? 'Ready' : status === 'warn' ? 'Warnings' : 'Errors') + '</span>' +
    '</div>' +
    '<div class="prompt-studio-meta-grid">' +
      _promptStudioMeta('Scope', r.scope || 'repo') +
      _promptStudioMeta('Path', r.relativePath || r.path || '') +
      _promptStudioMeta('Tools', tools.length ? tools.join(', ') : (r.kind === 'hooks' ? 'lifecycle commands' : 'default')) +
      _promptStudioMeta('Model', model.length ? model.join(', ') : 'default') +
    '</div>' +
    (issues.length ? '<div class="prompt-studio-issues">' + issues.map(function(i) { return '<div><i class="ti ti-alert-triangle"></i><span>' + escHtml(i) + '</span></div>'; }).join('') + '</div>' : '') +
    action +
    '<div class="prompt-studio-code-grid">' +
      '<section><h3>Frontmatter</h3><pre>' + escHtml(frontmatter) + '</pre></section>' +
      '<section><h3>Body</h3><pre>' + escHtml(r.body || (r.kind === 'hooks' ? JSON.stringify(r.hooks || {}, null, 2) : '')) + '</pre></section>' +
    '</div>';
}

async function runPromptStudioPrompt(name) {
  var out = document.getElementById('prompt-studio-run-output');
  var input = document.getElementById('prompt-studio-run-input');
  if (out) out.textContent = 'Rendering...';
  try {
    var r = await fetch('/api/customizations/run-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, input: input ? input.value : '' }),
    });
    var d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    if (out) out.textContent = d.content || '';
    return d;
  } catch (e) {
    if (out) out.textContent = 'Error: ' + (e.message || String(e));
    return null;
  }
}

async function sendPromptStudioPrompt(name) {
  var d = await runPromptStudioPrompt(name);
  if (!d) return;
  var input = document.getElementById('msg-input');
  if (input) {
    input.value = d.content || '';
    if (typeof resizeTextarea === 'function') resizeTextarea();
  }
  if (typeof closeAppPage === 'function') closeAppPage({ force: true });
  if (typeof sendMessage === 'function') sendMessage();
}

function _promptStudioMeta(label, value) {
  return '<div><span>' + escHtml(label) + '</span><strong title="' + escHtml(value || '') + '">' + escHtml(value || 'none') + '</strong></div>';
}

function _promptStudioKey(r) {
  return [r.kind || '', r.scope || '', r.path || r.name || ''].join('|');
}

function _promptStudioKindLabel(kind) {
  return ({
    all: 'All',
    prompt: 'Prompts',
    instruction: 'Instructions',
    agent: 'Agents',
    skill: 'Skills',
    hooks: 'Hooks',
    'agent-instructions': 'Legacy',
  })[kind] || kind || 'Custom';
}

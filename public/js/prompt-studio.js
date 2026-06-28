var promptStudioState = {
  records: [],
  selectedKey: '',
  filter: '',
  kind: 'all',
  draft: null,
};

var PROMPT_STUDIO_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'SubagentStart', 'SubagentStop', 'Stop'];

function openPromptStudioPage() {
  var body = typeof _openAppPage === 'function' ? _openAppPage('prompt-studio', 'Prompt Studio') : null;
  if (!body) return null;
  body.innerHTML =
    '<div class="prompt-studio-shell">' +
      '<div class="prompt-studio-header">' +
        '<div>' +
          '<div class="home-kicker"><span></span>Customizations</div>' +
          '<h1>Prompt Studio</h1>' +
          '<p>Create, inspect, test, and lint prompt files, scoped instructions, custom agents, skills, and hooks.</p>' +
        '</div>' +
        '<div class="prompt-studio-actions">' +
          '<button class="settings-row-btn" type="button" onclick="newPromptStudioRecord(\'prompt\')"><i class="ti ti-plus"></i> Prompt</button>' +
          '<button class="settings-row-btn" type="button" onclick="newPromptStudioRecord(\'instruction\')"><i class="ti ti-plus"></i> Instruction</button>' +
          '<button class="settings-row-btn" type="button" onclick="newPromptStudioRecord(\'agent\')"><i class="ti ti-plus"></i> Agent</button>' +
          '<button class="settings-row-btn" type="button" onclick="newPromptStudioRecord(\'skill\')"><i class="ti ti-plus"></i> Skill</button>' +
          '<button class="settings-row-btn" type="button" onclick="newPromptStudioRecord(\'hooks\')"><i class="ti ti-plus"></i> Hook</button>' +
          '<button class="settings-row-btn" type="button" onclick="loadPromptStudio(true)"><i class="ti ti-refresh"></i> Refresh</button>' +
        '</div>' +
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
    if (!promptStudioState.draft && (!promptStudioState.selectedKey || !promptStudioState.records.some(function(rec) { return _promptStudioKey(rec) === promptStudioState.selectedKey; }))) {
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
  var draftCard = promptStudioState.draft ? _promptStudioCard(promptStudioState.draft) : '';
  list.innerHTML = draftCard + (records.length ? records.map(_promptStudioCard).join('') : '<div class="health-empty"><i class="ti ti-file-search"></i><strong>No customizations found</strong><span>Try another filter or create a customization above.</span></div>');
  var selected = promptStudioState.draft || promptStudioState.records.find(function(r) { return _promptStudioKey(r) === promptStudioState.selectedKey; }) || records[0] || null;
  if (selected) promptStudioState.selectedKey = _promptStudioKey(selected);
  detail.innerHTML = selected ? _promptStudioDetail(selected) : '<div class="prompt-studio-empty-detail"><i class="ti ti-braces"></i><span>Select or create a customization.</span></div>';
}

function newPromptStudioRecord(kind) {
  var name = kind === 'hooks' ? 'policy' : kind === 'instruction' ? 'project-rules' : kind === 'agent' ? 'custom-agent' : kind === 'skill' ? 'workflow-skill' : 'custom-prompt';
  var body = kind === 'hooks'
    ? JSON.stringify({ hooks: { PreToolUse: [{ type: 'command', command: 'node .github/hooks/policy.js' }] } }, null, 2)
    : kind === 'skill'
      ? '# ' + name + '\n\n## Overview\nDescribe the workflow.\n\n## When to Use\n- Describe the trigger.\n\n## Process\n1. Do the first step.\n\n## Common Rationalizations\n- None.\n\n## Red Flags\n- Guessing.\n\n## Verification\n- Run or cite a concrete check.\n'
      : kind === 'agent'
        ? 'You are a focused custom agent. Define the workflow, tool-use rules, and final output contract here.\n'
        : kind === 'instruction'
          ? 'Add scoped repo guidance here.\n'
          : 'Use this prompt with: {{input}}\n';
  promptStudioState.draft = {
    kind: kind,
    name: name,
    description: '',
    scope: 'repo',
    path: '',
    frontmatter: { name: name, description: '' },
    tools: [],
    model: [],
    body: body,
    ok: true,
    warnings: [],
    errors: [],
    _draft: true,
  };
  promptStudioState.selectedKey = _promptStudioKey(promptStudioState.draft);
  if (promptStudioState.kind !== 'all' && promptStudioState.kind !== kind) promptStudioState.kind = kind;
  renderPromptStudio();
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
  var meta = [r._draft ? 'draft' : r.scope, _promptStudioKindLabel(r.kind)].filter(Boolean).join(' · ');
  return '<button class="prompt-studio-card ' + status + (key === promptStudioState.selectedKey ? ' active' : '') + '" onclick="selectPromptStudioRecord(' + JSON.stringify(key).replace(/"/g, '&quot;') + ')">' +
    '<span class="prompt-studio-status"></span>' +
    '<span class="prompt-studio-card-main"><strong>' + escHtml(r.name || '(unnamed)') + '</strong><small>' + escHtml(meta) + '</small></span>' +
    '<i class="ti ti-chevron-right"></i>' +
  '</button>';
}

function selectPromptStudioRecord(key) {
  if (!promptStudioState.draft || key !== _promptStudioKey(promptStudioState.draft)) promptStudioState.draft = null;
  promptStudioState.selectedKey = key;
  renderPromptStudio();
}

function _promptStudioDetail(r) {
  var status = r.ok === false ? 'fail' : ((r.warnings && r.warnings.length) ? 'warn' : 'ok');
  var readOnly = r.kind === 'agent-instructions';
  var issues = [].concat(r.errors || [], r.warnings || []);
  var action = r.kind === 'prompt'
    ? '<div class="prompt-studio-run"><textarea id="prompt-studio-run-input" placeholder="Prompt arguments"></textarea><button class="settings-row-btn" onclick="runPromptStudioPrompt(' + JSON.stringify(r.name).replace(/"/g, '&quot;') + ')"><i class="ti ti-player-play"></i> Render Prompt</button><button class="settings-row-btn" onclick="sendPromptStudioPrompt(' + JSON.stringify(r.name).replace(/"/g, '&quot;') + ')"><i class="ti ti-send"></i> Send</button><pre id="prompt-studio-run-output"></pre></div>'
    : '';
  return '<div class="prompt-studio-detail-head ' + status + '">' +
      '<div><span class="prompt-studio-kind">' + escHtml(_promptStudioKindLabel(r.kind)) + '</span><h2>' + escHtml(r.name || '(unnamed)') + '</h2><p>' + escHtml(r.description || 'No description.') + '</p></div>' +
      '<span class="prompt-studio-pill">' + (status === 'ok' ? 'Ready' : status === 'warn' ? 'Warnings' : 'Errors') + '</span>' +
    '</div>' +
    (issues.length ? '<div class="prompt-studio-issues">' + issues.map(function(i) { return '<div><i class="ti ti-alert-triangle"></i><span>' + escHtml(i) + '</span></div>'; }).join('') + '</div>' : '') +
    _promptStudioEditor(r, readOnly) +
    action;
}

function _promptStudioEditor(r, readOnly) {
  var fm = r.frontmatter || {};
  var tools = Array.isArray(r.tools) ? r.tools.join(', ') : '';
  var model = Array.isArray(r.model) ? r.model.join(', ') : '';
  var applyTo = Array.isArray(r.applyTo) ? r.applyTo.join(', ') : (fm.applyTo || '');
  var agents = Array.isArray(r.agents) ? r.agents.join(', ') : (Array.isArray(fm.agents) ? fm.agents.join(', ') : '');
  var pathText = r.path || '';
  var body = r.kind === 'hooks' ? (r.body || JSON.stringify(r.hooks || {}, null, 2)) : (r.body || '');
  var disabled = readOnly ? ' disabled' : '';
  var extra = '';
  if (r.kind === 'prompt') {
    extra += _promptStudioField('Agent', 'ps-agent', fm.agent || '', disabled);
    extra += _promptStudioField('Argument Hint', 'ps-argument-hint', fm['argument-hint'] || '', disabled);
    extra += _promptStudioField('Tools', 'ps-tools', tools, disabled, 'read, search, execute');
    extra += _promptStudioField('Model', 'ps-model', model, disabled, 'Claude Sonnet 4.5, GPT-5');
  } else if (r.kind === 'instruction') {
    extra += _promptStudioField('Apply To', 'ps-apply-to', applyTo, disabled, 'server/**/*.js');
  } else if (r.kind === 'agent') {
    extra += _promptStudioField('Tools', 'ps-tools', tools, disabled, 'read, edit, execute');
    extra += _promptStudioField('Model', 'ps-model', model, disabled, 'Claude Sonnet 4.5');
    extra += _promptStudioField('Allowed Subagents', 'ps-agents', agents, disabled, 'researcher, reviewer');
    extra += '<label class="prompt-studio-check"><input id="ps-user-invocable" type="checkbox"' + (r.userInvocable !== false ? ' checked' : '') + disabled + '> User invocable</label>';
    extra += '<label class="prompt-studio-check"><input id="ps-disable-model-invocation" type="checkbox"' + (r.disableModelInvocation === true ? ' checked' : '') + disabled + '> Disable model invocation</label>';
  } else if (r.kind === 'skill') {
    extra += _promptStudioField('Argument Hint', 'ps-argument-hint', fm['argument-hint'] || '', disabled);
    extra += '<label class="prompt-studio-check"><input id="ps-user-invocable" type="checkbox"' + (r.userInvocable !== false ? ' checked' : '') + disabled + '> User invocable</label>';
    extra += '<label class="prompt-studio-check"><input id="ps-disable-model-invocation" type="checkbox"' + (r.disableModelInvocation === true ? ' checked' : '') + disabled + '> Disable model invocation</label>';
  }
  if (r.kind !== 'hooks' && r.kind !== 'agent-instructions') {
    extra += _promptStudioHooksField(fm.hooks || r.hooks || {}, disabled);
  }
  return '<div class="prompt-studio-editor">' +
    '<div class="prompt-studio-editor-grid">' +
      _promptStudioField('Name', 'ps-name', r.name || '', disabled) +
      _promptStudioSelect('Scope', 'ps-scope', r.scope || 'repo', disabled) +
      _promptStudioField('Description', 'ps-description', r.description || fm.description || '', disabled) +
      _promptStudioField('Path', 'ps-path', pathText, disabled, 'Leave blank for canonical path') +
      extra +
    '</div>' +
    '<label class="prompt-studio-body-label"><span>' + (r.kind === 'hooks' ? 'JSON' : 'Body') + '</span><textarea id="ps-body"' + disabled + '>' + escHtml(body) + '</textarea></label>' +
    '<div class="prompt-studio-save-row">' +
      (readOnly ? '' : '<button class="settings-row-btn" onclick="savePromptStudioRecord()"><i class="ti ti-device-floppy"></i> Save</button>') +
      '<span id="prompt-studio-save-status"></span>' +
    '</div>' +
  '</div>';
}

function _promptStudioField(label, id, value, disabled, placeholder) {
  return '<label><span>' + escHtml(label) + '</span><input id="' + id + '" value="' + escHtml(value || '') + '" placeholder="' + escHtml(placeholder || '') + '"' + disabled + '></label>';
}

function _promptStudioSelect(label, id, value, disabled) {
  return '<label><span>' + escHtml(label) + '</span><select id="' + id + '"' + disabled + '><option value="repo"' + (value !== 'user' ? ' selected' : '') + '>Repo</option><option value="user"' + (value === 'user' ? ' selected' : '') + '>User</option></select></label>';
}

function _promptStudioHooksField(hooks, disabled) {
  var value = hooks && Object.keys(hooks || {}).length ? JSON.stringify(hooks, null, 2) : '';
  var eventOptions = PROMPT_STUDIO_HOOK_EVENTS.map(function(eventName) {
    return '<option value="' + escHtml(eventName) + '">' + escHtml(eventName) + '</option>';
  }).join('');
  return '<div class="prompt-studio-inline-hooks">' +
    '<label class="prompt-studio-body-label"><span>Inline Hooks JSON</span><textarea id="ps-inline-hooks"' + disabled + ' placeholder="{ &quot;UserPromptSubmit&quot;: [{ &quot;type&quot;: &quot;command&quot;, &quot;command&quot;: &quot;node .github/hooks/policy.js&quot; }] }">' + escHtml(value) + '</textarea></label>' +
    '<div class="prompt-studio-hook-builder">' +
      '<select id="ps-hook-event"' + disabled + '>' + eventOptions + '</select>' +
      '<input id="ps-hook-command"' + disabled + ' placeholder="node .github/hooks/policy.js">' +
      '<button class="settings-row-btn" type="button" onclick="promptStudioAddInlineHook()"' + disabled + '><i class="ti ti-plus"></i> Add hook</button>' +
    '</div>' +
  '</div>';
}

function promptStudioAddInlineHook() {
  var textarea = document.getElementById('ps-inline-hooks');
  var eventEl = document.getElementById('ps-hook-event');
  var commandEl = document.getElementById('ps-hook-command');
  var status = document.getElementById('prompt-studio-save-status');
  if (!textarea || !eventEl || !commandEl) return;
  var command = String(commandEl.value || '').trim();
  if (!command) {
    if (status) status.textContent = 'Enter a hook command first.';
    commandEl.focus();
    return;
  }
  var hooks = {};
  var raw = String(textarea.value || '').trim();
  if (raw) {
    try {
      hooks = JSON.parse(raw);
      if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('Expected an object');
    } catch (e) {
      if (status) status.textContent = 'Fix Inline Hooks JSON before adding: ' + (e.message || String(e));
      return;
    }
  }
  var eventName = eventEl.value || 'UserPromptSubmit';
  if (!Array.isArray(hooks[eventName])) hooks[eventName] = [];
  hooks[eventName].push({ type: 'command', command: command });
  textarea.value = JSON.stringify(hooks, null, 2);
  commandEl.value = '';
  if (status) status.textContent = 'Hook added. Save to write it.';
}

async function savePromptStudioRecord() {
  var selected = promptStudioState.draft || promptStudioState.records.find(function(r) { return _promptStudioKey(r) === promptStudioState.selectedKey; });
  if (!selected) return;
  var status = document.getElementById('prompt-studio-save-status');
  if (status) status.textContent = 'Saving...';
  try {
    var payload = _promptStudioPayload(selected);
    var r = await fetch('/api/customizations/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    promptStudioState.draft = null;
    promptStudioState.selectedKey = d.record ? _promptStudioKey(d.record) : '';
    await loadPromptStudio(true);
    if (typeof showToast === 'function') showToast('Customization saved');
  } catch (e) {
    if (status) status.textContent = 'Error: ' + (e.message || String(e));
  }
}

function _promptStudioPayload(record) {
  var kind = record.kind;
  var name = _value('ps-name').trim().toLowerCase();
  var scope = _value('ps-scope') || 'repo';
  var pathValue = _value('ps-path').trim();
  var body = _value('ps-body');
  var frontmatter = { name: name };
  var desc = _value('ps-description').trim();
  if (desc) frontmatter.description = desc;
  if (kind === 'prompt') {
    var agent = _value('ps-agent').trim();
    var argHint = _value('ps-argument-hint').trim();
    var tools = _csv('ps-tools');
    var model = _csv('ps-model');
    if (agent) frontmatter.agent = agent;
    if (argHint) frontmatter['argument-hint'] = argHint;
    if (tools.length) frontmatter.tools = tools;
    if (model.length) frontmatter.model = model;
  } else if (kind === 'instruction') {
    var applyTo = _csv('ps-apply-to');
    if (applyTo.length) frontmatter.applyTo = applyTo.length === 1 ? applyTo[0] : applyTo;
  } else if (kind === 'agent') {
    var agentTools = _csv('ps-tools');
    var agentModel = _csv('ps-model');
    var agents = _csv('ps-agents');
    if (agentTools.length) frontmatter.tools = agentTools;
    if (agentModel.length) frontmatter.model = agentModel;
    if (agents.length) frontmatter.agents = agents;
    frontmatter['user-invocable'] = _checked('ps-user-invocable');
    frontmatter['disable-model-invocation'] = _checked('ps-disable-model-invocation');
  } else if (kind === 'skill') {
    var skillHint = _value('ps-argument-hint').trim();
    if (skillHint) frontmatter['argument-hint'] = skillHint;
    frontmatter['user-invocable'] = _checked('ps-user-invocable');
    frontmatter['disable-model-invocation'] = _checked('ps-disable-model-invocation');
  }
  var inlineHooks = _jsonObject('ps-inline-hooks');
  if (inlineHooks && Object.keys(inlineHooks).length) frontmatter.hooks = inlineHooks;
  return {
    kind: kind,
    name: name,
    scope: scope,
    path: pathValue || (record._draft ? '' : record.path || ''),
    frontmatter: frontmatter,
    body: body,
  };
}

function _value(id) {
  var el = document.getElementById(id);
  return el ? el.value || '' : '';
}
function _checked(id) {
  var el = document.getElementById(id);
  return !!(el && el.checked);
}
function _csv(id) {
  return _value(id).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}
function _jsonObject(id) {
  var raw = _value(id).trim();
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
    return parsed;
  } catch (e) {
    throw new Error('Invalid Inline Hooks JSON: ' + (e.message || String(e)));
  }
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

function _promptStudioKey(r) {
  return [r._draft ? 'draft' : r.kind || '', r.scope || '', r.path || r.name || ''].join('|');
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

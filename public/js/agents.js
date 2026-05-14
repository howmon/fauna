// ── Agent Rules ───────────────────────────────────────────────────────────
// Stored in localStorage. Injected into EVERY system prompt as hard constraints.

var AGENT_RULES_KEY = 'fauna-agent-rules';

var BUILTIN_AGENT_RULES = [
  { id: 'builtin-shell', builtin: true, enabled: true,
    text: 'Always write complete, executable shell commands inside code blocks — never output an empty code block for a command. Every code block must contain real commands.' },
  { id: 'builtin-no-simulate', builtin: true, enabled: true,
    text: 'Never simulate or invent command output. Write the actual command and let the app run it.' },
];

function loadAgentRules() {
  try { return JSON.parse(localStorage.getItem(AGENT_RULES_KEY) || '[]'); }
  catch (_) { return []; }
}

function saveAgentRules(rules) {
  localStorage.setItem(AGENT_RULES_KEY, JSON.stringify(rules.filter(function(r) { return !r.builtin; })));
  // Sync to server so mobile apps see the latest rules
  fetch('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentRules: rules.filter(function(r) { return !r.builtin; }) }) }).catch(function() {});
}

function getAllAgentRules() {
  return BUILTIN_AGENT_RULES.concat(loadAgentRules());
}

function getAgentRulesContext() {
  var active = getAllAgentRules().filter(function(r) { return r.enabled !== false; });
  if (!active.length) return '';
  return '\n\n## Agent Rules (follow these strictly in every response)\n' +
    active.map(function(r, i) { return (i + 1) + '. ' + r.text; }).join('\n');
}

function toggleAgentRules() {
  if (typeof openSettingsPage === 'function') {
    openSettingsPage('playbook');
    if (typeof switchPlaybookTab === 'function') switchPlaybookTab('agent-rules');
  }
}

function renderAgentRules() {
  var all  = getAllAgentRules();
  var list = document.getElementById('agent-rules-list');
  if (!all.length) { list.innerHTML = '<div style="color:var(--fau-text-muted);font-size:12px;padding:12px">No rules yet. Add one below.</div>'; return; }
  list.innerHTML = all.map(function(r) {
    var isOn = r.enabled !== false;
    return '<div class="agent-rule-row' + (!isOn ? ' disabled' : '') + (r.builtin ? ' builtin' : '') + '">' +
      '<div class="agent-rule-text">' + escHtml(r.text) + '</div>' +
      (r.builtin ? '<span class="agent-rule-badge">built-in</span>' : '') +
      '<div style="display:flex;gap:4px;flex-shrink:0;margin-left:4px">' +
        '<button title="' + (isOn ? 'Disable' : 'Enable') + '" ' +
          'onclick="toggleAgentRule(\'' + r.id + '\')" ' +
          'style="background:none;border:none;cursor:pointer;color:' + (isOn ? 'var(--success)' : 'var(--fau-text-muted)') + ';font-size:15px;padding:2px">' +
          '<i class="ti ti-' + (isOn ? 'toggle-right' : 'toggle-left') + '"></i></button>' +
        (!r.builtin ? '<button title="Delete" onclick="deleteAgentRule(\'' + r.id + '\')" ' +
          'style="background:none;border:none;cursor:pointer;color:var(--fau-text-muted);font-size:14px;padding:2px">' +
          '<i class="ti ti-trash"></i></button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

function addAgentRule() {
  var input = document.getElementById('agent-rule-input');
  var text  = input.value.trim();
  if (!text) return;
  var rules = loadAgentRules();
  rules.push({ id: 'ar-' + Date.now(), text: text, enabled: true });
  saveAgentRules(rules);
  input.value = '';
  renderAgentRules();
  showToast('Rule added');
}

function toggleAgentRule(id) {
  // Built-in rules toggled in BUILTIN array
  var builtin = BUILTIN_AGENT_RULES.find(function(r) { return r.id === id; });
  if (builtin) { builtin.enabled = !builtin.enabled; renderAgentRules(); return; }
  var rules = loadAgentRules();
  var rule  = rules.find(function(r) { return r.id === id; });
  if (rule) { rule.enabled = !rule.enabled; saveAgentRules(rules); renderAgentRules(); }
}

function deleteAgentRule(id) {
  var rules = loadAgentRules().filter(function(r) { return r.id !== id; });
  saveAgentRules(rules);
  renderAgentRules();
}


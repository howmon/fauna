// ── Agent Builder — 7-Step Wizard UI ─────────────────────────────────────
// Provides a full in-app wizard to create, edit, test, scan, and export agents.

var builderState = {
  step: 1,
  totalSteps: 7,
  editing: null,  // agentName if editing an existing agent, null for new
  data: {
    name: '',
    displayName: '',
    description: '',
    category: 'productivity',
    icon: 'ti-robot',
    systemPrompt: '',
    orchestrator: false,
    shared: '',       // content for shared.md — auto-included in all sub-agent prompts
    agents: [],       // sub-agent refs: ['agents/overview', ...]
    subAgents: [],    // sub-agent data: [{ name, displayName, description, icon, systemPrompt, tools }]
    permissions: {
      shell: false,
      browser: false,
      figma: false,
      fileRead: [],
      fileWrite: [],
      network: { allowedDomains: [], blockAll: true }
    },
    tools: [],        // { name, description, parameters: {}, code: '' }
    testCases: [],     // { input, expectedOutput, result?, passed? }
    scanReport: null,
    rubricAudit: null  // { findings, improvedPrompt, summary }
  }
};

var AGENT_CATEGORIES = [
  { value: 'productivity', label: 'Productivity' },
  { value: 'development', label: 'Development' },
  { value: 'design', label: 'Design' },
  { value: 'research', label: 'Research' },
  { value: 'writing', label: 'Writing' },
  { value: 'data', label: 'Data & Analysis' },
  { value: 'other', label: 'Other' }
];

var AGENT_ICONS = [
  'ti-robot', 'ti-code', 'ti-search', 'ti-pencil', 'ti-vector-triangle',
  'ti-database', 'ti-chart-bar', 'ti-terminal-2', 'ti-world-www',
  'ti-shield-check', 'ti-brain', 'ti-bolt', 'ti-bug', 'ti-git-merge',
  'ti-palette', 'ti-mail', 'ti-file-analytics', 'ti-api',
  'ti-cpu', 'ti-cloud', 'ti-package', 'ti-wand'
];

// ── Auto-generate agent name from display name ───────────────────────────

function builderAutoName(displayName) {
  builderState.data.displayName = displayName;
  if (!builderState._nameManual && !builderState.editing) {
    var slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    builderState.data.name = slug;
    var nameInput = document.getElementById('builder-name');
    if (nameInput) nameInput.value = slug;
  }
}

// ── Open / close builder ─────────────────────────────────────────────────

async function openAgentBuilder(existingAgentName) {
  resetBuilderState();
  var panel = document.getElementById('agent-builder-panel');
  if (panel) {
    panel.style.display = 'flex';
    requestAnimationFrame(function() { panel.classList.add('open'); });
  }
  if (existingAgentName) {
    // Show loading state while agent data is fetched
    renderBuilderPanel();
    await loadExistingAgent(existingAgentName);
  }
  renderBuilderPanel();
}

function closeAgentBuilder() {
  var panel = document.getElementById('agent-builder-panel');
  if (panel) {
    panel.classList.remove('open');
    setTimeout(function() { panel.style.display = 'none'; }, 250);
  }
}

function resetBuilderState() {
  builderState.step = 1;
  builderState.editing = null;
  builderState._nameManual = false;
  builderState.data = {
    name: '', displayName: '', description: '', category: 'productivity',
    icon: 'ti-robot', systemPrompt: '', orchestrator: false,
    shared: '',
    agents: [], subAgents: [],
    permissions: {
      shell: false, browser: false, figma: false,
      fileRead: [], fileWrite: [],
      network: { allowedDomains: [], blockAll: true }
    },
    tools: [], testCases: [], scanReport: null, rubricAudit: null
  };
}

async function loadExistingAgent(name) {
  try {
    var r = await fetch('/api/agents/' + encodeURIComponent(name));
    if (!r.ok) return;
    var agent = await r.json();
    builderState.editing = name;
    builderState.data.name = agent.name || '';
    builderState.data.displayName = agent.displayName || '';
    builderState.data.description = agent.description || '';
    builderState.data.category = agent.category || 'productivity';
    builderState.data.icon = agent.icon || 'ti-robot';
    builderState.data.systemPrompt = agent.systemPrompt || '';
    builderState.data.orchestrator = agent.orchestrator || false;
    builderState.data.shared = agent._shared || '';
    // Load sub-agent references and data
    if (agent.agents && Array.isArray(agent.agents)) {
      builderState.data.agents = agent.agents;
    }
    if (agent._subAgents && Array.isArray(agent._subAgents)) {
      builderState.data.subAgents = agent._subAgents.map(function(s) {
        return {
          name: s.name || '',
          displayName: s.displayName || s.name || '',
          description: s.description || '',
          icon: s.icon || 'ti-robot',
          systemPrompt: s.systemPrompt || '',
          tools: []
        };
      });
    }
    if (agent.permissions) {
      builderState.data.permissions = Object.assign({}, builderState.data.permissions, agent.permissions);
    }
    // Load tools if present
    try {
      var tr = await fetch('/api/agents/' + encodeURIComponent(name) + '/tools');
      if (tr.ok) {
        var td = await tr.json();
        builderState.data.tools = (td.tools || []).map(function(t) {
          return { name: t.name, description: t.description, parameters: t.parameters || {}, code: t.code || '' };
        });
      }
    } catch (_) {}
  } catch (_) {
    showToast('Failed to load agent for editing');
  }
}

// ── Render main panel ────────────────────────────────────────────────────

function renderBuilderPanel() {
  var panel = document.getElementById('agent-builder-panel');
  if (!panel) return;
  var d = builderState.data;
  var step = builderState.step;

  var stepsHtml = renderStepIndicator();
  var bodyHtml = '';

  switch (step) {
    case 1: bodyHtml = renderStep1BasicInfo(); break;
    case 2: bodyHtml = renderStep2SystemPrompt(); break;
    case 3: bodyHtml = renderStep3Permissions(); break;
    case 4: bodyHtml = renderStep4Tools(); break;
    case 5: bodyHtml = renderStep5TestCases(); break;
    case 6: bodyHtml = renderStep6Scan(); break;
    case 7: bodyHtml = renderStep7Review(); break;
  }

  var navHtml = '<div class="builder-nav">';
  if (step > 1) {
    navHtml += '<button class="builder-btn secondary" onclick="builderPrev()"><i class="ti ti-arrow-left"></i> Back</button>';
  } else {
    navHtml += '<button class="builder-btn secondary" onclick="closeAgentBuilder()">Cancel</button>';
  }
  navHtml += '<span class="builder-nav-spacer"></span>';
  if (step < 7) {
    navHtml += '<button class="builder-btn primary" onclick="builderNext()">Next <i class="ti ti-arrow-right"></i></button>';
  } else {
    navHtml += '<button class="builder-btn primary" onclick="builderSave()"><i class="ti ti-device-floppy"></i> Save Agent</button>';
    navHtml += '<button class="builder-btn secondary" onclick="builderExport()"><i class="ti ti-package-export"></i> Export</button>';
    navHtml += '<button class="builder-btn accent" onclick="builderPublish()"><i class="ti ti-upload"></i> Publish</button>';
  }
  navHtml += '</div>';

  panel.innerHTML =
    '<div class="builder-header">' +
      '<span class="builder-title"><i class="ti ti-hammer"></i> ' + (builderState.editing ? 'Edit Agent' : 'Create Agent') + '</span>' +
      '<button class="builder-btn-icon" onclick="openAgentCodeView()" title="Code View"><i class="ti ti-code"></i></button>' +
      '<button class="builder-close" onclick="closeAgentBuilder()"><i class="ti ti-x"></i></button>' +
    '</div>' +
    stepsHtml +
    '<div class="builder-body">' + bodyHtml + '</div>' +
    navHtml;
}

// ── Step indicator ───────────────────────────────────────────────────────

function renderStepIndicator() {
  var labels = ['Info', 'Prompt', 'Permissions', 'Tools', 'Tests', 'Scan', 'Review'];
  var html = '<div class="builder-steps">';
  for (var i = 0; i < labels.length; i++) {
    var cls = 'builder-step-dot';
    if (i + 1 < builderState.step) cls += ' done';
    else if (i + 1 === builderState.step) cls += ' active';
    html += '<div class="' + cls + '" onclick="builderGoTo(' + (i + 1) + ')" title="Step ' + (i + 1) + ': ' + labels[i] + '">' +
      '<span class="builder-step-num">' + (i + 1) + '</span>' +
      '<span class="builder-step-label">' + labels[i] + '</span>' +
    '</div>';
    if (i < labels.length - 1) html += '<div class="builder-step-line' + (i + 1 < builderState.step ? ' done' : '') + '"></div>';
  }
  html += '</div>';
  return html;
}

// ── Step 1: Basic Info ───────────────────────────────────────────────────

function renderStep1BasicInfo() {
  var d = builderState.data;
  var catOptions = AGENT_CATEGORIES.map(function(c) {
    return '<option value="' + c.value + '"' + (d.category === c.value ? ' selected' : '') + '>' + c.label + '</option>';
  }).join('');

  var iconGrid = AGENT_ICONS.map(function(ic) {
    return '<div class="builder-icon-opt' + (d.icon === ic ? ' selected' : '') + '" onclick="builderSelectIcon(\'' + ic + '\')" title="' + ic + '"><i class="ti ' + ic + '"></i></div>';
  }).join('');

  var aiSection = builderState.editing ? '' :
    '<div class="builder-ai-generate">' +
      '<div class="builder-ai-header">' +
        '<i class="ti ti-sparkles" style="color:var(--accent)"></i>' +
        '<span>Describe your agent and AI will fill in everything</span>' +
      '</div>' +
      '<textarea class="builder-textarea" id="builder-ai-desc" rows="3" placeholder="e.g. An agent that reviews pull requests, checks for security issues, and suggests improvements…"></textarea>' +
      '<button class="builder-btn accent" id="builder-ai-gen-btn" onclick="builderAIGenerate()"><i class="ti ti-sparkles"></i> Generate Agent</button>' +
    '</div>' +
    '<div class="builder-ai-divider"><span>or fill in manually</span></div>';

  return '<div class="builder-section">' +
    aiSection +

    '<label class="builder-label">Display Name</label>' +
    '<input class="builder-input" id="builder-display-name" value="' + escHtml(d.displayName) + '" placeholder="My Agent" oninput="builderAutoName(this.value)">' +

    '<label class="builder-label">Agent Name <span class="builder-hint">' + (builderState.editing ? '(read-only)' : '(auto-generated, editable)') + '</span></label>' +
    '<input class="builder-input" id="builder-name" value="' + escHtml(d.name) + '" placeholder="my-agent" oninput="builderState.data.name=this.value.replace(/[^a-zA-Z0-9_-]/g,\'\');builderState._nameManual=true"' + (builderState.editing ? ' disabled style="opacity:0.6;cursor:not-allowed"' : '') + '>' +

    '<label class="builder-label">Description</label>' +
    '<textarea class="builder-textarea" id="builder-desc" rows="2" placeholder="Brief description of what this agent does" oninput="builderState.data.description=this.value">' + escHtml(d.description) + '</textarea>' +

    (builderState.editing ?
      '<label class="builder-label">Changelog <span class="builder-hint">(describe what changed in this update)</span></label>' +
      '<textarea class="builder-textarea" id="builder-changelog" rows="2" placeholder="e.g. Improved response accuracy, added new tool…" oninput="builderState.data.changelog=this.value">' + escHtml(d.changelog || '') + '</textarea>'
    : '') +

    '<label class="builder-label">Category</label>' +
    '<select class="builder-select" id="builder-category" onchange="builderState.data.category=this.value">' + catOptions + '</select>' +

    '<label class="builder-label">Icon</label>' +
    '<div class="builder-icon-grid">' + iconGrid +
      '<div class="builder-icon-opt builder-icon-upload' + (d.icon && d.icon.startsWith('custom:') ? ' selected' : '') + '" onclick="document.getElementById(\'builder-icon-file\').click()" title="Upload custom image">' +
        (d.icon && d.icon.startsWith('custom:') ? '<img src="/api/agents/' + encodeURIComponent(d.name) + '/icon" class="builder-icon-preview">' : '<i class="ti ti-photo-plus"></i>') +
      '</div>' +
    '</div>' +
    '<input type="file" id="builder-icon-file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" style="display:none" onchange="builderUploadIcon(this.files)">' +
  '</div>';
}

function builderSelectIcon(icon) {
  builderState.data.icon = icon;
  builderState.data._customIconData = null; // clear any pending custom icon
  renderBuilderPanel();
}

function builderUploadIcon(files) {
  if (!files || !files.length) return;
  var file = files[0];
  if (file.size > 2 * 1024 * 1024) { showToast('Icon must be under 2 MB'); return; }

  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      // Resize to 64x64 using canvas
      var canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      var ctx = canvas.getContext('2d');
      // Draw centered/cropped (cover)
      var scale = Math.max(64 / img.width, 64 / img.height);
      var w = img.width * scale;
      var h = img.height * scale;
      ctx.drawImage(img, (64 - w) / 2, (64 - h) / 2, w, h);
      var dataUrl = canvas.toDataURL('image/png');
      builderState.data.icon = 'custom:icon.png';
      builderState.data._customIconData = dataUrl;
      renderBuilderPanel();
    };
    img.onerror = function() { showToast('Could not read image'); };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ── AI Generate Agent ────────────────────────────────────────────────────

async function builderAIGenerate() {
  var descEl = document.getElementById('builder-ai-desc');
  if (!descEl || !descEl.value.trim()) { showToast('Describe the agent you want to create'); return; }

  var btn = document.getElementById('builder-ai-gen-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader builder-spin"></i> Generating…'; }

  try {
    var r = await fetch('/api/agent-builder/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: descEl.value.trim(), model: state.model || 'gpt-4.1' })
    });
    var config = await r.json();
    if (config.error) { showToast('Generation failed: ' + config.error); return; }

    // Populate builder state
    if (config.displayName) builderState.data.displayName = config.displayName;
    if (config.name) builderState.data.name = config.name;
    if (config.description) builderState.data.description = config.description;
    if (config.category) builderState.data.category = config.category;
    if (config.icon && AGENT_ICONS.indexOf(config.icon) !== -1) builderState.data.icon = config.icon;
    if (config.systemPrompt) builderState.data.systemPrompt = config.systemPrompt;
    if (config.permissions) {
      builderState.data.permissions = Object.assign({}, builderState.data.permissions, {
        shell: !!config.permissions.shell,
        browser: !!config.permissions.browser,
        figma: !!config.permissions.figma,
        fileRead: Array.isArray(config.permissions.fileRead) ? config.permissions.fileRead : [],
        fileWrite: Array.isArray(config.permissions.fileWrite) ? config.permissions.fileWrite : [],
        network: config.permissions.network ? {
          allowedDomains: Array.isArray(config.permissions.network.allowedDomains) ? config.permissions.network.allowedDomains : [],
          blockAll: config.permissions.network.blockAll !== false
        } : builderState.data.permissions.network
      });
    }

    // Populate tools
    if (Array.isArray(config.tools) && config.tools.length) {
      builderState.data.tools = config.tools.map(function(t) {
        return {
          name: (t.name || 'tool').replace(/[^a-zA-Z0-9_]/g, ''),
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
          code: t.code || ''
        };
      });
    }

    // Populate test cases
    if (Array.isArray(config.testCases) && config.testCases.length) {
      builderState.data.testCases = config.testCases.map(function(tc) {
        return {
          input: tc.input || '',
          expectedOutput: tc.expectedOutput || '',
          result: null,
          passed: null
        };
      });
    }

    // Populate orchestrator + sub-agents + shared
    if (config.orchestrator) {
      builderState.data.orchestrator = true;
      if (typeof config.shared === 'string') builderState.data.shared = config.shared;
      if (Array.isArray(config.subAgents) && config.subAgents.length) {
        builderState.data.subAgents = config.subAgents.map(function(s, i) {
          return {
            name: (s.name || ('sub-agent-' + (i + 1))).replace(/[^a-zA-Z0-9_-]/g, '-'),
            displayName: s.displayName || s.name || ('Sub Agent ' + (i + 1)),
            description: s.description || '',
            icon: (s.icon && AGENT_ICONS.indexOf(s.icon) !== -1) ? s.icon : 'ti-robot',
            systemPrompt: s.systemPrompt || '',
            tools: []
          };
        });
        syncSubAgentRefs();
      }
    }

    showToast('Agent generated! Review and adjust the details.');
    renderBuilderPanel();
  } catch (e) {
    showToast('Failed to generate agent');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-sparkles"></i> Generate Agent'; }
  }
}

// ── Step 2: System Prompt ────────────────────────────────────────────────

function renderStep2SystemPrompt() {
  var d = builderState.data;
  var tokenCount = Math.ceil(d.systemPrompt.length / 4); // rough token estimate

  return '<div class="builder-section">' +
    '<label class="builder-label">System Prompt</label>' +
    '<p class="builder-hint-block">Define the agent\'s personality, capabilities, and workflow. This will be injected as a system message when the agent is active.</p>' +
    '<textarea class="builder-textarea builder-prompt-editor" id="builder-prompt" rows="16" placeholder="You are an agent that..." oninput="builderUpdatePrompt()">' + escHtml(d.systemPrompt) + '</textarea>' +
    '<div class="builder-prompt-meta">' +
      '<span class="builder-token-count">~' + tokenCount + ' tokens</span>' +
      '<button class="builder-btn small" onclick="builderTestPrompt()"><i class="ti ti-player-play"></i> Test Prompt</button>' +
    '</div>' +
    '<div id="builder-prompt-preview" class="builder-preview" style="display:none"></div>' +
  '</div>';
}

function builderUpdatePrompt() {
  var el = document.getElementById('builder-prompt');
  if (el) {
    builderState.data.systemPrompt = el.value;
    var count = Math.ceil(el.value.length / 4);
    var countEl = el.parentElement.querySelector('.builder-token-count');
    if (countEl) countEl.textContent = '~' + count + ' tokens';
  }
}

async function builderTestPrompt() {
  var prompt = builderState.data.systemPrompt;
  if (!prompt.trim()) { showToast('Enter a system prompt first'); return; }

  var preview = document.getElementById('builder-prompt-preview');
  if (!preview) return;
  preview.style.display = 'block';
  preview.innerHTML = '<div class="builder-loading"><i class="ti ti-loader"></i> Testing prompt…</div>';

  try {
    var r = await fetch('/api/agent-builder/test-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: prompt, testMessage: 'What can you help me with?', model: state.model })
    });
    var d = await r.json();
    preview.innerHTML = '<div class="builder-test-result">' +
      '<div class="builder-test-label">Agent response preview:</div>' +
      '<div class="builder-test-output">' + escHtml(d.response || d.error || 'No response') + '</div>' +
    '</div>';
  } catch (_) {
    preview.innerHTML = '<div class="builder-test-result error">Failed to test prompt</div>';
  }
}

// ── Step 3: Permissions ──────────────────────────────────────────────────

function renderStep3Permissions() {
  var p = builderState.data.permissions;

  var fileReadList = (p.fileRead || []).map(function(path, i) {
    return '<div class="builder-path-item"><span>' + escHtml(path) + '</span><button class="builder-path-rm" onclick="builderRemovePath(\'fileRead\',' + i + ')"><i class="ti ti-x"></i></button></div>';
  }).join('') || '<div class="builder-hint-inline">No paths added</div>';

  var fileWriteList = (p.fileWrite || []).map(function(path, i) {
    return '<div class="builder-path-item"><span>' + escHtml(path) + '</span><button class="builder-path-rm" onclick="builderRemovePath(\'fileWrite\',' + i + ')"><i class="ti ti-x"></i></button></div>';
  }).join('') || '<div class="builder-hint-inline">No paths added</div>';

  var domainList = (p.network.allowedDomains || []).map(function(d, i) {
    return '<div class="builder-path-item"><span>' + escHtml(d) + '</span><button class="builder-path-rm" onclick="builderRemoveDomain(' + i + ')"><i class="ti ti-x"></i></button></div>';
  }).join('') || '<div class="builder-hint-inline">No domains added</div>';

  return '<div class="builder-section">' +
    '<p class="builder-hint-block">Configure what this agent is allowed to do. Fewer permissions = higher security score.</p>' +

    '<div class="builder-perm-row">' +
      '<label class="builder-toggle"><input type="checkbox"' + (builderState.data.orchestrator ? ' checked' : '') + ' onchange="builderState.data.orchestrator=this.checked;renderBuilderPanel()"><span class="builder-toggle-slider"></span></label>' +
      '<div class="builder-perm-info"><span class="builder-perm-name"><i class="ti ti-hierarchy-3"></i> Orchestrator Mode</span><span class="builder-perm-desc">Can delegate tasks to other agents and coordinate their responses</span></div>' +
    '</div>' +

    // Sub-agents section — visible when orchestrator is on
    (builderState.data.orchestrator ? renderSubAgentsSection() : '') +

    '<div class="builder-perm-row">' +
      '<label class="builder-toggle"><input type="checkbox"' + (p.shell ? ' checked' : '') + ' onchange="builderState.data.permissions.shell=this.checked"><span class="builder-toggle-slider"></span></label>' +
      '<div class="builder-perm-info"><span class="builder-perm-name"><i class="ti ti-terminal-2"></i> Shell Access</span><span class="builder-perm-desc">Execute shell commands</span></div>' +
    '</div>' +

    '<div class="builder-perm-row">' +
      '<label class="builder-toggle"><input type="checkbox"' + (p.browser ? ' checked' : '') + ' onchange="builderState.data.permissions.browser=this.checked"><span class="builder-toggle-slider"></span></label>' +
      '<div class="builder-perm-info"><span class="builder-perm-name"><i class="ti ti-world-www"></i> Browser Access</span><span class="builder-perm-desc">Open browser pane and browse web</span></div>' +
    '</div>' +

    '<div class="builder-perm-row">' +
      '<label class="builder-toggle"><input type="checkbox"' + (p.figma ? ' checked' : '') + ' onchange="builderState.data.permissions.figma=this.checked"><span class="builder-toggle-slider"></span></label>' +
      '<div class="builder-perm-info"><span class="builder-perm-name"><i class="ti ti-vector-triangle"></i> Figma Access</span><span class="builder-perm-desc">Read and modify Figma designs via MCP</span></div>' +
    '</div>' +

    '<div class="builder-perm-section">' +
      '<label class="builder-label"><i class="ti ti-folder"></i> Readable Folders</label>' +
      '<span class="builder-hint-inline" style="margin-bottom:6px;display:block">Folders (and all their contents) the agent can read. Use ~ for home directory.</span>' +
      '<div class="builder-path-list">' + fileReadList + '</div>' +
      '<div class="builder-path-add"><input class="builder-input small" id="builder-fr-input" placeholder="~/Documents" onkeydown="if(event.key===\'Enter\')builderAddPath(\'fileRead\')"><button class="builder-btn small" onclick="builderAddPath(\'fileRead\')"><i class="ti ti-plus"></i></button></div>' +
    '</div>' +

    '<div class="builder-perm-section">' +
      '<label class="builder-label"><i class="ti ti-folder-filled"></i> Writable Folders</label>' +
      '<span class="builder-hint-inline" style="margin-bottom:6px;display:block">Folders the agent can create or overwrite files in.</span>' +
      '<div class="builder-path-list">' + fileWriteList + '</div>' +
      '<div class="builder-path-add"><input class="builder-input small" id="builder-fw-input" placeholder="~/Output" onkeydown="if(event.key===\'Enter\')builderAddPath(\'fileWrite\')"><button class="builder-btn small" onclick="builderAddPath(\'fileWrite\')"><i class="ti ti-plus"></i></button></div>' +
    '</div>' +

    '<div class="builder-perm-section">' +
      '<div class="builder-perm-row" style="margin-bottom:6px">' +
        '<label class="builder-toggle"><input type="checkbox"' + (p.network.blockAll ? ' checked' : '') + ' onchange="builderState.data.permissions.network.blockAll=this.checked;renderBuilderPanel()"><span class="builder-toggle-slider"></span></label>' +
        '<div class="builder-perm-info"><span class="builder-perm-name"><i class="ti ti-cloud-off"></i> Block All Network</span><span class="builder-perm-desc">Block all outbound HTTP requests</span></div>' +
      '</div>' +
      (p.network.blockAll ? '' :
        '<label class="builder-label"><i class="ti ti-world"></i> Allowed Domains</label>' +
        '<div class="builder-path-list">' + domainList + '</div>' +
        '<div class="builder-path-add"><input class="builder-input small" id="builder-domain-input" placeholder="api.example.com" onkeydown="if(event.key===\'Enter\')builderAddDomain()"><button class="builder-btn small" onclick="builderAddDomain()"><i class="ti ti-plus"></i></button></div>'
      ) +
    '</div>' +
  '</div>';
}

function builderAddPath(type) {
  var inputId = type === 'fileRead' ? 'builder-fr-input' : 'builder-fw-input';
  var el = document.getElementById(inputId);
  if (!el || !el.value.trim()) return;
  builderState.data.permissions[type].push(el.value.trim());
  renderBuilderPanel();
}

function builderRemovePath(type, idx) {
  builderState.data.permissions[type].splice(idx, 1);
  renderBuilderPanel();
}

function builderAddDomain() {
  var el = document.getElementById('builder-domain-input');
  if (!el || !el.value.trim()) return;
  builderState.data.permissions.network.allowedDomains.push(el.value.trim());
  renderBuilderPanel();
}

function builderRemoveDomain(idx) {
  builderState.data.permissions.network.allowedDomains.splice(idx, 1);
  renderBuilderPanel();
}

// ── Sub-agents section (inside Permissions step when orchestrator is on) ─

function renderSubAgentsSection() {
  var subs = builderState.data.subAgents;
  var html = '<div class="builder-subagents-section">' +
    '<div class="builder-subagents-header">' +
      '<span class="builder-perm-name"><i class="ti ti-git-branch"></i> Sub-Agents (' + subs.length + ')</span>' +
      '<button class="builder-btn secondary small" onclick="builderAddSubAgent()"><i class="ti ti-plus"></i> Add</button>' +
    '</div>' +
    '<p class="builder-hint-inline">Bundled sub-agents that work as part of this orchestrator. Each gets its own system prompt and can be delegated to.</p>' +
    '<div class="builder-perm-section builder-shared-section">' +
      '<label class="builder-label"><i class="ti ti-file-description"></i> Shared Prompt (shared.md)</label>' +
      '<p class="builder-hint-inline" style="margin-bottom:6px">Content appended automatically to every sub-agent\'s system prompt.</p>' +
      '<textarea class="builder-input" rows="6" placeholder="Shared infrastructure, component keys, font helpers, design tokens, etc." style="resize:vertical;font-family:monospace;font-size:12px" onchange="builderState.data.shared=this.value" oninput="builderState.data.shared=this.value">' + escHtml(builderState.data.shared || '') + '</textarea>' +
    '</div>' +
    '<div style="height:1px;background:var(--border);margin:10px 0"></div>';

  if (subs.length) {
    html += '<div class="builder-subagents-list">';
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      html += '<div class="builder-subagent-row">' +
        '<div class="builder-subagent-icon"><i class="ti ' + escHtml(s.icon || 'ti-robot') + '"></i></div>' +
        '<div class="builder-subagent-info">' +
          '<input class="builder-input small" value="' + escHtml(s.displayName) + '" placeholder="Sub-agent name" onchange="builderUpdateSubAgent(' + i + ',\'displayName\',this.value)">' +
        '</div>' +
        '<div class="builder-subagent-actions">' +
          '<button class="builder-btn secondary small" onclick="builderEditSubAgent(' + i + ')" title="Edit prompt"><i class="ti ti-pencil"></i></button>' +
          '<button class="builder-btn secondary small" onclick="builderRemoveSubAgent(' + i + ')" title="Remove"><i class="ti ti-trash"></i></button>' +
        '</div>' +
      '</div>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function builderAddSubAgent() {
  var idx = builderState.data.subAgents.length + 1;
  builderState.data.subAgents.push({
    name: 'sub-agent-' + idx,
    displayName: 'Sub Agent ' + idx,
    description: '',
    icon: 'ti-robot',
    systemPrompt: '',
    tools: []
  });
  // Update agents refs array to match
  syncSubAgentRefs();
  renderBuilderPanel();
}

function builderRemoveSubAgent(idx) {
  builderState.data.subAgents.splice(idx, 1);
  syncSubAgentRefs();
  renderBuilderPanel();
}

function builderUpdateSubAgent(idx, field, value) {
  builderState.data.subAgents[idx][field] = value;
  // Auto-generate slug from displayName
  if (field === 'displayName') {
    var slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    builderState.data.subAgents[idx].name = slug;
  }
  syncSubAgentRefs();
}

function builderEditSubAgent(idx) {
  var sub = builderState.data.subAgents[idx];
  // Open a modal-style editor for the sub-agent's prompt
  var panel = document.getElementById('agent-builder-panel');
  if (!panel) return;
  var overlay = document.createElement('div');
  overlay.className = 'builder-subagent-editor';
  overlay.innerHTML =
    '<div class="builder-subagent-editor-inner">' +
      '<div class="builder-subagent-editor-header">' +
        '<span><i class="ti ' + escHtml(sub.icon || 'ti-robot') + '"></i> ' + escHtml(sub.displayName) + '</span>' +
        '<button class="builder-btn secondary small" onclick="this.closest(\'.builder-subagent-editor\').remove()"><i class="ti ti-x"></i></button>' +
      '</div>' +
      '<label class="builder-label">Description</label>' +
      '<input class="builder-input" id="subagent-edit-desc" value="' + escHtml(sub.description) + '" placeholder="What does this sub-agent do?">' +
      '<label class="builder-label">Icon</label>' +
      '<div class="builder-icon-grid" id="subagent-icon-grid">' +
        AGENT_ICONS.map(function(ic) {
          return '<div class="builder-icon-opt' + (sub.icon === ic ? ' selected' : '') + '" onclick="builderSelectSubAgentIcon(' + idx + ',\'' + ic + '\')" title="' + ic + '"><i class="ti ' + ic + '"></i></div>';
        }).join('') +
      '</div>' +
      '<label class="builder-label">System Prompt</label>' +
      '<textarea class="builder-textarea" id="subagent-edit-prompt" rows="12" placeholder="System prompt for this sub-agent…">' + escHtml(sub.systemPrompt) + '</textarea>' +
      '<div class="builder-subagent-editor-actions">' +
        '<button class="builder-btn primary" onclick="builderSaveSubAgentEdit(' + idx + ')"><i class="ti ti-check"></i> Save</button>' +
        '<button class="builder-btn secondary" onclick="this.closest(\'.builder-subagent-editor\').remove()">Cancel</button>' +
      '</div>' +
    '</div>';
  panel.appendChild(overlay);
}

function builderSaveSubAgentEdit(idx) {
  var desc = document.getElementById('subagent-edit-desc');
  var prompt = document.getElementById('subagent-edit-prompt');
  if (desc) builderState.data.subAgents[idx].description = desc.value;
  if (prompt) builderState.data.subAgents[idx].systemPrompt = prompt.value;
  var overlay = document.querySelector('.builder-subagent-editor');
  if (overlay) overlay.remove();
  renderBuilderPanel();
}

function builderSelectSubAgentIcon(idx, icon) {
  builderState.data.subAgents[idx].icon = icon;
  var grid = document.getElementById('subagent-icon-grid');
  if (grid) {
    grid.querySelectorAll('.builder-icon-opt').forEach(function(el) { el.classList.remove('selected'); });
    grid.querySelectorAll('.builder-icon-opt').forEach(function(el) {
      if (el.querySelector('.ti').classList.contains(icon)) el.classList.add('selected');
    });
  }
}

function syncSubAgentRefs() {
  builderState.data.agents = builderState.data.subAgents.map(function(s) {
    return 'agents/' + s.name;
  });
}

// ── Step 4: Tools ────────────────────────────────────────────────────────

function renderStep4Tools() {
  var tools = builderState.data.tools;

  var toolList = '';
  if (tools.length) {
    toolList = tools.map(function(t, i) {
      return '<div class="builder-tool-card">' +
        '<div class="builder-tool-header">' +
          '<span class="builder-tool-name"><i class="ti ti-puzzle"></i> ' + escHtml(t.name) + '</span>' +
          '<div class="builder-tool-actions">' +
            '<button class="builder-btn small" onclick="builderEditTool(' + i + ')"><i class="ti ti-edit"></i></button>' +
            '<button class="builder-btn small danger" onclick="builderRemoveTool(' + i + ')"><i class="ti ti-trash"></i></button>' +
          '</div>' +
        '</div>' +
        '<div class="builder-tool-desc">' + escHtml(t.description || 'No description') + '</div>' +
      '</div>';
    }).join('');
  } else {
    toolList = '<div class="builder-empty-state"><i class="ti ti-puzzle"></i><p>No custom tools yet</p></div>';
  }

  return '<div class="builder-section">' +
    '<p class="builder-hint-block">Define custom JavaScript tools that the agent can call. Tools run in a sandboxed environment.</p>' +
    '<div class="builder-tool-list">' + toolList + '</div>' +
    '<button class="builder-btn primary" onclick="builderAddTool()"><i class="ti ti-plus"></i> Add Tool</button>' +
    '<div id="builder-tool-editor" style="display:none"></div>' +
  '</div>';
}

function builderAddTool() {
  var idx = builderState.data.tools.length;
  builderState.data.tools.push({
    name: 'tool_' + (idx + 1),
    description: '',
    parameters: { type: 'object', properties: {} },
    code: '// Tool code runs in a sandbox with:\n// - context.fetch(url) for HTTP requests\n// - context.readFile(path) for reading files\n// - context.writeFile(path, content) for writing files\n// - context.store for persistent key-value storage\n\nmodule.exports = async function(args, context) {\n  // Your tool logic here\n  return { result: "hello" };\n};'
  });
  builderEditTool(idx);
}

function builderRemoveTool(idx) {
  builderState.data.tools.splice(idx, 1);
  renderBuilderPanel();
}

function builderEditTool(idx) {
  var tool = builderState.data.tools[idx];
  if (!tool) return;

  var editor = document.getElementById('builder-tool-editor');
  if (!editor) return;
  editor.style.display = 'block';

  editor.innerHTML =
    '<div class="builder-tool-edit">' +
      '<label class="builder-label">Tool Name</label>' +
      '<input class="builder-input" value="' + escHtml(tool.name) + '" oninput="builderState.data.tools[' + idx + '].name=this.value.replace(/[^a-zA-Z0-9_]/g,\'\')">' +

      '<label class="builder-label">Description</label>' +
      '<input class="builder-input" value="' + escHtml(tool.description) + '" oninput="builderState.data.tools[' + idx + '].description=this.value" placeholder="What does this tool do?">' +

      '<label class="builder-label">Parameters (JSON Schema)</label>' +
      '<textarea class="builder-textarea builder-code" rows="4" oninput="builderUpdateToolParams(' + idx + ',this.value)">' + escHtml(JSON.stringify(tool.parameters, null, 2)) + '</textarea>' +

      '<label class="builder-label">Code</label>' +
      '<textarea class="builder-textarea builder-code" rows="12" oninput="builderState.data.tools[' + idx + '].code=this.value">' + escHtml(tool.code) + '</textarea>' +

      '<div class="builder-tool-edit-actions">' +
        '<button class="builder-btn small" onclick="builderTestTool(' + idx + ')"><i class="ti ti-player-play"></i> Test Tool</button>' +
        '<button class="builder-btn small secondary" onclick="document.getElementById(\'builder-tool-editor\').style.display=\'none\'">Close Editor</button>' +
      '</div>' +
      '<div id="builder-tool-test-result-' + idx + '" class="builder-preview" style="display:none"></div>' +
    '</div>';
}

function builderUpdateToolParams(idx, val) {
  try {
    builderState.data.tools[idx].parameters = JSON.parse(val);
  } catch (_) {
    // Invalid JSON — ignore until valid
  }
}

async function builderTestTool(idx) {
  var tool = builderState.data.tools[idx];
  if (!tool) return;
  var resultEl = document.getElementById('builder-tool-test-result-' + idx);
  if (!resultEl) return;

  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div class="builder-loading"><i class="ti ti-loader"></i> Testing tool…</div>';

  try {
    var r = await fetch('/api/agent-builder/test-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: tool, args: {} })
    });
    var d = await r.json();
    if (d.error) {
      resultEl.innerHTML = '<div class="builder-test-result error"><i class="ti ti-alert-triangle"></i> ' + escHtml(d.error) + '</div>';
    } else {
      resultEl.innerHTML = '<div class="builder-test-result success"><i class="ti ti-check"></i> Success<pre>' + escHtml(JSON.stringify(d.result, null, 2)) + '</pre></div>';
    }
  } catch (e) {
    resultEl.innerHTML = '<div class="builder-test-result error">Test failed: ' + escHtml(e.message) + '</div>';
  }
}

// ── Step 5: Test Cases ───────────────────────────────────────────────────

function renderStep5TestCases() {
  var cases = builderState.data.testCases;

  var caseList = '';
  if (cases.length) {
    caseList = cases.map(function(tc, i) {
      var statusCls = tc.passed === true ? 'pass' : tc.passed === false ? 'fail' : '';
      var statusIcon = tc.passed === true ? '<i class="ti ti-check"></i>' : tc.passed === false ? '<i class="ti ti-x"></i>' : '<i class="ti ti-clock"></i>';
      return '<div class="builder-test-card ' + statusCls + '">' +
        '<div class="builder-test-card-header">' +
          '<span class="builder-test-status">' + statusIcon + '</span>' +
          '<span class="builder-test-title">Test #' + (i + 1) + '</span>' +
          '<button class="builder-btn small danger" onclick="builderRemoveTest(' + i + ')"><i class="ti ti-trash"></i></button>' +
        '</div>' +
        '<div class="builder-test-io">' +
          '<div><strong>Input:</strong> ' + escHtml(tc.input.substring(0, 100)) + '</div>' +
          '<div><strong>Expected:</strong> ' + escHtml(tc.expectedOutput.substring(0, 100)) + '</div>' +
          (tc.result ? '<div><strong>Got:</strong> ' + escHtml(String(tc.result).substring(0, 100)) + '</div>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  } else {
    caseList = '<div class="builder-empty-state"><i class="ti ti-test-pipe"></i><p>No test cases yet</p></div>';
  }

  var passCount = cases.filter(function(c) { return c.passed === true; }).length;
  var failCount = cases.filter(function(c) { return c.passed === false; }).length;
  var pendingCount = cases.length - passCount - failCount;

  var summaryHtml = cases.length ? '<div class="builder-test-summary">' +
    '<span class="builder-test-pass">' + passCount + ' passed</span>' +
    '<span class="builder-test-fail">' + failCount + ' failed</span>' +
    '<span class="builder-test-pending">' + pendingCount + ' pending</span>' +
  '</div>' : '';

  return '<div class="builder-section">' +
    '<p class="builder-hint-block">Add test cases to verify your agent works correctly. Tests run in the sandbox.</p>' +
    summaryHtml +
    '<div class="builder-test-list">' + caseList + '</div>' +

    '<div class="builder-test-add">' +
      '<label class="builder-label">Add Test Case</label>' +
      '<input class="builder-input" id="builder-test-input" placeholder="User message to test">' +
      '<input class="builder-input" id="builder-test-expected" placeholder="Expected response (substring match)">' +
      '<div class="builder-test-add-actions">' +
        '<button class="builder-btn primary" onclick="builderAddTest()"><i class="ti ti-plus"></i> Add Test</button>' +
        (cases.length ? '<button class="builder-btn accent" onclick="builderRunAllTests()"><i class="ti ti-player-play"></i> Run All Tests</button>' : '') +
      '</div>' +
    '</div>' +
  '</div>';
}

function builderAddTest() {
  var inputEl = document.getElementById('builder-test-input');
  var expectedEl = document.getElementById('builder-test-expected');
  if (!inputEl || !inputEl.value.trim()) return;
  builderState.data.testCases.push({
    input: inputEl.value.trim(),
    expectedOutput: (expectedEl && expectedEl.value.trim()) || '',
    result: null,
    passed: null
  });
  renderBuilderPanel();
}

function builderRemoveTest(idx) {
  builderState.data.testCases.splice(idx, 1);
  renderBuilderPanel();
}

async function builderRunAllTests() {
  var cases = builderState.data.testCases;
  if (!cases.length) return;
  showToast('Running ' + cases.length + ' test(s)…');

  for (var i = 0; i < cases.length; i++) {
    var tc = cases[i];
    try {
      var r = await fetch('/api/agent-builder/test-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt: builderState.data.systemPrompt, testMessage: tc.input, model: state.model })
      });
      var d = await r.json();
      tc.result = d.response || '';
      if (tc.expectedOutput) {
        tc.passed = tc.result.toLowerCase().indexOf(tc.expectedOutput.toLowerCase()) !== -1;
      } else {
        tc.passed = tc.result.length > 0;
      }
    } catch (_) {
      tc.result = 'Error running test';
      tc.passed = false;
    }
  }
  renderBuilderPanel();
  var passed = cases.filter(function(c) { return c.passed; }).length;
  showToast(passed + '/' + cases.length + ' tests passed');
}

// ── Step 6: Security Scan ────────────────────────────────────────────────

function renderStep6Scan() {
  var report = builderState.data.scanReport;

  if (!report) {
    return '<div class="builder-section">' +
      '<p class="builder-hint-block">Run a security scan to check your agent for vulnerabilities before saving or publishing. Agents need a minimum score of 80/100 to publish.</p>' +
      '<div class="builder-scan-cta">' +
        '<i class="ti ti-shield-check builder-scan-icon"></i>' +
        '<button class="builder-btn primary" onclick="builderRunScan()"><i class="ti ti-scan"></i> Run Security Scan</button>' +
      '</div>' +
    '</div>';
  }

  // Show scan results
  var badge = report.score >= 90 ? '<i class="ti ti-circle-check" style="color:#22c55e"></i>' : report.score >= 80 ? '<i class="ti ti-alert-triangle" style="color:#eab308"></i>' : '<i class="ti ti-circle-x" style="color:#ef4444"></i>';
  var status = report.passed ? 'PASSED' : 'FAILED';

  var findingsHtml = '';
  if (report.findings && report.findings.length) {
    var severityOrder = ['critical', 'high', 'medium', 'low'];
    var icons = { critical: '<i class="ti ti-circle-x" style="color:#ef4444"></i>', high: '<i class="ti ti-alert-circle" style="color:#f97316"></i>', medium: '<i class="ti ti-alert-triangle" style="color:#eab308"></i>', low: '<i class="ti ti-info-circle" style="color:#3b82f6"></i>' };
    for (var s = 0; s < severityOrder.length; s++) {
      var sev = severityOrder[s];
      var items = report.findings.filter(function(f) { return f.severity === sev; });
      if (!items.length) continue;
      findingsHtml += '<div class="scan-severity-group">';
      findingsHtml += '<div class="scan-severity-title">' + icons[sev] + ' ' + sev.charAt(0).toUpperCase() + sev.slice(1) + ' (' + items.length + ')</div>';
      for (var i = 0; i < items.length; i++) {
        var f = items[i];
        findingsHtml += '<div class="scan-finding"><div class="scan-finding-name">' + escHtml(f.checkName) + '</div><div class="scan-finding-desc">' + escHtml(f.description) + '</div></div>';
      }
      findingsHtml += '</div>';
    }
  }

  // Rubric audit panel
  var rubricHtml = '';
  var audit = builderState.data.rubricAudit;
  if (builderState._rubricLoading) {
    rubricHtml = '<div class="scan-rubric-section">' +
      '<div class="scan-rubric-title"><i class="ti ti-sparkles"></i> Analysing instruction quality\u2026</div>' +
      '<div class="builder-hint-block">Checking your system prompt against quality rubric\u2026</div>' +
    '</div>';
  } else if (audit) {
    var sevIcons = { high: '<i class="ti ti-alert-circle" style="color:#f97316"></i>', medium: '<i class="ti ti-alert-triangle" style="color:#eab308"></i>', low: '<i class="ti ti-info-circle" style="color:#3b82f6"></i>' };
    var auditFindings = '';
    if (audit.findings && audit.findings.length) {
      for (var ai = 0; ai < audit.findings.length; ai++) {
        var af = audit.findings[ai];
        auditFindings += '<div class="scan-finding">' +
          '<div class="scan-finding-name">' + (sevIcons[af.severity] || '') + ' <code>' + escHtml(af.id) + '</code> ' + escHtml(af.label) + '</div>' +
          '<div class="scan-finding-desc">' + escHtml(af.detail) + '</div>' +
        '</div>';
      }
    }
    rubricHtml = '<div class="scan-rubric-section">' +
      '<div class="scan-rubric-title"><i class="ti ti-sparkles"></i> Instruction Quality' +
        '<button class="builder-btn small" onclick="builderRunRubricAudit()" style="margin-left:auto"><i class="ti ti-refresh"></i> Re-analyse</button>' +
      '</div>' +
      (audit.summary ? '<div class="builder-hint-block">' + escHtml(audit.summary) + '</div>' : '') +
      (auditFindings || '<div class="scan-clean"><i class="ti ti-circle-check" style="color:#22c55e"></i> Prompt passes all quality checks.</div>') +
      (audit.improvedPrompt ? (
        '<div class="scan-rubric-improved">' +
          '<div class="scan-rubric-improved-label"><i class="ti ti-wand"></i> Suggested improvement</div>' +
          '<pre class="scan-rubric-preview">' + escHtml(audit.improvedPrompt.slice(0, 800)) + (audit.improvedPrompt.length > 800 ? '\u2026' : '') + '</pre>' +
          '<div class="scan-rubric-actions">' +
            '<button class="builder-btn primary" onclick="builderAcceptImprovedPrompt()"><i class="ti ti-check"></i> Accept &amp; replace my prompt</button>' +
            '<button class="builder-btn secondary" onclick="builderState.data.rubricAudit.improvedPrompt=null;renderBuilderPanel()">Dismiss</button>' +
          '</div>' +
        '</div>'
      ) : '') +
    '</div>';
  } else if (report) {
    // Scan done but no rubric yet (no systemPrompt, or not triggered)
    if (builderState.data.systemPrompt && builderState.data.systemPrompt.trim()) {
      rubricHtml = '<div class="scan-rubric-section">' +
        '<button class="builder-btn secondary" onclick="builderRunRubricAudit()"><i class="ti ti-sparkles"></i> Analyse instruction quality</button>' +
      '</div>';
    }
  }

  return '<div class="builder-section">' +
    '<div class="scan-header">' +
      '<span class="scan-badge-large">' + badge + '</span>' +
      '<span class="scan-score">' + report.score + '/100</span>' +
      '<span class="scan-status ' + (report.passed ? 'pass' : 'fail') + '">' + status + '</span>' +
      '<button class="builder-btn small" onclick="builderRunScan()" style="margin-left:auto"><i class="ti ti-refresh"></i> Rescan</button>' +
    '</div>' +
    (findingsHtml || '<div class="scan-clean"><i class="ti ti-circle-check" style="color:#22c55e"></i> No security issues found!</div>') +
    rubricHtml +
  '</div>';
}

async function builderRunScan() {
  showToast('Scanning agent…');
  builderState.data.rubricAudit = null;
  try {
    var r = await fetch('/api/agent-builder/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(builderState.data)
    });
    var report = await r.json();
    builderState.data.scanReport = report;
    renderBuilderPanel();
  } catch (_) {
    showToast('Scan failed');
    return;
  }
  // Auto-run rubric audit after security scan if there's a system prompt
  if (builderState.data.systemPrompt && builderState.data.systemPrompt.trim()) {
    await builderRunRubricAudit();
  }
}

async function builderRunRubricAudit() {
  builderState._rubricLoading = true;
  renderBuilderPanel();
  try {
    var r = await fetch('/api/agent-builder/rubric-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, builderState.data, { model: state.model }))
    });
    var audit = await r.json();
    builderState.data.rubricAudit = audit.error ? null : audit;
    if (audit.error) showToast('Rubric audit failed');
  } catch (_) {
    builderState.data.rubricAudit = null;
  }
  builderState._rubricLoading = false;
  renderBuilderPanel();
}

function builderAcceptImprovedPrompt() {
  var audit = builderState.data.rubricAudit;
  if (!audit || !audit.improvedPrompt) return;
  builderState.data.systemPrompt = audit.improvedPrompt;
  builderState.data.rubricAudit = null; // clear after accept
  showToast('Improved prompt applied — review it in Step 2');
  renderBuilderPanel();
}

// ── Step 7: Review & Package ─────────────────────────────────────────────

function renderStep7Review() {
  var d = builderState.data;
  var p = d.permissions;
  var report = d.scanReport;

  var permList = [];
  if (p.shell) permList.push('Shell');
  if (p.browser) permList.push('Browser');
  if (p.figma) permList.push('Figma');
  if (p.fileRead && p.fileRead.length) permList.push('Readable: ' + p.fileRead.join(', '));
  if (p.fileWrite && p.fileWrite.length) permList.push('Writable: ' + p.fileWrite.join(', '));
  if (!p.network.blockAll) permList.push('Network: ' + (p.network.allowedDomains.length ? p.network.allowedDomains.join(', ') : 'all'));

  var scanBadge = report ? (report.score >= 90 ? '<i class="ti ti-circle-check" style="color:#22c55e"></i>' : report.score >= 80 ? '<i class="ti ti-alert-triangle" style="color:#eab308"></i>' : '<i class="ti ti-circle-x" style="color:#ef4444"></i>') + ' ' + report.score + '/100' : '<i class="ti ti-circle" style="color:#9ca3af"></i> Not scanned';

  var testSummary = '';
  if (d.testCases.length) {
    var passed = d.testCases.filter(function(c) { return c.passed === true; }).length;
    testSummary = passed + '/' + d.testCases.length + ' passed';
  } else {
    testSummary = 'No tests';
  }

  return '<div class="builder-section">' +
    '<div class="builder-review">' +
      '<div class="builder-review-header">' +
        '<i class="ti ' + (d.icon || 'ti-robot') + ' builder-review-icon"></i>' +
        '<div>' +
          '<div class="builder-review-name">' + escHtml(d.displayName || d.name || 'Unnamed') + '</div>' +
          '<div class="builder-review-desc">' + escHtml(d.description || 'No description') + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="builder-review-grid">' +
        '<div class="builder-review-item"><span class="builder-review-label">Name</span><span>' + escHtml(d.name || '—') + '</span></div>' +
        '<div class="builder-review-item"><span class="builder-review-label">Category</span><span>' + escHtml(d.category) + '</span></div>' +
        '<div class="builder-review-item"><span class="builder-review-label">Orchestrator</span><span>' + (d.orchestrator ? '<i class="ti ti-hierarchy-3" style="color:var(--accent)"></i> Yes' : 'No') + '</span></div>' +
        (d.orchestrator && d.subAgents.length ? '<div class="builder-review-item"><span class="builder-review-label">Sub-Agents</span><span>' + d.subAgents.length + ' bundled (' + d.subAgents.map(function(s){return escHtml(s.displayName)}).join(', ') + ')</span></div>' : '') +
        '<div class="builder-review-item"><span class="builder-review-label">Permissions</span><span>' + (permList.length ? escHtml(permList.join(' · ')) : 'None') + '</span></div>' +
        '<div class="builder-review-item"><span class="builder-review-label">Tools</span><span>' + d.tools.length + ' custom tool(s)</span></div>' +
        '<div class="builder-review-item"><span class="builder-review-label">Tests</span><span>' + testSummary + '</span></div>' +
        '<div class="builder-review-item"><span class="builder-review-label">Security</span><span>' + scanBadge + '</span></div>' +
        '<div class="builder-review-item"><span class="builder-review-label">Prompt</span><span>' + Math.ceil(d.systemPrompt.length / 4) + ' tokens (~' + d.systemPrompt.length + ' chars)</span></div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

// ── Navigation ───────────────────────────────────────────────────────────

function builderNext() {
  // Validate current step
  if (builderState.step === 1) {
    var d = builderState.data;
    if (!d.displayName.trim()) { showToast('Display name is required'); return; }
    if (!d.name.trim()) { builderState.data.name = d.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
    if (!d.name.trim()) { showToast('Agent name is required'); return; }
  }
  if (builderState.step < builderState.totalSteps) {
    builderState.step++;
    renderBuilderPanel();
  }
}

function builderPrev() {
  if (builderState.step > 1) {
    builderState.step--;
    renderBuilderPanel();
  }
}

function builderGoTo(step) {
  if (step >= 1 && step <= builderState.totalSteps) {
    builderState.step = step;
    renderBuilderPanel();
  }
}

// ── Save agent ───────────────────────────────────────────────────────────

async function builderSave() {
  var d = builderState.data;
  if (!d.name.trim()) { showToast('Agent name is required'); return; }

  // Pass editing flag so server knows this is an update
  var payload = Object.assign({}, d, { _editing: !!builderState.editing });

  try {
    var r = await fetch('/api/agent-builder/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var result = await r.json();
    if (result.error) {
      showToast('Save failed: ' + result.error);
      return;
    }

    // Upload custom icon if present
    if (d._customIconData && d.icon && d.icon.startsWith('custom:')) {
      try {
        var blob = await (await fetch(d._customIconData)).blob();
        await fetch('/api/agents/' + encodeURIComponent(d.name) + '/icon', {
          method: 'POST',
          headers: { 'Content-Type': blob.type },
          body: blob
        });
      } catch (_) { /* icon upload failure is non-fatal */ }
    }

    showToast('Agent "' + d.displayName + '" saved!');
    // Record version in history
    if (typeof recordVersion === 'function' && result.version) {
      recordVersion(d.name, result.version, result.checksum || '');
    }
    await loadInstalledAgents();
    renderAgentList();
    closeAgentBuilder();
  } catch (e) {
    showToast('Failed to save agent');
  }
}

// ── Export as .zip ───────────────────────────────────────────────────────

async function builderExport() {
  var d = builderState.data;
  if (!d.name.trim()) { showToast('Agent name is required'); return; }

  try {
    var r = await fetch('/api/agent-builder/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d)
    });
    if (!r.ok) { showToast('Export failed'); return; }
    var blob = await r.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = d.name + '.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Exported ' + d.name + '.zip');
  } catch (_) {
    showToast('Export failed');
  }
}

// ── Publish directly to store ────────────────────────────────────────────

async function builderPublish() {
  var d = builderState.data;
  if (!d.name.trim()) { showToast('Agent name is required'); return; }

  // Must be signed in
  if (typeof storeState === 'undefined' || !storeState.account || !localStorage.getItem('store-token')) {
    showToast('Sign in to your developer account first');
    closeAgentBuilder();
    if (typeof openAgentStore === 'function') openAgentStore();
    if (typeof storeNavigate === 'function') storeNavigate('account');
    return;
  }

  // Save first to ensure local state is current
  showToast('Saving agent…');
  try {
    var saveR = await fetch('/api/agent-builder/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, d, { _editing: !!builderState.editing }))
    });
    var saveResult = await saveR.json();
    if (saveResult.error) { showToast('Save failed: ' + saveResult.error); return; }
  } catch (e) { showToast('Save failed'); return; }

  // Delegate to the store's unified publish flow
  closeAgentBuilder();
  if (typeof openAgentStore === 'function' && !storeState.open) openAgentStore();
  storeNavigate('publish');
  publishAgent(d.name);
}

// ── Create-Agent block parser (called after each AI message) ─────────────
// Detects ```create-agent ... ``` blocks, hides them from rendered markdown,
// and injects an "Open in Agent Builder" card into the message element.

function extractAndRenderCreateAgent(buffer, msgEl) {
  if (!msgEl) return;

  // Approach 1 — DOM-based: find pre[data-special-lang="create-agent"] placeholders injected
  // by the markdown renderer. These are invisible placeholders we replace with the card.
  var domBlocks = msgEl.querySelectorAll('pre[data-special-lang="create-agent"]');
  domBlocks.forEach(function(pre) {
    var codeEl = pre.querySelector('code.language-create-agent');
    if (!codeEl) return;
    var raw = codeEl.textContent.trim();
    var config;
    try { config = JSON.parse(raw); } catch (_) { return; }
    if (!config || !config.displayName) return;
    var card = _buildCreateAgentCard(config);
    pre.parentNode.insertBefore(card, pre);
    pre.parentNode.removeChild(pre);
  });

  // Approach 2 — buffer-based: fallback for any blocks the DOM approach missed
  // (e.g. history loads where markup may differ)
  var re = /```create-agent\s*([\s\S]*?)```/gi;
  var match;
  while ((match = re.exec(buffer)) !== null) {
    var raw = match[1].trim();
    var config;
    try { config = JSON.parse(raw); } catch (_) { continue; }
    if (!config || !config.displayName) continue;

    // Skip if DOM approach already handled this (card already present for this agent name)
    var existing = msgEl.querySelector('.create-agent-card[data-agent-name="' + CSS.escape(config.name || config.displayName) + '"]');
    if (existing) continue;

    var card = _buildCreateAgentCard(config);

    // Hide any remaining raw code block
    var codeBlocks = msgEl.querySelectorAll('code.language-create-agent');
    for (var _b = 0; _b < codeBlocks.length; _b++) {
      var pre = codeBlocks[_b].closest('pre') || codeBlocks[_b];
      if (pre) pre.style.display = 'none';
    }

    var body = msgEl.querySelector('.msg-body');
    if (body) body.appendChild(card);
  }
}

// ── Patch Agent — open existing owned agent in builder for editing ────────

function extractAndRenderPatchAgent(buffer, msgEl) {
  if (!msgEl) return;

  function processConfig(config, pre) {
    if (!config || !config.name) return;
    var card = _buildPatchAgentCard(config);
    if (pre) {
      pre.parentNode.insertBefore(card, pre);
      pre.parentNode.removeChild(pre);
    } else {
      var body = msgEl.querySelector('.msg-body');
      if (body) body.appendChild(card);
    }
    // Remove any immediately following sibling that looks like escaped JSON debris
    // (happens when backticks inside the JSON value terminate the fenced block early)
    _removeCardDebris(card);
  }

  // DOM-based
  var domBlocks = msgEl.querySelectorAll('pre[data-special-lang="patch-agent"]');
  domBlocks.forEach(function(pre) {
    var codeEl = pre.querySelector('code.language-patch-agent');
    if (!codeEl) return;
    var cfg;
    try { cfg = JSON.parse(codeEl.textContent.trim()); } catch (_) { return; }
    processConfig(cfg, pre);
  });

  // Buffer fallback
  var re = /```patch-agent\s*([\s\S]*?)```/gi;
  var match;
  while ((match = re.exec(buffer)) !== null) {
    var cfg;
    try { cfg = JSON.parse(match[1].trim()); } catch (_) { continue; }
    if (!cfg || !cfg.name) continue;
    if (msgEl.querySelector('.patch-agent-card[data-agent-name="' + CSS.escape(cfg.name) + '"]')) continue;
    processConfig(cfg, null);
  }
}

// Remove raw pre/p siblings immediately following an action card that look like
// escaped JSON debris (happens when backtick sequences inside JSON break the fence).
function _removeCardDebris(card) {
  var next = card.nextElementSibling;
  while (next) {
    var tag = next.tagName;
    var text = next.textContent || '';
    // Heuristic: looks like an escaped system prompt or escaped JSON
    var isDebris = (tag === 'P' || tag === 'PRE') &&
      (text.includes('\\n') || text.includes('async function') || text.includes('figma.') ||
       text.includes('loadFont') || (text.length > 200 && text.includes('{') && !next.dataset.specialLang));
    if (!isDebris) break;
    var toRemove = next;
    next = next.nextElementSibling;
    toRemove.style.display = 'none';
  }
}

function _buildPatchAgentCard(config) {  var card = document.createElement('div');
  card.className = 'create-agent-card patch-agent-card';
  card.dataset.agentName = config.name || '';
  var iconHtml = config.icon && config.icon.startsWith('ti-')
    ? '<i class="ti ' + escHtml(config.icon) + ' ca-icon"></i>'
    : '<i class="ti ti-robot ca-icon"></i>';
  card.innerHTML =
    '<div class="ca-header">' +
      iconHtml +
      '<div class="ca-info">' +
        '<div class="ca-name">' + escHtml(config.displayName || config.name) + '</div>' +
        '<div class="ca-desc">' + escHtml(config.reason || 'Open this agent to apply the suggested fixes') + '</div>' +
      '</div>' +
      '<div class="ca-badges"><span class="ca-badge edit"><i class="ti ti-pencil"></i> Edit Agent</span></div>' +
    '</div>' +
    '<div class="ca-actions">' +
      '<button class="builder-btn primary ca-open-btn"><i class="ti ti-pencil"></i> Open for Editing</button>' +
    '</div>';
  (function(cfg) {
    card.querySelector('.ca-open-btn').addEventListener('click', async function() {
      // Load the full agent from disk first, then merge AI's suggestions on top
      try {
        var r = await fetch('/api/agents/' + encodeURIComponent(cfg.name));
        if (!r.ok) throw new Error('not found');
        var existing = await r.json();
        // Merge: AI-supplied fields overwrite the fetched ones, but we keep everything from disk
        var merged = Object.assign({}, existing, {
          displayName: cfg.displayName || existing.displayName,
          description: cfg.description || existing.description,
          systemPrompt: cfg.systemPrompt || existing.systemPrompt,
          category: cfg.category || existing.category,
          icon: cfg.icon || existing.icon,
          permissions: cfg.permissions || existing.permissions,
          tools: cfg.tools || existing.tools || [],
          subAgents: cfg.subAgents || existing._subAgents || [],
          shared: cfg.shared || existing._shared || '',
        });
        openAgentBuilder(cfg.name);
        // Wait for builder to open then patch the state
        setTimeout(function() {
          Object.assign(builderState.data, merged);
          builderState.editing = true;
          builderState._nameManual = true;
          renderBuilderPanel();
        }, 200);
      } catch (e) {
        showToast('Could not load agent "' + cfg.name + '": ' + e.message);
      }
    });
  })(config);
  return card;
}

// ── Uninstall Agent ───────────────────────────────────────────────────────

function extractAndRenderUninstallAgent(buffer, msgEl) {
  if (!msgEl) return;

  function processConfig(config, pre) {
    if (!config || !config.name) return;
    var card = _buildUninstallAgentCard(config);
    if (pre) {
      pre.parentNode.insertBefore(card, pre);
      pre.parentNode.removeChild(pre);
    } else {
      var body = msgEl.querySelector('.msg-body');
      if (body) body.appendChild(card);
    }
    _removeCardDebris(card);
  }

  // DOM-based
  var domBlocks = msgEl.querySelectorAll('pre[data-special-lang="uninstall-agent"]');
  domBlocks.forEach(function(pre) {
    var codeEl = pre.querySelector('code.language-uninstall-agent');
    if (!codeEl) return;
    var cfg;
    try { cfg = JSON.parse(codeEl.textContent.trim()); } catch (_) { return; }
    processConfig(cfg, pre);
  });

  // Buffer fallback
  var re = /```uninstall-agent\s*([\s\S]*?)```/gi;
  var match;
  while ((match = re.exec(buffer)) !== null) {
    var cfg;
    try { cfg = JSON.parse(match[1].trim()); } catch (_) { continue; }
    if (!cfg || !cfg.name) continue;
    if (msgEl.querySelector('.uninstall-agent-card[data-agent-name="' + CSS.escape(cfg.name) + '"]')) continue;
    processConfig(cfg, null);
  }
}

function _buildUninstallAgentCard(config) {
  var card = document.createElement('div');
  card.className = 'create-agent-card uninstall-agent-card';
  card.dataset.agentName = config.name || '';
  var iconHtml = config.icon && config.icon.startsWith('ti-')
    ? '<i class="ti ' + escHtml(config.icon) + ' ca-icon"></i>'
    : '<i class="ti ti-robot ca-icon"></i>';
  card.innerHTML =
    '<div class="ca-header">' +
      iconHtml +
      '<div class="ca-info">' +
        '<div class="ca-name">' + escHtml(config.displayName || config.name) + '</div>' +
        '<div class="ca-desc">' + escHtml(config.reason || 'Remove this agent from your workspace') + '</div>' +
      '</div>' +
      '<div class="ca-badges"><span class="ca-badge danger"><i class="ti ti-trash"></i> Remove Agent</span></div>' +
    '</div>' +
    '<div class="ca-actions">' +
      '<button class="builder-btn danger ca-delete-btn"><i class="ti ti-trash"></i> Uninstall ' + escHtml(config.displayName || config.name) + '</button>' +
      '<button class="builder-btn secondary ca-cancel-btn">Cancel</button>' +
    '</div>';
  (function(cfg) {
    card.querySelector('.ca-delete-btn').addEventListener('click', async function() {
      if (!confirm('Permanently remove "' + cfg.displayName || cfg.name + '"? This cannot be undone.')) return;
      try {
        var r = await fetch('/api/agents/' + encodeURIComponent(cfg.name), { method: 'DELETE' });
        if (!r.ok) { var e = await r.json(); throw new Error(e.error || r.status); }
        showToast('"' + (cfg.displayName || cfg.name) + '" removed');
        card.innerHTML = '<div class="ca-header" style="opacity:.5"><i class="ti ti-circle-check ca-icon" style="color:var(--accent)"></i><div class="ca-info"><div class="ca-name">Agent removed</div></div></div>';
        // Refresh agent list in sidebar if function exists
        if (typeof loadAgents === 'function') loadAgents();
      } catch (e) {
        showToast('Failed to remove agent: ' + e.message);
      }
    });
    card.querySelector('.ca-cancel-btn').addEventListener('click', function() {
      card.remove();
    });
  })(config);
  return card;
}

// Build the card DOM element shared between DOM-based and buffer-based paths.
function _buildCreateAgentCard(config) {
  var card = document.createElement('div');
  card.className = 'create-agent-card';
  card.dataset.agentName = config.name || config.displayName || '';
  var isOrch = !!config.orchestrator;
  var subCount = Array.isArray(config.subAgents) ? config.subAgents.length : 0;
  var meta = isOrch
    ? ('<span class="ca-badge orch"><i class="ti ti-hierarchy-3"></i> Orchestrator</span>' +
       (subCount ? '<span class="ca-badge sub"><i class="ti ti-git-branch"></i> ' + subCount + ' sub-agent' + (subCount !== 1 ? 's' : '') + '</span>' : ''))
    : '<span class="ca-badge"><i class="ti ti-robot"></i> Agent</span>';
  var iconHtml = config.icon && config.icon.startsWith('ti-')
    ? '<i class="ti ' + escHtml(config.icon) + ' ca-icon"></i>'
    : '<i class="ti ti-robot ca-icon"></i>';
  card.innerHTML =
    '<div class="ca-header">' +
      iconHtml +
      '<div class="ca-info">' +
        '<div class="ca-name">' + escHtml(config.displayName) + '</div>' +
        '<div class="ca-desc">' + escHtml(config.description || '') + '</div>' +
      '</div>' +
      '<div class="ca-badges">' + meta + '</div>' +
    '</div>' +
    '<div class="ca-actions">' +
      '<button class="builder-btn primary ca-open-btn"><i class="ti ti-external-link"></i> Open in Agent Builder</button>' +
      '<button class="builder-btn secondary ca-copy-btn"><i class="ti ti-copy"></i> Copy JSON</button>' +
    '</div>';
  // Wire buttons — IIFE so cfg is closed over correctly
  (function(cfg) {
    card.querySelector('.ca-open-btn').addEventListener('click', function() {
      // Open the panel first (this calls resetBuilderState internally)
      openAgentBuilder();
      // Then populate state after the reset
      builderState._nameManual = true;
      builderState.data.name = (cfg.name || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'new-agent';
      builderState.data.displayName = cfg.displayName || '';
      builderState.data.description = cfg.description || '';
      builderState.data.category = cfg.category || 'productivity';
      if (cfg.icon && typeof AGENT_ICONS !== 'undefined' && AGENT_ICONS.indexOf(cfg.icon) !== -1) builderState.data.icon = cfg.icon;
      builderState.data.systemPrompt = cfg.systemPrompt || '';
      if (cfg.orchestrator) {
        builderState.data.orchestrator = true;
        builderState.data.shared = cfg.shared || '';
        if (Array.isArray(cfg.subAgents) && cfg.subAgents.length) {
          builderState.data.subAgents = cfg.subAgents.map(function(s, i) {
            return {
              name: (s.name || ('sub-' + (i + 1))).replace(/[^a-zA-Z0-9_-]/g, '-'),
              displayName: s.displayName || s.name || ('Sub Agent ' + (i + 1)),
              description: s.description || '',
              icon: (s.icon && typeof AGENT_ICONS !== 'undefined' && AGENT_ICONS.indexOf(s.icon) !== -1) ? s.icon : 'ti-robot',
              systemPrompt: s.systemPrompt || '',
              tools: []
            };
          });
          if (typeof syncSubAgentRefs === 'function') syncSubAgentRefs();
        }
      }
      if (cfg.permissions) {
        builderState.data.permissions = Object.assign({}, builderState.data.permissions, {
          shell: !!cfg.permissions.shell,
          browser: !!cfg.permissions.browser,
          figma: !!cfg.permissions.figma,
          fileRead: Array.isArray(cfg.permissions.fileRead) ? cfg.permissions.fileRead : [],
          fileWrite: Array.isArray(cfg.permissions.fileWrite) ? cfg.permissions.fileWrite : [],
          network: cfg.permissions.network
            ? { allowedDomains: Array.isArray(cfg.permissions.network.allowedDomains) ? cfg.permissions.network.allowedDomains : [], blockAll: cfg.permissions.network.blockAll !== false }
            : builderState.data.permissions.network
        });
      }
      if (Array.isArray(cfg.tools)) {
        builderState.data.tools = cfg.tools.map(function(t) {
          return { name: (t.name || 'tool').replace(/[^a-zA-Z0-9_]/g, ''), description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} }, code: t.code || '' };
        });
      }
      if (Array.isArray(cfg.testCases)) {
        builderState.data.testCases = cfg.testCases.map(function(tc) {
          return { input: tc.input || '', expectedOutput: tc.expectedOutput || '', result: null, passed: null };
        });
      }
      // Re-render now that state is populated
      renderBuilderPanel();
    });
    card.querySelector('.ca-copy-btn').addEventListener('click', function() {
      navigator.clipboard.writeText(JSON.stringify(cfg, null, 2)).catch(function() {});
      var btn = card.querySelector('.ca-copy-btn');
      btn.innerHTML = '<i class="ti ti-check"></i> Copied';
      setTimeout(function() { btn.innerHTML = '<i class="ti ti-copy"></i> Copy JSON'; }, 1500);
    });
  })(config);
  return card;
}

// ── Agent Code View (Monaco) ───────────────────────────────────────────────

var _acvMonacoEditor = null;
var _acvMonacoLoaded = false;

function openAgentCodeView() {
  var overlay = document.getElementById('agent-code-view');
  if (!overlay) return;
  overlay.style.display = 'flex';
  document.getElementById('acv-agent-name').textContent =
    builderState.data.displayName || builderState.data.name || 'Agent';

  var json = JSON.stringify(builderState.data, null, 2);

  if (_acvMonacoEditor) {
    _acvMonacoEditor.setValue(json);
    return;
  }

  if (typeof require === 'undefined') {
    // Monaco loader not yet available—show raw textarea fallback
    _acvShowFallback(json);
    return;
  }

  require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' } });
  require(['vs/editor/editor.main'], function() {
    _acvMonacoLoaded = true;
    var el = document.getElementById('acv-editor');
    if (!el) return;
    // Remove fallback textarea if present
    var fb = el.querySelector('textarea.acv-fallback');
    if (fb) { el.removeChild(fb); }

    _acvMonacoEditor = monaco.editor.create(el, {
      value: json,
      language: 'json',
      theme: 'vs-dark',
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, Consolas, monospace',
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      formatOnPaste: true,
      tabSize: 2,
      wordWrap: 'on'
    });
  });
}

function _acvShowFallback(json) {
  var el = document.getElementById('acv-editor');
  if (!el) return;
  var ta = document.createElement('textarea');
  ta.className = 'acv-fallback';
  ta.value = json;
  el.appendChild(ta);
}

function closeAgentCodeView() {
  var overlay = document.getElementById('agent-code-view');
  if (overlay) overlay.style.display = 'none';
}

function _acvGetValue() {
  if (_acvMonacoEditor) return _acvMonacoEditor.getValue();
  var fb = document.querySelector('#acv-editor textarea.acv-fallback');
  return fb ? fb.value : null;
}

function applyCodeViewChanges() {
  var raw = _acvGetValue();
  if (raw === null) { showToast('Editor not ready'); return false; }
  try {
    var parsed = JSON.parse(raw);
    // Preserve required shape fields that may be absent in edited JSON
    if (!parsed.permissions) parsed.permissions = builderState.data.permissions;
    if (!Array.isArray(parsed.subAgents)) parsed.subAgents = [];
    if (!Array.isArray(parsed.tools)) parsed.tools = [];
    if (!Array.isArray(parsed.testCases)) parsed.testCases = [];
    builderState.data = parsed;
    renderBuilderPanel();
    showToast('Changes applied to builder');
    return true;
  } catch (e) {
    showToast('Invalid JSON — ' + e.message);
    return false;
  }
}

function saveFromCodeView() {
  if (applyCodeViewChanges()) {
    closeAgentCodeView();
    builderSave();
  }
}

function publishFromCodeView() {
  if (applyCodeViewChanges()) {
    closeAgentCodeView();
    builderPublish();
  }
}

function isSandboxCodeView() {
  var cb = document.getElementById('acv-sandbox-cb');
  return cb && cb.checked;
}

// ── Find-in-Textarea (Cmd/Ctrl+F) ───────────────────────────────────────

var builderFindState = {
  textarea: null,
  matches: [],   // [{ start, end }]
  current: -1,
  bar: null
};

function builderOpenFind(textarea) {
  // If already open on this textarea, just focus the input
  if (builderFindState.bar && builderFindState.textarea === textarea) {
    var inp = builderFindState.bar.querySelector('input');
    if (inp) { inp.select(); inp.focus(); }
    return;
  }
  builderCloseFind();
  builderFindState.textarea = textarea;

  // Wrap textarea in a relative container if not already wrapped
  var parent = textarea.parentElement;
  if (!parent.classList.contains('builder-find-wrap')) {
    var wrap = document.createElement('div');
    wrap.className = 'builder-find-wrap';
    parent.insertBefore(wrap, textarea);
    wrap.appendChild(textarea);
  }

  // Create highlight backdrop behind textarea
  var backdrop = document.createElement('div');
  backdrop.className = 'builder-find-backdrop';
  textarea.parentElement.insertBefore(backdrop, textarea);
  builderFindState.backdrop = backdrop;
  textarea.classList.add('builder-find-active');

  // Copy computed styles from textarea to backdrop so text aligns perfectly
  var cs = getComputedStyle(textarea);
  backdrop.style.fontFamily = cs.fontFamily;
  backdrop.style.fontSize = cs.fontSize;
  backdrop.style.fontWeight = cs.fontWeight;
  backdrop.style.lineHeight = cs.lineHeight;
  backdrop.style.letterSpacing = cs.letterSpacing;
  backdrop.style.wordSpacing = cs.wordSpacing;
  backdrop.style.tabSize = cs.tabSize;
  backdrop.style.padding = cs.padding;
  backdrop.style.borderWidth = cs.borderWidth;
  backdrop.style.borderStyle = 'solid';
  backdrop.style.borderColor = 'transparent';
  backdrop.style.boxSizing = cs.boxSizing;

  // Sync scroll
  builderFindState._onScroll = function() {
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  };
  textarea.addEventListener('scroll', builderFindState._onScroll);

  var bar = document.createElement('div');
  bar.className = 'builder-find-bar';
  bar.innerHTML =
    '<input type="text" placeholder="Find…" spellcheck="false" autocomplete="off">' +
    '<span class="builder-find-count"></span>' +
    '<button class="builder-find-btn" title="Previous (Shift+Enter)" onclick="builderFindPrev()"><i class="ti ti-chevron-up"></i></button>' +
    '<button class="builder-find-btn" title="Next (Enter)" onclick="builderFindNext()"><i class="ti ti-chevron-down"></i></button>' +
    '<button class="builder-find-btn" title="Close (Esc)" onclick="builderCloseFind()"><i class="ti ti-x"></i></button>';

  textarea.parentElement.appendChild(bar);
  builderFindState.bar = bar;

  var input = bar.querySelector('input');
  input.addEventListener('input', function() { builderFindUpdate(this.value); });
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { e.preventDefault(); builderCloseFind(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) builderFindPrev(); else builderFindNext();
    }
  });
  input.focus();
}

function _builderFindRenderHighlights() {
  var bd = builderFindState.backdrop;
  var ta = builderFindState.textarea;
  if (!bd || !ta) return;

  var text = ta.value;
  var matches = builderFindState.matches;
  var current = builderFindState.current;

  if (!matches.length) {
    // Show plain text (preserves scroll-height parity)
    bd.textContent = text + '\n';
    return;
  }

  var html = '';
  var last = 0;
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    html += _escFindHtml(text.substring(last, m.start));
    var cls = i === current ? 'builder-find-hl builder-find-hl-current' : 'builder-find-hl';
    html += '<mark class="' + cls + '">' + _escFindHtml(text.substring(m.start, m.end)) + '</mark>';
    last = m.end;
  }
  html += _escFindHtml(text.substring(last));
  html += '\n'; // trailing newline keeps heights in sync
  bd.innerHTML = html;

  // Sync scroll
  bd.scrollTop = ta.scrollTop;
  bd.scrollLeft = ta.scrollLeft;
}

function _escFindHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function builderFindUpdate(query) {
  var ta = builderFindState.textarea;
  var countEl = builderFindState.bar && builderFindState.bar.querySelector('.builder-find-count');
  if (!ta) return;

  builderFindState.matches = [];
  builderFindState.current = -1;

  if (!query) {
    if (countEl) countEl.textContent = '';
    _builderFindRenderHighlights();
    return;
  }

  var text = ta.value.toLowerCase();
  var q = query.toLowerCase();
  var idx = 0;
  while (true) {
    var pos = text.indexOf(q, idx);
    if (pos === -1) break;
    builderFindState.matches.push({ start: pos, end: pos + q.length });
    idx = pos + 1;
  }

  if (builderFindState.matches.length) {
    // Jump to the match nearest the current cursor position
    var cursor = ta.selectionStart || 0;
    var best = 0;
    for (var i = 0; i < builderFindState.matches.length; i++) {
      if (builderFindState.matches[i].start >= cursor) { best = i; break; }
      best = i;
    }
    builderFindState.current = best;
    builderFindSelect();
  }

  _builderFindRenderHighlights();

  if (countEl) {
    countEl.textContent = builderFindState.matches.length
      ? (builderFindState.current + 1) + '/' + builderFindState.matches.length
      : 'No results';
  }
}

function builderFindSelect() {
  var ta = builderFindState.textarea;
  var m = builderFindState.matches[builderFindState.current];
  if (!ta || !m) return;
  ta.focus();
  ta.setSelectionRange(m.start, m.end);

  // Scroll textarea so the match is visible — use a mirror div to account for soft line wraps
  var mirror = document.createElement('div');
  var cs = getComputedStyle(ta);
  mirror.style.cssText = 'position:absolute;top:-9999px;left:-9999px;visibility:hidden;' +
    'white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;box-sizing:border-box;' +
    'width:' + ta.clientWidth + 'px;' +
    'font:' + cs.font + ';padding:' + cs.padding + ';' +
    'letter-spacing:' + cs.letterSpacing + ';line-height:' + cs.lineHeight + ';' +
    'tab-size:' + (cs.tabSize || '8') + ';';
  mirror.textContent = ta.value.substring(0, m.start);
  document.body.appendChild(mirror);
  var offsetY = mirror.scrollHeight;
  document.body.removeChild(mirror);
  var scrollTarget = offsetY - ta.clientHeight / 2;
  ta.scrollTop = Math.max(0, scrollTarget);

  _builderFindRenderHighlights();

  // Re-focus the find input so user can keep typing/navigating
  var inp = builderFindState.bar && builderFindState.bar.querySelector('input');
  if (inp) inp.focus();

  var countEl = builderFindState.bar && builderFindState.bar.querySelector('.builder-find-count');
  if (countEl && builderFindState.matches.length) {
    countEl.textContent = (builderFindState.current + 1) + '/' + builderFindState.matches.length;
  }
}

function builderFindNext() {
  if (!builderFindState.matches.length) return;
  builderFindState.current = (builderFindState.current + 1) % builderFindState.matches.length;
  builderFindSelect();
}

function builderFindPrev() {
  if (!builderFindState.matches.length) return;
  builderFindState.current = (builderFindState.current - 1 + builderFindState.matches.length) % builderFindState.matches.length;
  builderFindSelect();
}

function builderCloseFind() {
  if (builderFindState.bar) {
    builderFindState.bar.remove();
  }
  if (builderFindState.backdrop) {
    builderFindState.backdrop.remove();
  }
  if (builderFindState.textarea) {
    builderFindState.textarea.classList.remove('builder-find-active');
    if (builderFindState._onScroll) {
      builderFindState.textarea.removeEventListener('scroll', builderFindState._onScroll);
    }
    // Unwrap textarea from the find-wrap container if we created it
    var wrap = builderFindState.textarea.parentElement;
    if (wrap && wrap.classList.contains('builder-find-wrap')) {
      var parent = wrap.parentElement;
      parent.insertBefore(builderFindState.textarea, wrap);
      wrap.remove();
    }
    builderFindState.textarea.focus();
  }
  builderFindState.textarea = null;
  builderFindState.matches = [];
  builderFindState.current = -1;
  builderFindState.bar = null;
  builderFindState.backdrop = null;
  builderFindState._onScroll = null;
}

// Intercept Cmd/Ctrl+F when a builder textarea is focused
document.addEventListener('keydown', function(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    var panel = document.getElementById('agent-builder-panel');
    if (!panel || panel.style.display === 'none') return; // builder not open

    var active = document.activeElement;
    // Check if focus is in a textarea inside the builder panel
    if (active && active.tagName === 'TEXTAREA' && panel.contains(active)) {
      e.preventDefault();
      builderOpenFind(active);
      return;
    }
    // Also check if the find bar input itself is focused (re-trigger = select all text)
    if (builderFindState.bar && builderFindState.bar.contains(active) && builderFindState.textarea) {
      e.preventDefault();
      var inp = builderFindState.bar.querySelector('input');
      if (inp) { inp.select(); inp.focus(); }
    }
  }
}, true);

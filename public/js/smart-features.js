// ── Smart Features ────────────────────────────────────────────────────────
// Smart features — context-aware skills and patterns.
// A: Smart Commit    B: Enhanced Learning    C: Workspace Discovery
// D: Granular Context    F: Progressive Agent Loading    G: Branch Names

// ── A: Smart Commit ──────────────────────────────────────────────────────
// Generates commit message matching repo convention, stages, and commits.

async function smartCommit(opts) {
  opts = opts || {};
  var cwd = opts.cwd || (_convCwd[state.currentId] || '');
  if (!cwd) {
    var picked = await _showRepoPicker('/commit');
    if (!picked) return null;
    cwd = picked;
  }

  showToast('Generating commit…');
  try {
    var res = await fetch('/api/git/commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: cwd, stageAll: opts.stageAll !== false, amend: opts.amend || false, model: state.model })
    });
    var data = await res.json();
    if (!data.ok) {
      showToast(data.error || 'Commit failed');
      return data;
    }
    showToast('Committed: ' + data.commitHash);
    return data;
  } catch (e) {
    showToast('Commit error: ' + e.message);
    return null;
  }
}

// ── G: Branch Name Generation ────────────────────────────────────────────
// Generates a branch name from a description, optionally creates it.

async function generateBranchName(description, opts) {
  opts = opts || {};
  var cwd = opts.cwd || (_convCwd[state.currentId] || '');
  if (!cwd) {
    var picked = await _showRepoPicker('/branch');
    if (!picked) return null;
    cwd = picked;
  }  try {
    var res = await fetch('/api/git/branch-name', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: description, cwd: cwd, create: opts.create || false, model: state.model })
    });
    var data = await res.json();
    if (data.ok) {
      if (data.created) showToast('Branch created: ' + data.name);
      return data.name;
    }
    showToast(data.error || 'Branch name generation failed');
    return null;
  } catch (e) {
    showToast('Error: ' + e.message);
    return null;
  }
}

// ── C: Workspace Discovery ───────────────────────────────────────────────
// Auto-detect project context and inject into system prompt.

var _workspaceContext = null;

async function discoverWorkspace(cwd) {
  cwd = cwd || (_convCwd[state.currentId] || '');
  if (!cwd) {
    var picked = await _showRepoPicker('/discover');
    if (!picked) return null;
    cwd = picked;
  }

  try {
    var res = await fetch('/api/workspace/discover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: cwd })
    });
    var data = await res.json();
    if (data.ok) {
      _workspaceContext = data.context;
      showToast('Workspace detected: ' + (data.context.name || data.context.type || cwd));
      return data.context;
    }
  } catch (e) {
    dbg('Workspace discovery failed: ' + e.message, 'err');
  }
  return null;
}

function getWorkspaceContextPrompt() {
  if (!_workspaceContext || !_workspaceContext.summary) return '';
  return '\n\n## Workspace Context (auto-discovered)\n' + _workspaceContext.summary +
    (_workspaceContext.readme ? '\n\n### README excerpt\n' + _workspaceContext.readme.slice(0, 1500) : '');
}

// Auto-discover on CWD change
function onCwdChanged(cwd) {
  if (cwd && cwd.length > 2) discoverWorkspace(cwd);
}

// ── B: Enhanced Persistent Learning ──────────────────────────────────────
// Smarter save-instruction that deduplicates, appends to existing entries,
// and has quality checks inspired by VS Code's update-skills skill.

function enhancedSaveInstruction(title, body, tags) {
  var entries = loadPlaybook();

  // Quality check: reject trivial entries
  if (body.length < 20) {
    dbg('Playbook: skipping trivial entry "' + title + '" (' + body.length + ' chars)', 'warn');
    return false;
  }

  // Dedup: check for similar titles (fuzzy)
  var normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  var existing = entries.find(function(e) {
    var existNorm = e.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    return existNorm === normalizedTitle || levenshteinSimilarity(existNorm, normalizedTitle) > 0.8;
  });

  if (existing) {
    // Append as addendum if body is different enough
    if (existing.body.includes(body.trim())) {
      dbg('Playbook: duplicate body for "' + title + '", skipping', 'info');
      return false;
    }
    // Append learnings section
    existing.body += '\n\n**Update ' + new Date().toLocaleDateString() + ':** ' + body;
    existing.tags = mergeTags(existing.tags, tags);
    existing.updatedAt = Date.now();
    existing.autoSaved = true;
    savePlaybook(entries);
    if (playbookOpen) renderPlaybook();
    dbg('Playbook: updated existing "' + existing.title + '"', 'ok');
    return true;
  }

  // Check category match — try to place in an existing memory category
  if (_memoryCategories) {
    var matchedCat = _memoryCategories.find(function(cat) {
      if (cat.enabled === false) return false;
      if (!cat.keywords || !cat.keywords.length) return false;
      return cat.keywords.some(function(kw) {
        return title.toLowerCase().includes(kw) || body.toLowerCase().includes(kw) ||
               (tags || []).some(function(t) { return t.toLowerCase().includes(kw); });
      });
    });

    if (matchedCat) {
      // Add as a skill in the matched memory category instead of playbook
      addSkillToCategoryFromAI(matchedCat.id, title, body);
      return true;
    }
  }

  // Fall through to normal playbook save
  addPlaybookFromAI(title, body, tags);
  return true;
}

async function addSkillToCategoryFromAI(catId, title, body) {
  try {
    var res = await fetch('/api/memory/category/' + encodeURIComponent(catId) + '/group', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, body: body, enabled: true })
    });
    var data = await res.json();
    if (data.group && _memoryCategories) {
      var cat = _memoryCategories.find(function(c) { return c.id === catId; });
      if (cat) cat.groups.push(data.group);
      if (typeof renderMemoryList === 'function') renderMemoryList();
    }
    dbg('Playbook: saved as skill in "' + catId + '"', 'ok');
  } catch (e) {
    // Fallback to regular playbook
    addPlaybookFromAI(title, body, []);
  }
}

function mergeTags(existing, newTags) {
  var set = {};
  (existing || []).forEach(function(t) { set[t.toLowerCase()] = t; });
  (newTags || []).forEach(function(t) { if (!set[t.toLowerCase()]) set[t.toLowerCase()] = t; });
  return Object.values(set);
}

function levenshteinSimilarity(a, b) {
  if (a === b) return 1;
  var longer = a.length > b.length ? a : b;
  var shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  var costs = [];
  for (var i = 0; i <= longer.length; i++) {
    var lastVal = i;
    for (var j = 0; j <= shorter.length; j++) {
      if (i === 0) costs[j] = j;
      else if (j > 0) {
        var newVal = costs[j - 1];
        if (longer.charAt(i - 1) !== shorter.charAt(j - 1))
          newVal = Math.min(Math.min(newVal, lastVal), costs[j]) + 1;
        costs[j - 1] = lastVal;
        lastVal = newVal;
      }
    }
    if (i > 0) costs[shorter.length] = lastVal;
  }
  return (longer.length - costs[shorter.length]) / longer.length;
}

// ── D: Granular Context Budget Tracking ──────────────────────────────────
// Categorized context tracking inspired by VS Code's prompt budget system.

function computeContextBudget(systemPrompt, messages, model) {
  var budget = {
    system: { instructions: 0, tools: 0, total: 0 },
    user: { messages: 0, files: 0, toolResults: 0, total: 0 },
    total: 0,
    limit: getModelLimit(model || state.model),
  };

  // Parse system prompt sections
  if (systemPrompt) {
    var sysLen = systemPrompt.length;
    // Estimate token split: count section headers to estimate category sizes
    var sections = systemPrompt.split(/^## /m);
    sections.forEach(function(sec) {
      var charCount = sec.length;
      budget.system.instructions += charCount;
    });
    budget.system.total = Math.round(sysLen / 4); // ~4 chars/token
  }

  // Parse messages
  if (messages && messages.length) {
    messages.forEach(function(m) {
      var len;
      if (typeof m.content === 'string') {
        len = m.content.length;
      } else if (Array.isArray(m.content)) {
        len = m.content.reduce(function(sum, c) {
          if (c.type === 'text') return sum + (c.text || '').length;
          if (c.type === 'image_url') return sum + 1000; // estimate for image tokens
          return sum;
        }, 0);
      } else {
        len = 100;
      }

      var tokens = Math.round(len / 4);
      if (m.role === 'user') budget.user.messages += tokens;
      else if (m.role === 'assistant') budget.user.messages += tokens;
      else if (m.role === 'tool') budget.user.toolResults += tokens;
    });
    budget.user.total = budget.user.messages + budget.user.files + budget.user.toolResults;
  }

  budget.total = budget.system.total + budget.user.total;
  return budget;
}

// Enhanced context meter with category breakdown
function updateContextMeterGranular(data) {
  var meter = document.getElementById('ctx-meter');
  var fill = document.getElementById('ctx-meter-fill');
  var label = document.getElementById('ctx-meter-label');
  if (!meter || !fill || !label) return;

  var limit = getModelLimit(data.model || '');
  var promptTokens, completionTokens;

  if (data.usage) {
    promptTokens = data.usage.prompt_tokens || 0;
    completionTokens = data.usage.completion_tokens || 0;
  } else {
    promptTokens = Math.round((data.sysChars + data.msgChars) / 4);
    completionTokens = data.outputTokens || 0;
  }

  var totalUsed = promptTokens + completionTokens;
  var pct = Math.min((totalUsed / limit) * 100, 100);

  // Circular ring: r=9, circumference≈56.55
  var offset = (56.55 * (1 - pct / 100)).toFixed(2);
  fill.setAttribute('stroke-dashoffset', offset);
  var cls = 'ctx-ring-arc';
  if (pct > 80) cls += ' ctx-meter-danger';
  else if (pct > 50) cls += ' ctx-meter-warn';
  fill.setAttribute('class', cls);

  // Build granular breakdown
  var sysTokens = Math.round(data.sysChars / 4);
  var msgTokens = Math.round(data.msgChars / 4);

  var breakdown = 'sys:' + formatTokens(sysTokens) + ' + msgs:' + formatTokens(msgTokens);
  if (data.usage) {
    breakdown = 'in:' + formatTokens(promptTokens) + ' + out:' + formatTokens(completionTokens);
  }
  var tipParts = [
    'System prompt: ~' + formatTokens(sysTokens) + ' tokens',
    'Messages: ~' + formatTokens(msgTokens) + ' tokens',
  ];
  if (data.usage) {
    tipParts.push('Actual in: ' + formatTokens(promptTokens));
    tipParts.push('Actual out: ' + formatTokens(completionTokens));
  }
  tipParts.push('Model limit: ' + formatTokens(limit));
  tipParts.push('Used: ' + pct.toFixed(1) + '%');
  var labelText = breakdown + ' = ' + formatTokens(totalUsed) + '/' + formatTokens(limit) + (data.usage ? '' : ' (est.)');
  var popover = document.getElementById('ctx-meter-popover');
  if (popover) popover.innerHTML = tipParts.map(function(l) { return '<div>' + l + '</div>'; }).join('');
  meter.setAttribute('data-ctx-tip', labelText);
  meter.style.display = 'flex';
}

// ── F: Progressive Agent Loading ─────────────────────────────────────────
// Lazy-load agent system prompts: only inject full prompt when agent is invoked.
// Discovery phase: just name + description (~100 tokens).
// Active phase: full system prompt.

var _agentPromptCache = {};

async function getProgressiveAgentPrompt(agentName) {
  // Check cache first
  if (_agentPromptCache[agentName]) return _agentPromptCache[agentName];

  try {
    var res = await fetch('/api/agents/' + encodeURIComponent(agentName));
    var data = await res.json();
    if (data && data.systemPrompt) {
      _agentPromptCache[agentName] = data.systemPrompt;
      return data.systemPrompt;
    }
  } catch (e) {
    dbg('Progressive load failed for ' + agentName + ': ' + e.message, 'err');
  }
  return '';
}

function getAgentDiscoveryContext() {
  // Light-weight: just names + descriptions for agent routing
  var agents = sysCtx.installedAgents || [];
  if (!agents.length) return '';
  return '\n\n## Available Agents (invoke by name for specialized tasks)\n' +
    agents.map(function(a) {
      return '- **' + a.displayName + '** (`' + a.name + '`): ' + (a.description || 'No description');
    }).join('\n');
}

function clearAgentPromptCache() {
  _agentPromptCache = {};
}

// ── E: File Filter (client-side check, mirrors server) ───────────────────

var EXCLUDED_EXTS_CLIENT = new Set([
  'jpg','jpeg','png','gif','bmp','ico','webp','svg','eps','heif','heic',
  'mp4','m4v','mkv','webm','mov','avi','wmv','flv',
  'mp3','wav','m4a','flac','ogg','wma','aac',
  '7z','bz2','gz','tgz','rar','tar','xz','zip','iso','img',
  'woff','woff2','otf','ttf','eot',
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'exe','dll','dylib','so','o','bin','wasm',
  'pyc','pkl','class','jar',
  'pem','crt','cer','key','pfx','p12',
  'db','sqlite','parquet',
  'lock','log','map','tsbuildinfo',
]);

var EXCLUDED_DIRS_CLIENT = new Set([
  'node_modules','.git','.svn','dist','out','build','.next','__pycache__',
  'venv','.venv','.cache','.yarn','.turbo','Pods','.gradle','.terraform',
]);

function isFileIndexable(filePath) {
  var base = filePath.split('/').pop().toLowerCase();
  if (base === '.ds_store' || base === 'thumbs.db' || base === 'package-lock.json' || base === 'yarn.lock') return false;
  var dotIdx = base.lastIndexOf('.');
  if (dotIdx > 0) {
    var ext = base.slice(dotIdx + 1);
    if (EXCLUDED_EXTS_CLIENT.has(ext)) return false;
  }
  var parts = filePath.toLowerCase().split('/');
  for (var i = 0; i < parts.length; i++) {
    if (EXCLUDED_DIRS_CLIENT.has(parts[i])) return false;
  }
  return true;
}

// ── Slash command detection ──────────────────────────────────────────────
// Detects /commit, /branch, /discover in user input.

function handleSlashCommand(text) {
  var trimmed = text.trim();

  // /commit [--amend] [--cwd /path]
  if (/^\/commit\b/i.test(trimmed)) {
    var amend = /--amend/i.test(trimmed);
    var cwdMatch = trimmed.match(/--cwd\s+(\S+)/);
    smartCommit({ amend: amend, cwd: cwdMatch ? cwdMatch[1] : undefined });
    return true;
  }

  // /branch <description> [--create] [--cwd /path]
  if (/^\/branch\b/i.test(trimmed)) {
    var desc = trimmed.replace(/^\/branch\s*/i, '').replace(/--create/i, '').replace(/--cwd\s+\S+/i, '').trim();
    var create = /--create/i.test(trimmed);
    var cwdM = trimmed.match(/--cwd\s+(\S+)/);
    if (desc) {
      generateBranchName(desc, { create: create, cwd: cwdM ? cwdM[1] : undefined }).then(function(name) {
        if (name) {
          // Insert the branch name into chat as a system message
          var conv = getConv(state.currentId);
          if (conv) {
            conv.messages.push({ role: 'assistant', content: '**Branch name:** `' + name + '`' + (create ? ' ✓ created' : '\n\nUse `--create` to create it, or run:\n```bash\ngit checkout -b ' + name + '\n```') });
            saveConversations();
            showMessages();
          }
        }
      });
    } else {
      showToast('Usage: /branch <description> [--create]');
    }
    return true;
  }

  // /discover [path]
  if (/^\/discover\b/i.test(trimmed)) {
    var discoverPath = trimmed.replace(/^\/discover\s*/i, '').trim();
    discoverWorkspace(discoverPath || undefined).then(function(ctx) {
      if (ctx) {
        var conv = getConv(state.currentId);
        if (conv) {
          var msg = '**Workspace discovered:**\n```\n' + ctx.summary + '\n```';
          if (ctx.conventionFiles && ctx.conventionFiles.length) {
            msg += '\n\n**Convention files found:** ' + ctx.conventionFiles.join(', ');
          }
          conv.messages.push({ role: 'assistant', content: msg });
          saveConversations();
          showMessages();
        }
      }
    });
    return true;
  }

  return false;
}

// ── Slash command autocomplete ───────────────────────────────────────────

var _slashCommands = [
  { name: 'commit', description: 'Auto-stage, detect convention, generate commit message, and commit', usage: '/commit [--amend] [--cwd /path]', icon: 'ti-git-commit', needsCwd: true },
  { name: 'branch', description: 'Generate a branch name from a task description', usage: '/branch <description> [--create]', icon: 'ti-git-branch', needsCwd: false },
  { name: 'discover', description: 'Auto-detect project type, scripts, git info, and conventions', usage: '/discover [path]', icon: 'ti-search', needsCwd: false },
];

var slashAutocompleteOpen = false;

function getSlashAtCursor(input) {
  var text = input.value;
  var cursor = input.selectionStart;
  // Walk backwards from cursor to find '/'
  var start = cursor - 1;
  while (start >= 0 && /[\w-]/.test(text[start])) start--;
  if (start < 0 || text[start] !== '/') return null;
  // '/' must be at position 0 or preceded by whitespace
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  var partial = text.substring(start + 1, cursor);
  return { start: start, end: cursor, filter: partial };
}

function showSlashAutocomplete(filter) {
  var dropdown = document.getElementById('slash-autocomplete');
  if (!dropdown) return;

  var cmds = _slashCommands;
  if (filter) {
    var f = filter.toLowerCase();
    cmds = cmds.filter(function(c) { return c.name.toLowerCase().includes(f); });
  }

  if (cmds.length === 0) {
    dropdown.style.display = 'none';
    slashAutocompleteOpen = false;
    return;
  }

  var html = cmds.map(function(c) {
    return '<div class="slash-ac-item" data-cmd="' + c.name + '" onclick="selectSlashCommand(\'' + c.name + '\')">' +
      '<i class="ti ' + c.icon + ' slash-ac-icon"></i>' +
      '<div class="slash-ac-info">' +
        '<span class="slash-ac-name">/' + c.name + '</span>' +
        '<span class="slash-ac-desc">' + c.description + '</span>' +
      '</div>' +
    '</div>';
  }).join('');

  dropdown.innerHTML = html;
  dropdown.style.display = 'block';
  slashAutocompleteOpen = true;
}

function hideSlashAutocomplete() {
  var dropdown = document.getElementById('slash-autocomplete');
  if (dropdown) dropdown.style.display = 'none';
  slashAutocompleteOpen = false;
}

function selectSlashCommand(name) {
  var input = document.getElementById('msg-input');
  var slash = getSlashAtCursor(input);
  if (slash) {
    input.value = input.value.substring(0, slash.start) + '/' + name + ' ' + input.value.substring(slash.end);
    var newPos = slash.start + name.length + 2;
    input.setSelectionRange(newPos, newPos);
  }
  input.focus();
  hideSlashAutocomplete();
  resizeTextarea(input);
}

function handleSlashInput(e) {
  var input = e.target;
  var slash = getSlashAtCursor(input);
  if (slash) {
    showSlashAutocomplete(slash.filter);
  } else if (slashAutocompleteOpen) {
    hideSlashAutocomplete();
  }
}

function handleSlashAutocompleteKey(e) {
  if (!slashAutocompleteOpen) return false;
  var dropdown = document.getElementById('slash-autocomplete');
  if (!dropdown) return false;

  var items = dropdown.querySelectorAll('.slash-ac-item');
  var active = dropdown.querySelector('.slash-ac-item.active');
  var idx = -1;
  items.forEach(function(item, i) { if (item === active) idx = i; });

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (active) active.classList.remove('active');
    idx = (idx + 1) % items.length;
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (active) active.classList.remove('active');
    idx = idx <= 0 ? items.length - 1 : idx - 1;
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (active) {
      e.preventDefault();
      selectSlashCommand(active.dataset.cmd);
      return true;
    }
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideSlashAutocomplete();
    return true;
  }
  return false;
}

// ── Repo picker (shown inline when a slash command needs a git repo) ─────

async function _showRepoPicker(commandLabel) {
  return new Promise(function(resolve) {
    var conv = getConv(state.currentId);
    if (!conv) { showToast('No active conversation'); resolve(null); return; }

    showToast('Finding git repos…');
    fetch('/api/git/repos').then(function(r) { return r.json(); }).then(function(data) {
      var repos = (data.repos || []).slice(0, 15);
      if (repos.length === 0) {
        conv.messages.push({ role: 'assistant', content: '**No git repositories found.** Specify the path directly:\n\n`' + commandLabel + ' --cwd /path/to/your/repo`' });
        saveConversations(); showMessages();
        resolve(null);
        return;
      }

      var pickerId = 'repo-picker-' + Date.now();
      var home = repos[0].path.match(/^\/Users\/[^/]+/);
      home = home ? home[0] : '';

      var html = '<div class="repo-picker" id="' + pickerId + '">' +
        '<div class="repo-picker-header"><i class="ti ti-git-branch"></i> Which repo for <code>' + commandLabel + '</code>?</div>' +
        '<div class="repo-picker-list">';
      for (var i = 0; i < repos.length; i++) {
        var r = repos[i];
        var label = r.path.replace(home, '~');
        html += '<button class="repo-picker-item" data-path="' + r.path.replace(/"/g, '&quot;') + '">' +
          '<span class="repo-picker-name">' + r.name + '</span>' +
          '<span class="repo-picker-meta">' + label + (r.branch ? ' • ' + r.branch : '') + '</span>' +
        '</button>';
      }
      html += '</div>' +
        '<div class="repo-picker-footer">' +
          '<input type="text" class="repo-picker-input" placeholder="Or type a path…" />' +
          '<button class="repo-picker-go">Go</button>' +
        '</div>' +
      '</div>';

      // Insert as an assistant message
      conv.messages.push({ role: 'assistant', content: html, _isHTML: true });
      saveConversations();
      showMessages();

      // Wire up click handlers after DOM renders
      setTimeout(function() {
        var el = document.getElementById(pickerId);
        if (!el) { resolve(null); return; }

        el.querySelectorAll('.repo-picker-item').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var p = this.dataset.path;
            _convCwd[state.currentId] = p;
            el.innerHTML = '<div class="repo-picker-header"><i class="ti ti-check"></i> Using: <code>' + p.replace(home, '~') + '</code></div>';
            resolve(p);
          });
        });

        var goBtn = el.querySelector('.repo-picker-go');
        var pathInput = el.querySelector('.repo-picker-input');
        if (goBtn && pathInput) {
          goBtn.addEventListener('click', function() {
            var v = pathInput.value.trim();
            if (!v) return;
            if (v.startsWith('~')) v = home + v.slice(1);
            _convCwd[state.currentId] = v;
            el.innerHTML = '<div class="repo-picker-header"><i class="ti ti-check"></i> Using: <code>' + v + '</code></div>';
            resolve(v);
          });
          pathInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') goBtn.click();
          });
        }
      }, 100);

    }).catch(function(e) {
      showToast('Error finding repos: ' + e.message);
      resolve(null);
    });
  });
}

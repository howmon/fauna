// ── Playbook — Learned Instructions ───────────────────────────────────────
// Strategies and instructions learned from successful task approaches.
// Stored in localStorage. Injected into system prompt when enabled.

var PLAYBOOK_KEY = 'fauna-playbook';
var playbookOpen = false;

function loadPlaybook() {
  try { return JSON.parse(localStorage.getItem(PLAYBOOK_KEY) || '[]'); }
  catch (_) { return []; }
}
function savePlaybook(entries) {
  localStorage.setItem(PLAYBOOK_KEY, JSON.stringify(entries));
}

function togglePlaybook() {
  playbookOpen = !playbookOpen;
  document.getElementById('playbook-panel').classList.toggle('open', playbookOpen);
  if (playbookOpen) renderPlaybook();
}

function renderPlaybook() {
  var all = loadPlaybook();
  var list = document.getElementById('playbook-list');
  if (!all.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:12px">No saved instructions yet.<br>The AI can save strategies automatically, or add your own below.</div>';
    return;
  }
  list.innerHTML = all.map(function(e) {
    var isOn = e.enabled !== false;
    var tags = (e.tags || []).map(function(t) { return '<span class="pb-tag">' + escHtml(t) + '</span>'; }).join('');
    return '<div class="pb-row' + (!isOn ? ' disabled' : '') + '" data-pb-id="' + e.id + '">' +
      '<div class="pb-row-head">' +
        '<span class="pb-row-title">' + escHtml(e.title) + '</span>' +
        (e.autoSaved ? '<span class="pb-auto-badge">auto-saved</span>' : '') +
        '<div class="pb-row-actions">' +
          '<button title="' + (isOn ? 'Disable' : 'Enable') + '" onclick="togglePlaybookEntry(\'' + e.id + '\')">' +
            '<i class="ti ti-' + (isOn ? 'toggle-right' : 'toggle-left') + '" style="color:' + (isOn ? 'var(--success)' : 'var(--text-muted)') + '"></i></button>' +
          '<button title="Edit" onclick="editPlaybookEntry(\'' + e.id + '\')"><i class="ti ti-pencil"></i></button>' +
          '<button title="Delete" onclick="deletePlaybookEntry(\'' + e.id + '\')"><i class="ti ti-trash"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="pb-row-body">' + escHtml(e.body) + '</div>' +
      (tags ? '<div class="pb-row-tags">' + tags + '</div>' : '') +
    '</div>';
  }).join('');
}

function addPlaybookEntry() {
  var titleInput = document.getElementById('pb-title-input');
  var bodyInput  = document.getElementById('pb-body-input');
  var title = titleInput.value.trim();
  var body  = bodyInput.value.trim();
  if (!title || !body) { showToast('Title and body are required'); return; }
  var entries = loadPlaybook();
  entries.push({ id: 'pb-' + Date.now(), title: title, body: body, tags: [], enabled: true, autoSaved: false, createdAt: Date.now() });
  savePlaybook(entries);
  titleInput.value = '';
  bodyInput.value  = '';
  renderPlaybook();
  showToast('Playbook entry added');
}

function addPlaybookFromAI(title, body, tags) {
  var entries = loadPlaybook();
  // Deduplicate: if same title exists, update it instead
  var existing = entries.find(function(e) { return e.title === title; });
  if (existing) {
    existing.body = body;
    existing.tags = tags || existing.tags;
    existing.autoSaved = true;
    existing.updatedAt = Date.now();
  } else {
    entries.push({ id: 'pb-' + Date.now(), title: title, body: body, tags: tags || [], enabled: true, autoSaved: true, createdAt: Date.now() });
  }
  savePlaybook(entries);
  if (playbookOpen) renderPlaybook();
}

function togglePlaybookEntry(id) {
  var entries = loadPlaybook();
  var entry = entries.find(function(e) { return e.id === id; });
  if (entry) { entry.enabled = !entry.enabled; savePlaybook(entries); renderPlaybook(); }
}

async function editPlaybookEntry(id) {
  var entries = loadPlaybook();
  var entry = entries.find(function(e) { return e.id === id; });
  if (!entry) return;
  var newTitle = await showPrompt('Edit title:', entry.title);
  if (newTitle === null) return;
  var newBody = await showPrompt('Edit instruction:', entry.body);
  if (newBody === null) return;
  entry.title = newTitle.trim() || entry.title;
  entry.body  = newBody.trim() || entry.body;
  entry.updatedAt = Date.now();
  savePlaybook(entries);
  renderPlaybook();
  showToast('Entry updated');
}

function deletePlaybookEntry(id) {
  var entries = loadPlaybook().filter(function(e) { return e.id !== id; });
  savePlaybook(entries);
  renderPlaybook();
  showToast('Entry removed');
}

function getPlaybookContext() {
  var active = loadPlaybook().filter(function(e) { return e.enabled !== false; });
  if (!active.length) return '';
  return '\n\n## Playbook — Learned Instructions (apply these to relevant tasks)\n' +
    active.map(function(e, i) {
      return '### ' + (i + 1) + '. ' + e.title + '\n' + e.body;
    }).join('\n\n');
}

// ── save-instruction block rendering ──────────────────────────────────────
function extractAndRenderSaveInstruction(html, messageEl, isHistoryLoad) {
  var container = document.createElement('div');
  container.innerHTML = messageEl.querySelector('.msg-body') ? messageEl.querySelector('.msg-body').innerHTML : '';
  var codeBlocks = container.querySelectorAll('code.language-save-instruction, code.language-save_instruction');
  if (!codeBlocks.length) return;

  codeBlocks.forEach(function(code) {
    var pre = code.closest('pre');
    if (!pre || pre.dataset.siDone) return;
    pre.dataset.siDone = '1';

    try {
      var data = JSON.parse(code.textContent.trim());
      var title = (data.title || '').trim();
      var body  = (data.body || data.instruction || '').trim();
      var tags  = Array.isArray(data.tags) ? data.tags : [];
      if (!title || !body) return;

      // Build the widget
      var widget = document.createElement('div');
      widget.className = 'si-block';
      widget.innerHTML = '<div class="si-header">' +
        '<i class="ti ti-notebook" style="color:#f0a030"></i> ' +
        '<span>Save to Playbook: <strong>' + escHtml(title) + '</strong></span>' +
        '</div>' +
        '<div class="si-body">' + escHtml(body).replace(/\n/g, '<br>') + '</div>';

      // Auto-save on first encounter (not history reload)
      if (!isHistoryLoad) {
        // Use enhanced learning if available, fallback to direct save
        var saved = typeof enhancedSaveInstruction === 'function'
          ? enhancedSaveInstruction(title, body, tags)
          : (addPlaybookFromAI(title, body, tags), true);
        widget.innerHTML += '<div style="padding:4px 12px 8px"><span class="si-saved"><i class="ti ti-check"></i> ' + (saved ? 'Saved to Playbook' : 'Already saved (duplicate)') + '</span></div>';
      } else {
        widget.innerHTML += '<div style="padding:4px 12px 8px"><span style="font-size:11px;color:var(--text-dim)"><i class="ti ti-check"></i> Previously saved</span></div>';
      }

      pre.replaceWith(widget);
    } catch (e) {
      dbg('save-instruction parse error: ' + e.message, 'err');
    }
  });

  // Write back
  var body = messageEl.querySelector('.msg-body');
  if (body) body.innerHTML = container.innerHTML;
}

// ── Memory tab — Skill categories with tool-specific groups ──────────────
// Stored server-side at ~/.config/fauna/memory.json.
// Shape: [ { id, name, icon, enabled, builtIn, groups: [{id, title, body, enabled}] } ]

var _memoryCategories = null;
var _memoryDefaults = null;

function switchPlaybookTab(tab) {
  document.querySelectorAll('.pb-tab').forEach(function(el) {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.pb-tab-body').forEach(function(el) {
    el.classList.toggle('active', el.id === 'pb-tab-' + tab);
  });
  if (tab === 'memory' && !_memoryCategories) loadMemoryFromServer();
}

async function loadMemoryFromServer() {
  try {
    var res = await fetch('/api/memory');
    _memoryCategories = await res.json();
    renderMemoryList();
  } catch (e) {
    document.getElementById('memory-list').innerHTML =
      '<div style="color:var(--text-muted);font-size:12px;padding:12px">Failed to load memory: ' + escHtml(e.message) + '</div>';
  }
}

function renderMemoryList() {
  var list = document.getElementById('memory-list');
  if (!_memoryCategories || !_memoryCategories.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:12px">No skill categories. Click "New Category" to create one, or "Reset Built-in" to restore defaults.</div>';
    return;
  }
  list.innerHTML = _memoryCategories.map(function(cat) {
    var catOn = cat.enabled !== false;
    var groupCount = cat.groups ? cat.groups.length : 0;
    var activeCount = cat.groups ? cat.groups.filter(function(g) { return g.enabled !== false; }).length : 0;

    var groupsHtml = (cat.groups || []).map(function(g) {
      var isOn = g.enabled !== false;
      return '<div class="mem-group' + (!isOn ? ' disabled' : '') + '" data-mem-id="' + escHtml(g.id) + '" data-cat-id="' + escHtml(cat.id) + '">' +
        '<div class="mem-group-head" onclick="toggleMemGroupExpand(\'' + escHtml(cat.id) + '\',\'' + escHtml(g.id) + '\')">' +
          '<i class="ti ti-chevron-right" style="font-size:12px;transition:transform .15s"></i>' +
          '<span class="mem-group-title">' + escHtml(g.title) + '</span>' +
          '<div class="mem-group-actions" onclick="event.stopPropagation()">' +
            '<button title="' + (isOn ? 'Disable' : 'Enable') + '" onclick="toggleMemGroup(\'' + escHtml(cat.id) + '\',\'' + escHtml(g.id) + '\')">' +
              '<i class="ti ti-' + (isOn ? 'toggle-right' : 'toggle-left') + '" style="color:' + (isOn ? 'var(--success)' : 'var(--text-muted)') + '"></i></button>' +
            '<button title="Edit" onclick="editMemGroup(\'' + escHtml(cat.id) + '\',\'' + escHtml(g.id) + '\')"><i class="ti ti-pencil"></i></button>' +
            '<button title="Delete skill" onclick="deleteMemGroup(\'' + escHtml(cat.id) + '\',\'' + escHtml(g.id) + '\')"><i class="ti ti-trash" style="font-size:13px"></i></button>' +
          '</div>' +
        '</div>' +
        '<div class="mem-group-body">' + escHtml(g.body) + '</div>' +
        '<div class="mem-group-edit">' +
          '<input class="mem-edit-title" id="mem-edit-title-' + escHtml(cat.id) + '-' + escHtml(g.id) + '" value="' + escHtml(g.title) + '" placeholder="Skill title">' +
          '<textarea class="mem-edit-textarea" id="mem-edit-' + escHtml(cat.id) + '-' + escHtml(g.id) + '">' + escHtml(g.body) + '</textarea>' +
          '<div class="mem-edit-btns">' +
            '<span></span>' +
            '<button class="mem-edit-cancel" onclick="cancelMemEdit(\'' + escHtml(cat.id) + '\',\'' + escHtml(g.id) + '\')">Cancel</button>' +
            '<button class="mem-edit-save" onclick="saveMemGroup(\'' + escHtml(cat.id) + '\',\'' + escHtml(g.id) + '\')">Save</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="mem-category' + (!catOn ? ' disabled' : '') + '" data-cat-id="' + escHtml(cat.id) + '">' +
      '<div class="mem-cat-head" onclick="toggleCatExpand(\'' + escHtml(cat.id) + '\')">' +
        '<i class="ti ti-chevron-right mem-cat-chevron" style="font-size:14px;transition:transform .15s"></i>' +
        '<i class="ti ti-' + escHtml(cat.icon || 'tools') + '" style="font-size:16px;color:var(--accent)"></i>' +
        '<span class="mem-cat-name">' + escHtml(cat.name) + '</span>' +
        '<span class="mem-cat-count">' + activeCount + '/' + groupCount + '</span>' +
        '<div class="mem-cat-actions" onclick="event.stopPropagation()">' +
          '<button title="' + (catOn ? 'Disable category' : 'Enable category') + '" onclick="toggleCatEnabled(\'' + escHtml(cat.id) + '\')">' +
            '<i class="ti ti-' + (catOn ? 'toggle-right' : 'toggle-left') + '" style="color:' + (catOn ? 'var(--success)' : 'var(--text-muted)') + '"></i></button>' +
          '<button title="Edit keywords" onclick="editCatKeywords(\'' + escHtml(cat.id) + '\')"><i class="ti ti-hash" style="font-size:14px"></i></button>' +
          '<button title="Add skill" onclick="addSkillToCategory(\'' + escHtml(cat.id) + '\')"><i class="ti ti-plus" style="font-size:14px"></i></button>' +
          '<button title="Delete category" onclick="deleteCategory(\'' + escHtml(cat.id) + '\')"><i class="ti ti-trash" style="font-size:13px;color:#f87171"></i></button>' +
        '</div>' +
      '</div>' +
      ((cat.keywords && cat.keywords.length) ? '<div class="mem-cat-keywords" onclick="event.stopPropagation();editCatKeywords(\'' + escHtml(cat.id) + '\')">' + cat.keywords.map(function(k) { return '<span class="mem-kw-pill">' + escHtml(k) + '</span>'; }).join('') + '</div>' : '<div class="mem-cat-keywords mem-cat-keywords-empty" onclick="event.stopPropagation();editCatKeywords(\'' + escHtml(cat.id) + '\')"><span style="font-size:11px;color:var(--text-dim);cursor:pointer">Always active — click <i class="ti ti-hash" style="font-size:11px"></i> to add keyword filters</span></div>') +
      '<div class="mem-cat-body">' + groupsHtml + '</div>' +
    '</div>';
  }).join('');
}

function toggleCatExpand(catId) {
  var el = document.querySelector('.mem-category[data-cat-id="' + catId + '"]');
  if (!el) return;
  el.classList.toggle('expanded');
  var chevron = el.querySelector('.mem-cat-chevron');
  if (chevron) chevron.style.transform = el.classList.contains('expanded') ? 'rotate(90deg)' : '';
}

async function toggleCatEnabled(catId) {
  var cat = _memoryCategories.find(function(c) { return c.id === catId; });
  if (!cat) return;
  cat.enabled = !cat.enabled;
  try {
    await fetch('/api/memory/category/' + encodeURIComponent(catId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: cat.enabled })
    });
  } catch (_) {}
  renderMemoryList();
}

function toggleMemGroupExpand(catId, grpId) {
  var el = document.querySelector('.mem-group[data-cat-id="' + catId + '"][data-mem-id="' + grpId + '"]');
  if (!el || el.classList.contains('editing')) return;
  el.classList.toggle('expanded');
  var chevron = el.querySelector('.mem-group-head i');
  if (chevron) chevron.style.transform = el.classList.contains('expanded') ? 'rotate(90deg)' : '';
}

async function toggleMemGroup(catId, grpId) {
  var cat = _memoryCategories.find(function(c) { return c.id === catId; });
  if (!cat) return;
  var g = cat.groups.find(function(g) { return g.id === grpId; });
  if (!g) return;
  g.enabled = !g.enabled;
  try {
    await fetch('/api/memory/category/' + encodeURIComponent(catId) + '/group/' + encodeURIComponent(grpId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: g.enabled })
    });
  } catch (_) {}
  // Update DOM in-place instead of full re-render to preserve expanded state
  var el = document.querySelector('.mem-group[data-cat-id="' + catId + '"][data-mem-id="' + grpId + '"]');
  if (el) {
    el.classList.toggle('disabled', !g.enabled);
    var toggleBtn = el.querySelector('.mem-group-actions button[title="Enable"], .mem-group-actions button[title="Disable"]');
    if (toggleBtn) {
      toggleBtn.title = g.enabled ? 'Disable' : 'Enable';
      var icon = toggleBtn.querySelector('i');
      if (icon) {
        icon.className = 'ti ti-' + (g.enabled ? 'toggle-right' : 'toggle-left');
        icon.style.color = g.enabled ? 'var(--success)' : 'var(--text-muted)';
      }
    }
  }
  // Update category active count
  var catEl = document.querySelector('.mem-category[data-cat-id="' + catId + '"] .mem-cat-count');
  if (catEl) {
    var activeCount = cat.groups ? cat.groups.filter(function(g) { return g.enabled !== false; }).length : 0;
    catEl.textContent = activeCount + '/' + (cat.groups ? cat.groups.length : 0);
  }
}

function editMemGroup(catId, grpId) {
  var el = document.querySelector('.mem-group[data-cat-id="' + catId + '"][data-mem-id="' + grpId + '"]');
  if (!el) return;
  el.classList.remove('expanded');
  el.classList.add('editing');
  var ta = document.getElementById('mem-edit-' + catId + '-' + grpId);
  if (ta) ta.focus();
}

function cancelMemEdit(catId, grpId) {
  var el = document.querySelector('.mem-group[data-cat-id="' + catId + '"][data-mem-id="' + grpId + '"]');
  if (el) el.classList.remove('editing');
  var cat = _memoryCategories.find(function(c) { return c.id === catId; });
  if (!cat) return;
  var g = cat.groups.find(function(g) { return g.id === grpId; });
  var ta = document.getElementById('mem-edit-' + catId + '-' + grpId);
  var ti = document.getElementById('mem-edit-title-' + catId + '-' + grpId);
  if (g && ta) ta.value = g.body;
  if (g && ti) ti.value = g.title;
}

async function saveMemGroup(catId, grpId) {
  var ta = document.getElementById('mem-edit-' + catId + '-' + grpId);
  var ti = document.getElementById('mem-edit-title-' + catId + '-' + grpId);
  if (!ta) return;
  var cat = _memoryCategories.find(function(c) { return c.id === catId; });
  if (!cat) return;
  var g = cat.groups.find(function(g) { return g.id === grpId; });
  if (!g) return;
  g.body = ta.value;
  if (ti) g.title = ti.value.trim() || g.title;
  try {
    await fetch('/api/memory/category/' + encodeURIComponent(catId) + '/group/' + encodeURIComponent(grpId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: g.title, body: g.body })
    });
    showToast('Skill updated');
  } catch (e) {
    showToast('Failed to save: ' + e.message);
  }
  renderMemoryList();
}

async function deleteMemGroup(catId, grpId) {
  if (!await showConfirm('Delete this skill?')) return;
  var cat = _memoryCategories.find(function(c) { return c.id === catId; });
  if (!cat) return;
  cat.groups = cat.groups.filter(function(g) { return g.id !== grpId; });
  try {
    await fetch('/api/memory/category/' + encodeURIComponent(catId) + '/group/' + encodeURIComponent(grpId), { method: 'DELETE' });
    showToast('Skill removed');
  } catch (_) {}
  renderMemoryList();
}

async function resetMemGroup(catId, grpId) {
  if (!_memoryDefaults) {
    // Fetch defaults via reset endpoint (non-destructive — resets built-in only)
    try {
      var res = await fetch('/api/memory/reset', { method: 'POST' });
      var data = await res.json();
      _memoryDefaults = data.defaults || data.categories;
      _memoryCategories = data.categories;
      renderMemoryList();
      showToast('Built-in categories reset to defaults');
      return;
    } catch (_) { return; }
  }
  var defCat = _memoryDefaults.find(function(c) { return c.id === catId; });
  if (!defCat) { showToast('No default for this category'); return; }
  var defGrp = defCat.groups.find(function(g) { return g.id === grpId; });
  if (!defGrp) { showToast('No default for this skill'); return; }
  var cat = _memoryCategories.find(function(c) { return c.id === catId; });
  if (!cat) return;
  var g = cat.groups.find(function(g) { return g.id === grpId; });
  if (g) {
    g.body = defGrp.body;
    g.title = defGrp.title;
    g.enabled = true;
    await fetch('/api/memory/category/' + encodeURIComponent(catId) + '/group/' + encodeURIComponent(grpId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: defGrp.body, title: defGrp.title, enabled: true })
    });
    showToast('"' + g.title + '" reset to default');
    renderMemoryList();
  }
}

async function editCatKeywords(catId) {
  var cat = _memoryCategories.find(function(c) { return c.id === catId; });
  if (!cat) return;
  var current = (cat.keywords || []).join(', ');
  var input = await showPrompt('Keywords (comma-separated). Leave empty for always-active:', current);
  if (input === null) return;
  var keywords = input.split(',').map(function(k) { return k.trim().toLowerCase(); }).filter(Boolean);
  cat.keywords = keywords;
  try {
    await fetch('/api/memory/category/' + encodeURIComponent(catId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: keywords })
    });
    showToast(keywords.length ? 'Keywords updated (' + keywords.length + ')' : 'Category set to always-active');
  } catch (_) {}
  renderMemoryList();
}

async function addMemoryCategory() {
  var name = await showPrompt('Category name (e.g. "React Components", "Shell Scripts"):');
  if (!name || !name.trim()) return;
  var icon = await showPrompt('Tabler icon name (e.g. tools, code, brand-react, terminal-2):', 'tools');
  var kwInput = await showPrompt('Keywords to activate this category (comma-separated, or leave empty for always-active):', '');
  var keywords = (kwInput || '').split(',').map(function(k) { return k.trim().toLowerCase(); }).filter(Boolean);
  try {
    var res = await fetch('/api/memory/category', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), icon: (icon || 'tools').trim(), keywords: keywords })
    });
    var data = await res.json();
    if (data.category) {
      _memoryCategories.push(data.category);
      renderMemoryList();
      showToast('Category "' + data.category.name + '" created');
    }
  } catch (e) {
    showToast('Failed: ' + e.message);
  }
}

async function deleteCategory(catId) {
  var cat = _memoryCategories.find(function(c) { return c.id === catId; });
  if (!cat) return;
  if (!await showConfirm('Delete "' + cat.name + '" and all its skills?')) return;
  try {
    await fetch('/api/memory/category/' + encodeURIComponent(catId), { method: 'DELETE' });
    _memoryCategories = _memoryCategories.filter(function(c) { return c.id !== catId; });
    renderMemoryList();
    showToast('Category deleted');
  } catch (e) {
    showToast('Failed: ' + e.message);
  }
}

async function addSkillToCategory(catId) {
  var title = await showPrompt('Skill title:');
  if (!title || !title.trim()) return;
  try {
    var res = await fetch('/api/memory/category/' + encodeURIComponent(catId) + '/group', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), body: '' })
    });
    var data = await res.json();
    if (data.group) {
      var cat = _memoryCategories.find(function(c) { return c.id === catId; });
      if (cat) cat.groups.push(data.group);
      renderMemoryList();
      // Auto-expand the category and open edit mode for the new skill
      var catEl = document.querySelector('.mem-category[data-cat-id="' + catId + '"]');
      if (catEl && !catEl.classList.contains('expanded')) toggleCatExpand(catId);
      editMemGroup(catId, data.group.id);
    }
  } catch (e) {
    showToast('Failed: ' + e.message);
  }
}

async function resetMemoryToDefaults() {
  if (!await showConfirm('Reset built-in categories to defaults? Your custom categories will be preserved.')) return;
  try {
    var res = await fetch('/api/memory/reset', { method: 'POST' });
    var data = await res.json();
    _memoryCategories = data.categories;
    _memoryDefaults = data.defaults || null;
    renderMemoryList();
    showToast('Built-in categories reset to defaults');
  } catch (e) {
    showToast('Reset failed: ' + e.message);
  }
}

function exportMemory() {
  if (!_memoryCategories) return;
  var blob = new Blob([JSON.stringify(_memoryCategories, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fauna-memory.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importMemory(event) {
  var file = event.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = async function() {
    try {
      var cats = JSON.parse(reader.result);
      if (!Array.isArray(cats)) throw new Error('Expected array');
      await fetch('/api/memory', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cats)
      });
      _memoryCategories = cats;
      renderMemoryList();
      showToast('Memory imported (' + cats.length + ' categories)');
    } catch (e) {
      showToast('Import failed: ' + e.message);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function getMemoryContext(userMessage) {
  if (!_memoryCategories) return '';
  var msg = (userMessage || '').toLowerCase();
  var parts = [];
  _memoryCategories.forEach(function(cat) {
    if (cat.enabled === false) return;
    // Keyword gating: if category has keywords, only inject when message matches
    var kw = cat.keywords || [];
    if (kw.length && msg) {
      var matched = kw.some(function(k) { return msg.includes(k.toLowerCase()); });
      if (!matched) return;
    }
    var active = (cat.groups || []).filter(function(g) { return g.enabled !== false; });
    if (!active.length) return;
    parts.push('## ' + cat.name + ' Skills\n' +
      active.map(function(g) { return '### ' + g.title + '\n' + g.body; }).join('\n\n'));
  });
  if (!parts.length) return '';
  return '\n\n' + parts.join('\n\n');
}


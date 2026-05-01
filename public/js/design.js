// ── Design Mode ───────────────────────────────────────────────────────────
// Handles: <artifact> streaming, <question-form> rendering, direction picker,
// design project type UI, skill/system pickers.

// ── Artifact streaming state ──────────────────────────────────────────────
var _designArtifactBuf   = '';
var _designArtifactOpen  = false;
var _designArtifactMeta  = {};
var _designArtifactId    = null; // artifact id while building

/**
 * Called from chat.js on each content token (and on stream done).
 * Detects <artifact type="text/html" title="..."> ... </artifact> blocks
 * and routes them to addArtifact().
 *
 * @param {string} chunk   — the new token text
 * @param {string} buffer  — full accumulated buffer so far (post-chunk)
 */
function processDesignStreamChunk(chunk, buffer) {
  _designArtifactBuf += chunk;

  // Detect opening tag — can be multi-token so work from accumulated buf
  if (!_designArtifactOpen) {
    var openMatch = _designArtifactBuf.match(/<artifact([^>]*)>/i);
    if (openMatch) {
      _designArtifactOpen = true;
      _designArtifactMeta = _parseArtifactAttrs(openMatch[1]);
      // Trim everything up to and including the opening tag from buf
      _designArtifactBuf = _designArtifactBuf.slice(openMatch.index + openMatch[0].length);

      // Create a placeholder artifact so the pane shows "building…"
      if (typeof addArtifact === 'function') {
        _designArtifactId = addArtifact({
          type:    'html',
          title:   _designArtifactMeta.title || 'Design output',
          content: '<!-- building… -->',
          _building: true
        });
        if (typeof openArtifactPane === 'function') openArtifactPane();
      }
    }
  } else {
    // Check if we now have the closing tag
    var closeIdx = _designArtifactBuf.indexOf('</artifact>');
    if (closeIdx !== -1) {
      var html = _designArtifactBuf.slice(0, closeIdx).trim();
      _designArtifactBuf  = _designArtifactBuf.slice(closeIdx + '</artifact>'.length);
      _designArtifactOpen = false;

      // Update or add the artifact
      if (_designArtifactId) {
        var existing = state.artifacts.find(function(a) { return a.id === _designArtifactId; });
        if (existing) {
          existing.content   = html;
          existing._building = false;
          existing.title     = _designArtifactMeta.title || existing.title;
          if (typeof renderArtifactContent === 'function') renderArtifactContent();
        }
      } else if (typeof addArtifact === 'function') {
        addArtifact({ type: 'html', title: _designArtifactMeta.title || 'Design output', content: html });
      }
      _designArtifactId   = null;
      _designArtifactMeta = {};
    } else if (_designArtifactId) {
      // Mid-stream: update the placeholder with whatever we have so far
      var partial = _designArtifactBuf.trim();
      if (partial.length > 200) { // Avoid thrashing on every tiny token
        var existing2 = state.artifacts.find(function(a) { return a.id === _designArtifactId; });
        if (existing2 && existing2._building) {
          existing2.content = partial + '\n<!-- building… -->';
          // Re-render every ~1kb of content to show live progress
          if (partial.length % 1000 < chunk.length) {
            if (typeof renderArtifactContent === 'function') renderArtifactContent();
          }
        }
      }
    }
  }
}

/** Reset artifact streaming state when a new conversation starts */
function resetDesignArtifactState() {
  _designArtifactBuf   = '';
  _designArtifactOpen  = false;
  _designArtifactMeta  = {};
  _designArtifactId    = null;
}

// ── Question form rendering ───────────────────────────────────────────────

/**
 * Scan a message element for <question-form> blocks and replace them
 * with interactive HTML form widgets.
 * @param {HTMLElement} msgEl — the message body element
 */
function renderQuestionFormsInMessage(msgEl) {
  if (!msgEl) return;
  // Look for pre-formatted blocks that contain question-form XML
  // (the markdown renderer will have wrapped them in <pre> or <code> blocks,
  //  or left them as raw text in a <p>)
  var html = msgEl.innerHTML;
  if (html.indexOf('question-form') === -1) return;

  // Parse all <question-form ...> ... </question-form> blocks
  var regex = /<question-form([^>]*)>([\s\S]*?)<\/question-form>/gi;
  var newHtml = html.replace(regex, function(match, attrs, inner) {
    var parsed  = _parseQuestionFormXML(attrs, inner);
    return _buildQuestionFormHTML(parsed);
  });

  if (newHtml !== html) msgEl.innerHTML = newHtml;
}

/**
 * Parse a <question-form> XML fragment into a structured object.
 */
function _parseQuestionFormXML(attrStr, innerXml) {
  var idMatch  = attrStr.match(/id=["']([^"']+)["']/);
  var formId   = idMatch ? idMatch[1] : ('qform-' + Date.now());
  var fields   = [];

  var fieldRegex = /<field([^>]*)>([\s\S]*?)<\/field>/gi;
  var fm;
  while ((fm = fieldRegex.exec(innerXml)) !== null) {
    var fa     = fm[1];
    var fInner = fm[2];
    var field  = {
      id:          (_attr(fa, 'id')          || ''),
      type:        (_attr(fa, 'type')        || 'text'),
      label:       (_attr(fa, 'label')       || ''),
      placeholder: (_attr(fa, 'placeholder') || ''),
      required:    (_attr(fa, 'required')    || '') === 'true',
      options:     []
    };
    var optRegex = /<option([^>]*)>([\s\S]*?)<\/option>/gi;
    var om;
    while ((om = optRegex.exec(fInner)) !== null) {
      field.options.push({
        value: _attr(om[1], 'value') || om[2].trim(),
        label: om[2].trim()
      });
    }
    fields.push(field);
  }
  return { formId: formId, fields: fields };
}

function _attr(str, name) {
  var m = str.match(new RegExp(name + '=["\']([^"\']*)["\']'));
  return m ? m[1] : null;
}

/**
 * Build the interactive HTML widget for a parsed question form.
 */
function _buildQuestionFormHTML(parsed) {
  var formId = parsed.formId;
  var uid    = 'qf-' + formId + '-' + Math.random().toString(36).slice(2, 6);

  var fieldsHtml = parsed.fields.map(function(f) {
    var inputHtml = '';
    if (f.type === 'radio' && f.options.length) {
      inputHtml = '<div class="design-form-radio-group">' +
        f.options.map(function(opt) {
          return '<label class="design-form-radio">' +
            '<input type="radio" name="' + escHtml(uid + '-' + f.id) + '" value="' + escHtml(opt.value) + '"> ' +
            escHtml(opt.label) +
          '</label>';
        }).join('') +
      '</div>';
    } else if (f.type === 'select' && f.options.length) {
      inputHtml = '<select class="design-form-select" name="' + escHtml(f.id) + '">' +
        '<option value="">— select —</option>' +
        f.options.map(function(opt) {
          return '<option value="' + escHtml(opt.value) + '">' + escHtml(opt.label) + '</option>';
        }).join('') +
      '</select>';
    } else if (f.type === 'textarea') {
      inputHtml = '<textarea class="design-form-textarea" name="' + escHtml(f.id) + '" rows="3" placeholder="' + escHtml(f.placeholder) + '"></textarea>';
    } else {
      inputHtml = '<input class="design-form-input" type="text" name="' + escHtml(f.id) + '" placeholder="' + escHtml(f.placeholder) + '">';
    }
    return '<div class="design-form-field">' +
      '<label class="design-form-label">' + escHtml(f.label) + (f.required ? ' <span class="design-form-req">*</span>' : '') + '</label>' +
      inputHtml +
    '</div>';
  }).join('');

  return '<div class="design-question-form" id="' + escHtml(uid) + '">' +
    '<div class="design-form-header">' +
      '<i class="ti ti-layout-2"></i>' +
      '<span>Design Brief</span>' +
    '</div>' +
    '<form onsubmit="submitDesignForm(event, \'' + escHtml(uid) + '\')">' +
      fieldsHtml +
      '<button type="submit" class="design-form-submit">Continue <i class="ti ti-arrow-right"></i></button>' +
    '</form>' +
  '</div>';
}

/**
 * Called when the user submits a design question form.
 * Collects all field values and sends them to the AI.
 */
function submitDesignForm(evt, uid) {
  evt.preventDefault();
  var container = document.getElementById(uid);
  if (!container) return;
  var form    = container.querySelector('form');
  if (!form)   return;

  var lines = [];
  var elements = form.elements;
  var seen  = {};
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    if (!el.name || el.tagName === 'BUTTON') continue;
    // Radio buttons — only capture the checked one
    if (el.type === 'radio') {
      var rname = el.name.replace(/^qf-[^-]+-[^-]+-/, '');
      if (seen[rname]) continue;
      seen[rname] = true;
      var checked = form.querySelector('input[name="' + el.name + '"]:checked');
      if (checked) lines.push('**' + rname + '**: ' + checked.value);
      continue;
    }
    if (el.value && el.value.trim()) {
      lines.push('**' + el.name + '**: ' + el.value.trim());
    }
  }

  var summary = lines.join('\n');
  if (!summary) summary = '(no input provided)';

  // Collapse the form widget
  container.innerHTML = '<div class="design-form-submitted"><i class="ti ti-check"></i> Brief submitted</div>';

  if (typeof sendDirectMessage === 'function') {
    sendDirectMessage(summary, { fromAutoFeed: true });
  }
}

// ── Direction picker ──────────────────────────────────────────────────────

/**
 * Scan a message for <question-form id="direction"> and replace with
 * a visual direction picker (color swatch cards).
 * Directions are fetched once from /api/design/directions.
 */
var _cachedDirections = null;

function renderDirectionPickerInMessage(msgEl) {
  if (!msgEl) return;
  if (msgEl.innerHTML.indexOf('id="direction"') === -1 &&
      msgEl.innerHTML.indexOf("id='direction'") === -1) return;

  if (_cachedDirections) {
    _injectDirectionPickerNow(msgEl, _cachedDirections);
  } else {
    fetch('/api/design/directions')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        _cachedDirections = d.directions || [];
        _injectDirectionPickerNow(msgEl, _cachedDirections);
      })
      .catch(function() {});
  }
}

function _injectDirectionPickerNow(msgEl, directions) {
  var uid = 'dirpick-' + Math.random().toString(36).slice(2, 6);
  var cardsHtml = directions.map(function(d) {
    var swatches = (d.palette || []).map(function(c) {
      return '<div class="dir-swatch" style="background:' + escHtml(c) + '" title="' + escHtml(c) + '"></div>';
    }).join('');
    return '<label class="dir-card">' +
      '<input type="radio" name="' + escHtml(uid) + '-dir" value="' + escHtml(d.id) + '">' +
      '<div class="dir-card-inner">' +
        '<div class="dir-swatches">' + swatches + '</div>' +
        '<div class="dir-card-name">' + escHtml(d.name) + '</div>' +
        '<div class="dir-card-desc">' + escHtml(d.description) + '</div>' +
      '</div>' +
    '</label>';
  }).join('');

  var pickerHtml = '<div class="design-direction-picker" id="' + escHtml(uid) + '">' +
    '<div class="design-form-header"><i class="ti ti-palette"></i><span>Choose a visual direction</span></div>' +
    '<div class="dir-cards">' + cardsHtml + '</div>' +
    '<button class="design-form-submit" onclick="submitDirectionPicker(\'' + escHtml(uid) + '\')">' +
      'Use this direction <i class="ti ti-arrow-right"></i>' +
    '</button>' +
  '</div>';

  // Replace the <question-form id="direction"> block
  var html = msgEl.innerHTML;
  var regex = /<question-form[^>]*id=["']direction["'][^>]*>[\s\S]*?<\/question-form>/i;
  var replaced = html.replace(regex, pickerHtml);
  if (replaced !== html) msgEl.innerHTML = replaced;
}

function submitDirectionPicker(uid) {
  var container = document.getElementById(uid);
  if (!container) return;
  var checked = container.querySelector('input[type="radio"]:checked');
  if (!checked) { if (typeof showToast === 'function') showToast('Pick a direction first'); return; }

  var dirId   = checked.value;
  var dirName = checked.closest('.dir-card').querySelector('.dir-card-name').textContent;

  // Also persist to the active project's design metadata
  var projId = state.activeProjectId;
  if (projId) {
    fetch('/api/projects/' + projId + '/design', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directionId: dirId })
    }).catch(function() {});
  }

  container.innerHTML = '<div class="design-form-submitted"><i class="ti ti-check"></i> Direction selected: ' + escHtml(dirName) + '</div>';

  if (typeof sendDirectMessage === 'function') {
    sendDirectMessage('Visual direction: **' + dirName + '** (' + dirId + '). Please proceed with the design.', { fromAutoFeed: true });
  }
}

// ── Parse <artifact> attributes ───────────────────────────────────────────
function _parseArtifactAttrs(attrStr) {
  var obj = {};
  var typeMatch  = attrStr.match(/type=["']([^"']*)["']/);
  var titleMatch = attrStr.match(/title=["']([^"']*)["']/);
  if (typeMatch)  obj.type  = typeMatch[1];
  if (titleMatch) obj.title = titleMatch[1];
  return obj;
}

// ── Skill catalog cache ───────────────────────────────────────────────────
var _cachedSkills   = null;
var _cachedSystems  = null;

function loadDesignCatalog(cb) {
  var pending = 2;
  function done() { if (--pending === 0 && cb) cb({ skills: _cachedSkills, systems: _cachedSystems }); }
  if (_cachedSkills) { pending--; if (!pending && cb) cb({ skills: _cachedSkills, systems: _cachedSystems }); }
  else fetch('/api/design/skills').then(function(r){return r.json();}).then(function(d){ _cachedSkills = d.skills||[]; done(); }).catch(function(){ _cachedSkills = []; done(); });
  if (_cachedSystems) { pending--; if (!pending && cb) cb({ skills: _cachedSkills, systems: _cachedSystems }); }
  else fetch('/api/design/systems').then(function(r){return r.json();}).then(function(d){ _cachedSystems = d.systems||[]; done(); }).catch(function(){ _cachedSystems = []; done(); });
}

// ── Design project settings modal ─────────────────────────────────────────

function openDesignSettingsModal(projectId) {
  var proj = (state.projects || []).find(function(p){ return p.id === projectId; });
  if (!proj) return;
  var design = proj.design || {};

  var modal = document.getElementById('design-settings-modal');
  if (!modal) return;

  // Set current values
  var sel = modal.querySelector('[data-field="skillId"]');
  var sys = modal.querySelector('[data-field="systemId"]');
  var fid = modal.querySelector('[data-field="fidelity"]');
  var plt = modal.querySelector('[data-field="platform"]');

  loadDesignCatalog(function(catalog) {
    // Populate skill select
    if (sel) {
      sel.innerHTML = '<option value="">— choose skill —</option>';
      (catalog.skills || []).forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        if (s.id === design.skillId) opt.selected = true;
        sel.appendChild(opt);
      });
    }
    // Populate system select
    if (sys) {
      sys.innerHTML = '<option value="">— choose design system —</option>';
      (catalog.systems || []).forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        if (s.id === design.systemId) opt.selected = true;
        sys.appendChild(opt);
      });
    }
    // Set fidelity and platform
    if (fid) fid.value = design.fidelity || 'hi';
    if (plt) plt.value = design.platform  || 'desktop';

    modal.dataset.projectId = projectId;
    modal.style.display = 'flex';
  });
}

function closeDesignSettingsModal() {
  var modal = document.getElementById('design-settings-modal');
  if (modal) modal.style.display = 'none';
}

function saveDesignSettings() {
  var modal = document.getElementById('design-settings-modal');
  if (!modal) return;
  var projectId = modal.dataset.projectId;
  if (!projectId) return;

  var get = function(f) {
    var el = modal.querySelector('[data-field="' + f + '"]');
    return el ? el.value : null;
  };

  var payload = {
    skillId:  get('skillId')  || null,
    systemId: get('systemId') || 'default',
    fidelity: get('fidelity') || 'hi',
    platform: get('platform') || 'desktop'
  };

  fetch('/api/projects/' + projectId + '/design', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function(r){ return r.json(); }).then(function() {
    closeDesignSettingsModal();
    if (typeof showToast === 'function') showToast('Design settings saved');
    if (typeof loadProjects === 'function') loadProjects();
  }).catch(function(e) {
    if (typeof showToast === 'function') showToast('Failed to save: ' + e.message);
  });
}

// ── Hook: called by chat.js after rendering each AI message ──────────────
function postProcessDesignMessage(msgEl) {
  renderQuestionFormsInMessage(msgEl);
  renderDirectionPickerInMessage(msgEl);
}

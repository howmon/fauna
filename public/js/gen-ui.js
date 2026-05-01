// ── Generative UI — inline artifact renderer ──────────────────────────────
// Renders json-render-compatible flat specs (root + elements map) directly
// in the chat message using vanilla JS components. AI can emit:
//
//   ```gen-ui
//   { "root": "card-1", "elements": { ... } }
//   ```
//
// Supported component types: Card, Stack, Heading, Text, Badge, Stat,
// Table, List, Progress, Alert, Button, Divider, KeyValue, Grid, Code, Image
//
// Actions: copy_text, open_url, toggle_visible, setState

// ── State store (per-spec instance) ──────────────────────────────────────

function _genUiCreateState(initialState) {
  var state = Object.assign({}, initialState || {});
  var listeners = [];
  return {
    get: function(path) {
      var parts = (path || '').replace(/^\//, '').split('/');
      var cur = state;
      for (var i = 0; i < parts.length; i++) {
        if (cur == null) return undefined;
        cur = cur[parts[i]];
      }
      return cur;
    },
    set: function(path, value) {
      var parts = (path || '').replace(/^\//, '').split('/');
      var cur = state;
      for (var i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
      listeners.forEach(function(fn) { try { fn(state); } catch(_) {} });
    },
    subscribe: function(fn) { listeners.push(fn); },
    snapshot: function() { return state; }
  };
}

// ── Expression resolution ─────────────────────────────────────────────────

function _genUiResolve(expr, store) {
  if (expr === null || expr === undefined) return expr;
  if (typeof expr !== 'object') return expr;
  // { $state: "/path" }
  if (expr.$state !== undefined) return store.get(expr.$state);
  // { $template: "Hello ${/user/name}!" }
  if (expr.$template) {
    return expr.$template.replace(/\$\{([^}]+)\}/g, function(_, p) { return store.get(p) != null ? store.get(p) : ''; });
  }
  // { $cond, $then, $else }
  if (expr.$cond !== undefined) {
    var cond = _genUiResolve(expr.$cond, store);
    var result = expr.eq !== undefined ? cond == expr.eq : !!cond;
    return result ? _genUiResolve(expr.$then, store) : _genUiResolve(expr.$else, store);
  }
  return expr;
}

function _genUiProps(rawProps, store) {
  var out = {};
  if (!rawProps) return out;
  Object.keys(rawProps).forEach(function(k) { out[k] = _genUiResolve(rawProps[k], store); });
  return out;
}

// ── Visibility check ─────────────────────────────────────────────────────

function _genUiVisible(el, store) {
  if (!el.visible) return true;
  var rules = Array.isArray(el.visible) ? el.visible : [el.visible];
  return rules.every(function(rule) {
    var val = store.get(rule.$state);
    var result = rule.eq !== undefined ? val == rule.eq : !!val;
    return rule.not ? !result : result;
  });
}

// ── Action dispatch ──────────────────────────────────────────────────────

function _genUiDispatch(action, params, store, rootEl) {
  if (!action) return;
  switch (action) {
    case 'setState':
      if (params && params.statePath) store.set(params.statePath, params.value);
      break;
    case 'toggle_visible': {
      var path = params && params.statePath;
      if (path) store.set(path, !store.get(path));
      break;
    }
    case 'copy_text': {
      var text = params && params.text;
      if (text && navigator.clipboard) navigator.clipboard.writeText(text).catch(function(){});
      if (typeof showToast === 'function') showToast('Copied!');
      break;
    }
    case 'open_url': {
      var url = params && params.url;
      if (url && /^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener');
      break;
    }
    default: break;
  }
}

// ── Component renderers ───────────────────────────────────────────────────

var _genUiComponents = {

  Card: function(el, props, children, store) {
    var div = document.createElement('div');
    div.className = 'gui-card';
    if (props.title) {
      var h = document.createElement('div');
      h.className = 'gui-card-title';
      h.textContent = props.title;
      div.appendChild(h);
    }
    if (props.description) {
      var d = document.createElement('div');
      d.className = 'gui-card-desc';
      d.textContent = props.description;
      div.appendChild(d);
    }
    children.forEach(function(c) { div.appendChild(c); });
    return div;
  },

  Stack: function(el, props, children, store) {
    var div = document.createElement('div');
    var dir = props.direction === 'horizontal' ? 'row' : 'column';
    div.className = 'gui-stack gui-stack-' + dir;
    if (props.gap) div.style.gap = typeof props.gap === 'number' ? props.gap + 'px' : props.gap;
    if (props.align) div.style.alignItems = props.align;
    if (props.justify) div.style.justifyContent = props.justify;
    if (props.wrap) div.style.flexWrap = 'wrap';
    children.forEach(function(c) { div.appendChild(c); });
    return div;
  },

  Grid: function(el, props, children, store) {
    var div = document.createElement('div');
    div.className = 'gui-grid';
    var cols = props.columns || 2;
    div.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    if (props.gap) div.style.gap = typeof props.gap === 'number' ? props.gap + 'px' : props.gap;
    children.forEach(function(c) { div.appendChild(c); });
    return div;
  },

  Heading: function(el, props, children, store) {
    var level = Math.min(6, Math.max(1, parseInt(props.level) || 2));
    var h = document.createElement('h' + level);
    h.className = 'gui-heading gui-heading-' + level;
    h.textContent = props.text || '';
    return h;
  },

  Text: function(el, props, children, store) {
    var p = document.createElement('p');
    p.className = 'gui-text';
    if (props.muted) p.classList.add('gui-text-muted');
    if (props.strong) p.classList.add('gui-text-strong');
    if (props.small) p.classList.add('gui-text-small');
    if (props.code) {
      var code = document.createElement('code');
      code.className = 'gui-inline-code';
      code.textContent = props.text || '';
      p.appendChild(code);
    } else {
      p.textContent = props.text || '';
    }
    return p;
  },

  Badge: function(el, props, children, store) {
    var span = document.createElement('span');
    var variant = props.variant || 'default';
    span.className = 'gui-badge gui-badge-' + variant;
    span.textContent = props.label || props.text || '';
    return span;
  },

  Stat: function(el, props, children, store) {
    var div = document.createElement('div');
    div.className = 'gui-stat';
    var val = props.value != null ? String(props.value) : '';
    // Format
    if (props.format === 'currency' && !isNaN(parseFloat(val))) {
      val = '$' + parseFloat(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (props.format === 'percent') {
      val = val + '%';
    } else if (props.format === 'number' && !isNaN(parseFloat(val))) {
      val = parseFloat(val).toLocaleString();
    }
    div.innerHTML =
      '<div class="gui-stat-value">' + escHtml(val) + '</div>' +
      '<div class="gui-stat-label">' + escHtml(props.label || '') + '</div>';
    if (props.trend) {
      var up = props.trend > 0;
      div.innerHTML += '<div class="gui-stat-trend ' + (up ? 'up' : 'down') + '">' +
        '<i class="ti ti-trending-' + (up ? 'up' : 'down') + '"></i> ' +
        escHtml(String(Math.abs(props.trend))) + '%</div>';
    }
    return div;
  },

  Alert: function(el, props, children, store) {
    var div = document.createElement('div');
    var variant = props.variant || props.type || 'info';
    div.className = 'gui-alert gui-alert-' + variant;
    var icons = { info: 'ti-info-circle', success: 'ti-circle-check', warning: 'ti-alert-triangle', error: 'ti-alert-circle' };
    div.innerHTML = '<i class="ti ' + (icons[variant] || 'ti-info-circle') + ' gui-alert-icon"></i>' +
      '<div class="gui-alert-body">' +
        (props.title ? '<div class="gui-alert-title">' + escHtml(props.title) + '</div>' : '') +
        (props.message ? '<div class="gui-alert-msg">' + escHtml(props.message) + '</div>' : '') +
      '</div>';
    children.forEach(function(c) { div.appendChild(c); });
    return div;
  },

  Button: function(el, props, children, store) {
    var btn = document.createElement('button');
    var variant = props.variant || 'default';
    btn.className = 'gui-btn gui-btn-' + variant;
    if (props.disabled || props.loading) btn.disabled = true;
    if (props.loading) {
      btn.innerHTML = '<i class="ti ti-loader-2 gui-spin"></i> ' + escHtml(props.label || '');
    } else if (props.icon) {
      btn.innerHTML = '<i class="ti ' + escHtml(props.icon) + '"></i> ' + escHtml(props.label || '');
    } else {
      btn.textContent = props.label || props.text || 'Button';
    }
    if (props.action) {
      btn.addEventListener('click', function() {
        _genUiDispatch(props.action, props.actionParams || {}, store, null);
      });
    }
    return btn;
  },

  Divider: function(el, props, children, store) {
    var hr = document.createElement('hr');
    hr.className = 'gui-divider';
    if (props.label) {
      var wrap = document.createElement('div');
      wrap.className = 'gui-divider-labeled';
      wrap.innerHTML = '<span>' + escHtml(props.label) + '</span>';
      return wrap;
    }
    return hr;
  },

  KeyValue: function(el, props, children, store) {
    var div = document.createElement('div');
    div.className = 'gui-kv';
    div.innerHTML =
      '<span class="gui-kv-key">' + escHtml(props.key || props.label || '') + '</span>' +
      '<span class="gui-kv-value">' + escHtml(props.value != null ? String(props.value) : '') + '</span>';
    return div;
  },

  Table: function(el, props, children, store) {
    var wrap = document.createElement('div');
    wrap.className = 'gui-table-wrap';
    var tbl = document.createElement('table');
    tbl.className = 'gui-table';
    if (props.columns && Array.isArray(props.columns)) {
      var thead = document.createElement('thead');
      var tr = document.createElement('tr');
      props.columns.forEach(function(col) {
        var th = document.createElement('th');
        th.textContent = typeof col === 'string' ? col : (col.header || col.label || '');
        if (col.width) th.style.width = col.width;
        if (col.align) th.style.textAlign = col.align;
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      tbl.appendChild(thead);
    }
    if (props.rows && Array.isArray(props.rows)) {
      var tbody = document.createElement('tbody');
      props.rows.forEach(function(row) {
        var tr2 = document.createElement('tr');
        (Array.isArray(row) ? row : Object.values(row)).forEach(function(cell, ci) {
          var td = document.createElement('td');
          if (props.columns && props.columns[ci] && props.columns[ci].align) td.style.textAlign = props.columns[ci].align;
          td.textContent = cell != null ? String(cell) : '';
          tr2.appendChild(td);
        });
        tbody.appendChild(tr2);
      });
      tbl.appendChild(tbody);
    }
    wrap.appendChild(tbl);
    return wrap;
  },

  List: function(el, props, children, store) {
    var tag = props.ordered ? 'ol' : 'ul';
    var list = document.createElement(tag);
    list.className = 'gui-list' + (props.ordered ? ' gui-list-ordered' : '');
    var items = props.items || [];
    items.forEach(function(item) {
      var li = document.createElement('li');
      li.textContent = typeof item === 'string' ? item : (item.label || item.text || JSON.stringify(item));
      if (typeof item === 'object' && item.description) {
        var sub = document.createElement('span');
        sub.className = 'gui-list-desc';
        sub.textContent = item.description;
        li.appendChild(sub);
      }
      list.appendChild(li);
    });
    children.forEach(function(c) { list.appendChild(c); });
    return list;
  },

  Progress: function(el, props, children, store) {
    var div = document.createElement('div');
    div.className = 'gui-progress-wrap';
    var pct = Math.min(100, Math.max(0, parseFloat(props.value) || 0));
    var label = props.label || '';
    var showPct = props.showPercent !== false;
    if (label) {
      div.innerHTML = '<div class="gui-progress-header"><span>' + escHtml(label) + '</span>' +
        (showPct ? '<span>' + pct + '%</span>' : '') + '</div>';
    }
    var bar = document.createElement('div');
    bar.className = 'gui-progress-bar';
    var fill = document.createElement('div');
    fill.className = 'gui-progress-fill';
    fill.style.width = pct + '%';
    var variant = props.variant || 'default';
    if (variant !== 'default') fill.classList.add('gui-progress-' + variant);
    bar.appendChild(fill);
    div.appendChild(bar);
    return div;
  },

  Code: function(el, props, children, store) {
    var lang = props.language || props.lang || '';
    var pre = document.createElement('pre');
    pre.className = 'gui-code-block';
    var code = document.createElement('code');
    code.className = lang ? 'language-' + lang : '';
    var raw = props.code || props.content || '';
    try {
      if (lang && typeof hljs !== 'undefined' && hljs.getLanguage(lang)) {
        code.innerHTML = hljs.highlight(raw, { language: lang }).value;
      } else if (typeof hljs !== 'undefined') {
        code.innerHTML = hljs.highlightAuto(raw).value;
      } else {
        code.textContent = raw;
      }
    } catch(_) { code.textContent = raw; }
    pre.appendChild(code);
    return pre;
  },

  Image: function(el, props, children, store) {
    var img = document.createElement('img');
    img.className = 'gui-image';
    img.alt = props.alt || '';
    if (props.src && /^https?:\/\/|^data:image\//.test(props.src)) img.src = props.src;
    if (props.width) img.style.width = typeof props.width === 'number' ? props.width + 'px' : props.width;
    if (props.height) img.style.height = typeof props.height === 'number' ? props.height + 'px' : props.height;
    img.style.maxWidth = '100%';
    return img;
  },

  Select: function(el, props, children, store) {
    var wrap = document.createElement('div');
    wrap.className = 'gui-select-wrap';
    if (props.label) {
      var lbl = document.createElement('label');
      lbl.className = 'gui-select-label';
      lbl.textContent = props.label;
      wrap.appendChild(lbl);
    }
    var sel = document.createElement('select');
    sel.className = 'gui-select';
    var options = props.options || [];
    options.forEach(function(opt) {
      var o = document.createElement('option');
      if (typeof opt === 'string') { o.value = opt; o.textContent = opt; }
      else { o.value = opt.value != null ? opt.value : opt.label; o.textContent = opt.label || opt.value; }
      sel.appendChild(o);
    });
    // Bind to state
    if (props.value && props.value.$bindState) {
      var sp = props.value.$bindState;
      var initial = store.get(sp);
      if (initial != null) sel.value = String(initial);
      sel.addEventListener('change', function() { store.set(sp, sel.value); });
    } else if (props.value != null) {
      sel.value = String(props.value);
    }
    wrap.appendChild(sel);
    return wrap;
  },

  Input: function(el, props, children, store) {
    var wrap = document.createElement('div');
    wrap.className = 'gui-input-wrap';
    if (props.label) {
      var lbl = document.createElement('label');
      lbl.className = 'gui-input-label';
      lbl.textContent = props.label;
      wrap.appendChild(lbl);
    }
    var inp = document.createElement('input');
    inp.className = 'gui-input';
    inp.type = props.type || 'text';
    inp.placeholder = props.placeholder || '';
    if (props.value && props.value.$bindState) {
      var sp = props.value.$bindState;
      inp.value = store.get(sp) != null ? String(store.get(sp)) : '';
      inp.addEventListener('input', function() { store.set(sp, inp.value); });
    } else if (props.value != null) {
      inp.value = String(props.value);
    }
    wrap.appendChild(inp);
    return wrap;
  },

  Tabs: function(el, props, children, store) {
    var wrap = document.createElement('div');
    wrap.className = 'gui-tabs';
    var tabs = props.tabs || [];
    var statePath = props.statePath || ('__tabs_' + Math.random().toString(36).slice(2));
    if (store.get(statePath) == null) store.set(statePath, tabs[0] && tabs[0].id || tabs[0] || '');
    var bar = document.createElement('div');
    bar.className = 'gui-tab-bar';
    var content = document.createElement('div');
    content.className = 'gui-tab-content';
    function render() {
      var active = store.get(statePath);
      bar.innerHTML = '';
      tabs.forEach(function(tab) {
        var id = typeof tab === 'string' ? tab : tab.id;
        var label = typeof tab === 'string' ? tab : (tab.label || tab.id);
        var btn = document.createElement('button');
        btn.className = 'gui-tab-btn' + (active === id ? ' active' : '');
        btn.textContent = label;
        btn.addEventListener('click', function() { store.set(statePath, id); });
        bar.appendChild(btn);
      });
      // show matching child
      Array.from(content.children).forEach(function(c, i) {
        var tabId = tabs[i] && (typeof tabs[i] === 'string' ? tabs[i] : tabs[i].id);
        c.style.display = tabId === active ? '' : 'none';
      });
    }
    // children map to tabs in order
    children.forEach(function(c) { content.appendChild(c); });
    store.subscribe(function() { render(); });
    render();
    wrap.appendChild(bar);
    wrap.appendChild(content);
    return wrap;
  }
};

// ── Tree renderer ─────────────────────────────────────────────────────────

function _genUiRenderElement(id, elements, store, depth) {
  if (depth > 20) return document.createTextNode(''); // guard against cycles
  var el = elements[id];
  if (!el) return document.createTextNode('');

  // Visibility
  if (!_genUiVisible(el, store)) {
    var placeholder = document.createElement('span');
    placeholder.style.display = 'none';
    placeholder.dataset.guiId = id;
    // Re-render on state changes
    store.subscribe(function() {
      var vis = _genUiVisible(el, store);
      if (vis && placeholder.parentNode) {
        var rendered = _genUiRenderElement(id, elements, store, depth);
        placeholder.parentNode.replaceChild(rendered, placeholder);
      }
    });
    return placeholder;
  }

  var props = _genUiProps(el.props, store);
  var children = (el.children || []).map(function(cid) {
    return _genUiRenderElement(cid, elements, store, depth + 1);
  });

  var renderer = _genUiComponents[el.type];
  if (!renderer) {
    // Unknown component — render as a dimmed label
    var unknown = document.createElement('div');
    unknown.className = 'gui-unknown';
    unknown.textContent = '[' + (el.type || '?') + ']';
    return unknown;
  }
  return renderer(el, props, children, store);
}

// ── Public API ────────────────────────────────────────────────────────────

// Renders a gen-ui spec into a container element
function renderGenUI(spec, container) {
  var store = _genUiCreateState(spec.state || {});
  try {
    var root = _genUiRenderElement(spec.root, spec.elements || {}, store, 0);
    container.appendChild(root);
  } catch (e) {
    container.innerHTML = '<div class="gui-error"><i class="ti ti-alert-circle"></i> Render error: ' + escHtml(e.message) + '</div>';
  }
}

// ── Derive a human-readable title from a spec ─────────────────────────────

function _genUiSpecTitle(spec) {
  // Try root element props.title, then first Heading text, then root type
  var root = spec.elements && spec.elements[spec.root];
  if (!root) return 'UI Component';
  if (root.props && root.props.title) return root.props.title;
  // Walk children for first Heading
  var all = Object.values(spec.elements);
  for (var i = 0; i < all.length; i++) {
    if (all[i].type === 'Heading' && all[i].props && all[i].props.text) return all[i].props.text;
  }
  return root.type || 'UI Component';
}

// ── Post-stream extractor ─────────────────────────────────────────────────
// Called after streaming completes (and on history load) to find all
// gen-ui placeholders and replace them with live rendered UI.

function extractAndRenderGenUI(buffer, msgEl, isHistoryLoad) {
  var blocks = msgEl.querySelectorAll('pre[data-special-lang="gen-ui"]');
  if (!blocks.length) return;
  blocks.forEach(function(pre) {
    var code = pre.querySelector('code');
    var raw = code ? code.textContent : pre.textContent;
    var spec;
    try {
      spec = JSON.parse(raw.trim());
    } catch (e) {
      var errEl = document.createElement('div');
      errEl.className = 'gui-parse-error';
      errEl.innerHTML = '<i class="ti ti-alert-circle"></i> <strong>gen-ui:</strong> JSON parse error — ' + escHtml(e.message);
      pre.replaceWith(errEl);
      return;
    }
    if (!spec || !spec.root || !spec.elements) {
      // Tolerate a bare component shorthand: { type, props, children }
      if (spec && spec.type) {
        spec = { root: '__root__', elements: { '__root__': spec } };
      } else {
        var warnEl = document.createElement('div');
        warnEl.className = 'gui-parse-error';
        warnEl.textContent = 'gen-ui: spec must have root + elements (or a single type/props object)';
        pre.replaceWith(warnEl);
        return;
      }
    }

    var wrapper = document.createElement('div');
    wrapper.className = 'gui-root';
    renderGenUI(spec, wrapper);

    // ── "Add to Project" footer ──────────────────────────────────────────
    var footer = document.createElement('div');
    footer.className = 'gui-footer';
    var specJson = raw.trim(); // keep the raw JSON for saving
    var title = _genUiSpecTitle(spec);

    var saveBtn = document.createElement('button');
    saveBtn.className = 'gui-footer-btn';
    saveBtn.innerHTML = '<i class="ti ti-folder-plus"></i> Add to Project';
    saveBtn.addEventListener('click', function() {
      if (typeof saveGenUIToProject === 'function') {
        saveGenUIToProject(specJson, title);
      }
    });
    footer.appendChild(saveBtn);
    wrapper.appendChild(footer);

    pre.replaceWith(wrapper);
  });
}

// ── Catalog prompt (for system prompt injection) ──────────────────────────
// Returns a markdown description of available components for the AI.

var GEN_UI_CATALOG_PROMPT = `
## Output format decision — artifact pane vs inline gen-ui vs plain text

Use this decision table every time you produce structured or visual output. Pick **exactly one** format.

### Use \`\`\`artifact:<type>:<title>\`\`\` (artifact pane) when:
- The output is a **file or document** the user will save, copy, or reuse (code, HTML, Markdown, JSON, CSV)
- The output is **long** (more than ~40 lines of content)
- The user's request contains words like *create*, *write*, *generate*, *build*, *draft* referencing a file or doc
- The output is runnable/executable (shell script, HTML page, full component)
- Artifact types: \`html\`, \`markdown\`, \`json\`, \`csv\`, \`code\`, \`text\`, \`files\`, \`summary\`

### Use a \`\`\`gen-ui\`\`\` block (inline in chat) when:
- The output is a **snapshot** of current data: metrics, status, comparison, leaderboard
- The output is a **compact interactive widget**: tabs, toggle, progress tracker, key-value list
- The user asked for a *dashboard*, *scorecard*, *summary card*, *checklist*, or *status overview*
- The content is **ephemeral** — not something the user needs to save or edit
- The output would be ≤ 30 logical elements and primarily visual/structured rather than prose

### Use **plain Markdown prose** when:
- The answer is conversational, explanatory, or a list of bullet points
- No special formatting would add clarity
- Never wrap plain explanations in gen-ui or artifact blocks

### Priority rule
Artifact > gen-ui > prose. If in doubt between artifact and gen-ui, ask: *would the user want to copy or save this later?* If yes → artifact. If it's just a visual aid for this moment → gen-ui.

---

## Generative UI (gen-ui inline blocks)
Render interactive UI components inline using a \`gen-ui\` code block containing a valid JSON flat spec.

**Spec shape:** \`{ "root": "id", "elements": { "id": { "type", "props", "children": [] } }, "state": {} }\`

### Available components
| Type | Key props | Notes |
|------|-----------|-------|
| \`Card\` | \`title\`, \`description\` | Container with optional header |
| \`Stack\` | \`direction\` ("vertical"/"horizontal"), \`gap\`, \`align\`, \`justify\`, \`wrap\` | Flex layout |
| \`Grid\` | \`columns\` (number), \`gap\` | CSS grid layout |
| \`Heading\` | \`text\`, \`level\` (1–6) | Heading element |
| \`Text\` | \`text\`, \`muted\`, \`strong\`, \`small\`, \`code\` | Paragraph |
| \`Badge\` | \`label\`, \`variant\` ("default"/"success"/"warning"/"error"/"info") | Colored badge |
| \`Stat\` | \`value\`, \`label\`, \`format\` ("currency"/"percent"/"number"), \`trend\` | Metric display |
| \`Alert\` | \`title\`, \`message\`, \`variant\` ("info"/"success"/"warning"/"error") | Callout banner |
| \`Button\` | \`label\`, \`variant\` ("default"/"primary"/"danger"), \`action\`, \`actionParams\`, \`icon\`, \`disabled\` | Clickable button |
| \`Divider\` | \`label\` (optional) | Horizontal rule |
| \`KeyValue\` | \`key\`, \`value\` | Label: value row |
| \`Table\` | \`columns\` (strings or \`{header,width,align}\`), \`rows\` (2-D array) | Data table |
| \`List\` | \`items\` (strings or \`{label,description}\`), \`ordered\` | Bullet/numbered list |
| \`Progress\` | \`value\` (0–100), \`label\`, \`variant\` | Progress bar |
| \`Code\` | \`code\`, \`language\` | Syntax-highlighted snippet |
| \`Image\` | \`src\`, \`alt\`, \`width\`, \`height\` | Image |
| \`Select\` | \`label\`, \`options\`, \`value\` | Dropdown |
| \`Input\` | \`label\`, \`placeholder\`, \`type\`, \`value\` | Text input |
| \`Tabs\` | \`tabs\` (array of \`{id,label}\`), \`statePath\` | Tabbed layout |

### Actions (Button.action)
\`setState\` · \`toggle_visible\` · \`copy_text\` · \`open_url\`

### Dynamic props
- \`{ "$state": "/path" }\` — read state
- \`{ "$bindState": "/path" }\` — two-way bind (Input / Select)
- \`{ "$template": "Hello \${/name}!" }\` — string interpolation
- \`{ "$cond": {"$state":"/x"}, "eq": true, "$then": "A", "$else": "B" }\` — conditional

### Example — dashboard card
\`\`\`gen-ui
{
  "root": "card",
  "elements": {
    "card": { "type": "Card", "props": { "title": "Q1 Metrics" }, "children": ["grid"] },
    "grid": { "type": "Grid", "props": { "columns": 3, "gap": 12 }, "children": ["s1","s2","s3"] },
    "s1": { "type": "Stat", "props": { "value": "128400", "label": "Revenue", "format": "currency", "trend": 12 }, "children": [] },
    "s2": { "type": "Stat", "props": { "value": "94", "label": "NPS", "format": "number", "trend": -2 }, "children": [] },
    "s3": { "type": "Stat", "props": { "value": "73", "label": "CSAT", "format": "percent", "trend": 5 }, "children": [] }
  }
}
\`\`\``.trim();

// Attach to window so chat.js can include it in the system prompt
window.GEN_UI_CATALOG_PROMPT = GEN_UI_CATALOG_PROMPT;

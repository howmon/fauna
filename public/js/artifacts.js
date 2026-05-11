// ── Artifact Pane ─────────────────────────────────────────────────────────

var _codePreviewRegistry = {}; // id → rawText for Preview buttons on code blocks

var ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Prune artifacts older than 30 days from a conversation's persisted list
function pruneStaleArtifacts(conv) {
  if (!conv || !conv.artifacts) return;
  var cutoff = Date.now() - ARTIFACT_TTL_MS;
  conv.artifacts = conv.artifacts.filter(function(a) {
    return !a.createdAt || a.createdAt > cutoff;
  });
}

function addArtifact(spec) {
  var id = 'art-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  var artifact = Object.assign({ id: id, createdAt: Date.now() }, spec);
  state.artifacts.push(artifact);
  if (state.artifacts.length > 20) state.artifacts.shift();
  renderArtifactTabs();
  // Lazy-load image data if only a path was provided
  if (artifact.type === 'image' && artifact.path && !artifact.base64) {
    fetchArtifactImage(id, artifact.path);
  }
  // Persist to current conversation (strip large binary so localStorage stays small)
  var conv = getConv(state.currentId);
  if (conv) {
    if (!conv.artifacts) conv.artifacts = [];
    var stored = Object.assign({}, artifact);
    if (stored.base64 && stored.base64.length > 20000) delete stored.base64;
    conv.artifacts.push(stored);
    if (conv.artifacts.length > 20) conv.artifacts.shift();
    saveConversations();
  }
  return id;
}

// Open the pane and show a specific artifact (called from cards/buttons)
function openArtifact(id) {
  switchArtifactTab(id);
  openArtifactPane();
}

// Inject a compact inline card that lets the user open the artifact on demand
function injectArtifactCard(id, containerEl) {
  if (!containerEl) return;
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (!a) return;
  var icons = { html:'ti-brand-html5', image:'ti-photo', markdown:'ti-markdown', json:'ti-braces',
                csv:'ti-table', text:'ti-file-text', files:'ti-folder-open', web:'ti-world', pdf:'ti-file-type-pdf', docx:'ti-file-word',
                code:'ti-code', svg:'ti-vector', summary:'ti-align-left' };
  var labels = { html:'HTML', image:'Image', markdown:'Markdown', json:'JSON',
                 csv:'CSV', text:'Text', files:'Files', web:'Web', pdf:'PDF', docx:'DOCX', code:'Code',
                 svg:'SVG', summary:'Summary' };
  var icon  = icons[a.type]  || 'ti-file';
  var label = labels[a.type] || a.type;
  var card  = document.createElement('div');
  card.className = 'artifact-card';
  card.innerHTML =
    '<div class="artifact-card-icon"><i class="ti ' + icon + '"></i></div>' +
    '<div class="artifact-card-info">' +
      '<div class="artifact-card-title">' + escHtml(a.title || 'Artifact') + '</div>' +
      '<span class="artifact-card-type">' + escHtml(label) + '</span>' +
    '</div>' +
    '<button class="artifact-card-open" onclick="openArtifact(\'' + id + '\')">' +
      '<i class="ti ti-arrow-right"></i> Open' +
    '</button>';
  containerEl.appendChild(card);
}

function removeArtifact(id) {
  var idx = state.artifacts.findIndex(function(a) { return a.id === id; });
  if (idx === -1) return;
  state.artifacts.splice(idx, 1);
  if (state.activeArtifact === id) {
    state.activeArtifact = state.artifacts.length ? state.artifacts[state.artifacts.length - 1].id : null;
  }
  renderArtifactTabs();
  if (!state.artifacts.length) closeArtifactPane();
  else renderArtifactContent();
}

function openArtifactPane() {
  document.getElementById('artifact-pane').classList.add('open');
}

function closeArtifactPane() {
  document.getElementById('artifact-pane').classList.remove('open');
}

// ── Artifact pane resize ──────────────────────────────────────────────────
(function () {
  var STORAGE_KEY = 'fauna-artifact-width';
  var MIN = 280, MAX = 900;

  // Restore saved width
  var saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (saved && saved >= MIN && saved <= MAX) {
    var style = document.createElement('style');
    style.id = 'artifact-width-override';
    style.textContent = '#artifact-pane.open { width: ' + saved + 'px !important; }';
    document.head.appendChild(style);
  }

  function setWidth(w) {
    w = Math.max(MIN, Math.min(MAX, w));
    var el = document.getElementById('artifact-width-override');
    if (!el) {
      el = document.createElement('style');
      el.id = 'artifact-width-override';
      document.head.appendChild(el);
    }
    el.textContent = '#artifact-pane.open { width: ' + w + 'px !important; }';
    localStorage.setItem(STORAGE_KEY, w);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var handle = document.getElementById('artifact-resize-handle');
    if (!handle) return;

    var startX, startW;

    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var pane = document.getElementById('artifact-pane');
      startX = e.clientX;
      startW = pane.getBoundingClientRect().width;
      pane.classList.add('resizing');

      function onMove(e) {
        var delta = startX - e.clientX; // dragging left = wider
        setWidth(startW + delta);
      }
      function onUp() {
        document.getElementById('artifact-pane').classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Double-click handle → reset to default width
    handle.addEventListener('dblclick', function () {
      localStorage.removeItem(STORAGE_KEY);
      var el = document.getElementById('artifact-width-override');
      if (el) el.textContent = '#artifact-pane.open { width: 440px !important; }';
    });
  });
}());


function appendAINotice(markdown, convId) {
  var inner = getConvInner(convId || state.currentId);
  if (!inner) return;
  var el = document.createElement('div');
  el.className = 'msg ai';
  el.innerHTML = '<div class="msg-body"><div class="prose">' + renderMarkdown(markdown) + '</div></div>';
  inner.appendChild(el);
  scrollBottom();
}

function switchArtifactTab(id) {
  state.activeArtifact = id;
  state.artifactCodeView = false; // reset to visual when switching tabs
  renderArtifactTabs();
  renderArtifactContent();
}

function renderArtifactTabs() {
  var tabs = document.getElementById('artifact-tabs');
  if (!tabs) return;
  tabs.innerHTML = state.artifacts.map(function(a) {
    var icon = artifactTypeIcon(a.type);
    var active = a.id === state.activeArtifact ? ' active' : '';
    return '<div class="artifact-tab' + active + '" onclick="switchArtifactTab(\'' + a.id + '\')" title="' + escHtml(a.title || '') + '">' +
      '<i class="ti ' + icon + '" style="font-size:11px;flex-shrink:0"></i>' +
      '<span class="artifact-tab-text">' + escHtml(a.title || 'Artifact') + '</span>' +
      '<button class="artifact-tab-close" onclick="event.stopPropagation();removeArtifact(\'' + a.id + '\')" title="Close">×</button>' +
    '</div>';
  }).join('');
}

function artifactTypeIcon(type) {
  var m = { html:'ti-brand-html5', image:'ti-photo', markdown:'ti-markdown', json:'ti-braces',
            csv:'ti-table', text:'ti-file-text', files:'ti-folder-open', web:'ti-world', pdf:'ti-file-type-pdf', docx:'ti-file-word',
            code:'ti-code', svg:'ti-vector', summary:'ti-align-left', design:'ti-layout-2' };
  return m[type] || 'ti-file';
}

// Per-artifact frame setting: null = no frame, 'browser-chrome' | 'iphone-15-pro' | 'android-pixel' | 'macbook'
var _artifactFrames = {};

function renderArtifactContent() {
  var body = document.getElementById('artifact-body');
  if (!body) return;
  var a = state.artifacts.find(function(x) { return x.id === state.activeArtifact; });
  if (!a) {
    body.innerHTML = '<div class="artifact-empty"><i class="ti ti-layers-intersect"></i><span>Nothing to preview</span></div>';
    return;
  }

  var toolbar = makeArtifactToolbar(a);
  var content = '';
  var showCode = !!state.artifactCodeView;

  if ((a.type === 'html' || a.type === 'svg' || a.type === 'design') && !showCode) {
    var doc = a.type === 'svg'
      ? '<!DOCTYPE html><html><body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh">' + a.content + '</body></html>'
      : a.content;
    var activeFrame = _artifactFrames[a.id] || null;
    if (activeFrame && a.type === 'design') {
      // Render inside device frame — load frame HTML, communicate content via postMessage
      content = '<div class="artifact-scroll artifact-frame-wrap" style="height:calc(100% - 35px);background:#1a1a1a;overflow:auto">' +
        '<iframe id="frame-host-' + a.id + '" src="/api/design/frames/' + encodeURIComponent(activeFrame) + '" style="border:none;width:100%;height:100%;min-height:600px" ' +
          'sandbox="allow-scripts allow-same-origin" ' +
          'onload="(function(el){var f=el.contentWindow;var d=' + JSON.stringify(JSON.stringify({type:'setContent',html:doc})) + ';f.postMessage(JSON.parse(d),\'*\')})(this)">' +
        '</iframe>' +
      '</div>';
    } else {
      var srcdoc = doc.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/`/g,'&#96;').replace(/\n/g,'&#10;');
      content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
        '<iframe srcdoc="' + srcdoc + '" sandbox="allow-scripts allow-modals allow-popups allow-forms" title="' + escHtml(a.title) + '"></iframe>' +
      '</div>';
    }

  } else if ((a.type === 'html' || a.type === 'svg' || a.type === 'design' || showCode) && a.content != null) {
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<pre class="artifact-mono">' + escHtml(a.content || '') + '</pre>' +
    '</div>';

  } else if (a.type === 'image') {
    var src = a.base64 ? 'data:' + (a.mime || 'image/png') + ';base64,' + a.base64 : '';
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<div class="artifact-image-wrap">' +
        (src ? '<img src="' + src + '" alt="' + escHtml(a.title) + '" id="artimg-' + a.id + '">'
             : '<div id="artimg-' + a.id + '" style="color:var(--fau-text-muted);font-size:12px">Loading…</div>') +
      '</div>' +
    '</div>';

  } else if (a.type === 'pdf' && a.path) {
    var pdfUrl = '/api/preview-file?path=' + encodeURIComponent(a.path);
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px);background:#2a2a2a">' +
      '<iframe src="' + pdfUrl + '" title="' + escHtml(a.title || 'PDF') + '" style="width:100%;height:100%;border:none;background:#fff"></iframe>' +
    '</div>';

  } else if (a.type === 'docx') {
    var readOnly = a.editable === false;
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<div style="padding:12px;display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box">' +
        '<div style="font-size:12px;color:var(--fau-text-muted)">' +
          (readOnly ? 'Previewing extracted document text. Editing is not supported for this document format in this build.' : 'Previewing extracted document text. Edit below and save back to the source document.') +
        '</div>' +
        '<textarea id="artifact-docx-editor-' + a.id + '" spellcheck="true" style="flex:1;min-height:280px;resize:none;background:var(--fau-surface2);color:var(--fau-text);border:1px solid var(--fau-border);border-radius:8px;padding:12px;font:13px/1.5 var(--mono);outline:none">' + escHtml(a.content || '') + '</textarea>' +
      '</div>' +
    '</div>';

  } else if (a.type === 'markdown' || a.type === 'summary' || a.type === 'web') {
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<div class="artifact-prose msg-body" id="artifact-md-' + a.id + '">' + renderMarkdown(a.content || '') + '</div>' +
    '</div>';

  } else if (a.type === 'json') {
    var pretty = a.content;
    try { pretty = JSON.stringify(JSON.parse(a.content), null, 2); } catch (_) {}
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<pre class="artifact-mono">' + escHtml(pretty) + '</pre>' +
    '</div>';

  } else if (a.type === 'csv') {
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<div class="artifact-prose">' + csvToHtmlTable(a.content || '') + '</div>' +
    '</div>';

  } else if (a.type === 'files') {
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<div class="artifact-files">' + renderFileList(a.content || '') + '</div>' +
    '</div>';

  } else {
    // text / code / fallback
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<pre class="artifact-mono">' + escHtml(a.content || '') + '</pre>' +
    '</div>';
  }

  body.innerHTML = toolbar + content;
  
  // Initialize mermaid diagrams if this is a markdown artifact
  if ((a.type === 'markdown' || a.type === 'summary' || a.type === 'web') && typeof initMermaidInContainer === 'function') {
    var mdContainer = document.getElementById('artifact-md-' + a.id);
    if (mdContainer) {
      setTimeout(function() { initMermaidInContainer(mdContainer); }, 100);
    }
  }
}

function makeArtifactToolbar(a) {
  var btns = '';
  var showCode = !!state.artifactCodeView;

  // Visual / Code toggle for HTML, SVG, and design artifacts
  if (a.type === 'html' || a.type === 'svg' || a.type === 'design') {
    btns += '<button class="artifact-tbtn artifact-tbtn-view' + (!showCode ? ' active' : '') + '" onclick="setArtifactView(false)" title="Rendered preview"><i class="ti ti-eye"></i> Visual</button>';
    btns += '<button class="artifact-tbtn artifact-tbtn-view' + (showCode ? ' active' : '') + '" onclick="setArtifactView(true)" title="View source"><i class="ti ti-code"></i> Code</button>';
  }

  // Device frame picker for design artifacts
  if (a.type === 'design') {
    var curFrame = _artifactFrames[a.id] || '';
    var frames = [
      { id: '',               icon: 'ti-layout',          label: 'No frame' },
      { id: 'browser-chrome', icon: 'ti-browser',         label: 'Browser' },
      { id: 'macbook',        icon: 'ti-device-laptop',   label: 'MacBook' },
      { id: 'iphone-15-pro',  icon: 'ti-device-mobile',   label: 'iPhone' },
      { id: 'android-pixel',  icon: 'ti-brand-android',   label: 'Android' }
    ];
    frames.forEach(function(f) {
      btns += '<button class="artifact-tbtn' + (curFrame === f.id ? ' active' : '') + '" ' +
        'onclick="setArtifactFrame(\'' + a.id + '\',\'' + f.id + '\')" title="' + f.label + '">' +
        '<i class="ti ' + f.icon + '"></i>' +
      '</button>';
    });
    // PDF print button
    btns += '<button class="artifact-tbtn" onclick="printDesignArtifact(\'' + a.id + '\')" title="Print / Save as PDF"><i class="ti ti-printer"></i><span class="artifact-tbtn-label"> PDF</span></button>';
  }

  // Copy source code
  if (a.content != null) {
    btns += '<button class="artifact-tbtn" onclick="copyArtifact(\'' + a.id + '\')" title="Copy source code"><i class="ti ti-copy"></i><span class="artifact-tbtn-label"> Copy Code</span></button>';
  }
  // Download
  if (a.content != null) {
    var ext = (a.type === 'design') ? '.html' : a.type === 'html' ? '.html' : a.type === 'svg' ? '.svg' : a.type === 'json' ? '.json' : a.type === 'csv' ? '.csv' : a.type === 'markdown' ? '.md' : '.txt';
    var filename = (a.title || 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
    btns += '<button class="artifact-tbtn" onclick="downloadArtifact(\'' + a.id + '\',\'' + escHtml(filename) + '\')" title="Download file"><i class="ti ti-download"></i><span class="artifact-tbtn-label"> Download</span></button>';
  }
  // Open externally in default browser
  if (a.type === 'html' || a.type === 'svg' || a.type === 'design') {
    btns += '<button class="artifact-tbtn" onclick="openArtifactExternal(\'' + a.id + '\')" title="Open in browser"><i class="ti ti-external-link"></i><span class="artifact-tbtn-label"> Open</span></button>';
  }
  if ((a.type === 'image') && a.path) {
    btns += '<button class="artifact-tbtn" onclick="openFileInFinder(\'' + a.path + '\')" title="Reveal in Finder"><i class="ti ti-folder"></i><span class="artifact-tbtn-label"> Reveal</span></button>';
  }
  if (a.type === 'pdf' && a.path) {
    btns += '<button class="artifact-tbtn" onclick="openFilePath(\'' + a.path + '\')" title="Open file"><i class="ti ti-external-link"></i><span class="artifact-tbtn-label"> Open</span></button>';
    btns += '<button class="artifact-tbtn" onclick="openFileInFinder(\'' + a.path + '\')" title="Reveal in Finder"><i class="ti ti-folder"></i><span class="artifact-tbtn-label"> Reveal</span></button>';
  }
  if (a.type === 'docx' && a.path) {
    if (a.editable !== false) {
      btns += '<button class="artifact-tbtn" onclick="saveDocxArtifact(\'' + a.id + '\')" title="Save changes back to document"><i class="ti ti-device-floppy"></i><span class="artifact-tbtn-label"> Save</span></button>';
    }
    btns += '<button class="artifact-tbtn" onclick="openFilePath(\'' + a.path + '\')" title="Open file"><i class="ti ti-external-link"></i><span class="artifact-tbtn-label"> Open</span></button>';
    btns += '<button class="artifact-tbtn" onclick="openFileInFinder(\'' + a.path + '\')" title="Reveal in Finder"><i class="ti ti-folder"></i><span class="artifact-tbtn-label"> Reveal</span></button>';
  }
  if (a.url && /^https?:\/\//i.test(a.url)) {
    btns += '<button class="artifact-tbtn" onclick="window.open(\'' + escHtml(a.url) + '\',\'_blank\')" title="Open URL"><i class="ti ti-external-link"></i><span class="artifact-tbtn-label"> Open</span></button>';
  }
  // Save to active project
  if (state.activeProjectId && a.content != null) {
    btns += '<button class="artifact-tbtn proj-save-btn" onclick="saveArtifactToProject(\'' + escHtml(a.id) + '\')" title="Save to project"><i class="ti ti-folder-plus"></i><span class="artifact-tbtn-label"> Save to Project</span></button>';
  }
  return '<div class="artifact-toolbar">' +
    '<span class="artifact-toolbar-label">' + escHtml(a.title || 'Artifact') + '</span>' +
    btns +
  '</div>';
}

function setArtifactFrame(id, frameId) {
  _artifactFrames[id] = frameId;
  if (state.activeArtifact === id) renderArtifactContent();
}

function printDesignArtifact(id) {
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (!a || !a.content) return;
  var win = window.open('', '_blank');
  if (!win) return;
  win.document.write(a.content);
  win.document.close();
  win.focus();
  setTimeout(function() { win.print(); }, 500);
}

function setArtifactView(codeMode) {
  state.artifactCodeView = codeMode;
  renderArtifactContent();
}

function copyArtifact(id) {
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (a && a.content != null) navigator.clipboard.writeText(a.content).catch(function() {});
}

function downloadArtifact(id, filename) {
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (!a || a.content == null) return;
  var blob = new Blob([a.content], { type: 'text/plain' });
  var url  = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click();
  document.body.removeChild(link); URL.revokeObjectURL(url);
}

function openArtifactExternal(id) {
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (!a) return;
  if (a.type === 'html' || a.type === 'svg') {
    // Write to a temp file via the API, then open with the OS default browser.
    // Using Blob + window.open doesn't work in Electron (blob: URLs are blocked by shell.openExternal).
    var isWin = navigator.userAgent.includes('Windows');
    var ext = a.type === 'svg' ? '.svg' : '.html';
    var tmpPath = isWin
      ? 'C:\\Users\\Public\\fauna-artifact-' + a.id + ext
      : '/tmp/fauna-artifact-' + a.id + ext;
    var openCmd = isWin ? 'start "" "' + tmpPath + '"' : 'open ' + JSON.stringify(tmpPath);
    fetch('/api/write-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpPath, content: a.content })
    }).then(function() {
      fetch('/api/shell-exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: openCmd })
      });
    }).catch(function(e) { console.error('openArtifactExternal:', e); });
  }
}

function openFileInFinder(path) {
  fetch('/api/shell-exec', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'open -R ' + JSON.stringify(path) }) }).catch(function(){});
}

function openFilePath(path) {
  fetch('/api/shell-exec', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'open ' + JSON.stringify(path) }) }).catch(function(){});
}

async function saveDocxArtifact(id) {
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (!a || !a.path) return;
  var editor = document.getElementById('artifact-docx-editor-' + id);
  if (!editor) return;
  var nextContent = editor.value;
  try {
    var r = await fetch('/api/write-document-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: a.path, content: nextContent })
    });
    var d = await r.json();
    if (!r.ok || !d.ok) throw new Error((d && d.error) || 'Failed to save document');
    a.content = nextContent;
    saveConversations();
    showToast('Document saved');
  } catch (e) {
    showToast('Save failed: ' + e.message);
  }
}

async function fetchArtifactImage(id, path) {
  try {
    var r = await fetch('/api/read-image?path=' + encodeURIComponent(path));
    if (!r.ok) return;
    var d = await r.json();
    var a = state.artifacts.find(function(x) { return x.id === id; });
    if (a) { a.base64 = d.base64; a.mime = d.mime; }
    // Update DOM if currently displayed
    var el = document.getElementById('artimg-' + id);
    if (el) {
      var img = document.createElement('img');
      img.src = 'data:' + d.mime + ';base64,' + d.base64;
      img.alt = path;
      img.style.cssText = 'max-width:100%;max-height:65vh;object-fit:contain;border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,.4)';
      el.parentNode.replaceChild(img, el);
    }
  } catch (_) {}
}

function csvToHtmlTable(csv) {
  var lines = csv.trim().split('\n');
  if (!lines.length) return '';
  var headers = lines[0].split(',').map(function(h) { return '<th>' + escHtml(h.trim()) + '</th>'; }).join('');
  var rows = lines.slice(1).map(function(row) {
    return '<tr>' + row.split(',').map(function(c) { return '<td>' + escHtml(c.trim()) + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<table><thead><tr>' + headers + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderFileList(text) {
  return text.trim().split('\n').filter(Boolean).map(function(line) {
    line = line.trim();
    var isDir = line.endsWith('/');
    var name  = line.split('/').pop() || line;
    var icon  = isDir ? 'ti-folder' : fileIcon(name);
    var canPreview = isLikelyArtifactPath(line);
    return '<div class="artifact-file-row' + (canPreview ? '' : ' artifact-file-row-disabled') + '"' +
      (canPreview ? ' onclick="previewFilePath(' + JSON.stringify(line) + ')"' : '') +
      ' title="' + escHtml(canPreview ? line : 'Not a previewable file path: ' + line) + '">' +
      '<i class="ti ' + icon + '"></i>' +
      '<span class="artifact-file-path">' + escHtml(line) + '</span>' +
    '</div>';
  }).join('');
}

function isLikelyArtifactPath(line) {
  var value = String(line || '').trim();
  if (!value) return false;
  if (/^[0-9]+:?$/.test(value)) return false;
  if (/^[0-9]+:\s*$/.test(value)) return false;
  if (/^[A-Za-z]+:$/.test(value)) return false;
  if (/^[A-Za-z][A-Za-z\s-]{1,40}:$/.test(value)) return false;
  if (/^(developer|assistant|user|system)$/i.test(value)) return false;
  if (/^[*-]\s+/.test(value)) value = value.replace(/^[*-]\s+/, '');
  if (/^\d+[.)]\s+/.test(value)) value = value.replace(/^\d+[.)]\s+/, '');
  if (/^(https?:|data:|blob:)/i.test(value)) return false;
  if (/^[~./]/.test(value)) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (/[\\/]/.test(value)) return true;
  if (/\.[A-Za-z0-9]{1,8}$/.test(value)) return true;
  return false;
}

function fileIcon(name) {
  var ext = (name.split('.').pop() || '').toLowerCase();
  var m = { js:'ti-brand-javascript', ts:'ti-brand-typescript', jsx:'ti-brand-react', tsx:'ti-brand-react',
            py:'ti-brand-python', html:'ti-brand-html5', css:'ti-palette', json:'ti-braces',
            md:'ti-markdown', txt:'ti-file-text', png:'ti-photo', jpg:'ti-photo',
            jpeg:'ti-photo', gif:'ti-photo', svg:'ti-vector', pdf:'ti-file-type-pdf',
            sh:'ti-terminal', csv:'ti-table', xml:'ti-code', yaml:'ti-file', yml:'ti-file' };
  return m[ext] || 'ti-file';
}

async function previewFilePath(filePath) {
  if (!isLikelyArtifactPath(filePath)) return;
  var ext = (filePath.split('.').pop() || '').toLowerCase();
  if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
    openArtifact(addArtifact({ type: 'image', title: filePath.split('/').pop(), path: filePath }));
    return;
  }
  if (ext === 'pdf') {
    openArtifact(addArtifact({ type: 'pdf', title: filePath.split('/').pop(), path: filePath }));
    return;
  }
  if (['doc','docx','rtf','odt','pages'].includes(ext)) {
    try {
      var docRes = await fetch('/api/extract-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath })
      });
      var docData = await docRes.json();
      if (!docRes.ok || !docData.ok) throw new Error((docData && docData.error) || 'Failed to preview document');
      openArtifact(addArtifact({ type: 'docx', title: filePath.split('/').pop(), path: docData.path || filePath, content: docData.content || '', editable: docData.editable !== false }));
    } catch (_) {}
    return;
  }
  try {
    var r = await fetch('/api/shell-exec', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ command: 'cat ' + JSON.stringify(filePath) + ' 2>/dev/null | head -500' }) });
    var d = await r.json();
    if (d.stdout) {
      var type = ['md','markdown'].includes(ext) ? 'markdown'
               : ext === 'json' ? 'json'
               : ext === 'csv'  ? 'csv'
               : ['html','htm'].includes(ext) ? 'html'
               : 'text';
      openArtifact(addArtifact({ type: type, title: filePath.split('/').pop(), path: filePath, content: d.stdout }));
    }
  } catch (_) {}
}

// Called from code-block Preview buttons
function previewCodeBlock(codeId, lang) {
  var raw = _codePreviewRegistry[codeId];
  if (raw == null) return;
  var typeMap = { html:'html', svg:'svg', markdown:'markdown', md:'markdown',
                  json:'json', csv:'csv', javascript:'code', python:'code' };
  var type  = typeMap[lang] || 'text';
  var title = lang.toUpperCase() + ' Preview';
  var id = addArtifact({ type: type, title: title, content: raw });
  openArtifact(id); // explicit user click → open immediately
}

// Extract ```artifact:TYPE blocks that AI can emit directly
// injectCards=false when called from appendMessageDOM (history load — cards injected from restored state.artifacts)
function extractArtifactsFromBuffer(buffer, msgEl, injectCards) {
  if (injectCards === undefined) injectCards = true;
  var container = msgEl ? (msgEl.querySelector('.msg-body') || msgEl) : null;
  var re = /```artifact:([^\n`]+)\n([\s\S]*?)```/g;
  var match;
  while ((match = re.exec(buffer)) !== null) {
    var spec    = match[1].trim();
    var content = match[2];
    var parts   = spec.split(':');
    var type    = parts[0];
    var title   = parts.slice(1).join(':') || type;
    var id;

    if (injectCards) {
      // Live stream end — create artifact and inject card
      if (type === 'image') {
        id = addArtifact({ type: 'image', title: title, path: title });
      } else if (type === 'html') {
        id = addArtifact({ type: 'html', title: title || 'HTML Preview', content: content });
      } else if (type === 'markdown' || type === 'md') {
        id = addArtifact({ type: 'markdown', title: title || 'Document', content: content });
      } else if (type === 'json') {
        id = addArtifact({ type: 'json', title: title || 'JSON', content: content });
      } else if (type === 'csv') {
        id = addArtifact({ type: 'csv', title: title || 'Data', content: content });
      } else if (type === 'files') {
        id = addArtifact({ type: 'files', title: title || 'Files', content: content });
      } else if (type === 'summary') {
        id = addArtifact({ type: 'summary', title: title || 'Summary', content: content });
      } else {
        id = addArtifact({ type: 'text', title: title || 'Output', content: content });
      }
      if (id && container) injectArtifactCard(id, container);
    } else {
      // History load — artifacts already restored into state.artifacts; just inject the card
      var existing = state.artifacts.find(function(a) {
        return a.type === type && (a.title === title || a.title === (title || type));
      });
      if (existing && container) injectArtifactCard(existing.id, container);
    }
  }
}

// Auto-detect artifacts from shell stdout (file listings, JSON output, etc.)
function detectShellArtifacts(command, stdout, containerEl) {
  if (!stdout || stdout.trim().length < 100) return;
  var cmd = command.trim();

  // Only explicit file-listing commands with meaningful output
  if (/^find\s+\S+.*-(?:type\s+f|name\b)/i.test(cmd) || /^ls\s+-[la]{2,}/i.test(cmd)) {
    var lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length >= 6) {
      var id = addArtifact({ type: 'files', title: 'Files', content: stdout.trim() });
      if (id && containerEl) injectArtifactCard(id, containerEl);
    }
    return;
  }

  // JSON: only rich nested objects
  var trimmed = stdout.trim();
  if (trimmed.length > 300 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      var parsed = JSON.parse(trimmed);
      var depth = JSON.stringify(parsed).split('{').length - 1 + JSON.stringify(parsed).split('[').length - 1;
      if (depth >= 4) {
        var id = addArtifact({ type: 'json', title: 'JSON Output', content: trimmed });
        if (id && containerEl) injectArtifactCard(id, containerEl);
      }
    } catch (_) {}
  }
}


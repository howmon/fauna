// ── Markdown setup ────────────────────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: true });
marked.use({
  renderer: {
    code(token, infostring, escaped) {
      // marked.js has TWO calling conventions depending on version:
      //   Old (v4-): code(codeText:string, infostring:string, escaped:bool)
      //   New (v5+): code(token:object) where token.text / token.lang
      var rawText, lang, fullLang;
      if (typeof token === 'string') {
        // Old API — first arg IS the code content
        rawText = token.trim();
        fullLang = (infostring || '');
        lang = fullLang.split(/[\s.]/)[0] || 'plaintext';
      } else {
        // New token-object API
        rawText = (token.text != null ? token.text : token.raw || '').trim();
        fullLang = (token.lang || '');
        lang = fullLang.split(/[\s.]/)[0] || 'plaintext';
      }
      dbg('  fence lang=' + lang + ' text=' + JSON.stringify(rawText.slice(0,80)), 'info');

      // Explicit tool blocks: rendered as plain placeholders, replaced by widgets after streaming
      if (lang === 'shell-exec' || lang === 'shell_exec') {
        return '<pre data-special-lang="shell-exec"><code class="language-shell-exec">' + escHtml(rawText) + '</code></pre>';
      }
      // write-file blocks: lang is "write-file:/path/to/file" (raw, unsanitized — fallback only)
      // Use fullLang so file extensions (dots) are not stripped from the path
      if (fullLang.startsWith('write-file:') || fullLang.startsWith('write-file/')) {
        // Inline write-file block (not yet sanitized) — extract content directly
        var wfPath = fullLang.replace(/^write-file[:/]/, '').trim();
        var wfId = 'wf-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        _wfContentStore[wfId] = { path: wfPath, content: rawText };
        return '<pre data-special-lang="write-file"><code class="language-write-file" data-wf-id="' + escHtml(wfId) + '" data-wf-path="' + escHtml(wfPath) + '"></code></pre>';
      }
      // write-file-ready: already sanitized placeholder — content is in _wfContentStore
      // Use fullLang so any dots in the path survive
      if (fullLang.startsWith('write-file-ready:')) {
        var parts = fullLang.slice('write-file-ready:'.length).split(':');
        var wfId  = parts[0];
        var wfPath = parts.slice(1).join(':');
        return '<pre data-special-lang="write-file"><code class="language-write-file" data-wf-id="' + escHtml(wfId) + '" data-wf-path="' + escHtml(wfPath) + '"></code></pre>';
      }
      // Runnable script langs — treat as shell-exec so they auto-run when autoRunShell is on.
      // The shell-exec pipeline already serializes execution, feeds results back to the AI,
      // and hard-stops on empty output, so regular bash/sh/python blocks can use it safely.
      var RUNNABLE_LANGS = { bash:1, sh:1, zsh:1, shell:1, python:1, python3:1, node:1, nodejs:1, ruby:1, perl:1, console:1 };
      if (RUNNABLE_LANGS[lang]) {
        return '<pre data-special-lang="shell-exec"><code class="language-shell-exec">' + escHtml(rawText) + '</code></pre>';
      }
      if (lang === 'figma-exec' || lang === 'figma_exec') {
        return '<pre data-special-lang="figma-exec"><code class="language-figma-exec">' + escHtml(rawText) + '</code></pre>';
      }
      if (lang === 'save-instruction' || lang === 'save_instruction') {
        return '<pre data-special-lang="save-instruction"><code class="language-save-instruction">' + escHtml(rawText) + '</code></pre>';
      }
      // create-agent blocks: rendered as an invisible placeholder so extractAndRenderCreateAgent
      // can replace them with the "Open in Agent Builder" card. No run button, no COT wrapping.
      if (lang === 'create-agent' || lang === 'create_agent') {
        return '<pre data-special-lang="create-agent" style="display:none"><code class="language-create-agent">' + escHtml(rawText) + '</code></pre>';
      }
      // patch-agent: edit an existing owned agent
      if (lang === 'patch-agent' || lang === 'patch_agent') {
        return '<pre data-special-lang="patch-agent" style="display:none"><code class="language-patch-agent">' + escHtml(rawText) + '</code></pre>';
      }
      // uninstall-agent: remove a locally installed agent
      if (lang === 'uninstall-agent' || lang === 'uninstall_agent') {
        return '<pre data-special-lang="uninstall-agent" style="display:none"><code class="language-uninstall-agent">' + escHtml(rawText) + '</code></pre>';
      }
      // gen-ui: generative UI spec — rendered inline as live components after streaming
      if (lang === 'gen-ui' || lang === 'gen_ui') {
        return '<pre data-special-lang="gen-ui" style="display:none"><code class="language-gen-ui">' + escHtml(rawText) + '</code></pre>';
      }

      var highlighted;
      try {
        if (hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(rawText, { language: lang }).value;
        } else {
          highlighted = hljs.highlightAuto(rawText).value;
        }
      } catch (e) { highlighted = escHtml(rawText); }

      // Non-runnable display languages (markup, data, configs)
      var NO_RUN = { html:1, xml:1, svg:1, json:1, yaml:1, yml:1, toml:1,
                     css:1, scss:1, less:1, markdown:1, md:1, diff:1, patch:1 };
      var showRun = !NO_RUN[lang];

      var runBtn = showRun
        ? '<button class="code-run" data-lang="' + lang + '" onclick="runCodeBlock(this)" title="Run in shell"><i class="ti ti-player-play"></i> Run</button>'
        : '';

      // Preview button for visual languages
      var PREVIEWABLE = { html:1, svg:1, markdown:1, md:1, json:1, csv:1 };
      var previewBtn = '';
      if (PREVIEWABLE[lang]) {
        var codeId = 'cprev-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
        _codePreviewRegistry[codeId] = rawText;
        previewBtn = '<button class="code-preview" onclick="previewCodeBlock(\'' + codeId + '\',\'' + lang + '\')" title="Preview in artifact pane"><i class="ti ti-eye"></i> Preview</button>';
      }

      return '<pre data-lang="' + lang + '"><div class="code-header"><span>' + lang + '</span>' +
        '<div style="display:flex;gap:4px;margin-left:auto">' + previewBtn + runBtn +
        '<button class="code-copy" onclick="copyCode(this)">Copy</button></div></div>' +
        '<code class="hljs language-' + lang + '">' + highlighted + '</code></pre>';
    },

    // Proxy local file images through /api/read-image so they actually load
    image(token) {
      var href = typeof token === 'string' ? token : (token.href || '');
      var title = typeof token === 'string' ? '' : (token.title || '');
      var text  = typeof token === 'string' ? '' : (token.text || '');
      // Absolute local paths (e.g. /tmp/screen.png, /Users/...) → proxy through read-image
      if (href && /^\/[a-zA-Z]/.test(href) && !href.startsWith('/api/')) {
        var proxy = '/api/read-image?path=' + encodeURIComponent(href);
        var imgId = 'mdimg-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
        // Async-load the image via the API
        setTimeout(function() {
          fetch(proxy).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
            if (!d) return;
            var el = document.getElementById(imgId);
            if (el) el.src = 'data:' + d.mime + ';base64,' + d.base64;
          }).catch(function(){});
        }, 0);
        return '<img id="' + imgId + '" alt="' + escHtml(text) + '" style="max-width:100%;border-radius:6px;margin:8px 0"' +
          (title ? ' title="' + escHtml(title) + '"' : '') + '>';
      }
      // Remote URLs and data URIs pass through normally
      return '<img src="' + escHtml(href) + '" alt="' + escHtml(text) + '" style="max-width:100%;border-radius:6px;margin:8px 0"' +
        (title ? ' title="' + escHtml(title) + '"' : '') + '>';
    }
  }
});

function renderMarkdown(text) {
  // Strip artifact fenced blocks before rendering — they're shown as entity cards, not code fences
  // Backreference: match same number of opening/closing backticks (3+) so nested ``` inside artifacts are preserved
  var cleaned = (text || '').replace(/(`{3,})artifact:[^\n]+\n[\s\S]*?\1\n?/g, '');
  
  // Pre-process mermaid blocks before markdown parsing
  // Replace ```mermaid blocks with placeholder divs
  var mermaidId = 0;
  var mermaidBlocks = {};
  cleaned = cleaned.replace(/```mermaid\n([\s\S]*?)```/g, function(match, code) {
    var id = 'mermaid-placeholder-' + (mermaidId++);
    mermaidBlocks[id] = code.trim();
    return '<div class="mermaid-placeholder" data-mermaid-id="' + id + '"></div>';
  });

  // Handle unclosed mermaid block at end of text (streaming — closing ``` not yet received).
  // Without this, marked@13 treats everything after the unclosed fence as code and
  // stops rendering the rest of the message as markdown (looks like truncation).
  cleaned = cleaned.replace(/```mermaid\n([\s\S]*)$/, function(match, code) {
    var id = 'mermaid-placeholder-' + (mermaidId++);
    mermaidBlocks[id] = code.trim(); // preserve partial diagram; will re-render when fence closes
    return '<div class="mermaid-placeholder" data-mermaid-id="' + id + '"></div>';
  });
  
  try {
    var html = marked.parse(cleaned);
    // Sanitise HTML to prevent XSS from AI-generated or injected content
    html = typeof DOMPurify !== 'undefined'
      ? DOMPurify.sanitize(html, { ADD_ATTR: ['data-special-lang', 'data-lang', 'data-wf-id', 'data-wf-path', 'onclick', 'data-code-id', 'data-mermaid-id'], ADD_TAGS: ['iframe'] })
      : html;
    
    // Replace placeholders with actual mermaid divs
    html = html.replace(/<div class="mermaid-placeholder" data-mermaid-id="([^"]+)"><\/div>/g, function(match, id) {
      var code = mermaidBlocks[id] || '';
      return '<pre class="mermaid">' + escHtml(code) + '</pre>';
    });
    
    return html;
  }
  catch (e) { return escHtml(cleaned); }
}

// Initialize mermaid diagrams in a container after it's been inserted into DOM
function initMermaidInContainer(container) {
  if (typeof mermaid === 'undefined' || !container) return;
  
  try {
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
    var mermaidBlocks = container.querySelectorAll('pre.mermaid');
    if (mermaidBlocks.length === 0) return;
    
    mermaidBlocks.forEach(function(block) {
      var code = block.textContent;
      var id = 'mermaid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
      block.id = id;
      block.textContent = code; // Ensure clean text content
    });
    
    mermaid.run({ nodes: Array.from(mermaidBlocks) });
  } catch (e) {
    console.error('[mermaid] Init error:', e);
  }
}

// ── Chain of Thought rendering ────────────────────────────────────────────

// Segment buffer into {type:'prose',text} | {type:'code',lang,lines,isLive}
function parseBufferSegments(buffer) {
  var segments = [];
  var re = /```([^\n`]*)\n([\s\S]*?)```/g;
  var lastIndex = 0, match;
  while ((match = re.exec(buffer)) !== null) {
    var prose = buffer.slice(lastIndex, match.index);
    if (prose) segments.push({ type: 'prose', text: prose });
    var lang = (match[1].trim().split(/[\s.]/)[0] || 'code').toLowerCase();
    segments.push({ type: 'code', lang: lang, lines: match[2].split('\n').length, isLive: false });
    lastIndex = match.index + match[0].length;
  }
  var rest = buffer.slice(lastIndex);
  if (rest) {
    var fenceIdx = rest.lastIndexOf('\n```');
    if (fenceIdx === -1) fenceIdx = rest.indexOf('```');
    if (fenceIdx !== -1) {
      var pre = rest.slice(0, fenceIdx);
      if (pre) segments.push({ type: 'prose', text: pre });
      var after = rest.slice(fenceIdx).replace(/^```/, '');
      var lm = after.match(/^([^\n]*)\n/);
      var pl = lm ? (lm[1].trim().split(/[\s.]/)[0] || 'code').toLowerCase() : 'code';
      segments.push({ type: 'code', lang: pl, lines: after.split('\n').length, isLive: true });
    } else {
      segments.push({ type: 'prose', text: rest });
    }
  }
  return segments;
}

// Merge consecutive code segments into groups
function groupCodeSegments(segments) {
  var out = [];
  segments.forEach(function(seg) {
    var last = out[out.length - 1];
    if (seg.type === 'code' && last && last.type === 'codegroup') {
      last.items.push(seg);
      if (seg.isLive) last.isLive = true;
    } else if (seg.type === 'code') {
      out.push({ type: 'codegroup', items: [seg], isLive: seg.isLive });
    } else {
      out.push(seg);
    }
  });
  return out;
}

// Label for a group of code blocks
function groupLabel(items, isLive) {
  var n = items.length;
  var lang = items[0].lang;
  var SHELL = { bash:1, sh:1, zsh:1, shell:1, 'shell-exec':1, plaintext:1, text:1, console:1,
                python:1, python3:1, node:1, nodejs:1, ruby:1, perl:1 };
  if (n === 1) {
    var labels = { bash:'Shell command', sh:'Shell command', zsh:'Shell command',
      python:'Python', python3:'Python', javascript:'JavaScript', html:'HTML',
      css:'CSS', json:'JSON', markdown:'Document', svg:'SVG',
      'figma-exec':'Figma action', 'shell-exec':'Shell command' };
    var base = labels[lang] || lang.toUpperCase() || 'Code';
    return base + (items[0].lines > 2 ? ' · ' + items[0].lines + ' lines' : '') + (isLive ? '…' : '');
  }
  // Multiple — describe by category
  var allShell = items.every(function(i) { return SHELL[i.lang]; });
  if (allShell) return n + ' shell commands' + (isLive ? '…' : '');
  return n + ' code blocks' + (isLive ? '…' : '');
}

// Used during streaming: prose renders normally, consecutive code blocks become one pill
function renderStreamingCOT(buffer) {
  var segments = parseBufferSegments(buffer);
  var grouped  = groupCodeSegments(segments);
  var result   = '';
  grouped.forEach(function(seg) {
    if (seg.type === 'prose') {
      try { result += marked.parse(seg.text); } catch(_) { result += escHtml(seg.text); }
    } else {
      // codegroup → single pill
      var items = seg.items;
      var lang  = items[0].lang;
      var ICONS = { bash:'ti-terminal-2', sh:'ti-terminal-2', zsh:'ti-terminal-2',
        python:'ti-brand-python', python3:'ti-brand-python', javascript:'ti-brand-javascript',
        html:'ti-brand-html5', css:'ti-palette', json:'ti-braces', markdown:'ti-markdown',
        'figma-exec':'ti-vector-triangle', 'shell-exec':'ti-terminal-2', svg:'ti-vector' };
      var icon = ICONS[lang] || 'ti-code';
      var label = groupLabel(items, seg.isLive);
      var spin = seg.isLive ? ' style="animation:spin 1s linear infinite"' : '';
      var liveIcon = seg.isLive ? 'ti-loader' : icon;
      result += '<div class="cot-pill"><i class="ti ' + liveIcon + '"' + spin + '></i>' + escHtml(label) + '</div>';
    }
  });
  var raw = result || marked.parse(buffer);
  // Sanitise streaming output to prevent AI-generated style/script tags from
  // bleeding into Fauna's own UI during streaming (marked passes HTML through).
  return typeof DOMPurify !== 'undefined'
    ? DOMPurify.sanitize(raw, { ADD_ATTR: ['data-special-lang', 'data-lang', 'data-wf-id', 'data-wf-path', 'onclick', 'data-code-id'], ADD_TAGS: ['iframe'] })
    : raw;
}

// Returns true if el2 immediately follows el1 with only whitespace between
function cotAreAdjacent(el1, el2) {
  var node = el1.nextSibling;
  while (node) {
    if (node === el2) return true;
    if (node.nodeType === 3 && !node.textContent.trim()) { node = node.nextSibling; continue; }
    if (node.nodeName === 'BR') { node = node.nextSibling; continue; }
    return false;
  }
  return false;
}

// Build groups of consecutive matching elements
function buildAdjacentGroups(elements) {
  if (!elements.length) return [];
  var groups = [[elements[0]]];
  for (var i = 1; i < elements.length; i++) {
    var prev = groups[groups.length - 1];
    if (cotAreAdjacent(prev[prev.length - 1], elements[i])) {
      prev.push(elements[i]);
    } else {
      groups.push([elements[i]]);
    }
  }
  return groups;
}

// Called after streaming — groups consecutive same-type blocks into one collapsible COT
function wrapInChainOfThought(msgEl) {
  var body = msgEl.querySelector('.msg-body');
  if (!body) return;

  // Group consecutive shell-exec blocks
  var shellBlocks = Array.from(body.querySelectorAll('.shell-exec-block'));
  buildAdjacentGroups(shellBlocks).forEach(function(group) {
    var n = group.length;
    var firstCmd = (group[0].dataset.code || '').trim().split('\n')[0];
    if (firstCmd.length > 60) firstCmd = firstCmd.slice(0, 57) + '…';
    var label = n === 1
      ? (firstCmd || 'Shell command')
      : n + ' shell commands — ' + firstCmd;
    wrapGroupInCOT(group, 'ti-terminal-2', label);
  });

  // Group consecutive figma-exec blocks
  var figmaBlocks = Array.from(body.querySelectorAll('.figma-exec-block'));
  buildAdjacentGroups(figmaBlocks).forEach(function(group) {
    var label = group.length === 1 ? 'Figma action' : group.length + ' Figma actions';
    wrapGroupInCOT(group, 'ti-vector-triangle', label);
  });

  // Wrap large standalone code blocks (≥ 8 lines) individually
  var LANG_LABELS = { html:'HTML', css:'CSS', javascript:'JavaScript', js:'JavaScript',
    python:'Python', json:'JSON', markdown:'Markdown', bash:'Shell script',
    typescript:'TypeScript', tsx:'React TSX', jsx:'React JSX', svg:'SVG' };
  var LANG_ICONS  = { html:'ti-brand-html5', css:'ti-palette', javascript:'ti-brand-javascript',
    python:'ti-brand-python', json:'ti-braces', markdown:'ti-markdown',
    bash:'ti-terminal-2', typescript:'ti-brand-typescript', svg:'ti-vector' };
  body.querySelectorAll('pre[data-lang]').forEach(function(pre) {
    var lang   = (pre.dataset.lang || '').toLowerCase();
    var codeEl = pre.querySelector('code');
    if (!codeEl) return;
    var lines  = (codeEl.innerText || '').split('\n').length;
    if (lines < 8) return;
    var label  = (LANG_LABELS[lang] || lang.toUpperCase() || 'Code') + ' · ' + lines + ' lines';
    wrapGroupInCOT([pre], LANG_ICONS[lang] || 'ti-code', label);
  });

}

// Wrap one or more elements together in a single <details> COT block
function wrapGroupInCOT(elements, icon, label) {
  if (!elements.length) return;
  var details = document.createElement('details');
  details.className = 'cot-block';
  details.innerHTML =
    '<summary>' +
      '<i class="ti ' + icon + '" style="font-size:12px;flex-shrink:0;color:var(--fau-text-muted)"></i>' +
      '<span class="cot-label">' + escHtml(label) + '</span>' +
      '<i class="ti ti-chevron-right cot-chevron"></i>' +
    '</summary>';
  var content = document.createElement('div');
  content.className = 'cot-block-content';
  details.appendChild(content);
  elements[0].parentNode.insertBefore(details, elements[0]);
  elements.forEach(function(el) { content.appendChild(el); });
}

// Keep old name as alias for single-element calls
function wrapInCOT(el, icon, label) { wrapGroupInCOT([el], icon, label); }


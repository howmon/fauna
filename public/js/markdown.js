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
      if (fullLang.startsWith('file-plan-ready:')) {
        var planParts = fullLang.slice('file-plan-ready:'.length).split(':');
        var readyPlanId = planParts[0];
        return '<pre data-special-lang="file-plan"><code class="language-file-plan" data-wf-id="' + escHtml(readyPlanId) + '" data-wf-path="(file plan)"></code></pre>';
      }
      if (lang === 'file-plan' || lang === 'workspace-edit' || lang === 'bulk-edit') {
        var planId = 'wf-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        _wfContentStore[planId] = { path: '(file plan)', content: rawText, mode: 'file-plan' };
        return '<pre data-special-lang="file-plan"><code class="language-file-plan" data-wf-id="' + escHtml(planId) + '" data-wf-path="(file plan)"></code></pre>';
      }
      // Runnable script langs — treat as shell-exec so they auto-run when autoRunShell is on.
      // ONLY pure shell tags. Models use `python`/`node`/`ruby`/`perl`/`console` constantly
      // for *displaying* code, not for *running* it; piping their source straight into zsh
      // produces nonsense errors that then get fed back to the model in a tight loop
      // (see transcript 2026-06-02T17-42-08: a ```python``` excerpt was executed three
      // times as if it were shell, each time emitting `zsh: no matches found: ...`).
      // If the user genuinely wants `python -c '...'` or `node -e '...'`, the model can
      // wrap it in a ```bash fence — that is the unambiguous, explicit form.
      var RUNNABLE_LANGS = { bash:1, sh:1, zsh:1, shell:1 };
      var langLower = (lang || '').toLowerCase();
      if (RUNNABLE_LANGS[langLower]) {
        return '<pre data-special-lang="shell-exec"><code class="language-shell-exec">' + escHtml(rawText) + '</code></pre>';
      }
      // Sniff unlabeled / plaintext / text fences for obvious shell content.
      // Models sometimes emit ``` (no language tag) or ```plaintext when they
      // mean a runnable command — without this the block stays inert and the
      // task stalls. Only triggers when the first non-blank line clearly
      // starts with a shell-style token to avoid false positives on prose.
      if (langLower === '' || langLower === 'plaintext' || langLower === 'text') {
        var firstLine = (rawText.match(/^[ \t]*([^\n]+)/) || [,''])[1].trim();
        // Strip leading prompt markers like "$ " or "> " before sniffing.
        firstLine = firstLine.replace(/^[$>][ \t]+/, '');
        var SHELL_SNIFF = /^(?:#!\/|[A-Z_][A-Z0-9_]*=|sudo\b|cd\b|ls\b|cat\b|echo\b|mkdir\b|rm\b|cp\b|mv\b|grep\b|find\b|sed\b|awk\b|tar\b|chmod\b|chown\b|touch\b|head\b|tail\b|wc\b|sort\b|uniq\b|xargs\b|tee\b|which\b|whoami\b|pwd\b|export\b|source\b|kill\b|ps\b|top\b|df\b|du\b|env\b|set\b|unset\b|TMPF=|TMP=|python3?\b|node\b|npm\b|npx\b|yarn\b|pnpm\b|deno\b|bun\b|ruby\b|perl\b|php\b|go\b|cargo\b|rustc\b|java\b|javac\b|gcc\b|clang\b|make\b|cmake\b|git\b|gh\b|brew\b|apt\b|apt-get\b|yum\b|dnf\b|pacman\b|pip3?\b|pipx\b|poetry\b|conda\b|curl\b|wget\b|ssh\b|scp\b|rsync\b|nc\b|ping\b|traceroute\b|dig\b|nslookup\b|docker\b|podman\b|kubectl\b|helm\b|terraform\b|ansible\b|aws\b|gcloud\b|az\b|psql\b|mysql\b|sqlite3?\b|redis-cli\b|mongo\b|jq\b|yq\b)/;
        if (firstLine && SHELL_SNIFF.test(firstLine)) {
          return '<pre data-special-lang="shell-exec"><code class="language-shell-exec">' + escHtml(rawText) + '</code></pre>';
        }
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
  // Strip artifact fenced blocks before rendering — they're shown as entity cards, not code fences.
  // Line-based balanced scanner: when the outer artifact fence is 3 backticks
  // and the artifact contains a ```lang inner block, naïve regex would close
  // at the inner fence and leak the rest into chat. This handles both 3- and
  // 4+ backtick outer fences correctly.
  var srcLines = (text || '').split('\n');
  var keep = [];
  var i = 0;
  while (i < srcLines.length) {
    var open = srcLines[i].match(/^(`{3,})artifact:.+?\s*$/);
    if (!open) { keep.push(srcLines[i]); i++; continue; }
    var fenceLen = open[1].length;
    var innerOpen = false;
    var j = i + 1;
    var closed = false;
    for (; j < srcLines.length; j++) {
      var l = srcLines[j];
      var fence = l.match(/^(`{3,})(\S*)\s*$/);
      if (!fence) continue;
      var thisLen = fence[1].length;
      var hasLang = !!fence[2];
      if (fenceLen >= 4) {
        if (thisLen >= fenceLen && !hasLang) { closed = true; break; }
      } else {
        if (innerOpen) { if (!hasLang && thisLen === 3) innerOpen = false; }
        else { if (hasLang) innerOpen = true; else if (thisLen === 3) { closed = true; break; } }
      }
    }
    i = closed ? j + 1 : srcLines.length;
  }
  var cleaned = keep.join('\n');
  // Strip suggestion blocks — rendered as clickable CTA buttons, not code
  cleaned = cleaned.replace(/`{3,4}\s*suggestions[ \t]*\r?\n[\s\S]*?`{3,4}\n?/gi, '');
  // Collapse runs of 3+ newlines left by stripped blocks so they don't render
  // as a tall stack of empty paragraphs between surrounding content.
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');

  // Repair fences that the model glued onto prose without a newline, e.g.
  //   "...refresh the case study.```browser-ext-action\n{...}\n```"
  // Marked requires opening fences at column 0, so without this the fence is
  // parsed as inline code, the special-language renderer never fires, and the
  // downstream extractor (browser-ext, shell-exec, write-file, etc.) finds 0
  // blocks. Insert the missing newline before any ```<lang> that follows a
  // non-newline character. Safe because real fenced blocks already start a
  // new line, so this only rewrites malformed cases.
  cleaned = cleaned.replace(/([^\n])(```[a-zA-Z][\w:.\/-]*)/g, '$1\n$2');
  
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

  // ── Math pre-processing (KaTeX) ──────────────────────────────────────
  // Extract $$...$$, \[...\] (display) and \(...\), $...$ (inline) into
  // sentinel-string placeholders BEFORE marked.parse so markdown's _ * \
  // rules don't mangle LaTeX. Re-inserted post-sanitize. Skips fenced code
  // blocks (already protected by marked) and inline `code`.
  //
  // IMPORTANT: placeholders are PLAIN TEXT (\u0001MATH<n>\u0001), NOT HTML
  // spans. HTML placeholders were unreliable — DOMPurify could drop empty
  // <span>s or reorder attributes, breaking the post-process regex.
  // The sentinel chars are control characters that won't appear in normal
  // text and won't be touched by marked or DOMPurify.
  var mathId = 0;
  var mathBlocks = {};
  function _expandNested(s) {
    // Some models mix delimiters (e.g. $...\(...\)...$). When an outer match
    // captures text containing an inner placeholder sentinel, expand it back
    // to the raw TeX so KaTeX sees clean LaTeX, not control characters.
    return s.replace(/\u0001MATH(\d+)\u0001/g, function(_, i) {
      var m = mathBlocks['m' + i];
      return m ? m.tex : '';
    });
  }
  function mathPlace(tex, display) {
    var id = 'm' + (mathId++);
    mathBlocks[id] = { tex: _expandNested(tex.trim()), display: display };
    return '\u0001MATH' + id.slice(1) + '\u0001';
  }
  // Protect fenced + inline code from the math scanner
  var codeStash = [];
  cleaned = cleaned.replace(/```[\s\S]*?```|`[^`\n]+`/g, function(m) {
    codeStash.push(m);
    return '\u0000CODE' + (codeStash.length - 1) + '\u0000';
  });
  // Display math: $$...$$
  cleaned = cleaned.replace(/\$\$([\s\S]+?)\$\$/g, function(_, tex) {
    return mathPlace(tex, true);
  });
  // Display math: \[...\]
  cleaned = cleaned.replace(/\\\[([\s\S]+?)\\\]/g, function(_, tex) {
    return mathPlace(tex, true);
  });
  // Inline math: \(...\)
  cleaned = cleaned.replace(/\\\(([\s\S]+?)\\\)/g, function(_, tex) {
    return mathPlace(tex, false);
  });
  // Inline math: $...$ — must not match currency ($5, $100M etc.) so require
  // a non-space immediately after the opening $ and before the closing $,
  // and disallow a digit/letter directly adjacent on the OUTSIDE. Also bail
  // out if the captured content contains a backslash-escaped dollar (\$),
  // which usually means the model is using $ as a literal currency symbol
  // inside math without proper delimiters.
  cleaned = cleaned.replace(/(^|[^\w$])\$(?!\s)([^\n$]+?)(?<!\s)\$(?![\w$])/g, function(m, pre, tex) {
    if (/\\\$/.test(tex)) return m; // skip — looks like currency, not math
    return pre + mathPlace(tex, false);
  });
  // Restore code blocks
  cleaned = cleaned.replace(/\u0000CODE(\d+)\u0000/g, function(_, i) {
    return codeStash[+i] || '';
  });
  
  try {
    var html = marked.parse(cleaned);
    // Sanitise HTML to prevent XSS from AI-generated or injected content
    html = typeof DOMPurify !== 'undefined'
      ? DOMPurify.sanitize(html, { ADD_ATTR: ['data-special-lang', 'data-lang', 'data-wf-id', 'data-wf-path', 'onclick', 'data-code-id', 'data-mermaid-id', 'data-math-id'], ADD_TAGS: ['iframe'] })
      : html;
    
    // Replace placeholders with actual mermaid divs
    html = html.replace(/<div class="mermaid-placeholder" data-mermaid-id="([^"]+)"><\/div>/g, function(match, id) {
      var code = mermaidBlocks[id] || '';
      return '<pre class="mermaid">' + escHtml(code) + '</pre>';
    });

    // Replace math placeholders with KaTeX-rendered HTML.
    // Sentinel format: \u0001MATH<n>\u0001 (control chars survive both
    // marked.parse and DOMPurify untouched).
    html = html.replace(/\u0001MATH(\d+)\u0001/g, function(match, n) {
      var m = mathBlocks['m' + n];
      if (!m) return '';
      if (typeof window !== 'undefined' && window.katex) {
        try {
          return window.katex.renderToString(m.tex, {
            displayMode: !!m.display,
            throwOnError: false,
            output: 'html',
            strict: 'ignore',
          });
        } catch (e) {
          return '<code class="math-error">' + escHtml(m.tex) + '</code>';
        }
      }
      // KaTeX not loaded yet — fall back to escaped raw TeX wrapped so it's
      // visually recognisable. (Should be rare; KaTeX is in <head>.)
      return (m.display ? '<div class="math-fallback">' : '<span class="math-fallback">') +
             (m.display ? '$$' : '$') + escHtml(m.tex) + (m.display ? '$$' : '$') +
             (m.display ? '</div>' : '</span>');
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

// ── Activity/detail rendering ─────────────────────────────────────────────

// Segment buffer into {type:'prose',text} | {type:'code',lang,lines,isLive}
function parseBufferSegments(buffer) {
  var segments = [];
  var re = /```([^\n`]*)\n([\s\S]*?)```/g;
  var lastIndex = 0, match;
  while ((match = re.exec(buffer)) !== null) {
    var prose = buffer.slice(lastIndex, match.index);
    if (prose) segments.push({ type: 'prose', text: prose });
    var lang = (match[1].trim().split(/[\s.]/)[0] || 'code').toLowerCase();
    segments.push({ type: 'code', lang: lang, lines: match[2].split('\n').length, chars: match[2].length, isLive: false });
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
      segments.push({ type: 'code', lang: pl, lines: after.split('\n').length, chars: after.length, isLive: true });
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
    // Live pills must visibly tick while the model streams inside an unclosed
    // fence — otherwise a long ``` shell-output ``` block (or any code fence)
    // shows the same "Shell command…" text for many seconds and the bubble
    // looks frozen even though tokens are flowing. Round chars to the nearest
    // 25 so the label updates roughly every chunk without thrashing.
    if (isLive) {
      var liveLines = items[0].lines || 0;
      var liveChars = items[0].chars || 0;
      var rounded = Math.round(liveChars / 25) * 25;
      var stats = liveLines > 2 ? (liveLines + ' lines, ' + rounded + ' chars') : (rounded + ' chars');
      return base + ' · ' + stats + '…';
    }
    return base + (items[0].lines > 2 ? ' · ' + items[0].lines + ' lines' : '');
  }
  // Multiple — describe by category
  var allShell = items.every(function(i) { return SHELL[i.lang]; });
  if (allShell) return n + ' shell commands' + (isLive ? '…' : '');
  return n + ' code blocks' + (isLive ? '…' : '');
}

// Used during streaming: prose renders normally, consecutive code blocks become one activity pill.
function renderStreamingActivity(buffer) {
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

// Called after streaming — groups consecutive same-type blocks into one collapsible activity/details block.
function wrapInActivityDetails(msgEl) {
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

  // Group consecutive file-write widgets
  var writeBlocks = Array.from(body.querySelectorAll('.wf-block')).filter(function(el) { return !el.closest('.cot-block'); });
  buildAdjacentGroups(writeBlocks).forEach(function(group) {
    var firstPath = group[0].querySelector('.wf-path');
    var firstStatus = group[0].querySelector('.wf-status');
    var pathText = firstPath ? firstPath.textContent.trim() : '';
    var statusText = firstStatus ? firstStatus.textContent.trim() : '';
    var label = group.length === 1
      ? ('File operation' + (pathText ? ' — ' + pathText : '') + (statusText ? ' · ' + statusText : ''))
      : group.length + ' file operations' + (statusText ? ' · ' + statusText : '');
    wrapGroupInCOT(group, 'ti-file-code', label);
  });

  // Group consecutive browser/fetch widgets
  var browserBlocks = Array.from(body.querySelectorAll('.ba-block')).filter(function(el) { return !el.closest('.cot-block'); });
  buildAdjacentGroups(browserBlocks).forEach(function(group) {
    var firstLabel = group[0].querySelector('.ba-label');
    var firstDesc = group[0].querySelector('.ba-desc');
    var descText = firstDesc ? firstDesc.textContent.trim() : '';
    var label = group.length === 1
      ? ((firstLabel ? firstLabel.textContent.trim() : 'Browser action') + (descText ? ' — ' + descText : ''))
      : group.length + ' browser actions' + (descText ? ' — ' + descText : '');
    wrapGroupInCOT(group, 'ti-world-search', label);
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

// Compatibility aliases for older call sites/extensions.
function renderStreamingCOT(buffer) { return renderStreamingActivity(buffer); }
function wrapInChainOfThought(msgEl) { return wrapInActivityDetails(msgEl); }
function wrapInCOT(el, icon, label) { wrapGroupInCOT([el], icon, label); }

function compactProcessClusters(msgEl) {
  if (!msgEl) return;
  var body = msgEl.querySelector('.msg-body');
  if (!body) return;
  var selectors = '.cot-pill,.cot-block,.wf-block,.shell-exec-block,.figma-exec-block,.ba-block';
  var containers = [body].concat(Array.from(body.querySelectorAll('.prose,.cot-block-content')));
  containers.forEach(function(container) {
    if (!container || container.closest('.process-cluster')) return;
    var children = Array.from(container.children || []);
    var run = [];
    function flush() {
      if (run.length < 3) { run = []; return; }
      var shellCount = run.filter(function(el) { return el.classList.contains('shell-exec-block') || /shell command|shell commands/i.test(el.textContent || ''); }).length;
      var writeCount = run.filter(function(el) { return el.classList.contains('wf-block') || /file operation|file operations|write-file|append-file|replace-string|apply-patch/i.test(el.textContent || ''); }).length;
      var browserCount = run.filter(function(el) { return el.classList.contains('ba-block') || /browser action|browser actions|navigate|extract|screenshot/i.test(el.textContent || ''); }).length;
      var labelParts = [];
      if (writeCount) labelParts.push(writeCount + ' file ' + (writeCount === 1 ? 'write' : 'writes'));
      if (shellCount) labelParts.push(shellCount + ' shell ' + (shellCount === 1 ? 'command' : 'commands'));
      if (browserCount) labelParts.push(browserCount + ' browser ' + (browserCount === 1 ? 'action' : 'actions'));
      var title = labelParts.length ? labelParts.join(' · ') : run.length + ' operations';

      var details = document.createElement('details');
      details.className = 'process-cluster';
      details.innerHTML = '<summary>' +
        '<span class="process-cluster-icon"><i class="ti ti-list-check"></i></span>' +
        '<span class="process-cluster-title">Process timeline</span>' +
        '<span class="process-cluster-meta">' + escHtml(title) + '</span>' +
        '<span class="process-cluster-action">Show details</span>' +
      '</summary>';
      var content = document.createElement('div');
      content.className = 'process-cluster-content';
      details.appendChild(content);
      run[0].parentNode.insertBefore(details, run[0]);
      run.forEach(function(el) { content.appendChild(el); });
      run = [];
    }
    children.forEach(function(child) {
      if (child.matches && child.matches(selectors)) {
        run.push(child);
      } else {
        flush();
        run = [];
      }
    });
    flush();
  });
}

function compactLongAssistantMessage(msgEl, sourceText) {
  if (!msgEl || !msgEl.classList || !msgEl.classList.contains('ai')) return;
  if (msgEl.querySelector('.long-response-details')) return;
  var body = msgEl.querySelector('.msg-body');
  if (!body) return;

  var raw = String(body.innerText || sourceText || '');
  var plain = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_~`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  var lineCount = raw.split('\n').length;
  var visibleText = (body.innerText || '').trim();
  if (raw.length < 7000 && lineCount < 120 && visibleText.length < 6000) return;

  var preserveSelector = [
    '.msg-shell-verification', '.shell-exec-block', '.wf-block', '.figma-exec-block',
    '.ba-block', '.cot-block', '.artifact-card', '.suggestions-row', '.gen-ui-root', '.create-agent-card',
    '.patch-agent-card', '.task-create-card', '.process-cluster'
  ].join(',');
  var children = Array.from(body.children || []);
  var movable = children.filter(function(child) {
    if (!child || !child.textContent || !child.textContent.trim()) return false;
    return !(child.matches && child.matches(preserveSelector));
  });
  if (!movable.length) return;

  var details = document.createElement('details');
  details.className = 'long-response-details';
  var summary = document.createElement('summary');
  summary.innerHTML =
    '<span class="long-response-icon"><i class="ti ti-file-text"></i></span>' +
    '<span class="long-response-title">Long response collapsed</span>' +
    '<span class="long-response-meta">' + lineCount + ' lines · ' + Math.round(raw.length / 1000) + 'k chars</span>' +
    '<span class="long-response-action">Show full</span>';
  details.appendChild(summary);

  if (plain) {
    var preview = document.createElement('div');
    preview.className = 'long-response-preview';
    preview.textContent = plain.slice(0, 520) + (plain.length > 520 ? '…' : '');
    details.appendChild(preview);
  }

  var content = document.createElement('div');
  content.className = 'long-response-content';
  details.appendChild(content);
  body.appendChild(details);
  movable.forEach(function(node) { content.appendChild(node); });
}


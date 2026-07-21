// ── Sending messages ──────────────────────────────────────────────────────

// Keywords that suggest the user wants system/file actions performed
var SYSTEM_TASK_PATTERNS = [
  /\bdesktop\b/i, /\barrange\s+(my\s+)?files/i, /clean\s*up\s+(my\s+)?(desktop|files|folder)/i,
  /organis[ez]\s+(my\s+)?(desktop|files|folder|downloads)/i,
  /files?\s+on\s+(my\s+)?desktop/i, /my\s+(desktop\s+)?files/i, /move\s+file/i,
  /list\s+(file|app|process|program)/i, /show\s+(me\s+)?(what|the)/i,
  /open\s+app/i, /running\s+app/i, /installed\s+app/i,
  /take\s+screenshot/i, /screenshot/i,
  /disk\s+space/i, /storage/i, /find\s+file/i,
  /\bwindow(s)?\b/i, /\b(tile|arrange|resize|move)\s+(my\s+)?(window|app)/i,
  /what.*(apps?|windows?).*open/i, /which.*apps?.*open/i, /frontmost/i, /focused\s+app/i
];

// Patterns that indicate the user wants live window/app context (Codex-style)
var WINDOW_CONTEXT_PATTERNS = [
  /what.*(apps?|windows?).*open/i, /which.*apps?.*open/i,
  /\b(list|show).*(apps?|windows?)/i,
  /frontmost/i, /focused\s+app/i, /running\s+app/i,
  /\b(tile|arrange|resize|move|stack|split)\s+(my\s+)?(window|app)/i,
  /side[- ]by[- ]side/i
];

// Patterns that specifically indicate a desktop file organization task (for organizer card)
var DESKTOP_ORG_PATTERNS = [
  /\b(organis|organiz)[ez]?\s+(my\s+)?(desktop|files|folder|downloads)/i,
  /\b(clean|tidy)\s*(up)?\s+(my\s+)?(desktop|files|downloads)/i,
  /\barrange\s+(my\s+)?(desktop|files)/i,
  /sort\s+(my\s+)?(desktop|files|downloads)/i
];

function _isBrowserTabReferenceAttachment(att) {
  return !!(att && att.extSource && (att.tabId || att.clientId || att.browser));
}

function _isFigmaFileReferenceAttachment(att) {
  return !!(att && (att.type === 'figma_file' || att.extSource === 'figma') && att.fileKey);
}

function _getSelectedFigmaFileKeysFromAttachments(attachments) {
  var list = Array.isArray(attachments) ? attachments : (state && state.pendingAttachments) || [];
  var seen = new Set();
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (_isFigmaFileReferenceAttachment(a) && !seen.has(a.fileKey)) {
      seen.add(a.fileKey);
      out.push(a.fileKey);
    }
  }
  return out;
}
window.getSelectedFigmaFileKeys = function() {
  return _getSelectedFigmaFileKeysFromAttachments();
};

async function _buildLiveBrowserAttachmentContext(attachments, opts) {
  if (!attachments || !attachments.length) return '';
  var refs = attachments.filter(_isBrowserTabReferenceAttachment);
  if (!refs.length) return '';

  // Dedup: if the prior user message in this conversation already carried
  // the same tabId(s), the model still has that snapshot — re-injecting
  // 8KB of identical page text on every turn wastes context AND amplifies
  // the "do not re-fetch" guardrail to the point where the model refuses
  // even when the user explicitly asks. Skip refs already seen.
  try {
    var conv = (opts && opts.conv) || null;
    if (conv && Array.isArray(conv.messages)) {
      var lastUser = null;
      for (var j = conv.messages.length - 1; j >= 0; j--) {
        if (conv.messages[j] && conv.messages[j].role === 'user') { lastUser = conv.messages[j]; break; }
      }
      var seenTabIds = new Set();
      if (lastUser && Array.isArray(lastUser.attachments)) {
        for (var k = 0; k < lastUser.attachments.length; k++) {
          var pa = lastUser.attachments[k];
          if (pa && pa.tabId) seenTabIds.add(String(pa.tabId));
        }
      }
      if (seenTabIds.size) {
        refs = refs.filter(function(r) { return !r.tabId || !seenTabIds.has(String(r.tabId)); });
      }
    }
  } catch (_) {}

  if (!refs.length) {
    // All refs were already shown in the prior turn — leave a tiny pointer
    // instead of the full payload so the model knows the context is fresh.
    return '\n\n[Same browser tab(s) as the previous turn — content already in context above. If the user is asking for a new interaction (click/type/navigate) or fresher data, use `browser-ext-action` now.]';
  }

  var chunks = [];
  var failedRefs = [];
  for (var i = 0; i < refs.length; i++) {
    var att = refs[i];
    var body = { action: 'extract', params: { maxChars: 8000 } };
    if (att.tabId) body.tabId = att.tabId;
    if (att.clientId) body.clientId = att.clientId;
    else if (att.browser) body.browser = String(att.browser).replace(/\s+\(\d+\)$/, '');

    var d = null;
    try {
      var r = await fetch('/api/ext/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      d = await r.json().catch(function() { return null; });
      if ((!d || d.ok === false) && body.clientId && String(body.clientId).startsWith('relay-')) {
        // Relay route may fail even when direct extraction works.
        var retryBody = { action: 'extract', params: { maxChars: 8000 } };
        if (att.tabId) retryBody.tabId = att.tabId;
        if (att.browser) retryBody.browser = String(att.browser).replace(/\s+\(\d+\)$/, '');
        var r2 = await fetch('/api/ext/command', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(retryBody)
        });
        var d2 = await r2.json().catch(function() { return null; });
        if (d2 && d2.ok) d = d2;
      }
    } catch (_) {}

    if (d && d.ok) {
      var title = d.title || att.name || 'Browser tab';
      var url = d.url || att.sourceUri || '';
      var text = (d.text || d.content || '').trim();
      if (!text) text = '(No text extracted)';
      chunks.push(
        '```\n' +
        '// Live browser tab context (resolved at send time)\n' +
        '// Title: ' + title + '\n' +
        (url ? ('// URL: ' + url + '\n') : '') +
        text + '\n' +
        '```'
      );
    } else {
      failedRefs.push(att);
    }
  }

  if (!chunks.length && !failedRefs.length) return '';

  var header = '';
  if (chunks.length) {
    header = '\n\n[Resolved live browser tab context — already extracted from the user\'s shared browser tab via the extension. PRIORITY RULE: if the user\'s message in this turn explicitly asks you to use the browser, navigate, click, type, refresh, or fetch newer data, you MUST emit a `browser-ext-action` block for that — the user\'s explicit request always wins. Otherwise (no explicit browser request), just answer from the inline content below and do not re-fetch the same page. Note: `fauna_browser` is a SEPARATE in-app webview unrelated to the user\'s real tab and will be blank — prefer `browser-ext-action` for any interaction with the attached tab.]\n';
  }
  var body2 = chunks.join('\n\n');
  if (failedRefs.length) {
    var failNote = '\n\n[Browser-extension tab attached but live extraction returned no content. If you need the page text, emit ONE ```browser-ext-action block with {"action":"extract"} (and tabId/clientId from the attachment Meta line). Do NOT call `fauna_browser` — that drives a separate in-app webview that does not share state with the user\'s real browser tab and will be blank.]';
    body2 += failNote;
  }
  return header + body2;
}

// Short confirmations — user is approving a plan the AI just described
var CONFIRM_PATTERNS = /^(yes|proceed|do it|go ahead|execute|run it|ok|okay|sure|do this|confirm|apply|start|make it so|go|yep|yup|do that|please do|please proceed|sounds good|let'?s? do it)[\.\!\?]?$/i;

async function gatherSystemContext(text) {
  var ctx = [];
  var home    = sysCtx.home    || '~';
  var desktop = sysCtx.desktop || (home + '/Desktop');
  var conv    = state.currentId ? getConv(state.currentId) : null;

  // If user is confirming a plan, inject a command-forcing instruction.
  // BUT: if the prior assistant message already contains runnable shell/bash
  // blocks, the model has nothing new to write — re-prompting would just emit
  // duplicate commands AND leak the bracketed instruction into the saved user
  // message (visible in transcripts/exports). With chained auto-run those
  // pending blocks already executed on their own, so the user's "proceed" is
  // ack-only; pass it through cleanly.
  if (CONFIRM_PATTERNS.test(text.trim())) {
    var lastAI = conv && conv.messages.slice().reverse().find(function(m) { return m.role === 'assistant'; });
    if (lastAI) {
      var lastContent = lastAI.content || '';
      var hasRunnableBlocks = /```(?:shell[-_]exec|bash|sh|zsh)\b/i.test(lastContent);
      if (hasRunnableBlocks) return '';
      if (DESKTOP_ORG_PATTERNS.some(function(p) { return p.test(lastContent); })) state._lastMsgWasDesktopTask = true;
      return '\n\n[The user has confirmed the plan. Now output the COMPLETE shell commands to execute it — ' +
        'write every command inside code blocks with real content. ' +
        'Do not leave any code block empty. Do not just describe — write the actual commands.\n' +
        'Example format:\n' +
        'mkdir -p ~/Desktop/Screenshots\n' +
        'mv ~/Desktop/Screenshot*.png ~/Desktop/Screenshots/\n' +
        'Each command on its own line, all inside one code block.]';
    }
  }

  var matched = SYSTEM_TASK_PATTERNS.some(function(p) { return p.test(text); });
  if (!matched) return '';

  // Gather Desktop contents
  if (/desktop|arrange|clean|organis|organiz/i.test(text)) {
    state._lastMsgWasDesktopTask = DESKTOP_ORG_PATTERNS.some(function(p) { return p.test(text); });
    try {
      var r = await fetch('/api/shell-exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'ls -1A "' + desktop + '" 2>/dev/null | head -80' })
      });
      var d = await r.json();
      if (d.stdout && d.stdout.trim()) {
        ctx.push('Current Desktop contents (`ls ~/Desktop`):\n```\n' + d.stdout.trim() + '\n```');
      } else {
        ctx.push('Desktop is empty (no files found at ' + desktop + ').');
      }
    } catch (_) {}
  }

  // Gather disk space if relevant
  if (/disk|storage|space/i.test(text)) {
    try {
      var r2 = await fetch('/api/shell-exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'df -h ~' })
      });
      var d2 = await r2.json();
      if (d2.stdout) ctx.push('Disk usage:\n```\n' + d2.stdout.trim() + '\n```');
    } catch (_) {}
  }

  // Gather running apps / windows (Codex-style) when intent matches
  if (WINDOW_CONTEXT_PATTERNS.some(function(p) { return p.test(text); })) {
    try {
      var rw = await fetch('/api/window-context');
      var dw = await rw.json();
      if (dw && dw.ok && Array.isArray(dw.apps)) {
        var lines = dw.apps.slice(0, 30).map(function(a) {
          var wins = (a.windows || []).slice(0, 4).map(function(w) {
            return '    • "' + (w.title || '(untitled)') + '" ' + w.w + '×' + w.h + ' @ (' + w.x + ',' + w.y + ')';
          }).join('\n');
          return '  - ' + a.name + (a.frontmost ? ' [frontmost]' : '') +
            ' pid=' + a.pid + ' windows=' + (a.windows || []).length +
            (wins ? '\n' + wins : '');
        }).join('\n');
        var scr = dw.screen ? ' (screen ' + dw.screen.width + '×' + dw.screen.height + ')' : '';
        ctx.push('Visible apps and windows' + scr + ':\n```\n' + lines + '\n```\nTo arrange windows, POST {moves:[{app,x,y,w,h}]} to /api/window-arrange.');
      } else if (dw && dw.needsAccessibility) {
        ctx.push('Window context unavailable: Accessibility permission needed for Fauna in System Settings → Privacy & Security → Accessibility.');
      }
    } catch (_) {}
  }

  return ctx.length ? '\n\n[System context gathered automatically]\n' + ctx.join('\n') : '';
}

// ── Suggested next steps ──────────────────────────────────────────────────
// Parse ```suggestions blocks and render clickable CTA buttons after the message.

// Pull the most recent USER message from the active conversation so the
// fallback can craft suggestions that reference the actual topic instead of
// generic "Tell me more" / "Try a different angle" / "Make it concrete".
function _lastUserPromptText() {
  try {
    var convId = (typeof state !== 'undefined' && state) ? state.currentId : null;
    var conv   = (typeof getConv === 'function' && convId) ? getConv(convId) : null;
    if (!conv || !Array.isArray(conv.messages)) return '';
    for (var i = conv.messages.length - 1; i >= 0; i--) {
      var m = conv.messages[i];
      if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
        // Strip any "[Current date and time: …]" footer the client appends.
        return m.content.replace(/\n*\[Current date and time:[^\]]*\]\s*$/i, '').trim();
      }
    }
  } catch (_) {}
  return '';
}

// Extract a 1-3 word topic phrase from the user's most recent prompt so
// fallback labels can reference it ("Refine the 3D model" instead of
// "Try a different angle"). Drops generic verbs, filler, and stop words.
function _topicFromUserPrompt(promptText) {
  var t = String(promptText || '').toLowerCase().trim();
  if (!t) return '';
  // Strip a leading imperative verb so the noun phrase surfaces.
  t = t.replace(/^(please\s+)?(can you\s+|could you\s+|i (?:want|need|would like)(?: to)?\s+)?(create|make|build|design|generate|write|draw|render|show|give|find|fetch|fix|debug|update|edit|add|implement|explain|tell|help)\s+(me\s+)?(a |an |the |some |us\s+|us a |us an )?/i, '');
  // Take the first 4 words, drop trailing punctuation.
  var words = t.split(/\s+/).slice(0, 4).join(' ').replace(/[^a-z0-9\s\-.]/gi, '').trim();
  if (!words || words.length < 3) return '';
  // Skip if it's just stopwords.
  if (/^(this|that|it|them|something|anything|help|please|now)$/i.test(words)) return '';
  return words.length > 32 ? words.slice(0, 32).replace(/\s+\S*$/, '') : words;
}

// If the assistant ended with an "options menu" (numbered list, "reply with
// one word", etc.), pull each option out as a CTA. This is the single most
// common case where the model legitimately needs the user to pick — making
// those picks one-click instead of "type the word" is a huge UX win.
function _suggestionsFromOptionsMenu(text) {
  var src = String(text || '');
  if (!src.trim()) return null;

  // Look only at the trailing third of the message — the menu always lives at
  // the end, never mid-prose.
  var tail = src.length > 800 ? src.slice(-1200) : src;

  // Pattern A: numbered list "1. xxx" / "1) xxx" (2-5 items).
  var numbered = tail.match(/(?:^|\n)\s*\d+[.)]\s+([^\n]{3,80})/g);
  if (numbered && numbered.length >= 2 && numbered.length <= 6) {
    var picks = numbered.slice(0, 4).map(function(line) {
      return line.replace(/^\s*\d+[.)]\s+/, '').trim()
        // Strip trailing "or" / ", or" connectors.
        .replace(/,?\s+or\s*$/i, '')
        // Collapse leading "a/an/the".
        .replace(/^(an?|the)\s+/i, '')
        // Cap length so buttons stay compact.
        .slice(0, 56);
    }).filter(Boolean);
    if (picks.length >= 2) return picks;
  }

  // Pattern B: "Reply with one word: - `openscad` - `obj` …" — backticked
  // single-token options at the tail.
  var oneWord = tail.match(/(?:reply|respond|type|say|pick|choose)\s+(?:with\s+)?(?:one\s+word|one\s+of)?[\s:]*([\s\S]{0,400})$/i);
  if (oneWord) {
    var opts = (oneWord[1].match(/`([a-z][\w\s-]{0,20})`/gi) || [])
      .map(function(w) { return w.replace(/`/g, '').trim(); })
      .filter(Boolean);
    if (opts.length >= 2 && opts.length <= 6) return opts.slice(0, 4);
  }

  return null;
}

function _fallbackSuggestionsFromMessage(buffer) {
  var text = String(buffer || '');
  if (!text.trim()) return [];

  // Highest priority: the assistant offered an explicit menu of choices.
  // Surface each choice as a button so the user clicks instead of typing.
  var menu = _suggestionsFromOptionsMenu(text);
  if (menu && menu.length) return menu;

  // Highest priority: assistant explicitly asked the user to reply with a
  // specific word/phrase to continue. Surface that as the primary CTA so the
  // user doesn't have to type it. Catches patterns like:
  //   Reply "continue" and I'll pick up at …
  //   Say "go" to proceed
  //   Type 'yes' to confirm
  var replyMatch = text.match(/(?:reply|say|type|respond(?:\s+with)?)\s+["'`]?([a-z][\w\s-]{0,20})["'`]?\s+(?:and|to)\b/i);
  if (replyMatch) {
    var word = replyMatch[1].trim();
    if (word) return [word.charAt(0).toUpperCase() + word.slice(1), 'Show what was done', 'Stop here'];
  }

  // Paused-mid-task signals (tool limits, per-turn caps, partial progress) —
  // the assistant is mid-workflow and needs to resume, not brainstorm.
  if (/(?:per-turn|tool limit|hit the limit|paused|partial|still to build|to be continued|pick up where|resume)/i.test(text)) {
    return ['Continue', 'Show what was done', 'Stop here'];
  }

  if (/validation failed|truncated|incomplete|failed|error|not found|exception/i.test(text)) {
    return ['Fix the issue', 'Show the relevant logs', 'Try a safer approach'];
  }
  if (/test|vitest|npm test|playwright|coverage/i.test(text)) {
    return ['Run the tests', 'Fix failing tests', 'Summarize test coverage'];
  }
  if (/(wrote|written|created|generated|saved).*(file|document|guide|markdown|project)|IMPLEMENTATION_GUIDE|README|runbook|spec/i.test(text)) {
    return ['Verify generated files', 'Open the generated document', 'Continue implementation'];
  }
  if (/build|npm run build|electron-builder|compiled|packag/i.test(text)) {
    return ['Run the app', 'Review build warnings', 'Package a release'];
  }
  if (/code|patch|changed|updated|implemented|fixed/i.test(text)) {
    return ['Review the changes', 'Run verification', 'Continue refining'];
  }
  // Q&A / brainstorm / idea responses — let the user act on or extend the
  // idea rather than offering meaningless "Continue / Verify the result"
  // buttons. Require a stronger brainstorm signal than a single keyword
  // (the old `\bidea|app|build\b` matcher fired on "Building spec" / "spec
  // page" in paused-mid-task messages).
  if (/\b(what if|how about|consider|could be|might (?:work|be)|brainstorm|here are .* ideas?|some ideas?|possible (?:apps?|products?|directions?))\b/i.test(text)) {
    return ['Build this app', 'Refine the idea', 'Suggest another angle'];
  }

  // Topical default — reference the user's actual ask so buttons stay
  // contextual instead of falling back to the meaningless "Tell me more /
  // Try a different angle / Make it concrete" triplet.
  var topic = _topicFromUserPrompt(_lastUserPromptText());
  if (topic) {
    return [
      'Refine the ' + topic,
      'Show me an alternative',
      'Explain how this works',
    ];
  }
  return ['Tell me more', 'Try a different angle', 'Make it concrete'];
}

// Extract the trailing "summary" text of a rendered message: the visible prose
// that remains AFTER tool-activity blocks have been collapsed into <details>.
// This is what the assistant actually wrote to wrap up the task, so it's the
// right source for contextual recommended-action suggestions.
function _summaryTextForSuggestions(msgEl) {
  if (!msgEl) return '';
  var body = msgEl.querySelector('.msg-body') || msgEl;
  // Clone so we can strip collapsed activity/tool blocks without mutating the DOM.
  var clone = body.cloneNode(true);
  var stripSel = [
    'details', '.cot-block', '.long-response-details', '.process-cluster',
    '.shell-exec-block', '.wf-block', '.figma-exec-block', '.ba-block',
    '.suggestion-bar', '.create-agent-card', '.patch-agent-card',
    '.task-create-card', '.gen-ui-root', '.artifact-card'
  ].join(',');
  Array.from(clone.querySelectorAll(stripSel)).forEach(function(n) { n.remove(); });
  var text = (clone.innerText || clone.textContent || '').trim();
  // Prefer the last non-empty paragraph(s) — that's the closing summary.
  if (text) {
    var paras = text.split(/\n{2,}/).map(function(p) { return p.trim(); }).filter(Boolean);
    if (paras.length) {
      // Use up to the last 2 paragraphs to give the matcher enough signal.
      return paras.slice(-2).join('\n\n');
    }
  }
  return text;
}

// Guard against rendering a completely blank assistant bubble. Some turns
// arrive as nothing but a fenced ```suggestions block (or any payload that
// gets fully hoisted out of the body into a sibling widget / bottom bar) — in
// that case the `.msg-body` ends up empty after extraction and the user sees
// the header + suggestion bar with NOTHING in between. Call this AFTER all
// widget extractions to inject a friendly placeholder when the bubble would
// otherwise be visually empty.
function ensureAssistantBubbleNotEmpty(msgEl) {
  if (!msgEl) return;
  var body = msgEl.querySelector('.msg-body');
  if (!body) return;
  // Anything that's already been hoisted into a visible widget counts as
  // "not empty" — even a collapsed <details> shows a summary line. Scan the
  // ENTIRE bubble (msgEl), not just .msg-body, because plan panels and some
  // other widgets are inserted as siblings of .msg-body inside msgEl.
  var widgetSel = [
    'details', '.cot-block', '.long-response-details', '.process-cluster',
    '.shell-exec-block', '.wf-block', '.figma-exec-block', '.ba-block',
    '.create-agent-card', '.patch-agent-card', '.task-create-card',
    '.gen-ui-root', '.artifact-card', '.save-instruction-card',
    '.shell-exec-autorun-badge', '.plan-panel', '.shell-empty-warning',
    'img', 'video', 'audio', 'svg', 'iframe'
  ].join(',');
  if (msgEl.querySelector(widgetSel)) return;
  // Also count sibling artifact cards / gen-ui mounts inserted by the
  // extractors right after msgEl.
  var sib = msgEl.nextElementSibling;
  while (sib) {
    if (sib.matches && sib.matches('.artifact-card,.gen-ui-root,.task-create-card,.create-agent-card,.patch-agent-card,.save-instruction-card,.plan-panel')) return;
    sib = sib.nextElementSibling;
  }
  var visibleText = (body.innerText || body.textContent || '').trim();
  if (visibleText) return;
  // Don't replace if the body already has the friendly fallback text we set
  // up-front in the streaming-done branch (avoid clobbering "No response.").
  if (body.dataset && body.dataset.emptyPlaceholder === '1') return;
  // Genuinely empty bubble with no widgets and no text — leave it visually
  // collapsed. The suggestion bar (rendered after this) carries the next
  // action. A wordy "(empty response — the model returned only a hidden
  // block…)" placeholder reads like an error to the user when in practice
  // it just means "tool output already shown above; no extra prose this turn".
  body.style.display = 'none';
  if (body.dataset) body.dataset.emptyPlaceholder = '1';
}

function extractAndRenderSuggestions(buffer, msgEl, allowFallback) {
  var forceFinal = allowFallback === 'force';
  // Don't show CTAs while the conversation is mid-task: if a shell command is
  // still running / pending auto-run, or the stream is still in flight, the
  // assistant is about to continue speaking and the suggestion bar would be
  // premature.  The next assistant message's `done` event will retry.
  // NOTE: do NOT gate on `_autoFeedDepth` — that counter stays elevated after
  // the chain ends (only resets on a new user turn), which would hide CTAs on
  // the final assistant message of any auto-feed sequence.
  // Pending-shell checks are scoped to THIS message only — an unrun shell
  // block on an earlier bubble shouldn't suppress CTAs on later bubbles.
  try {
    var _convId = (typeof state !== 'undefined' && state) ? state.currentId : null;
    var _conv   = (typeof getConv === 'function' && _convId) ? getConv(_convId) : null;
    if (_conv && _conv._streaming) return;
    // Don't show CTAs while the stop button is red — any background work
    // (auto-feed chains, shell verification, delegations) means the assistant
    // is about to keep talking.
    if (!forceFinal && typeof _hasActiveConversationWork === 'function' && _hasActiveConversationWork()) return;
    if (!forceFinal && msgEl) {
      var _localWidgets = msgEl.querySelectorAll('.shell-exec-block');
      for (var _i = 0; _i < _localWidgets.length; _i++) {
        var _w = _localWidgets[_i];
        var _resEl = _w.querySelector('.shell-exec-result');
        var _isRunning = !!(_resEl && _resEl.classList.contains('running'));
        var _isPendingAuto = !!(typeof _shellAutoRunPending !== 'undefined' &&
                                _w.dataset.shellKey && _shellAutoRunPending[_w.dataset.shellKey]);
        if (_isRunning || _isPendingAuto) return;
      }
    }
  } catch (_) { /* fall through */ }

  // Tolerant of trailing spaces, casing (Suggestions/SUGGESTIONS), CRLF, and
  // 4-backtick fences. Captures the JSON body for parsing.
  var match = buffer.match(/`{3,4}\s*suggestions[ \t]*\r?\n([\s\S]*?)`{3,4}/i);
  if (match) {
    // The model emitted an explicit ```suggestions block — render it directly.
    // If it's malformed or empty, DON'T bail: fall through to model-generated
    // contextual suggestions so the bar still appears.
    var items = null;
    try { items = JSON.parse(match[1].trim()); } catch (_) { items = null; }
    if (Array.isArray(items) && items.length) {
      _renderSuggestionBar(items, msgEl, false, _suggestionTurnKeyForBuffer(buffer));
      return;
    }
    // else: fall through to contextual generation below.
  }

  // No usable explicit block. Generate REAL contextual suggestions with a fast
  // model (via the existing Copilot connection — no separate AI key). The
  // caller can opt out by passing allowFallback === false (e.g. mid-chain).
  if (allowFallback === false) return;
  if (forceFinal) {
    var fallbackText = _summaryTextForSuggestions(msgEl) || buffer;
    var fallbackItems = _fallbackSuggestionsFromMessage(fallbackText);
    if (fallbackItems.length) _renderSuggestionBar(fallbackItems, msgEl, true, _suggestionTurnKeyForBuffer(buffer));
    return;
  }
  _generateContextualSuggestions(msgEl);
}

// Render a recommended-actions bar for the given items below the latest
// assistant message. Shared by the explicit-block and model-generated paths.
function _renderSuggestionBar(items, msgEl, isFallback, turnKey) {
  if (!Array.isArray(items) || !items.length || !msgEl) return;
  if (msgEl.classList && msgEl.classList.contains('chain-msg')) return;

  // Suggestions are conversation-level CTAs: keep only the latest bar visible.
  var scope = msgEl.closest('[data-conv-messages]') || msgEl;
  var existingBars = Array.from(scope.querySelectorAll('.suggestion-bar'));

  // Idempotent re-render: if a bar with the same items + fallback flag is
  // already in place, do nothing. The CSS `animation: msgIn .25s ease` would
  // otherwise replay every time a caller (history load, setBusy retry,
  // loadConversation timer, the cached-render path in
  // _doGenerateContextualSuggestions, or the streaming `done` path) re-fires
  // — when two of them land back-to-back, the bar visibly flickers.
  var newLabels = items.slice(0, 4).map(function(s) { return String(s); });
  var newSig = (isFallback ? 'fb|' : 'ai|') + newLabels.join('\u0000');
  for (var _i = 0; _i < existingBars.length; _i++) {
    if (turnKey && existingBars[_i].dataset && existingBars[_i].dataset.sugTurnKey === turnKey) {
      for (var _j = 0; _j < existingBars.length; _j++) {
        if (_j !== _i) existingBars[_j].remove();
      }
      return;
    }
    if (existingBars[_i].dataset && existingBars[_i].dataset.sugSig === newSig) {
      // Drop the duplicates (keep the matching one in place).
      for (var _k = 0; _k < existingBars.length; _k++) {
        if (_k !== _i) existingBars[_k].remove();
      }
      if (turnKey && existingBars[_i].dataset) existingBars[_i].dataset.sugTurnKey = turnKey;
      return;
    }
  }
  existingBars.forEach(function(old) { old.remove(); });

  var bar = document.createElement('div');
  bar.className = 'suggestion-bar' + (isFallback ? ' suggestion-bar-fallback' : '');
  bar.setAttribute('aria-label', 'Recommended actions');
  bar.dataset.sugSig = newSig;
  if (turnKey) bar.dataset.sugTurnKey = turnKey;

  items.slice(0, 4).forEach(function(label) {
    var btn = document.createElement('button');
    btn.className = 'suggestion-btn';
    btn.textContent = label;
    btn.onclick = function() {
      bar.remove();
      var input = document.getElementById('msg-input');
      input.value = label;
      sendMessage();
    };
    bar.appendChild(btn);
  });

  // "Other…" button — focuses input so user can type
  var otherBtn = document.createElement('button');
  otherBtn.className = 'suggestion-btn suggestion-btn-other';
  otherBtn.innerHTML = '<i class="ti ti-dots"></i> Other…';
  otherBtn.onclick = function() {
    bar.remove();
    var input = document.getElementById('msg-input');
    input.focus();
  };
  bar.appendChild(otherBtn);

  // Keep the bar owned by the assistant bubble. Conversation-level siblings
  // are routinely reordered/cleaned by stream, artifact, and placeholder code;
  // nesting the bar after the message body keeps it stable once rendered.
  msgEl.appendChild(bar);
}

// Debounced trigger so history-load (which calls this once per message) and
// live streaming both result in a single API call targeting the FINAL
// assistant message of the conversation.
var _sugGenTimers = {};
var _sugInFlight = {};

function _suggestionHash(text) {
  text = String(text || '');
  var hash = 2166136261;
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
}

function _suggestionTurnKey(msgs, lastAssistant) {
  var lastUser = null;
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] === lastAssistant) continue;
    if (msgs[i] && msgs[i].role === 'user') { lastUser = msgs[i]; break; }
  }
  var userText = lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';
  var assistantText = lastAssistant && typeof lastAssistant.content === 'string' ? lastAssistant.content : '';
  return _suggestionHash(userText.slice(-2000) + '\n---assistant---\n' + assistantText.slice(-4000));
}

function _suggestionTurnKeyForBuffer(buffer) {
  try {
    var convId = (typeof state !== 'undefined' && state) ? state.currentId : null;
    var conv = (typeof getConv === 'function' && convId) ? getConv(convId) : null;
    var msgs = conv && Array.isArray(conv.messages) ? conv.messages : [];
    var lastAssistant = null;
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'assistant') { lastAssistant = msgs[i]; break; }
    }
    if (lastAssistant && typeof lastAssistant.content === 'string') return _suggestionTurnKey(msgs, lastAssistant);
  } catch (_) {}
  return _suggestionHash('\n---assistant---\n' + String(buffer || '').slice(-4000));
}

function _renderFallbackSuggestionsForTurn(convId, turnKey, lastAssistant) {
  var ci = (typeof getConvInner === 'function')
    ? getConvInner(convId)
    : document.querySelector('[data-conv-messages="' + convId + '"]');
  var el = ci && (ci.querySelector('.msg.ai:last-of-type, .msg.assistant:last-of-type') || Array.from(ci.querySelectorAll('.msg.ai, .msg.assistant')).pop());
  if (!el) return;
  var existing = ci && ci.querySelector('.suggestion-bar');
  if (existing && existing.dataset && existing.dataset.sugTurnKey === turnKey) return;
  var text = _summaryTextForSuggestions(el) || (lastAssistant && typeof lastAssistant.content === 'string' ? lastAssistant.content : '');
  var fallback = _fallbackSuggestionsFromMessage(text);
  if (fallback.length) _renderSuggestionBar(fallback, el, true, turnKey);
}

function _generateContextualSuggestions(msgEl) {
  var convId = (typeof state !== 'undefined' && state) ? state.currentId : null;
  if (!convId) return;
  clearTimeout(_sugGenTimers[convId]);
  _sugGenTimers[convId] = setTimeout(function() { _doGenerateContextualSuggestions(convId); }, 400);
}

function _doGenerateContextualSuggestions(convId) {
  var conv = (typeof getConv === 'function') ? getConv(convId) : null;
  if (!conv) return;
  // Only the active conversation gets a live suggestion bar.
  if (typeof state !== 'undefined' && state && state.currentId !== convId) return;
  if (conv._streaming) return;
  if (typeof _hasActiveConversationWork === 'function' && _hasActiveConversationWork()) return;

  var msgs = Array.isArray(conv.messages) ? conv.messages : [];
  var lastAssistant = null;
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'assistant') { lastAssistant = msgs[i]; break; }
  }
  if (!lastAssistant) return;
  var turnKey = _suggestionTurnKey(msgs, lastAssistant);

  // Locate the latest assistant message element in the active conversation's
  // container. The per-conversation container is the `[data-conv-messages]`
  // div returned by getConvInner (rendered with display:contents) — NOT a
  // `.conv-inner` element, which does not exist in the DOM.
  var convInner = (typeof getConvInner === 'function')
    ? getConvInner(convId)
    : document.querySelector('[data-conv-messages="' + convId + '"]');
  if (!convInner) return;
  var msgEl = convInner.querySelector('.msg.ai:last-of-type, .msg.assistant:last-of-type')
    || Array.from(convInner.querySelectorAll('.msg.ai, .msg.assistant')).pop();
  if (!msgEl) return;

  var existingBar = convInner.querySelector('.suggestion-bar');
  if (existingBar && existingBar.dataset && existingBar.dataset.sugTurnKey === turnKey) return;
  if (_sugInFlight[convId] === turnKey) return;

  // Cache (in-memory only; `_`-prefixed keys are stripped before storage) so we
  // don't re-call the model when the same turn is re-rendered within a session.
  // Only a NON-EMPTY cache short-circuits — a stale/empty array (e.g. a prior
  // transient failure) must fall through and regenerate, otherwise the bar
  // would stay hidden for that turn forever.
  if (lastAssistant._suggestionsKey === turnKey && Array.isArray(lastAssistant._suggestions) && lastAssistant._suggestions.length) {
    _renderSuggestionBar(lastAssistant._suggestions, msgEl, false, turnKey);
    return;
  }

  // Build a small context payload: the last few messages, trimmed.
  var recent = msgs.slice(-4).map(function(m) {
    var c = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? (m.content.find(function(p){ return p && p.type === 'text'; }) || {}).text || '' : '');
    return { role: m.role, content: String(c || '').slice(0, 2000) };
  }).filter(function(m) { return m.content.trim(); });
  if (!recent.length) return;

  var reqId = (conv._sugReqId = (conv._sugReqId || 0) + 1);
  _sugInFlight[convId] = turnKey;
  fetch('/api/conversation-suggestions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: recent, model: 'gpt-4.1-mini' })
  }).then(function(r) { return r.json(); }).then(function(data) {
    var items = (data && Array.isArray(data.suggestions)) ? data.suggestions : [];
    // Only cache REAL results. Caching an empty array (transient model failure /
    // rate-limit) would permanently suppress the recommended-actions bar for
    // this turn, since the cache short-circuits before re-fetching. Leaving it
    // uncached lets the setBusy retry (and any later re-render) try again.
    if (items.length) {
      lastAssistant._suggestions = items;
      lastAssistant._suggestionsKey = turnKey;
    }
    if (_sugInFlight[convId] === turnKey) delete _sugInFlight[convId];
    // Stale guards: a newer turn started, conv switched, or streaming resumed.
    if (conv._sugReqId !== reqId) return;
    if (typeof state !== 'undefined' && state && state.currentId !== convId) return;
    if (conv._streaming) return;
    if (typeof _hasActiveConversationWork === 'function' && _hasActiveConversationWork()) return;
    if (!items.length) {
      _renderFallbackSuggestionsForTurn(convId, turnKey, lastAssistant);
      return;
    }
    // Re-locate the message element in case the DOM changed.
    var ci = (typeof getConvInner === 'function')
      ? getConvInner(convId)
      : document.querySelector('[data-conv-messages="' + convId + '"]');
    var existing = ci && ci.querySelector('.suggestion-bar');
    if (existing && existing.dataset && existing.dataset.sugTurnKey === turnKey) return;
    var el = ci && (ci.querySelector('.msg.ai:last-of-type, .msg.assistant:last-of-type') || Array.from(ci.querySelectorAll('.msg.ai, .msg.assistant')).pop());
    if (el) _renderSuggestionBar(items, el, false, turnKey);
  }).catch(function() {
    if (_sugInFlight[convId] === turnKey) delete _sugInFlight[convId];
    _renderFallbackSuggestionsForTurn(convId, turnKey, lastAssistant);
  });
}


// Send a message directly into the conversation (supports vision/array content).
// Used by auto-feed when a screenshot was taken.
async function sendDirectMessage(content, opts) {
  opts = opts || {};
  var targetId = opts.targetConvId || state.currentId;
  if (!targetId) { newConversation(); targetId = state.currentId; }
  var conv = getConv(targetId);
  if (!conv) return;
  if (conv._cancelled) return;
  if (conv._streaming) return;
  if (!opts.fromAutoFeed && !opts.isBrowserFeed) conv._autoFeedDepth = 0;
  if (!opts.fromAutoFeed && !opts.isBrowserFeed) conv._depthLimitNotified = false;

  var isCurrentConv = (targetId === state.currentId);
  var isChainFeed = !!(opts.isAutoFeed || opts.isBrowserFeed);

  var displayText = typeof content === 'string' ? content
    : (content.find(function(c){ return c.type === 'text'; }) || {}).text || '';

  var userMsg = { role: 'user', content: content, timestamp: Date.now() };
  if (opts.isBrowserFeed) userMsg._isBrowserFeed = true;
  if (opts.isAutoFeed || opts.fromAutoFeed) userMsg._isAutoFeed = true;
  if (opts.isWriteFileFeed) userMsg._isWriteFileFeed = true;
  // Attach inline image if provided (e.g. browser extension snapshot)
  if (opts.image) {
    var imgDataUrl = opts.image;
    var imgMime = 'image/png';
    var imgBase64 = imgDataUrl;
    if (imgDataUrl.startsWith('data:')) {
      var parts = imgDataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (parts) { imgMime = parts[1]; imgBase64 = parts[2]; }
    }
    userMsg.images = [{ base64: imgBase64, mime: imgMime, name: 'snapshot' }];
  }
  conv.messages.push(userMsg);

  // Mark chain mode so streamResponse can merge the next AI bubble
  if (isChainFeed) conv._chainMode = true;
  if (opts.suppressShellAutoRun) conv._suppressShellAutoRunOnce = true;

  if (isCurrentConv) {
    if (isChainFeed) {
      // Silent — no "Browser page fed to AI" / "Shell output fed to AI" system messages
      dbg('chain feed: ' + (opts.isBrowserFeed ? 'browser' : opts.isWriteFileFeed ? 'write-file' : 'shell/auto'), 'info');
    } else if (displayText) {
      appendMessageDOM('user', displayText, [], true);
      showMessages();
    }
    forceScrollBottom();
  }
  bumpConvToTop(conv.id);
  saveConversations();
  await streamResponse(conv);
}

async function sendMessage(opts) {
  opts = opts || {};
  if (!state.currentId) newConversation();
  var conv = getConv(state.currentId);
  if (!conv) return;
  if (!opts.fromAutoFeed) conv._autoFeedDepth = 0; // user-initiated → reset chain
  if (!opts.fromAutoFeed) conv._depthLimitNotified = false;
  if (!opts.fromAutoFeed) conv._chainMode = false; // user msg → not a chain continuation
  if (!opts.fromAutoFeed) { delete conv._writeRepairMode; delete conv._suppressShellAutoRunOnce; } // new user turn clears prior write-repair gate
  if (conv._streaming) {
    // Safety: if streaming flag is stale (>90s), force reset
    if (Date.now() - (conv._streamingStart || 0) > 90000) {
      dbg('⚠ streaming flag stale — force reset', 'warn');
      conv._streaming = false;
      conv._autoFeedDepth = 0;
      setBusy(false);
    } else {
      dbg('⛔ sendMessage blocked — already streaming', 'warn');
      return;
    }
  }
  var input = document.getElementById('msg-input');
  var text  = input.value.trim();
  if (!text && !state.pendingAttachments.length) { dbg('sendMessage: empty input', 'warn'); return; }
  dbg('sendMessage: ' + text.slice(0,80), 'info');

  // ── Slash commands ───────────────────────────────────────────────────
  // `/compact` — force-summarize this conversation now, regardless of size.
  // Mirrors Codex's `/compact` and the server's auto-compaction path.
  if (text === '/compact' || text === '/compact ') {
    input.value = '';
    resizeTextarea(input);
    dbg('/compact requested — forcing summarization', 'cmd');
    await maybeCompressConversation(conv, { force: true });
    return;
  }

  // Handle multi-agent composition: @agent1 + @agent2 [parallel] message
  var compParsed = typeof parseCompositionMention === 'function' ? parseCompositionMention(text) : null;
  if (compParsed) {
    input.value = '';
    resizeTextarea(input);
    hideAgentAutocomplete();
    // Record analytics for each agent
    if (typeof recordAgentInvocation === 'function') {
      compParsed.agents.forEach(function(n) { recordAgentInvocation(n); });
    }
    await runComposition(compParsed.agents, compParsed.mode, compParsed.text, conv);
    return;
  }

  // Multi-chip sequential composition: when 2+ agent chips are active, run them sequentially
  if (typeof _agentChips !== 'undefined' && _agentChips.length > 1 && text) {
    input.value = '';
    resizeTextarea(input);
    hideAgentAutocomplete();
    await runMultiChipComposition(_agentChips.slice(), text, conv, state.pendingAttachments.slice());
    return;
  }

  // Handle @agent mentions
  var agentParsed = parseAgentMention(text);
  if (agentParsed.agent) {
    if (agentParsed.agent === 'default') {
      deactivateAgent(conv);
      text = agentParsed.text;
    } else {
      await activateAgent(agentParsed.agent, conv, agentParsed.inline);
      // Sync agent chips so state is saved to conversation
      if (typeof _syncChipsFromActiveAgent === 'function') _syncChipsFromActiveAgent();
      text = agentParsed.text;
    }
    if (!text && !state.pendingAttachments.length) {
      // Only agent switch, no message content
      input.value = '';
      resizeTextarea(input);
      hideAgentAutocomplete();
      return;
    }
  }
  hideAgentAutocomplete();

  // ── Slash command interception (smart features) ─────────────────────────
  if (typeof handleSlashCommand === 'function' && handleSlashCommand(text)) {
    input.value = '';
    resizeTextarea(input);
    return;
  }

  // Build user message content (text + file/url attachments + auto-gathered system context)
  var content = text;
  var pendingImages = [];
  if (state.pendingAttachments.length) {
    state.pendingAttachments.forEach(att => {
      if (att.type === 'image') {
        pendingImages.push({ base64: att.base64, mime: att.mime, name: att.name });
      } else {
        var label = att.extSource === 'page'      ? 'Browser page: '      + att.name
                  : att.extSource === 'selection' ? 'Browser selection from ' + (att.sourceUri || att.name)
                  : _isFigmaFileReferenceAttachment(att) ? 'Figma file: ' + att.name
                  : att.type === 'url'            ? 'URL: ' + att.name
                  : 'File: ' + att.name;
        var ref = att.sourceUri || ('attachment://' + encodeURIComponent(att.name || 'file'));
        var meta = [];
        if (att.mime) meta.push('mime=' + att.mime);
        if (att.size) meta.push('bytes=' + att.size);
        if (att.warning) meta.push('warning=' + att.warning);
        if (att.browser) meta.push('browser=' + att.browser);
        if (att.tabId) meta.push('tabId=' + att.tabId);
        if (att.clientId) meta.push('clientId=' + att.clientId);
        if (att.fileKey) meta.push('fileKey=' + att.fileKey);
        if (att.currentPage) meta.push('page=' + att.currentPage);
        var header = '// ' + label + '\n// Ref: ' + ref + (meta.length ? '\n// Meta: ' + meta.join(', ') : '');
        if (_isBrowserTabReferenceAttachment(att)) {
          var note = 'Browser tab attached via the extension; its live content is resolved inline below (if extraction succeeded). Use that content directly — do NOT open the in-app `fauna_browser` webview to re-fetch it (that is a different, blank browser).';
          content += '\n\n```\n' + header + '\n// ' + note + '\n```';
        } else if (_isFigmaFileReferenceAttachment(att)) {
          var figmaNote = 'Selected Figma target. Prefer this file when calling figma_execute. If multiple Figma files are selected, use the fileKey explicitly.';
          content += '\n\n```\n' + header + '\n// ' + figmaNote + '\n```';
        } else {
          content += '\n\n```\n' + header + '\n' + (att.content || '') + '\n```';
        }
      }
    });
  }

  var displayContent = content;
  // Resolve browser tab references to live context at send-time (keeps visible message compact)
  var liveBrowserCtx = await _buildLiveBrowserAttachmentContext(state.pendingAttachments, { conv: conv });
  if (liveBrowserCtx) content += liveBrowserCtx;

  // Inject live system context when the message is about system tasks
  var sysContext = await gatherSystemContext(text);
  var apiContent = sysContext ? content + sysContext : content;

  // Inject current date/time — gives the AI authoritative "today" context on every turn
  apiContent += '\n\n[Current date and time: ' + new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'short', hour12: false }).format(new Date()) + ']';

  var userMsg = {
    role: 'user',
    content: apiContent,
    _displayText: displayContent,
    images: pendingImages.length ? pendingImages : undefined,
    attachments: state.pendingAttachments.map(function(a) {
      return {
        type: a.type,
        name: a.name,
        content: a.type === 'image' || _isBrowserTabReferenceAttachment(a) || _isFigmaFileReferenceAttachment(a) ? undefined : a.content,
        sourceUri: a.sourceUri,
        extSource: a.extSource,
        browser: a.browser,
        tabId: a.tabId,
        clientId: a.clientId,
        fileKey: a.fileKey,
        currentPage: a.currentPage,
        timestamp: a.timestamp,
        figmaDisconnected: !!a.figmaDisconnected,
        size: a.size,
        warning: a.warning,
        base64: a.type === 'image' ? a.base64 : undefined,
        mime: a.mime
      };
    })
  };
  if (conv._pendingToolPolicy) {
    userMsg._toolPolicy = conv._pendingToolPolicy;
    delete conv._pendingToolPolicy;
  }
  if (conv._pendingModelPolicy) {
    userMsg._modelPolicy = conv._pendingModelPolicy;
    delete conv._pendingModelPolicy;
  }
  conv.messages.push(userMsg);

  bumpConvToTop(conv.id);
  saveConversations();
  appendMessageDOM('user', displayContent, userMsg.attachments, true);
  showMessages();
  clearAttachments({ preservePersistent: true });

  input.value = '';
  if (typeof aiAutocompleteClear === 'function') aiAutocompleteClear();
  resizeTextarea(input);
  forceScrollBottom();

  await streamResponse(conv);
}

// ── Multi-chip composition ────────────────────────────────────────────────
// When 2+ agent chips are active: show mode picker (parallel/sequential),
// run all agents via /api/chat (like sub-agent delegation), show result cards.

async function runMultiChipComposition(agentNames, userMessage, conv, attachments) {
  if (!conv) return;
  attachments = attachments || [];

  // Build content with any file/url attachments appended (same as sendMessage)
  var content = userMessage;
  var pendingImages = [];
  attachments.forEach(function(att) {
    if (att.type === 'image') {
      pendingImages.push({ base64: att.base64, mime: att.mime, name: att.name });
    } else {
      var label = att.extSource === 'page'      ? 'Browser page: '      + att.name
                : att.extSource === 'selection' ? 'Browser selection from ' + (att.sourceUri || att.name)
                : _isFigmaFileReferenceAttachment(att) ? 'Figma file: ' + att.name
                : att.type === 'url'            ? 'URL: ' + att.name
                : 'File: ' + att.name;
      var ref = att.sourceUri || ('attachment://' + encodeURIComponent(att.name || 'file'));
      var meta = [];
      if (att.mime) meta.push('mime=' + att.mime);
      if (att.size) meta.push('bytes=' + att.size);
      if (att.warning) meta.push('warning=' + att.warning);
      if (att.browser) meta.push('browser=' + att.browser);
      if (att.tabId) meta.push('tabId=' + att.tabId);
      if (att.clientId) meta.push('clientId=' + att.clientId);
      if (att.fileKey) meta.push('fileKey=' + att.fileKey);
      if (att.currentPage) meta.push('page=' + att.currentPage);
      var header = '// ' + label + '\n// Ref: ' + ref + (meta.length ? '\n// Meta: ' + meta.join(', ') : '');
      if (_isBrowserTabReferenceAttachment(att)) {
        var note = 'Browser tab attached via the extension; its live content is resolved inline below (if extraction succeeded). Use that content directly — do NOT open the in-app `fauna_browser` webview to re-fetch it (that is a different, blank browser).';
        content += '\n\n```\n' + header + '\n// ' + note + '\n```';
      } else if (_isFigmaFileReferenceAttachment(att)) {
        var figmaNote = 'Selected Figma target. Prefer this file when calling figma_execute. If multiple Figma files are selected, use the fileKey explicitly.';
        content += '\n\n```\n' + header + '\n// ' + figmaNote + '\n```';
      } else {
        content += '\n\n```\n' + header + '\n' + (att.content || '') + '\n```';
      }
    }
  });

  var displayContent = content;
  // Resolve browser tab references to live context at send-time (keeps visible message compact)
  var liveBrowserCtx = await _buildLiveBrowserAttachmentContext(attachments, { conv: conv });
  if (liveBrowserCtx) content += liveBrowserCtx;

  // Show the user message in chat
  var userMsg = { role: 'user', content: content, images: pendingImages.length ? pendingImages : undefined, timestamp: Date.now() };
  conv.messages.push(userMsg);

  saveConversations();
  appendMessageDOM('user', displayContent, null, true);
  showMessages();
  clearAttachments({ preservePersistent: true });
  forceScrollBottom();

  // Use per-conv DOM container so switching away doesn't hide/destroy the progress UI
  var inner = getConvInner(conv.id);

  // Mark conv as streaming so sidebar shows spinner + other convo sends are not blocked
  conv._streaming = true;
  conv._streamingStart = Date.now();
  if (state.currentId === conv.id) setBusy(true);

  // ── Build progress UI with mode picker ───────────────────────────────────
  var mcId = 'mc-' + Date.now();
  var agentRows = agentNames.map(function(n, i) {
    var a = findAgent(n);
    var icon = a ? (a.icon || 'ti-robot') : 'ti-robot';
    var name = a ? a.displayName : n;
    return '<div class="delegation-agent-row" id="mc-row-' + i + '-' + mcId + '">' +
      '<div class="delegation-agent-status"></div>' +
      '<i class="ti ' + escHtml(icon) + ' delegation-agent-icon"></i>' +
      '<span class="delegation-agent-name">' + escHtml(name) + '</span>' +
      '<span class="delegation-agent-task" id="mc-task-' + i + '-' + mcId + '">' + escHtml(userMessage.length > 70 ? userMessage.substring(0, 70) + '…' : userMessage) + '</span>' +
      '<span class="delegation-agent-time" id="mc-time-' + i + '-' + mcId + '"></span>' +
    '</div>';
  }).join('');

  var agentOptionsHtml = agentNames.map(function(n, i) {
    var a = findAgent(n);
    var icon = a ? (a.icon || 'ti-robot') : 'ti-robot';
    var name = a ? a.displayName : n;
    return '<button class="deleg-mode-btn deleg-single-agent-btn" onclick="window[\'_mcPickMode_' + mcId + '\'] && window[\'_mcPickMode_' + mcId + '\'](\'single:' + i + '\')">' +
      '<i class="ti ' + escHtml(icon) + '"></i> ' + escHtml(name) + '</button>';
  }).join('');

  var modePickerHtml =
    '<div class="delegation-mode-picker" id="mc-mode-picker-' + mcId + '">' +
      '<span class="deleg-mode-label"><i class="ti ti-settings-2"></i> Run mode:</span>' +
      '<button class="deleg-mode-btn" id="mc-mode-parallel-' + mcId + '" onclick="window[\'_mcPickMode_' + mcId + '\'] && window[\'_mcPickMode_' + mcId + '\'](\'parallel\')"><i class="ti ti-bolt"></i> Parallel</button>' +
      '<button class="deleg-mode-btn" id="mc-mode-sequential-' + mcId + '" onclick="window[\'_mcPickMode_' + mcId + '\'] && window[\'_mcPickMode_' + mcId + '\'](\'sequential\')"><i class="ti ti-arrow-down"></i> Sequential</button>' +
      '<button class="deleg-mode-btn" onclick="var el=document.getElementById(\'mc-single-picker-' + mcId + '\');el.style.display=el.style.display===\'none\'?\'\':\'none\'"><i class="ti ti-user"></i> Single</button>' +
    '</div>' +
    '<div class="delegation-single-picker" id="mc-single-picker-' + mcId + '" style="display:none">' +
      '<span class="deleg-mode-label">Pick one agent:</span>' +
      agentOptionsHtml +
    '</div>';

  var progressEl = document.createElement('div');
  progressEl.className = 'delegation-progress';
  progressEl.innerHTML =
    '<div class="delegation-progress-header" id="mc-header-' + mcId + '"><i class="ti ti-hierarchy-3"></i> Running ' + agentNames.length + ' agents…</div>' +
    modePickerHtml +
    '<div class="delegation-agent-list">' + agentRows + '</div>';
  if (inner) { inner.appendChild(progressEl); scrollBottom(); }

  // ── Wait for user mode choice — no auto-timeout ──────────────────────────
  var chosenMode = await new Promise(function(resolve) {
    window['_mcPickMode_' + mcId] = function(mode) {
      resolve(mode);
    };
  });
  window['_mcPickMode_' + mcId] = null;

  // Handle single-agent mode
  if (chosenMode.startsWith('single:')) {
    var singleIdx = parseInt(chosenMode.split(':')[1], 10);
    agentNames = [agentNames[singleIdx]];
    chosenMode = 'parallel';
  }

  // ── Setup abort ───────────────────────────────────────────────────────────
  var abortCtrl = new AbortController();
  var cancelled = false;
  var headerEl = document.getElementById('mc-header-' + mcId);

  var pickerEl = document.getElementById('mc-mode-picker-' + mcId);
  if (pickerEl) {
    pickerEl.innerHTML =
      '<span class="deleg-mode-chosen"><i class="ti ti-' + (chosenMode === 'sequential' ? 'arrow-down' : 'bolt') + '"></i> ' + (chosenMode === 'sequential' ? 'Sequential' : 'Parallel') + '</span>';
  }

  window['_mcStop_' + mcId] = function() {
    cancelled = true;
    abortCtrl.abort();
    agentNames.forEach(function(_, _i) {
      var _r = document.getElementById('mc-row-' + _i + '-' + mcId);
      if (_r && (_r.classList.contains('working') || _r.classList.contains('pending'))) {
        _r.classList.remove('working', 'pending');
        _r.classList.add('cancelled');
        var _st = _r.querySelector('.delegation-agent-status');
        if (_st) _st.innerHTML = '<i class="ti ti-minus" style="font-size:10px;color:var(--fau-text-muted)"></i>';
      }
    });
    if (headerEl) { headerEl.innerHTML = '<i class="ti ti-player-stop-filled"></i> Stopped by user'; headerEl.classList.add('cancelled'); }
    conv._streaming = false;
    conv._abortController = null;
    if (state.currentId === conv.id) setBusy(false);
    renderConvList();
  };
  // Expose to main stop button
  window._delegStop = window['_mcStop_' + mcId];

  // ── Mark rows as pending (sequential) or working (parallel) ──────────────
  agentNames.forEach(function(_, i) {
    var _r = document.getElementById('mc-row-' + i + '-' + mcId);
    if (!_r) return;
    if (chosenMode === 'sequential') {
      _r.classList.add('pending');
      _r.querySelector('.delegation-agent-status').innerHTML = '<span class="deleg-pending-dot"></span>';
    } else {
      _r.classList.add('working');
      _r.querySelector('.delegation-agent-status').innerHTML = '<span class="delegation-spinner"></span>';
    }
  });
  scrollBottom();

  // ── runOne: call /api/chat for a single agent ─────────────────────────────
  function runOne(agent, idx, task, priorResultsText) {
    if (cancelled) return Promise.resolve({ agentName: agent.name, displayName: agent.displayName, icon: agent.icon || 'ti-robot', task: task, response: 'Cancelled', duration: 0, cancelled: true });
    var row = document.getElementById('mc-row-' + idx + '-' + mcId);
    var timeEl = document.getElementById('mc-time-' + idx + '-' + mcId);
    if (row) { row.classList.remove('pending'); row.classList.add('working'); row.querySelector('.delegation-agent-status').innerHTML = '<span class="delegation-spinner"></span>'; }
    var start = Date.now();
    var timerTick = setInterval(function() {
      if (timeEl && row && row.classList.contains('working'))
        timeEl.textContent = ((Date.now() - start) / 1000).toFixed(0) + 's';
    }, 500);
    var userContent = task + (priorResultsText ? '\n\n---\nPrevious agent results for context:\n' + priorResultsText : '');
    var selectedFigmaFileKeys = _getSelectedFigmaFileKeysFromAttachments(attachments);
    return fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortCtrl.signal,
      body: JSON.stringify({
        messages: [{ role: 'user', content: userContent }],
        model: state.model,
        agentName: agent.name,
        isDelegation: true,
        useFigmaMCP: !!(agent.permissions && agent.permissions.figma),
        selectedFigmaFileKeys,
        usePlaywrightMCP: !!(agent.permissions && agent.permissions.browser),
        thinkingBudget: state.thinkingBudget || 'high',
        systemPrompt: '## Active Agent: ' + agent.displayName + '\n\n' + (agent.systemPrompt || '') + '\n\nYou are running as one of several agents in a multi-agent session. Complete your assigned task thoroughly.'
      })
    }).then(function(r) {
      return typeof readDelegationStream === 'function' ? readDelegationStream(r, abortCtrl.signal) : r.text();
    }).then(function(text) {
      clearInterval(timerTick);
      var dur = Date.now() - start;
      if (row) { row.classList.remove('working'); row.classList.add('done'); }
      if (timeEl) timeEl.textContent = (dur / 1000).toFixed(1) + 's';
      return { agentName: agent.name, displayName: agent.displayName, icon: agent.icon || 'ti-robot', task: task, response: text, duration: dur };
    }).catch(function(e) {
      clearInterval(timerTick);
      var dur = Date.now() - start;
      var isCancelled = e.name === 'AbortError' || cancelled;
      if (row) { row.classList.remove('working'); row.classList.add(isCancelled ? 'cancelled' : 'error'); }
      if (timeEl) timeEl.textContent = (dur / 1000).toFixed(1) + 's';
      return { agentName: agent.name, displayName: agent.displayName || agent.name, icon: 'ti-robot', task: task, response: isCancelled ? 'Cancelled' : ('Error: ' + e.message), duration: dur, error: !isCancelled, cancelled: isCancelled };
    });
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  var results = [];
  if (chosenMode === 'sequential') {
    for (var _si = 0; _si < agentNames.length; _si++) {
      if (cancelled) break;
      var _agent = findAgent(agentNames[_si]);
      if (!_agent) continue;
      var priorCtx = results.length ? results.map(function(r) { return '**' + (r.displayName || r.agentName) + '**: ' + r.response.substring(0, 800); }).join('\n\n') : null;
      var res = await runOne(_agent, _si, userMessage, priorCtx);
      results.push(res);
    }
  } else {
    // Parallel — all at once
    results = await Promise.all(agentNames.map(function(n, i) {
      var _a = findAgent(n);
      if (!_a) return Promise.resolve({ agentName: n, displayName: n, icon: 'ti-robot', task: userMessage, response: 'Agent not found', duration: 0, error: true });
      return runOne(_a, i, userMessage, null);
    }));
  }

  delete window['_mcStop_' + mcId];

  // Clear streaming state
  conv._streaming = false;
  conv._abortController = null;
  if (state.currentId === conv.id) setBusy(false);
  renderConvList();

  // ── Finalize ──────────────────────────────────────────────────────────────
  if (cancelled) {
    // headerEl already updated by _mcStop handler
    return;
  }

  if (headerEl) {
    headerEl.innerHTML = '<i class="ti ti-circle-check"></i> All ' + agentNames.length + ' agents complete';
    headerEl.classList.add('complete');
  }

  // Show per-agent result cards (reuse delegation renderer)
  if (typeof showDelegationResults === 'function') {
    showDelegationResults(results, inner);
  }

  // Persist results summary to conversation
  var summary = results.map(function(r) {
    return '**' + escHtml(r.displayName || r.agentName) + '**\n' + (r.response || '');
  }).join('\n\n---\n\n');
  var aiSummaryMsg = { role: 'assistant', content: summary };
  conv.messages.push(aiSummaryMsg);
  saveConversations();
  if (typeof maybeUpdateConversationTitle === 'function') maybeUpdateConversationTitle(conv);

  forceScrollBottom();
  if (typeof renderAgentChips === 'function') renderAgentChips();
}

async function streamResponse(conv) {
  var convId = conv.id;
  function isActive() { return state.currentId === convId; }

  conv._streaming = true;
  conv._streamingStart = Date.now();
  conv._cancelled = false;
  conv._abortController = new AbortController();
  if (isActive()) setBusy(true);
  renderConvList(); // show streaming spinner in sidebar

  // Create AI message placeholder — append to this conv's own DOM container (works in background too)
  var _currentAgentInfo = null;
  if (typeof isAgentActive === 'function' && isAgentActive()) {
    _currentAgentInfo = { name: activeAgent.name, displayName: activeAgent.displayName, icon: activeAgent.manifest.icon || 'ti-robot' };
  }
  var msgEl  = createMessageEl('ai', _currentAgentInfo);
  if (!msgEl) {
    console.error('[chat] createMessageEl returned null — aborting stream setup');
    conv._streaming = false;
    if (isActive()) setBusy(false);
    return;
  }
  msgEl.dataset.streamingLive = '1';
  var bodyEl = msgEl.querySelector('.msg-body');
  // Track widgets emitted during this assistant turn so they can be persisted
  // on the message and remounted after a reload.
  var _streamWidgets = [];
  // Track files created via the write/shell function tools this turn. The
  // server emits `artifact_created` events for them; we buffer here and append
  // ```artifact-ref fences to the message at stream end so entity cards render
  // (and persist across reload) even though no ```write-file block was emitted.
  var _streamArtifacts = [];
  // Chained turns inherit the latest persisted plan even when the server
  // suppresses an unchanged plan_update event.
  var _isChainContinuation = !!conv._chainMode;
  var _latestPlannedMessage = _isChainContinuation
    ? (conv.messages || []).slice().reverse().find(function(message) {
        return message && message.role === 'assistant' && message.plan && Array.isArray(message.plan.items);
      })
    : null;
  var _currentPlan = _latestPlannedMessage ? _latestPlannedMessage.plan : null;
  function _ensureLiveMessageAttached() {
    if (!conv._streaming) return;
    if (!msgEl) return;
    if (msgEl.isConnected) return;
    var inner = getConvInner(convId);
    if (!inner) return;
    Array.from(inner.querySelectorAll('.msg.ai[data-streaming-live="1"]')).forEach(function(existing) {
      if (existing !== msgEl) existing.remove();
    });
    inner.appendChild(msgEl);
    // A new live message is taking the bottom slot. Drop any existing
    // conversation-level suggestion bar: it was generated against an earlier
    // (incomplete) turn and would now appear ABOVE the just-attached summary.
    // The current message's `done` handler will regenerate a fresh, contextual
    // bar at the proper position.
    Array.from(inner.querySelectorAll('.suggestion-bar')).forEach(function(b) { b.remove(); });
    if (isActive()) { showMessages(); forceScrollBottom(); }
  }
  function _streamingStatusHtml(label) {
    return '<div class="thinking streaming-status">' +
      '<div class="think-dot"></div><div class="think-dot"></div><div class="think-dot"></div>' +
      '<span class="thinking-label">' + escHtml(label || 'Fauna is working…') + '</span>' +
    '</div>';
  }
  function _bodyHasVisibleStreamContent() {
    if (!bodyEl) return false;
    if ((bodyEl.textContent || '').trim()) return true;
    return !!bodyEl.querySelector('img,svg,iframe,video,audio,canvas,.cot-pill,.tool-status-stack,.shell-output-block');
  }
  function _ensureStreamingStatus(label) {
    _ensureLiveMessageAttached();
    if (!conv._streaming || !isActive() || !bodyEl) return;
    if (!_bodyHasVisibleStreamContent()) bodyEl.innerHTML = _streamingStatusHtml(label);
  }
  bodyEl.innerHTML = _streamingStatusHtml('Fauna is thinking…');
  // Chain-merge: if this is a continuation from auto-feed, visually merge with previous AI message
  if (conv._chainMode) {
    msgEl.classList.add('chain-msg');
    conv._chainMode = false;
  }
  getConvInner(convId).appendChild(msgEl);
  if (isActive()) { showMessages(); forceScrollBottom(); }

  var buffer       = '';
  var renderTimer  = null;
  var lastScrolled = 0;
  var tokenCount   = 0;
  var _lastRenderTraceAt = 0;
  var _streamStartedAt = Date.now();
  var _lastLiveRenderHtml = '';
  var _lastToolOutputAccum = ''; // rolling last ~1000 chars of tool_output for input context
  var _toolOutputBlockChars = 0; // chars of live output kept in the collapsed tool activity view (capped)
  var _liveToolOutputEl = null;
  var _liveToolOutputBody = null;
  var _liveToolOutputLabel = null;
  var _liveToolOutputMeta = null;
  var _liveToolOutputPre = null;
  var _liveToolOutputEntryCount = 0;
  var _liveActivityThinkingTitle = null;
  var _liveActivityThinkingPreview = null;
  var _liveActivityThinkingStep = null;
  var _activityEntries = [];
  var _activityEntryByCallId = Object.create(null);
  var _currentActivityEntry = null;
  var _reasoning = null; // { startedAt, durationSeconds } — compact thinking status only
  var _reasoningSummary = '';
  var _publicReasoningSummary = '';
  var _reasoningTickTimer = null; // ticks the "Thinking… Ns" counter live until content/done
  var _activityTickTimer = null;
  var _processDurationSeconds = null;
  if (typeof resetDesignArtifactState === 'function') resetDesignArtifactState();

  function _setLiveToolOutputOpen(open) {
    if (!_liveToolOutputEl) return;
    _liveToolOutputEl.setAttribute('data-open', open ? '1' : '0');
    var toggle = _liveToolOutputEl.querySelector('.tool-activity-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function _updateLiveToolOutputSummary(completed) {
    if (!_liveToolOutputEl) return;
    var count = _liveToolOutputEntryCount;
    if (_liveToolOutputLabel) _liveToolOutputLabel.textContent = 'Activity';
    if (_liveToolOutputMeta) {
      var steps = Math.max(1, count + (_reasoning ? 1 : 0));
      var elapsedSeconds = _processDurationSeconds != null
        ? _processDurationSeconds
        : Math.max(0, Math.floor((Date.now() - _streamStartedAt) / 1000));
      _liveToolOutputMeta.textContent = steps + ' step' + (steps === 1 ? '' : 's') + ' · ' + _formatElapsed(elapsedSeconds * 1000) + (completed ? ' · complete' : ' · running');
    }
    if (completed && _liveToolOutputBody) {
      Array.from(_liveToolOutputBody.querySelectorAll('.tool-activity-pre')).forEach(function(pre) {
        if (!pre.textContent) pre.textContent = 'Completed without preview output.';
      });
    }
    if (_liveToolOutputBody && typeof applyActivityStepLimit === 'function') {
      applyActivityStepLimit(_liveToolOutputBody, !!completed);
    }
    _liveToolOutputEl.setAttribute('data-completed', completed ? '1' : '0');
  }

  function _startActivityTicker() {
    if (_activityTickTimer) return;
    _activityTickTimer = setInterval(function() {
      _updateLiveToolOutputSummary(false);
    }, 1000);
  }

  function _stopActivityTicker() {
    if (_activityTickTimer) {
      clearInterval(_activityTickTimer);
      _activityTickTimer = null;
    }
  }

  function _ensureLiveToolOutputPanel() {
    _ensureLiveMessageAttached();
    if (!_liveToolOutputEl || !_liveToolOutputEl.isConnected) {
      _liveToolOutputEl = document.createElement('div');
      _liveToolOutputEl.className = 'shell-output-block live-tool-output-block tool-activity-panel';
      _liveToolOutputEl.setAttribute('data-open', '1');
      _liveToolOutputEl.setAttribute('data-completed', '0');

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'tool-activity-toggle';
      toggle.setAttribute('aria-expanded', 'true');
      toggle.addEventListener('click', function() {
        _setLiveToolOutputOpen(_liveToolOutputEl.getAttribute('data-open') !== '1');
      });

      var icon = document.createElement('span');
      icon.className = 'tool-activity-icon';
      icon.textContent = '›';
      _liveToolOutputLabel = document.createElement('span');
      _liveToolOutputLabel.className = 'tool-activity-label';
      _liveToolOutputLabel.textContent = 'Activity';
      _liveToolOutputMeta = document.createElement('span');
      _liveToolOutputMeta.className = 'tool-activity-meta';
      _liveToolOutputMeta.textContent = 'running';
      toggle.appendChild(icon);
      toggle.appendChild(_liveToolOutputLabel);
      toggle.appendChild(_liveToolOutputMeta);

      _liveToolOutputBody = document.createElement('div');
      _liveToolOutputBody.className = 'tool-activity-body';
      _liveToolOutputEl.appendChild(toggle);
      _liveToolOutputEl.appendChild(_liveToolOutputBody);
      _startActivityTicker();
      if (bodyEl && bodyEl.querySelector('.streaming-status') && !buffer) bodyEl.innerHTML = '';
      if (msgEl && bodyEl) msgEl.insertBefore(_liveToolOutputEl, bodyEl);
      else if (msgEl) msgEl.appendChild(_liveToolOutputEl);
    }
    return _liveToolOutputEl;
  }

  function _activityEntryDetail(entry) {
    if (!entry) return '';
    var descriptorDetail = typeof formatActivityDescriptorDetail === 'function'
      ? formatActivityDescriptorDetail(entry.activity)
      : '';
    return [descriptorDetail || (entry.command ? '$ ' + entry.command : ''), entry.resultSummary || entry.progress || '', entry.output || ''].filter(Boolean).join('\n\n');
  }

  function _beginLiveToolOutput(label, callId, command, activity) {
    _ensureLiveToolOutputPanel();
    if (!_liveToolOutputBody) return null;
    _liveToolOutputEntryCount++;
    _currentActivityEntry = { callId: callId || '', label: label || 'Tool output', command: String(command || ''), activity: activity || null, output: '', progress: 'Starting…' };
    _activityEntries.push(_currentActivityEntry);
    if (callId) _activityEntryByCallId[callId] = _currentActivityEntry;
    Array.from(_liveToolOutputBody.querySelectorAll('.tool-activity-entry[data-open="1"]')).forEach(function(existing) {
      existing.dataset.open = '0';
      var existingToggle = existing.querySelector('.tool-activity-step-toggle');
      if (existingToggle) existingToggle.setAttribute('aria-expanded', 'false');
    });
    var toolKind = activity && activity.kind
      ? activity.kind
      : (typeof activityStepKind === 'function' ? activityStepKind(label, 'tool') : 'tool');
    var step = createActivityStep(label || 'Tool output', toolKind, _activityEntryDetail(_currentActivityEntry), true);
    _liveToolOutputPre = step.text;
    _currentActivityEntry.step = step;
    _liveToolOutputBody.appendChild(step.entry);
    _updateLiveToolOutputSummary(false);
    return _liveToolOutputPre;
  }

  function _updateLiveToolProgress(evt) {
    var entry = (evt.callId && _activityEntryByCallId[evt.callId]) || _currentActivityEntry;
    if (!entry || !entry.step) return;
    entry.progress = evt.completed && entry.resultSummary ? '' : String(evt.message || 'Still running…');
    if (typeof setActivityStepDetailAvailability === 'function') setActivityStepDetailAvailability(entry.step, true);
    updateActivityStepDetail(entry.step, _activityEntryDetail(entry));
    entry.step.entry.dataset.completed = evt.completed ? '1' : '0';
    entry.step.entry.dataset.failed = evt.failed ? '1' : '0';
  }

  function _updateLiveToolActivityResult(evt) {
    var entry = evt.callId && _activityEntryByCallId[evt.callId];
    if (!entry || !entry.step) return;
    entry.resultSummary = String(evt.summary || '');
    entry.progress = '';
    updateActivityStepDetail(entry.step, _activityEntryDetail(entry));
    entry.step.entry.dataset.completed = '1';
    entry.step.entry.dataset.failed = evt.status === 'failed' ? '1' : '0';
  }

  function _ensureLiveToolOutputBlock() {
    return _liveToolOutputPre || _beginLiveToolOutput('Tool output');
  }

  // ── Ephemeral tool status stack (Clawpilot-style) ──────────────────
  // Track total count + first-tool-ts across the burst so the user sees
  // "12/n · 1m 47s" instead of just the most recent tool name. Long agentic
  // bursts (40+ tools, 5+ minutes) otherwise look identical to a hung pill.
  var _toolStatuses = []; // { label, ts } — last 3 only (display window)
  var _toolStatusCount = 0;
  var _toolStatusFirstAt = 0;
  var _toolStatusTickTimer = null;
  var _toolStatusEl = null;
  function _addToolStatus(label) {
    if (!_toolStatusCount) _toolStatusFirstAt = Date.now();
    _toolStatusCount++;
    _toolStatuses.push({ label: label, ts: Date.now() });
    if (_toolStatuses.length > 3) _toolStatuses.shift();
    _renderToolStatuses();
    // Tick the elapsed counter every second while a burst is in flight so the
    // pill keeps moving even if no new tools fire for a while.
    if (!_toolStatusTickTimer) {
      _toolStatusTickTimer = setInterval(function() {
        if (_toolStatuses.length) _renderToolStatuses();
        else { clearInterval(_toolStatusTickTimer); _toolStatusTickTimer = null; }
      }, 1000);
    }
  }
  function _clearToolStatuses() {
    _toolStatuses = [];
    _toolStatusCount = 0;
    _toolStatusFirstAt = 0;
    if (_toolStatusTickTimer) { clearInterval(_toolStatusTickTimer); _toolStatusTickTimer = null; }
    if (_toolStatusEl) { _toolStatusEl.remove(); _toolStatusEl = null; }
    _ensureStreamingStatus('Fauna is working…');
  }
  function _formatElapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    var r = s % 60;
    return r ? (m + 'm ' + r + 's') : (m + 'm');
  }
  function _renderToolStatuses() {
    if (!_toolStatuses.length) { _clearToolStatuses(); return; }
    if (bodyEl && bodyEl.querySelector('.streaming-status') && !buffer) bodyEl.innerHTML = '';
    if (!_toolStatusEl) {
      _toolStatusEl = document.createElement('div');
      _toolStatusEl.className = 'tool-status-stack';
      bodyEl.appendChild(_toolStatusEl);
    }
    var html = '';
    var last = _toolStatuses.length - 1;
    var elapsed = _toolStatusFirstAt ? _formatElapsed(Date.now() - _toolStatusFirstAt) : '';
    for (var t = 0; t < _toolStatuses.length; t++) {
      var op = t === last ? 1 : t === last - 1 ? 0.6 : 0.4;
      var labelText = _toolStatuses[t].label;
      // Append "· N tools · Ms" to the most recent line so the pill visibly
      // ticks during long bursts. Only show the count when we've seen >1 so
      // single-tool turns stay clean.
      var suffix = '';
      if (t === last && (_toolStatusCount > 1 || elapsed)) {
        var parts = [];
        if (_toolStatusCount > 1) parts.push(_toolStatusCount + ' tools');
        if (elapsed) parts.push(elapsed);
        if (parts.length) suffix = ' <span style="opacity:0.65;font-variant-numeric:tabular-nums">· ' + parts.join(' · ') + '</span>';
      }
      html += '<div class="tool-status-line" style="opacity:' + op + '">' +
        '<span class="tool-status-icon">⚡</span>' +
        '<span class="' + (t === last ? 'tool-status-shimmer' : '') + '">' + escHtml(labelText) + '</span>' +
        suffix +
      '</div>';
    }
    _toolStatusEl.innerHTML = html;
  }

  function _showInlineNotice(message) {
    if (!message || !bodyEl) return;
    _ensureLiveMessageAttached();
    var notice = bodyEl.querySelector('.stream-inline-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'stream-inline-notice';
      notice.innerHTML = '<i class="ti ti-info-circle"></i><span></span><button type="button" class="stream-inline-notice-close" aria-label="Dismiss notice"><i class="ti ti-x"></i></button>';
      var close = notice.querySelector('.stream-inline-notice-close');
      if (close) close.onclick = function() { notice.remove(); };
      bodyEl.appendChild(notice);
    }
    var text = notice.querySelector('span');
    if (text) text.textContent = message;
    scrollBottom();
  }

  function scheduleRender() {
    _ensureLiveMessageAttached();
    if (!isActive() || !bodyEl) return;
    if (renderTimer) return;
    // Coalesce on the next animation frame instead of a 60ms timeout so the
    // visible text keeps pace with the token stream (~16ms at 60Hz). This is
    // the "token-by-token feel" change — render at display rate, not at a
    // human-perceptible debounce. rAF is dropped to setTimeout(0) when the
    // tab is backgrounded so we don't busy-spin a hidden conversation.
    const _schedule = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    renderTimer = _schedule(() => {
      renderTimer = null;
      if (buffer) {
        bodyEl.classList.add('streaming-cursor');
        var renderStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        var liveBuffer = typeof redactWriteFileBlocksForStreaming === 'function' ? redactWriteFileBlocksForStreaming(buffer) : buffer;
        var rendered = (typeof renderStreamingActivity === 'function' ? renderStreamingActivity : renderStreamingCOT)(liveBuffer);
        var renderEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        var visibleChanged = rendered !== _lastLiveRenderHtml;
        if (rendered && rendered.trim()) {
          if (visibleChanged) {
            bodyEl.innerHTML = rendered;
            _lastLiveRenderHtml = rendered;
          }
        } else {
          _ensureStreamingStatus('Fauna is working…');
        }
        var now = Date.now();
        var renderMs = renderEnd - renderStart;
        if (visibleChanged || renderMs > 25 || now - _lastRenderTraceAt > 5000) {
          _lastRenderTraceAt = now;
          dbg('stream render: raw=' + buffer.length + 'ch visible=' + liveBuffer.length + 'ch html=' + (rendered || '').length + 'ch renderMs=' + renderMs.toFixed(1) + (visibleChanged ? ' changed' : ' unchanged'), 'info');
        }
        if (now - lastScrolled > 200) { scrollBottom(); lastScrolled = now; }
      } else {
        _ensureStreamingStatus('Fauna is working…');
      }
    });
  }

  function _updateReasoningPanel(durationSeconds, completed, keepActivityRunning) {
    _ensureLiveMessageAttached();
    if (!isActive() || !msgEl) return;
    if (completed && !_reasoning) return;
    _ensureLiveToolOutputPanel();
    if (!_liveToolOutputBody) return;
    if (!_liveActivityThinkingTitle) {
      _liveActivityThinkingStep = createActivityStep('Thinking…', 'thinking', 'Waiting for a model-provided reasoning summary…', true);
      _liveActivityThinkingTitle = _liveActivityThinkingStep.title;
      _liveActivityThinkingPreview = _liveActivityThinkingStep.text;
      _liveToolOutputBody.insertBefore(_liveActivityThinkingStep.entry, _liveToolOutputBody.firstChild);
    }
    var elapsed = durationSeconds != null ? durationSeconds
                : (_reasoning && _reasoning.startedAt) ? Math.round((Date.now() - _reasoning.startedAt) / 1000) : null;
    var label = completed
      ? ('Thought for ' + (elapsed != null ? elapsed + 's' : '…'))
      : (elapsed != null ? 'Thinking… ' + elapsed + 's' : 'Thinking…');
    var displaySummary = _reasoningSummary || _publicReasoningSummary;
    _liveActivityThinkingTitle.textContent = label;
    if (_liveActivityThinkingStep) {
      updateActivityStepDetail(_liveActivityThinkingStep, displaySummary || (completed ? '' : 'Preparing a public approach summary…'));
      if (completed && typeof setActivityStepDetailAvailability === 'function') {
        setActivityStepDetailAvailability(_liveActivityThinkingStep, !!displaySummary);
      }
    }
    _updateLiveToolOutputSummary(!!completed && !keepActivityRunning);
  }

  function _syncPublicReasoningSummary() {
    if (typeof extractPublicReasoningSummary !== 'function') return;
    var summary = extractPublicReasoningSummary(buffer);
    if (!summary || summary === _publicReasoningSummary) return;
    _publicReasoningSummary = summary;
    if (!_reasoning) _reasoning = { startedAt: Date.now() };
    var phaseCompleted = _reasoning.durationSeconds != null;
    _updateReasoningPanel(phaseCompleted ? _reasoning.durationSeconds : null, phaseCompleted, phaseCompleted);
  }

  function _finalizeReasoningPhase() {
    _stopReasoningTicker();
    if (!_reasoning || _reasoning.durationSeconds != null) return;
    _reasoning.durationSeconds = _reasoning.startedAt
      ? Math.max(0, Math.round((Date.now() - _reasoning.startedAt) / 1000))
      : 0;
    _updateReasoningPanel(_reasoning.durationSeconds, true, true);
  }

  function _hasVisibleAssistantStreamContent() {
    var visibleBuffer = typeof stripPublicReasoningSummaryBlocks === 'function'
      ? stripPublicReasoningSummaryBlocks(buffer)
      : buffer;
    return !!String(visibleBuffer || '').trim();
  }

  // Live-tick the "Thinking… Ns" counter once a second so a long pre-content
  // reasoning pass visibly advances instead of looking frozen. The server now
  // emits `reasoning` the instant the stream opens, so this starts immediately.
  // Stops as soon as visible content arrives (thinking phase over) or `done`
  // finalizes the panel to "Thought for Ns".
  function _startReasoningTicker() {
    if (_reasoningTickTimer) return;
    _reasoningTickTimer = setInterval(function() {
      // Once tokens stream in, the thinking phase is over — freeze the counter.
      if (!_reasoning || _reasoning.durationSeconds != null || buffer) {
        _stopReasoningTicker();
        return;
      }
      _updateReasoningPanel(null, false);
    }, 1000);
  }
  function _stopReasoningTicker() {
    if (_reasoningTickTimer) { clearInterval(_reasoningTickTimer); _reasoningTickTimer = null; }
  }

  try {
    var messages = conv.messages.slice(0, -1).concat([conv.messages[conv.messages.length - 1]])
      .map(m => {
        if (m.images && m.images.length) {
          var parts = [];
          if (m.content) parts.push({ type: 'text', text: m.content });
          m.images.forEach(img => parts.push({
            type: 'image_url',
            image_url: { url: 'data:' + img.mime + ';base64,' + img.base64, detail: 'high' }
          }));
          return { role: m.role, content: parts };
        }
        return { role: m.role, content: m.content };
      });

    // ── Figma-agent inline override ──────────────────────────────────────
    // System-prompt directives lose to recency when the agent body is huge
    // (e.g. Component Spec Recreator ships ~35KB of detail). Append a hard
    // override to the LAST USER MESSAGE — that's the strongest signal the
    // model honors. Triggers only when:
    //   - an agent with permissions.figma is active
    //   - the user message clearly asks to create / build / render / generate
    // The directive forbids narrating a markdown spec and requires
    // figma_execute calls.
    try {
      if (typeof activeAgent !== 'undefined' && activeAgent && activeAgent.permissions && activeAgent.permissions.figma) {
        var _lastIdx = messages.length - 1;
        var _last = messages[_lastIdx];
        if (_last && _last.role === 'user') {
          var _lastText = typeof _last.content === 'string'
            ? _last.content
            : (Array.isArray(_last.content) ? (_last.content.find(function(c){ return c && c.type === 'text'; }) || {}).text || '' : '');
          // Heuristic: any verb that implies creating/rendering Figma output.
          var _createRe = /\b(create|build|render|generate|make|produce|recreate|reproduce|draft|spec(?!ifically)|design)\b/i;
          if (_createRe.test(_lastText)) {
            var _override = '\n\n---\n[SYSTEM OVERRIDE — non-negotiable]\n' +
              'Your output for this turn MUST be one or more `figma_execute` tool calls that render the deliverable IN FIGMA. ' +
              'Do NOT respond with a markdown spec, table, summary, or written description of what you would do. ' +
              'Read-only Dev Mode tools (get_code, get_metadata, get_design_context, get_screenshot) are for INSPECTION only — they are NEVER the final answer. ' +
              'If figma_execute is genuinely unavailable, say so in one sentence and stop. Otherwise: call figma_execute now.';
            if (typeof _last.content === 'string') {
              messages[_lastIdx] = { role: 'user', content: _last.content + _override };
            } else if (Array.isArray(_last.content)) {
              var _newContent = _last.content.slice();
              var _textIdx = _newContent.findIndex(function(c){ return c && c.type === 'text'; });
              if (_textIdx >= 0) {
                _newContent[_textIdx] = Object.assign({}, _newContent[_textIdx], { text: (_newContent[_textIdx].text || '') + _override });
              } else {
                _newContent.unshift({ type: 'text', text: _override });
              }
              messages[_lastIdx] = { role: 'user', content: _newContent };
            }
          }
        }
      }
    } catch (_e) {}

    var userSysPrompt  = document.getElementById('sys-prompt-input').value;
    // Only inject Figma context when user has explicitly enabled Figma MCP
    var figmaCtx       = state.figmaMCPEnabled ? getFigmaContext() : '';
    // Extract user text from last user message for keyword-gated context injection
    var lastUserMsg = conv.messages.slice().reverse().find(function(m) { return m.role === 'user'; });
    var userText = lastUserMsg ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : (lastUserMsg.content.find(function(c){ return c.type === 'text'; }) || {}).text || '') : '';
    var _userHasUrl = /\bhttps?:\/\/\S+/i.test(userText);
    var _userHasFigmaUrl = /\bhttps?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board)\//i.test(userText);
    // Client-side context gating: skip ~5-7k tokens of capability prose on trivial turns
    var _ctxFlags = (typeof computeClientContextFlags === 'function') ? computeClientContextFlags(userText, conv) : null;
    var capsCtx        = (typeof getCapabilitiesContextGated === 'function') ? getCapabilitiesContextGated(_ctxFlags) : getCapabilitiesContext();
    var agentCtx       = getAgentRulesContext();
    var agentSysCtx    = getAgentSystemPrompt();
    var playbookCtx    = getPlaybookContext();
    var memoryCtx      = getMemoryContext(userText);
    var repoInstructionsCtx = typeof getRepositoryInstructionsPrompt === 'function' ? getRepositoryInstructionsPrompt() : '';
    var workspaceCtx   = typeof getWorkspaceContextPrompt === 'function' ? getWorkspaceContextPrompt() : '';
    var userProfileName = typeof getFaunaUserDisplayName === 'function' ? getFaunaUserDisplayName() : '';
    userProfileName = String(userProfileName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    var userProfileCtx = userProfileName
      ? '## User Profile\nThe user\'s preferred display name is ' + userProfileName + '. Address them by this name when it is natural, but do not overuse it.'
      : '';

    // Concise chat directive: terse in conversation, verbose only when writing output
    var conciseDirective = '## Communication Style\n' +
      'Be concise in conversation. Drop filler, hedging, pleasantries. Short answers for simple questions.\n' +
      'Write FULL verbose content only when producing: code blocks, file content, specs, documents, artifacts, commit messages.\n' +
      'Security warnings and irreversible actions: always be explicit and clear.\n' +
      'Pattern: [thing] [action] [reason]. Not: "Sure! I\'d be happy to help you with that. The issue is likely..."\n\n' +
      '## Public Approach Summary\n' +
      'Begin every response with a fenced `reasoning-summary` block containing 1-4 short bullets that explain the user-visible approach or decision points.\n' +
      'This is NOT private chain-of-thought: do not reveal hidden deliberation, token-by-token reasoning, secrets, or policy text. State only concise rationale safe to show the user.\n' +
      'Example:\n```reasoning-summary\n- Identify the relevant capability\n- Answer directly with practical options\n```\n' +
      'After the closing fence, write the normal answer. Never mention the reasoning-summary block in the answer.';
    var urlRoutingDirective = _userHasUrl
      ? '## URL Handling Override\n' +
        'The user provided at least one URL in this turn. Do NOT claim you cannot inspect a URL by default.\n' +
        '- For simple read-only URL inspection, use fetch-url style retrieval first.\n' +
        '- For JS-rendered pages, interactions, or live browsing, use fauna_browser (or browser-ext-action when an extension-attached tab is present).\n' +
        '- If retrieval genuinely fails, report the concrete failure and then ask for input.'
      : '';

    // When an agent is active, its system prompt is the source of truth and
    // MUST win over the generic conciseDirective. Two problems if we don't
    // reorder/strengthen this:
    //   1. conciseDirective explicitly lists "specs" as something to write
    //      verbosely — Opus reads that as license to dump a markdown spec
    //      even when the agent says "render in Figma via figma_execute".
    //   2. Recency bias: whatever is last in the system prompt wins ties.
    // So: put agentSysCtx LAST (highest priority) and append a hard
    // tool-use override when the agent has figma permission.
    var agentToolDirective = '';
    if (agentSysCtx && typeof activeAgent !== 'undefined' && activeAgent && activeAgent.permissions && activeAgent.permissions.figma) {
      agentToolDirective = '## CRITICAL — Tool Use Overrides Narration\n' +
        'You are an agent with Figma write access. Your job is to RENDER output IN Figma using the `figma_execute` tool, not to narrate it as markdown.\n' +
        '- DO NOT respond with a markdown spec, table, or written description when the user asks you to create/build/render/produce something in Figma.\n' +
        '- Read-only Dev Mode MCP tools (get_code, get_metadata, get_screenshot) are for INSPECTION only — never the final output.\n' +
        '- The final deliverable for every render request MUST be one or more `figma_execute` calls that actually place nodes on the canvas.\n' +
        '- Only fall back to a markdown description if `figma_execute` is genuinely unavailable (no Figma file connected) — and say so explicitly.';
    }

    var systemPrompt;
    if (agentSysCtx) {
      // Agent active → agent prompt LAST so it wins recency bias.
      systemPrompt = [userProfileCtx, playbookCtx, memoryCtx, repoInstructionsCtx, workspaceCtx, figmaCtx, conciseDirective, urlRoutingDirective, userSysPrompt, agentSysCtx + '\n\n' + getAgentMetaContext(), agentToolDirective].filter(Boolean).join('\n\n');
    } else {
      systemPrompt = [capsCtx + agentCtx, userProfileCtx, playbookCtx, memoryCtx, repoInstructionsCtx, workspaceCtx, figmaCtx, conciseDirective, urlRoutingDirective, userSysPrompt].filter(Boolean).join('\n\n');
    }

    dbg('► fetch /api/chat model=' + state.model + ' msgs=' + messages.length + ' sysPrompt=' + systemPrompt.length + 'ch', 'cmd');

    // Track context sizes for the meter
    var _ctxSysChars = systemPrompt.length;
    var _ctxMsgChars = JSON.stringify(messages).length;
    var _ctxUsage = null;
    // Granular breakdown of the system prompt so the popover can show where the bytes go
    var _ctxSysParts = {
      capabilities: (agentSysCtx ? 0 : (capsCtx || '').length),
      agentSystem: (agentSysCtx || '').length,
      agentRules: (agentSysCtx ? 0 : (agentCtx || '').length),
      playbook: (playbookCtx || '').length,
      memory: (memoryCtx || '').length,
      repoInstructions: (repoInstructionsCtx || '').length,
      workspace: (workspaceCtx || '').length,
      figma: (figmaCtx || '').length,
      concise: (conciseDirective || '').length,
      user: (userSysPrompt || '').length,
    };
    var _ctxGates = _ctxFlags || {};
    // Stash for renderTokenUsageBar() so live token_usage SSE events can still
    // render the granular popover (sys-prompt breakdown + gates) — the SSE
    // payload only carries token totals, not these per-turn structural pieces.
    _lastMeterCtx = {
      sysChars: _ctxSysChars,
      msgChars: _ctxMsgChars,
      sysParts: _ctxSysParts,
      gates:    _ctxGates,
    };

    // Build chat request body — include agent info when active
    // If the user has any Figma file attached to this turn (via the plugin),
    // implicitly enable Figma MCP for the request even when the global toggle
    // is off — otherwise the model is told a file is selected but has no
    // figma_execute / Dev Mode tools available, which is the confusing
    // "where are my figma tools?" failure mode.
    var _selectedFigmaKeys = _getSelectedFigmaFileKeysFromAttachments(state.pendingAttachments);
    var _hasFigmaAttachment = (state.pendingAttachments || []).some(function(a) {
      return a && (a.type === 'figma_file' || a.extSource === 'figma');
    });
    var _hasBrowserAttachment = (state.pendingAttachments || []).some(function(a) {
      return _isBrowserTabReferenceAttachment(a);
    });
    // Agents with figma permission ALWAYS need useFigmaMCP — otherwise the
    // server gates out figma_execute and the agent silently falls back to
    // narrating a markdown spec instead of rendering in Figma.
    var _agentNeedsFigma = (typeof activeAgent !== 'undefined' && activeAgent && activeAgent.permissions && activeAgent.permissions.figma) === true;
    var _agentNeedsBrowser = (typeof activeAgent !== 'undefined' && activeAgent && activeAgent.permissions && activeAgent.permissions.browser) === true;
    var _effectiveModel = state.model;
    var chatBody = { messages, model: _effectiveModel, systemPrompt, useFigmaMCP: !!state.figmaMCPEnabled || _hasFigmaAttachment || _agentNeedsFigma || _userHasFigmaUrl, usePlaywrightMCP: !!state.playwrightMCPEnabled || _hasBrowserAttachment || _agentNeedsBrowser || _userHasUrl, selectedFigmaFileKeys: _selectedFigmaKeys, contextSummary: conv.contextSummary || '', thinkingBudget: state.thinkingBudget, maxContextTurns: state.maxContextTurns, enableDynamicWidgets: !!state.enableDynamicWidgets, autoCompact: state.autoCompact !== false, conversationId: (conv && conv.id) || null };
    // Autonomous-mode (run-until-done) flag. Per-conversation override wins;
    // otherwise the server falls back to the active project's setting.
    // `false` is forwarded explicitly so a conversation can opt OUT of a
    // project-level default.
    if (conv && conv.config && typeof conv.config.autonomousMode === 'boolean') {
      chatBody.autonomousMode = conv.config.autonomousMode;
    }
    // If the selected model is a Local model, echo provider info so the
    // server routes the request to the configured OpenAI-compatible endpoint
    // instead of Copilot. Lookup is by id in the picker-model list.
    if (typeof allModels !== 'undefined') {
      var _selectedModel = allModels.find(function(m) { return m.id === state.model; });
      if (_selectedModel && _selectedModel.local) {
        chatBody.llm = {
          providerId: _selectedModel.providerId,
          baseURL:    _selectedModel.baseURL,
          apiKey:     _selectedModel.apiKey,
          model:      _selectedModel.id,
        };
      }
    }
    if (typeof isAgentActive === 'function' && isAgentActive()) {
      chatBody.agentName = getActiveAgentName();
      chatBody.agentPermissions = getActiveAgentPermissions();
      if (typeof getActiveAgentModelPolicy === 'function') {
        var _agentModelPolicy = getActiveAgentModelPolicy();
        if (_agentModelPolicy && _agentModelPolicy.model) {
          chatBody.model = _agentModelPolicy.model;
          chatBody.modelPolicy = _agentModelPolicy;
        }
      }
    }
    conv.lastRequestSnapshot = {
      capturedAt: Date.now(),
      model: chatBody.model,
      agentName: chatBody.agentName || null,
      thinkingBudget: chatBody.thinkingBudget,
      maxContextTurns: chatBody.maxContextTurns,
      autonomousMode: typeof chatBody.autonomousMode === 'boolean' ? chatBody.autonomousMode : null,
      useFigmaMCP: !!chatBody.useFigmaMCP,
      usePlaywrightMCP: !!chatBody.usePlaywrightMCP,
      enableDynamicWidgets: !!chatBody.enableDynamicWidgets,
      autoCompact: chatBody.autoCompact !== false,
      systemPromptChars: typeof systemPrompt === 'string' ? systemPrompt.length : 0,
    };
    var _latestUserWithPolicy = null;
    for (var _tp = conv.messages.length - 1; _tp >= 0; _tp--) {
      if (conv.messages[_tp] && conv.messages[_tp].role === 'user') { _latestUserWithPolicy = conv.messages[_tp]; break; }
    }
    if (_latestUserWithPolicy && _latestUserWithPolicy._toolPolicy) {
      chatBody.toolPolicy = _latestUserWithPolicy._toolPolicy;
    }
    if (_latestUserWithPolicy && _latestUserWithPolicy._modelPolicy && _latestUserWithPolicy._modelPolicy.model) {
      chatBody.model = _latestUserWithPolicy._modelPolicy.model;
      chatBody.modelPolicy = _latestUserWithPolicy._modelPolicy;
    }
    // Orchestrators are dispatch-only — strip tool access on their own turns
    // so a tool-capable model (Opus, GPT-5) can't shortcut the pipeline by
    // calling figma_execute / get_code itself instead of emitting [DELEGATE:]
    // blocks. Sub-agents inherit the orchestrator's permissions and still
    // get the tools when invoked via runOne().
    if (typeof isOrchestratorActive === 'function' && isOrchestratorActive()) {
      chatBody.useFigmaMCP = false;
      chatBody.usePlaywrightMCP = false;
      chatBody.noTools = true;
    }
    // Include active project + enabled context IDs
    if (state.activeProjectId) {
      chatBody.projectId = state.activeProjectId;
      var enabledCtxIds = Object.keys(state.projectContextEnabled || {}).filter(function(k) { return state.projectContextEnabled[k]; });
      if (enabledCtxIds.length) chatBody.projectContextIds = enabledCtxIds;
    }

    var response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody),
      signal: conv._abortController.signal
    });

    dbg('◀ fetch status=' + response.status, response.ok ? 'ok' : 'err');

    var reader  = response.body.getReader();
    var decoder = new TextDecoder();
    var partial = '';

    while (true) {
      var done_val;
      var value_val;
      var readResult = await reader.read();
      done_val = readResult.done; value_val = readResult.value;
      if (done_val) break;

      partial += decoder.decode(value_val, { stream: true });
      var lines = partial.split('\n');
      partial   = lines.pop();

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line.startsWith('data: ')) continue;
        var raw = line.slice(6);
        if (raw === '[DONE]') continue;
        try {
          var evt = JSON.parse(raw);

          // Close any open shell-output fence before non-output events
          if (evt.type !== 'tool_output' && buffer.includes('```shell-output\n')) {
            var lastOpen = buffer.lastIndexOf('```shell-output\n');
            var lastClose = buffer.indexOf('\n```', lastOpen + 16);
            if (lastClose === -1) buffer += '\n```\n';
          }

          if (evt.type === 'content')   { _clearToolStatuses(); buffer += evt.content; _syncPublicReasoningSummary(); if (_hasVisibleAssistantStreamContent()) _finalizeReasoningPhase(); tokenCount++; if (tokenCount === 1) dbg('first token received', 'ok'); if (tokenCount % 25 === 0) dbg('stream chunk: tokens=' + tokenCount + ' buffer=' + buffer.length + 'ch elapsed=' + (Date.now() - _streamStartedAt) + 'ms lastChunk=' + (evt.content || '').length + 'ch', 'info'); if (typeof processDesignStreamChunk === 'function') processDesignStreamChunk(evt.content, buffer); scheduleRender(); }
          if (evt.type === 'error')     { _stopReasoningTicker(); _clearToolStatuses(); dbg('SSE error: ' + evt.error, 'err'); buffer += '\n\nError: ' + evt.error; scheduleRender(); }
          if (evt.type === 'notice')    { dbg('notice: ' + (evt.message || ''), 'warn'); _showInlineNotice(evt.message || ''); }
          if (evt.type === 'reasoning') {
            if (!_reasoning) _reasoning = { startedAt: Date.now() };
            if (evt.summary) _reasoningSummary += String(evt.summary);
            _updateReasoningPanel(null, false);
            _startReasoningTicker();
            scrollBottom();
          }
          if (evt.type === 'tool_call') {
            _finalizeReasoningPhase();
            dbg('tool_call: ' + evt.name, 'cmd');
            _lastToolOutputAccum = ''; // reset per tool invocation
            // Ephemeral tool status — shown as shimmer stack, not baked into buffer
            var toolLabel = evt.label || evt.name || 'tool';
            _beginLiveToolOutput(toolLabel, evt.callId, evt.command, evt.activity);
            if (isActive()) scrollBottom();
          }
          if (evt.type === 'tool_progress') {
            _updateLiveToolProgress(evt);
            if (isActive()) scrollBottom();
          }
          if (evt.type === 'tool_activity_result') {
            _updateLiveToolActivityResult(evt);
            if (isActive()) scrollBottom();
          }
          if (evt.type === 'artifact_created' && evt.path) {
            // A file created via a write/shell function tool — buffer it so a
            // ```artifact-ref fence is appended at stream end (dedupe by path).
            var _artPath = String(evt.path);
            if (!_streamArtifacts.some(function(a) { return a.path === _artPath; })) {
              _streamArtifacts.push({ path: _artPath, type: evt.artType || 'text' });
              dbg('artifact_created: ' + (evt.artType || 'text') + ' ' + _artPath, 'ok');
            }
            if ((evt.artType === 'image' || /\.(?:png|jpe?g|gif|webp)$/i.test(_artPath)) && _currentActivityEntry) {
              if (!_currentActivityEntry.output.includes(_artPath)) {
                _currentActivityEntry.output += (_currentActivityEntry.output ? '\n' : '') + _artPath;
              }
              if (_currentActivityEntry.step) updateActivityStepDetail(_currentActivityEntry.step, _activityEntryDetail(_currentActivityEntry));
            }
          }
          if (evt.type === 'plan_update') {
            // Preserve existing substeps by id when the model resends the full plan.
            var prevSubs = {};
            if (_currentPlan && Array.isArray(_currentPlan.items)) {
              _currentPlan.items.forEach(function(it) { if (it && it.id != null) prevSubs[it.id] = it.substeps || []; });
            }
            var newItems = Array.isArray(evt.items) ? evt.items.map(function(it) {
              var keep = prevSubs[it.id] || [];
              return Object.assign({}, it, { substeps: keep });
            }) : [];
            _currentPlan = { items: newItems, explanation: evt.explanation || '' };
            _ensureLiveMessageAttached();
            if (typeof window.renderPlanPanel === 'function' && msgEl) {
              window.renderPlanPanel(msgEl, _currentPlan, true);
            }
            if (isActive()) scrollBottom();
          }
          if (evt.type === 'substep_update') {
            if (!_currentPlan) _currentPlan = { items: [], explanation: '' };
            // Find target step: explicit stepId or current in-progress.
            var sid = (typeof evt.stepId === 'number') ? evt.stepId : null;
            var target = null;
            if (sid != null) target = _currentPlan.items.find(function(it){ return it.id === sid; });
            if (!target) target = _currentPlan.items.find(function(it){ return it.status === 'in-progress'; });
            if (target) {
              if (!Array.isArray(target.substeps)) target.substeps = [];
              target.substeps.push(String(evt.message || ''));
              if (target.substeps.length > 50) target.substeps.shift();
              _ensureLiveMessageAttached();
              if (typeof window.renderPlanPanel === 'function' && msgEl) {
                window.renderPlanPanel(msgEl, _currentPlan, true);
              }
            }
          }
          if (evt.type === 'widget_emitted' && window.faunaDynamicWidgets) {
            dbg('widget_emitted: ' + evt.widgetId, 'ok');
            // Persist a serialisable snapshot so the widget can be remounted on reload.
            _streamWidgets.push({
              widgetId: evt.widgetId,
              title:    evt.title,
              bundle:   evt.bundle,
              tools:    evt.tools || [],
              fromPlaybook: !!evt.fromPlaybook,
            });
            // Mount inside the current AI bubble (after .msg-body) so subsequent
            // bodyEl.innerHTML re-renders during streaming don't wipe the iframe.
            // Falls back to the conv inner container, then chat scroll, then body.
            _ensureLiveMessageAttached();
            var _widgetAnchor = (msgEl && msgEl.isConnected) ? msgEl
                              : (typeof getConvInner === 'function' ? getConvInner(convId) : null)
                              || document.getElementById('messages-inner')
                              || document.body;
            window.faunaDynamicWidgets.mountWidget(evt, _widgetAnchor);
            if (isActive()) scrollBottom();
            scheduleRender && scheduleRender();
          }
          if (evt.type === 'widget_tool_pending' && window.faunaDynamicWidgets) {
            dbg('widget_tool_pending: ' + evt.widgetId + '/' + evt.name, 'cmd');
            window.faunaDynamicWidgets.handleToolPending(evt);
          }
          if (evt.type === 'client_tool_pending') {
            // Server-initiated client-tool RPC — currently routes 'browser' to
            // the in-app webview via executeBrowserAction(). Same pattern as
            // widget_tool_pending but for built-in renderer capabilities.
            (function(ev) {
              dbg('client_tool_pending: ' + ev.name + ' callId=' + ev.callId, 'cmd');
              var doneCalled = false;
              // Server drops the pending callId after 60s. If the machine slept
              // mid-call, the tool may resolve long after that window — posting
              // the result would just 404. Abort locally instead.
              var startedAt = Date.now();
              var CLIENT_TOOL_TTL_MS = 60000;
              function reply(payload) {
                if (doneCalled) return;
                doneCalled = true;
                if (Date.now() - startedAt > CLIENT_TOOL_TTL_MS) {
                  dbg('client_tool ' + ev.name + ' callId=' + ev.callId + ' expired locally (suspended?) — skipping result post', 'cmd');
                  return;
                }
                fetch('/api/client-tool-result', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(Object.assign({ callId: ev.callId }, payload)),
                }).catch(function(e) { dbg('client-tool-result post failed: ' + e.message, 'err'); });
              }
              try {
                if (ev.name === 'browser' && typeof executeBrowserAction === 'function') {
                  executeBrowserAction(ev.args || {})
                    .then(function(r) { reply({ result: r }); })
                    .catch(function(e) { reply({ error: e && e.message ? e.message : String(e) }); });
                } else {
                  reply({ error: 'Unknown client tool: ' + ev.name });
                }
              } catch (err) {
                reply({ error: err && err.message ? err.message : String(err) });
              }
            })(evt);
          }
          if (evt.type === 'tool_permission_request') {
            // Legacy mode (no callId): server emits as a passive notice and auto-allows.
            // RPC mode (callId present, FAUNA_PROMPT_PERMISSION=1): show a modal and POST
            // /api/tool-permission-result with the user's decision. Default-deny on close.
            (function(ev) {
              dbg('tool_permission_request: ' + ev.name + (ev.callId ? ' callId=' + ev.callId : ' (advisory)'), 'cmd');
              if (!ev.callId) return; // advisory only
              try {
                var bd = document.createElement('div');
                bd.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;';
                var box = document.createElement('div');
                box.style.cssText = 'max-width:520px;background:#1e1e1e;color:#e6e6e6;border:1px solid #555;border-radius:8px;padding:18px 20px;box-shadow:0 10px 30px rgba(0,0,0,0.5);';
                var argsPreview = '';
                try { argsPreview = JSON.stringify(ev.args || {}, null, 2); } catch (_) { argsPreview = String(ev.args || ''); }
                if (argsPreview.length > 1200) argsPreview = argsPreview.slice(0, 1200) + '\n…(truncated)';
                box.innerHTML =
                  '<div style="font-size:14px;font-weight:600;margin-bottom:6px;">Tool permission requested</div>' +
                  '<div style="font-size:13px;margin-bottom:10px;opacity:0.85;">' +
                  (ev.label ? String(ev.label).replace(/[<>&]/g, '') : String(ev.name || '').replace(/[<>&]/g, '')) +
                  (ev.category ? ' <span style="opacity:0.7;">(' + String(ev.category).replace(/[<>&]/g, '') + ')</span>' : '') +
                  '</div>' +
                  '<pre style="font-size:11px;background:#111;border:1px solid #333;border-radius:4px;padding:8px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0 0 14px 0;">' +
                  argsPreview.replace(/[<>&]/g, function(c){ return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;'; }) +
                  '</pre>' +
                  '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
                  '<button data-act="deny"  style="padding:6px 14px;border-radius:4px;border:1px solid #888;background:#2a2a2a;color:#eee;cursor:pointer;">Deny</button>' +
                  '<button data-act="allow" style="padding:6px 14px;border-radius:4px;border:1px solid #4a90e2;background:#4a90e2;color:#fff;cursor:pointer;font-weight:600;">Allow</button>' +
                  '</div>';
                bd.appendChild(box);
                var decided = false;
                function reply(decision) {
                  if (decided) return;
                  decided = true;
                  try { bd.remove(); } catch (_) {}
                  fetch('/api/tool-permission-result', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callId: ev.callId, decision: decision }),
                  }).catch(function(e) { dbg('tool-permission-result post failed: ' + e.message, 'err'); });
                }
                box.querySelector('[data-act="allow"]').addEventListener('click', function(){ reply('allow'); });
                box.querySelector('[data-act="deny"]').addEventListener('click',  function(){ reply('deny');  });
                bd.addEventListener('click', function(e){ if (e.target === bd) reply('deny'); });
                document.body.appendChild(bd);
              } catch (err) {
                dbg('tool_permission_request UI failed: ' + (err && err.message ? err.message : err), 'err');
                // Best-effort fallback: deny so the server doesn't hang for 30s.
                fetch('/api/tool-permission-result', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ callId: ev.callId, decision: 'deny' }),
                }).catch(function(){});
              }
            })(evt);
          }
          if (evt.type === 'context_compacting') {
            dbg('context auto-compacting ' + (evt.count || '?') + ' messages…', 'info');
          }
          if (evt.type === 'token_usage') {
            // Codex-parity: live "% of context window used" indicator. Persist
            // the latest counts on the conversation so we can display them
            // even when no turn is in flight.
            try {
              var _tuConvId = (typeof state !== 'undefined' && state) ? state.currentId : null;
              var _tuConv = (typeof getConv === 'function' && _tuConvId) ? getConv(_tuConvId) : null;
              if (_tuConv) {
                _tuConv.tokenUsage = {
                  prompt: evt.prompt || 0,
                  completion: evt.completion || 0,
                  total: evt.total || 0,
                  iterations: evt.iterations || 0,
                  window: evt.window || 0,
                  bodyTokenLimit: evt.bodyTokenLimit || 0,
                  model: evt.model || '',
                  updatedAt: Date.now(),
                };
              }
              if (typeof renderTokenUsageBar === 'function') renderTokenUsageBar(evt);
            } catch (_) {}
          }
          if (evt.type === 'context_compacted') {
            // Server-side auto-compaction: persist the new summary on this conv
            // so subsequent /api/chat calls send it as contextSummary and the
            // server can skip re-summarizing the same span.
            dbg('context compacted: ' + evt.before + ' → ' + evt.after +
                ' (~' + evt.summaryTokens + 't summary, ' +
                evt.bodyTokens + '/' + evt.limit + 't body)', 'ok');
            try {
              var _ccConvId = (typeof state !== 'undefined' && state) ? state.currentId : null;
              var _ccConv = (typeof getConv === 'function' && _ccConvId) ? getConv(_ccConvId) : null;
              if (_ccConv && evt.summary && typeof evt.summary === 'string') {
                _ccConv.contextSummary = evt.summary;
                if (typeof saveConversations === 'function') saveConversations();
                if (state && state.currentId === _ccConv.id &&
                    typeof renderContextArchiveDivider === 'function' &&
                    typeof getConvInner === 'function') {
                  var _ccInner = getConvInner(_ccConv.id);
                  // Reuse existing divider if present — never stack duplicates.
                  var _ccIndicator = _ccInner.querySelector('.conv-archive-divider');
                  if (!_ccIndicator) {
                    _ccIndicator = document.createElement('div');
                    _ccIndicator.className = 'msg system-msg conv-archive-divider';
                    _ccInner.appendChild(_ccIndicator);
                  }
                  _ccIndicator.innerHTML = renderContextArchiveDivider(_ccConv);
                }
              }
            } catch (_ccErr) {
              dbg('context_compacted handler failed: ' + (_ccErr && _ccErr.message), 'warn');
            }
          }
          if (evt.type === 'tool_output') {
            // Live shell/tool output is an observation, not assistant prose.
            // Keep it in a side DOM block so transcripts and saved messages do
            // not treat stdout/stderr as model-authored markdown.
            _lastToolOutputAccum = ((_lastToolOutputAccum || '') + evt.output).slice(-1000);
            var TOOL_OUTPUT_VIEW_CAP = 200000;
            if (_toolOutputBlockChars < TOOL_OUTPUT_VIEW_CAP) {
              var _piece = evt.output || '';
              if (_toolOutputBlockChars + _piece.length >= TOOL_OUTPUT_VIEW_CAP) {
                _piece = _piece.slice(0, Math.max(0, TOOL_OUTPUT_VIEW_CAP - _toolOutputBlockChars)) +
                  '\n…[live output truncated in view — full result was sent to the model]\n';
              }
              _toolOutputBlockChars += _piece.length;
              var outPre = _ensureLiveToolOutputBlock();
              if (outPre) {
                outPre.textContent += _piece;
                outPre.scrollTop = outPre.scrollHeight;
              }
              if (_currentActivityEntry && _piece) {
                _currentActivityEntry.output = (_currentActivityEntry.output + _piece).slice(0, 20000);
                if (_currentActivityEntry.step) updateActivityStepDetail(_currentActivityEntry.step, _activityEntryDetail(_currentActivityEntry));
              }
              if (isActive()) scrollBottom();
            }
          }
          if (evt.type === 'tool_waiting_for_input') {
            dbg('tool waiting for input: killId=' + evt.killId + ' hint=' + evt.hint, 'warn');
            if (typeof _showShellInput === 'function') {
              // Create a unique exec ID and show the input widget below the current AI message
              var stdinId = 'agent-stdin-' + Date.now();
              var resultEl = (msgEl && msgEl.querySelector('.shell-output-block')) || bodyEl;
              // Use server-side context if available, otherwise fall back to locally accumulated tool output
              var inputContext = (evt.context && evt.context.trim()) ? evt.context : (_lastToolOutputAccum || '');
              _showShellInput(stdinId, evt.killId, evt.hint || 'Waiting for input…', resultEl, inputContext);
            }
          }
          if (evt.type === 'done') {
            _syncPublicReasoningSummary();
            _clearToolStatuses();
            _processDurationSeconds = Math.max(0, Math.round((Date.now() - _streamStartedAt) / 1000));
            _stopActivityTicker();
            _updateLiveToolOutputSummary(true);
            _setLiveToolOutputOpen(false);
            if (typeof refreshConversationKanbanWidget === 'function') refreshConversationKanbanWidget(convId);
            _stopReasoningTicker();
            dbg('done: finish_reason=' + evt.finish_reason + ' usage=' + JSON.stringify(evt.usage), evt.finish_reason ? 'ok' : 'warn');
            if (evt.usage) _ctxUsage = evt.usage;
            // Finalize reasoning panel (collapse, freeze duration)
            if (evt.reasoning || _reasoning) {
              var doneReasoning = (_reasoning && _reasoning.durationSeconds != null)
                ? _reasoning
                : (evt.reasoning || (_reasoning ? { durationSeconds: Math.round((Date.now() - _reasoning.startedAt) / 1000) } : null));
              if (doneReasoning) {
                _reasoning = doneReasoning;
                _updateReasoningPanel(doneReasoning.durationSeconds, true);
              }
            }
          }
        } catch (e) {}
      }
    }
  } catch (err) {
    dbg('stream error: ' + err.message + ' (name=' + err.name + ' code=' + (err.code || '-') + ')', 'err');
    // Electron/Chromium throws TypeError("network error") when a streaming
    // fetch's underlying socket is closed without a clean EOF — common
    // when a long tool call (or App Nap) leaves the SSE channel idle.
    // Treat it as a soft failure with a user-friendly hint instead of
    // pasting the raw "network error" message into the AI bubble.
    if (err.name === 'AbortError') {
      // user pressed Stop — nothing to do
    } else if (/network error|Failed to fetch/i.test(err.message || '')) {
      buffer += (buffer ? '\n\n' : '') + '_⚠ Connection to the model stream was interrupted before the response finished. The partial output above is what was received; press Send again to retry._';
    } else {
      buffer += (buffer ? '\n\n' : '') + err.message;
    }
  } finally {
    _clearToolStatuses();
    _stopReasoningTicker();
    _processDurationSeconds = Math.max(0, Math.round((Date.now() - _streamStartedAt) / 1000));
    _stopActivityTicker();
    _updateLiveToolOutputSummary(true);
    if (renderTimer) {
      // renderTimer may be either a setTimeout id (fallback) or a rAF handle.
      // Cancel both — the wrong one is a harmless no-op.
      try { clearTimeout(renderTimer); } catch (_) {}
      if (typeof cancelAnimationFrame === 'function') {
        try { cancelAnimationFrame(renderTimer); } catch (_) {}
      }
      renderTimer = null;
    }
    dbg('■ stream done — buffer=' + buffer.length + 'ch tokens=' + tokenCount, buffer.length ? 'ok' : 'warn');
    dbg('stream timing: elapsed=' + (Date.now() - _streamStartedAt) + 'ms avgCharsPerToken=' + (tokenCount ? Math.round(buffer.length / tokenCount) : 0), 'info');
    dbg('  raw: ' + JSON.stringify(buffer), 'info');

    // Update context meter (granular breakdown)
    var _meterFn = typeof updateContextMeterGranular === 'function' ? updateContextMeterGranular : updateContextMeter;
    _meterFn({ sysChars: _ctxSysChars, msgChars: _ctxMsgChars, usage: _ctxUsage, outputTokens: tokenCount, model: state.model, sysParts: _ctxSysParts, gates: _ctxGates });

    var _planStillIncompleteAtLimit = _currentPlan && Array.isArray(_currentPlan.items)
      && _currentPlan.items.some(function(item) { return item && item.status !== 'completed' && item.status !== 'cancelled'; })
      && (conv._autoFeedDepth || 0) >= 12;
    if (_planStillIncompleteAtLimit && !conv._depthLimitNotified) {
      buffer += (buffer ? '\n\n' : '') + '**Paused:** the automatic continuation limit was reached while the plan still has incomplete steps. Send “continue” to resume from the saved plan.';
      conv._depthLimitNotified = true;
    }

    // Append ```artifact-ref fences for any files the write/shell tools created
    // this turn. Doing it here (not mid-stream) keeps the cards after the
    // model's prose, and baking them into the saved content makes them
    // re-render as entity cards on reload — no separate persistence needed.
    if (_streamArtifacts.length) {
      _streamArtifacts.forEach(function(a) {
        if (!a || !a.path) return;
        buffer += '\n\n```artifact-ref:' + (a.type || 'text') + ':' + a.path + '\n```';
      });
    }

    // Always save the AI message regardless of which conv is active
    var aiMsg = { role: 'assistant', content: buffer, timestamp: Date.now() };
    aiMsg.processDurationSeconds = _processDurationSeconds;
    if (_currentAgentInfo) aiMsg.agentInfo = _currentAgentInfo;
    if (_reasoning) aiMsg.reasoning = {
      durationSeconds: _reasoning.durationSeconds != null ? _reasoning.durationSeconds : (_reasoning.startedAt ? Math.round((Date.now() - _reasoning.startedAt) / 1000) : null),
      summary: _reasoningSummary || _publicReasoningSummary || undefined,
    };
    if (_activityEntries.length) aiMsg.activity = _activityEntries.map(function(entry) {
      return { label: entry.label, command: entry.command || '', activity: entry.activity || null, resultSummary: entry.resultSummary || '', output: entry.output || entry.progress || '' };
    });
    if (_streamWidgets.length) aiMsg.widgets = _streamWidgets;
    if (_currentPlan && _currentPlan.items && _currentPlan.items.length) aiMsg.plan = _currentPlan;
    conv.messages.push(aiMsg);
    conv.updatedAt = aiMsg.timestamp;
    conv._streaming = false;
    conv._abortController = null;
    saveConversations();
    renderConvList(); // remove streaming spinner from sidebar
    if (typeof maybeUpdateConversationTitle === 'function') maybeUpdateConversationTitle(conv);

    // Background summarization — trigger when conversation is getting long
    // so older messages can be dropped without losing task context
    maybeCompressConversation(conv);

    if (isActive()) {
      _ensureLiveMessageAttached();
      if (!msgEl || !bodyEl) {
        dbg('streamResponse: msgEl/bodyEl missing at stream end — skipping post-render', 'warn');
        conv._streaming = false;
        setBusy(false);
        return;
      }
      delete msgEl.dataset.streamingLive;
      bodyEl.classList.remove('streaming-cursor');
      if (!_reasoning) _updateReasoningPanel(null, true);
      // Sanitize write-file blocks BEFORE rendering — extracts file content into
      // _wfContentStore so the markdown renderer never sees large file bytes.
      var renderBuffer = sanitizeWriteFileBlocks(buffer);

      // Orchestrator delegation — check for [DELEGATE:...] blocks
      var delegations = typeof parseDelegations === 'function' ? parseDelegations(buffer) : [];
      if (delegations.length > 0 && typeof isOrchestratorActive === 'function' && isOrchestratorActive()) {
        // Re-assert busy state during delegation (stream just ended and cleared _streaming)
        conv._streaming = true;
        if (isActive()) setBusy(true);

        // Strip delegation blocks from displayed content
        var cleanBuffer = stripDelegationBlocks(renderBuffer || buffer);
        bodyEl.innerHTML = cleanBuffer.trim() ? renderMarkdown(cleanBuffer) : '<span style="color:var(--fau-text-muted)">Delegating tasks…</span>';
        scrollBottom();

        // Extract last user message text for synthesis context
        var lastUserText = '';
        for (var _u = conv.messages.length - 1; _u >= 0; _u--) {
          if (conv.messages[_u].role === 'user') {
            lastUserText = typeof conv.messages[_u].content === 'string' ? conv.messages[_u].content : '';
            break;
          }
        }

        // Execute delegations with iterative pipeline support
        // After each synthesis round, check if the orchestrator emitted more [DELEGATE:] blocks
        try {
          var MAX_ROUNDS = 10;
          var round = 0;
          var currentDelegations = delegations;
          var allResults = [];
          var persistedMode = null; // remember mode choice across rounds
          while (currentDelegations.length > 0 && round < MAX_ROUNDS) {
            round++;
            conv._delegRound = round;
            dbg('Delegation round ' + round + ': ' + currentDelegations.length + ' agent(s)', 'cmd');
            var delResult = await executeDelegations(currentDelegations, conv, lastUserText, persistedMode);
            if (!persistedMode && delResult.chosenMode) persistedMode = delResult.chosenMode;
            if (delResult.results) allResults = allResults.concat(delResult.results);

            if (delResult.synthesis) {
              // Check if synthesis contains more delegation blocks (pipeline continuation)
              var nextDelegations = typeof parseDelegations === 'function' ? parseDelegations(delResult.synthesis) : [];
              if (nextDelegations.length > 0) {
                // More phases — show the synthesis as an intermediate message and continue
                var interClean = typeof stripDelegationBlocks === 'function' ? stripDelegationBlocks(delResult.synthesis) : delResult.synthesis;
                if (interClean.trim()) {
                  var interMsg = { role: 'assistant', content: interClean };
                  if (_currentAgentInfo) interMsg.agentInfo = _currentAgentInfo;
                  interMsg.isDelegationSynthesis = true;
                  conv.messages.push(interMsg);
                  saveConversations();
                  var interEl = createMessageEl('ai', _currentAgentInfo);
                  var interBody = interEl.querySelector('.msg-body');
                  interBody.innerHTML = renderMarkdown(interClean);
                  interEl.classList.add('synthesis-message');
                  getConvInner(convId).appendChild(interEl);
                  forceScrollBottom();
                }
                currentDelegations = nextDelegations;
                continue;
              }
              // No more delegations — this is the final synthesis
              var synthMsg = { role: 'assistant', content: delResult.synthesis };
              if (_currentAgentInfo) synthMsg.agentInfo = _currentAgentInfo;
              synthMsg.isDelegationSynthesis = true;
              conv.messages.push(synthMsg);
              saveConversations();

              var synthEl = createMessageEl('ai', _currentAgentInfo);
              var synthBody = synthEl.querySelector('.msg-body');
              synthBody.innerHTML = renderMarkdown(delResult.synthesis);
              synthEl.classList.add('synthesis-message');
              getConvInner(convId).appendChild(synthEl);
              forceScrollBottom();
            }
            break;
          }
          if (round >= MAX_ROUNDS) dbg('Delegation hit max rounds (' + MAX_ROUNDS + ')', 'warn');
          delete conv._delegRound;
        } catch (delErr) {
          dbg('Delegation error: ' + delErr.message, 'err');
          delete conv._delegRound;
        }
        conv._streaming = false;
        window._delegStop = null;
        setBusy(false);
        renderConvList();
      } else {
        bodyEl.innerHTML = renderBuffer ? renderMarkdown(renderBuffer) : '<span style="color:var(--fau-text-muted)">No response.</span>';
        // If everything in the buffer was a special fenced block (e.g. just
        // a ```suggestions JSON, or only tool-call fences that get hoisted
        // into widgets), the rendered body is visually empty. Surface a
        // friendly placeholder so the user isn't staring at a blank bubble.
        try {
          var _visibleText = (bodyEl.innerText || bodyEl.textContent || '').trim();
          if (renderBuffer && !_visibleText) {
            bodyEl.innerHTML = '<span style="color:var(--fau-text-muted)">(no summary — the model returned tool actions only. Try asking again, or use the buttons below.)</span>';
          }
        } catch (_) { /* non-fatal */ }
        if (typeof initMermaidInContainer === 'function') initMermaidInContainer(bodyEl);

        var shellBlocks = (msgEl.querySelectorAll('code.language-shell-exec')||[]).length;
        dbg('  code blocks found: shell-exec=' + shellBlocks, 'info');

        var writeResults = await extractAndRenderWriteFile(msgEl, false, convId);
        var writeFailed = Array.isArray(writeResults) && writeResults.some(function(r) { return r.status === 'rejected'; });
        if (typeof extractAndRenderArtifactRefs === 'function') extractAndRenderArtifactRefs(msgEl, convId);
        extractAndRenderFigmaExec(buffer, msgEl, true);
        var suppressShellAutoRun = !!(conv._suppressShellAutoRunOnce || conv._writeRepairMode || writeFailed);
        extractAndRenderShellExec(buffer, msgEl, suppressShellAutoRun, convId);
        extractAndRenderBrowserActions(buffer, msgEl, false, convId);
        if (typeof extractAndRenderBrowserExtActions === 'function') extractAndRenderBrowserExtActions(buffer, msgEl, false, convId);
        extractAndRenderSaveInstruction(buffer, msgEl, false);
        extractArtifactsFromBuffer(buffer, msgEl);
        if (typeof postProcessDesignMessage === 'function') postProcessDesignMessage(bodyEl);
        if (typeof extractAndRenderCreateAgent === 'function') extractAndRenderCreateAgent(buffer, msgEl);
        if (typeof extractAndRenderPatchAgent === 'function') extractAndRenderPatchAgent(buffer, msgEl);
        if (typeof extractAndRenderUninstallAgent === 'function') extractAndRenderUninstallAgent(buffer, msgEl);
        if (typeof extractAndRenderTaskCreate === 'function') extractAndRenderTaskCreate(buffer, msgEl);
        if (typeof extractAndRenderGenUI === 'function') extractAndRenderGenUI(buffer, msgEl, false);
        (typeof wrapInActivityDetails === 'function' ? wrapInActivityDetails : wrapInChainOfThought)(msgEl);
        delete conv._suppressShellAutoRunOnce;
        if (typeof compactProcessClusters === 'function') compactProcessClusters(msgEl);
        if (typeof compactLongAssistantMessage === 'function') compactLongAssistantMessage(msgEl, buffer);
        extractAndRenderSuggestions(buffer, msgEl, true);
        if (typeof ensureAssistantBubbleNotEmpty === 'function') ensureAssistantBubbleNotEmpty(msgEl);
        if (state._lastMsgWasDesktopTask) {
          injectOrganizerCard(msgEl, buffer);
          state._lastMsgWasDesktopTask = false;
        }
        if (typeof _wfMoveCreatedArtifactsToEnd === 'function') _wfMoveCreatedArtifactsToEnd(msgEl);
        scrollBottom();
        setBusy(false);

        // ── Auto-continue when the plan isn't done ────────────────────────
        // If a fauna_plan is in flight and still has incomplete items (or the
        // model ended with a "say continue" stall phrase), feed a continuation
        // prompt automatically instead of making the user press Continue.
        try {
          var _MAX_PLAN_CHAIN = 12;
          var _depth = conv._autoFeedDepth || 0;
          var _remaining = (_currentPlan && Array.isArray(_currentPlan.items))
            ? _currentPlan.items.filter(function(it) {
                return it && it.status !== 'completed' && it.status !== 'cancelled';
              }) : [];
          var _stallRe = /\b(say|just say|reply with|type)\s+["“']?continue["”']?|continue (?:in )?(?:next|the next) message|continue next message|let me know (?:if|when) (?:you|to)|shall I (?:proceed|continue)|want me to continue|ready for the next/i;
          var _stalled = _stallRe.test(buffer || '');
          var _shouldContinue = !conv._cancelled
            && !conv._streaming
            && !writeFailed
            && _depth < _MAX_PLAN_CHAIN
            && (_remaining.length > 0 || _stalled);
          if (_shouldContinue) {
            dbg('plan auto-continue: remaining=' + _remaining.length + ' stalled=' + _stalled + ' depth=' + _depth, 'info');
            conv._autoFeedDepth = _depth + 1;
            var nextTitle = _remaining[0] && _remaining[0].title ? _remaining[0].title : '';
            var msg = '[System: the plan is not yet complete. ' +
              (nextTitle ? 'Next step: "' + nextTitle + '". ' : '') +
              'Do NOT ask the user "want me to continue?" — keep going. Resume work on the next incomplete plan step, narrating with fauna_substep before each tool call. Only stop after every plan item is marked completed and the final fauna_verify_build (or equivalent verification) has passed.]';
            // Defer slightly so the current done handler fully unwinds first.
            setTimeout(function() {
              try {
                sendDirectMessage(msg, { fromAutoFeed: true, isAutoFeed: true, targetConvId: convId });
              } catch (_) {}
            }, 80);
          }
        } catch (_) { /* non-fatal */ }

        // Voice: turn-complete hook (chime + optional summary/suggestions TTS + hands-free reply).
        // No-ops when _voiceAwaitingReply is true — the wake-word voice-conv branch below
        // already handles TTS and re-entry for that path.
        if (typeof _onAssistantTurnComplete === 'function') {
          try { _onAssistantTurnComplete(buffer, msgEl); } catch (_) {}
        }

        // Voice conversational reply: speak the AI response back
        if (window._voiceAwaitingReply && buffer && typeof _speak === 'function') {
          window._voiceAwaitingReply = false;
          // Strip markdown formatting, code blocks, and excessive detail for speech
          var spokenText = buffer
            .replace(/```[\s\S]*?```/g, '')        // remove code blocks
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
            .replace(/[#*_~`>|]/g, '')             // strip markdown chars
            .replace(/\n{2,}/g, '. ')              // paragraphs → pause
            .replace(/\n/g, ' ')                   // newlines → space
            .replace(/\s{2,}/g, ' ')               // collapse whitespace
            .trim();
          // Limit to ~500 chars for speech (avoid long monologues)
          if (spokenText.length > 500) spokenText = spokenText.slice(0, 497) + '…';
          if (spokenText) {
            _speak(spokenText);
            // Re-enter command mode after TTS finishes (persistent conversation)
            if (typeof _conversationMode !== 'undefined' && _conversationMode && typeof _reenterCommandMode === 'function') {
              // Wait for TTS to finish, then re-enter. _ttsActive is set
              // by _speak() and cleared on completion (both Kokoro + WebSpeech
              // paths), so it's a reliable cross-engine "still speaking" flag.
              var _checkTTS = setInterval(function() {
                var stillSpeaking = (typeof _ttsActive !== 'undefined' && _ttsActive) ||
                                    (window.speechSynthesis && window.speechSynthesis.speaking);
                if (!stillSpeaking) {
                  clearInterval(_checkTTS);
                  setTimeout(_reenterCommandMode, 600);
                }
              }, 300);
            }
          }
        }
      }
    } else {
      // Background conversation — render into its (hidden) DOM and auto-run shell commands unless this turn explicitly suppresses them.
      dbg('■ background stream done for conv ' + convId, 'info');
      bodyEl.classList.remove('streaming-cursor');
      var renderBuffer = sanitizeWriteFileBlocks(buffer);
      bodyEl.innerHTML = renderBuffer ? renderMarkdown(renderBuffer) : '';
      if (typeof initMermaidInContainer === 'function') initMermaidInContainer(bodyEl);
      var bgWriteResults = await extractAndRenderWriteFile(msgEl, false, convId);
      var bgWriteFailed = Array.isArray(bgWriteResults) && bgWriteResults.some(function(r) { return r.status === 'rejected'; });
      if (typeof extractAndRenderArtifactRefs === 'function') extractAndRenderArtifactRefs(msgEl, convId);
      extractAndRenderFigmaExec(buffer, msgEl, true);
      var suppressShellAutoRunFinal = !!(conv._suppressShellAutoRunOnce || conv._writeRepairMode || bgWriteFailed);
      extractAndRenderShellExec(buffer, msgEl, suppressShellAutoRunFinal, convId);  // auto-run continues in background unless explicitly suppressed
      extractAndRenderBrowserActions(buffer, msgEl, false, convId);
      if (typeof extractAndRenderBrowserExtActions === 'function') extractAndRenderBrowserExtActions(buffer, msgEl, false, convId);
      extractAndRenderSaveInstruction(buffer, msgEl, false);
      extractArtifactsFromBuffer(buffer, msgEl, true);
      if (typeof postProcessDesignMessage === 'function') postProcessDesignMessage(bodyEl);
      if (typeof extractAndRenderCreateAgent === 'function') extractAndRenderCreateAgent(buffer, msgEl);
      if (typeof extractAndRenderPatchAgent === 'function') extractAndRenderPatchAgent(buffer, msgEl);
      if (typeof extractAndRenderUninstallAgent === 'function') extractAndRenderUninstallAgent(buffer, msgEl);
      if (typeof extractAndRenderTaskCreate === 'function') extractAndRenderTaskCreate(buffer, msgEl);
      if (typeof extractAndRenderGenUI === 'function') extractAndRenderGenUI(buffer, msgEl, true);
      (typeof wrapInActivityDetails === 'function' ? wrapInActivityDetails : wrapInChainOfThought)(msgEl);
      if (typeof compactProcessClusters === 'function') compactProcessClusters(msgEl);
      if (typeof compactLongAssistantMessage === 'function') compactLongAssistantMessage(msgEl, buffer);
      if (typeof _wfMoveCreatedArtifactsToEnd === 'function') _wfMoveCreatedArtifactsToEnd(msgEl);
      if (typeof ensureAssistantBubbleNotEmpty === 'function') ensureAssistantBubbleNotEmpty(msgEl);
      delete conv._suppressShellAutoRunOnce;
    }
  }
}

// ── Context summarization ─────────────────────────────────────────────────

// How many chars of history to keep without compressing
var SUMMARIZE_THRESHOLD = 30000;  // trigger when raw history exceeds this
var SUMMARIZE_KEEP_RECENT = 6;    // always keep the last N messages verbatim after summary

async function maybeCompressConversation(conv, opts) {
  opts = opts || {};
  if (conv._summarizing) return;  // already in progress

  // Calculate total raw size of conversation
  var totalChars = conv.messages.reduce(function(sum, m) {
    return sum + (typeof m.content === 'string' ? m.content.length : 500);
  }, 0);

  // Only summarize if we're over threshold and have enough messages to make it worthwhile
  // (unless explicitly forced via /compact slash command)
  if (!opts.force) {
    if (totalChars < SUMMARIZE_THRESHOLD || conv.messages.length < 8) return;
  } else {
    if (conv.messages.length < 4) {
      dbg('/compact: not enough history to summarize (' + conv.messages.length + ' msgs)', 'warn');
      return;
    }
  }

  // Messages to summarize: everything except the last N (keep recent verbatim)
  var toSummarize = conv.messages.slice(0, -SUMMARIZE_KEEP_RECENT);
  if (toSummarize.length < 4) {
    if (opts.force) toSummarize = conv.messages.slice(0, -2);
    if (toSummarize.length < 2) return;
  }

  dbg('↻ summarizing ' + toSummarize.length + ' old messages (~' + totalChars + ' chars)…', 'info');
  conv._summarizing = true;

  try {
    var r = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: toSummarize, model: state.model })
    });
    if (!r.ok) throw new Error('summarize failed: ' + r.status);
    var data = await r.json();
    if (!data.summary) return;

    // Archive old messages (strip image base64 to keep storage lean) instead of dropping
    var archiveBatch = toSummarize.map(function(m) {
      // Remove raw image bytes; keep text so the history is readable
      if (Array.isArray(m.content)) {
        var textOnly = m.content.filter(function(c) { return c.type === 'text'; }).map(function(c) { return c.text; }).join('\n');
        return Object.assign({}, m, { content: textOnly || '[image]', images: undefined });
      }
      if (m.images && m.images.length) {
        return Object.assign({}, m, { images: undefined });
      }
      return m;
    });
    conv.archivedMessages = (conv.archivedMessages || []).concat(archiveBatch);

    // Store summary and trim active history (only recent messages sent to AI)
    conv.contextSummary = data.summary;
    conv.messages = conv.messages.slice(-SUMMARIZE_KEEP_RECENT);
    saveConversations();
    dbg('context compressed — summary: ' + data.summary.length + ' chars, kept last ' + SUMMARIZE_KEEP_RECENT + ' messages, archived ' + archiveBatch.length + ' to history', 'ok');

    // Show an indicator in the active conversation
    if (state.currentId === conv.id) {
      var _inner = getConvInner(conv.id);
      var indicator = _inner.querySelector('.conv-archive-divider');
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'msg system-msg conv-archive-divider';
        _inner.appendChild(indicator);
      }
      indicator.innerHTML = renderContextArchiveDivider(conv);
      if (typeof reconcileBusyState === 'function') reconcileBusyState();
    }
  } catch (e) {
    dbg('summarize error: ' + e.message, 'warn');
  } finally {
    conv._summarizing = false;
  }
}

// Codex-parity: live token-usage forwarded into the existing #ctx-meter ring
// in the composer toolbar (the same line as "⏎ send · ⇧⏎ newline"). Driven by
// the `token_usage` SSE event emitted from server/routes/chat.js after every
// model iteration. We just shape the payload to match updateContextMeter()'s
// expected `{ usage:{ prompt_tokens, completion_tokens }, model }` contract.
function renderTokenUsageBar(evt) {
  // Prefer the granular updater so the hover popover keeps showing the full
  // sys-prompt / messages / gates breakdown instead of just the one-line
  // "in: + out: = total · billed:" summary.
  var fn = (typeof updateContextMeterGranular === 'function')
    ? updateContextMeterGranular
    : (typeof updateContextMeter === 'function' ? updateContextMeter : null);
  if (!fn) return;
  try {
    var ctx = _lastMeterCtx || {};
    fn({
      sysChars: ctx.sysChars || 0,
      msgChars: ctx.msgChars || 0,
      sysParts: ctx.sysParts || null,
      gates:    ctx.gates    || null,
      usage: {
        prompt_tokens:     Number(evt && evt.prompt)     || 0,
        completion_tokens: Number(evt && evt.completion) || 0,
        total_tokens:      Number(evt && evt.total)      || 0,
      },
      billed: {
        prompt: Number(evt && evt.billedPrompt) || 0,
        total:  Number(evt && evt.billedTotal)  || 0,
      },
      iterations: Number(evt && evt.iterations) || 0,
      model: (evt && evt.model) || '',
    });
  } catch (_) { /* non-fatal */ }
}

// Last per-turn meter context (sysChars/sysParts/gates) captured at stream
// start so token_usage SSE events can render the granular popover breakdown
// instead of falling back to the one-line summary.
var _lastMeterCtx = null;

// Hide the ctx-meter ring (e.g. when starting a fresh conversation that has
// no token_usage history yet). Called from newConversation() and from
// loadConversation() when the target conv has no recorded usage.
function resetContextMeter() {
  var meter = document.getElementById('ctx-meter');
  if (meter) meter.style.display = 'none';
}

function renderContextArchiveDivider(conv) {
  var summary = conv && conv.contextSummary ? String(conv.contextSummary) : '';
  return '<div class="msg-body conv-archive-divider-inner">' +
    '<div class="conv-archive-head">' +
      '<i class="ti ti-history"></i>' +
      '<span>Older messages archived — full history preserved above, AI context starts here</span>' +
    '</div>' +
    (summary ? '<div class="conv-archive-summary">' + escHtml(summary) + '</div>' : '') +
  '</div>';
}

function showContextSummary(convId) {
  var conv = getConv(convId);
  if (!conv || !conv.contextSummary) return;
  // Show as an artifact
  var id = addArtifact({ type: 'markdown', title: 'Task Context Summary', content: conv.contextSummary });
  openArtifact(id);
}

function stopGeneration() {
  var conv = getConv(state.currentId);
  if (!conv) return;
  var stoppedShell = 0;
  if (typeof stopActiveShellWorkForCurrentConversation === 'function') {
    stoppedShell = stopActiveShellWorkForCurrentConversation() || 0;
  }
  var stoppedBrowser = 0;
  if (typeof stopActiveBrowserWorkForCurrentConversation === 'function') {
    stoppedBrowser = stopActiveBrowserWorkForCurrentConversation(state.currentId) || 0;
  }
  conv._cancelled = true;
  if (conv._abortController) conv._abortController.abort();
  // Also stop any active delegation
  if (typeof window._delegStop === 'function') window._delegStop();
  conv._streaming = false;
  conv._abortController = null;
  setBusy(false);
  renderConvList();
  var msg = 'Generation stopped';
  if (stoppedShell) msg = 'Shell verification stopped';
  else if (stoppedBrowser) msg = 'Browser action stopped';
  showToast(msg);
}

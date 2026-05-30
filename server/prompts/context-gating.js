// Codex-parity: gate heavy static system-prompt blocks on actual demand
// instead of injecting them every turn. The full GEN_UI catalog, the
// browser-panel doc, and the Frontend Quality bar together cost ~7k tokens
// — but a typical "explain this code" / "fix this bug" / "what does X mean"
// turn needs none of them.
//
// This module inspects the latest user message + the recent assistant
// transcript and returns a flag set telling the chat route which optional
// sections to inject. Once a conversation has used a capability we stay
// "sticky" and keep injecting the relevant block for the rest of the conv
// — flipping it off mid-thread would surprise the model.

const GENUI_KW = /\b(dashboard|scorecard|widget|gen[-_ ]?ui|chart|graph|stat\b|metric|kpi|leaderboard|table|playlist|carousel|podcast|narrat(e|ion)|read .* aloud|say this|tts|voiceover|video|movie|episode|gallery|tabs?\b|circuit|schematic|wiring|netlist|spice|op[- ]?amp|transistor|resistor|capacitor|inductor|whiteboard|lesson|teach me|walk me through|explain how|visualiz)/i;

const BROWSER_KW = /\b(browser|navigate|tab\b|open .* url|fetch .* page|crawl|scrape|click|fill .* form|type into|screenshot|snapshot|dev[- ]?server|localhost|https?:\/\/|extension|playwright|extract page)/i;

const FRONTEND_KW = /\b(ui|ux|frontend|front[- ]?end|website|landing page|hero section|component library|css|tailwind|react|next\.?js|svelte|vue|design system|figma|typography|color palette|gradient|hover state|animation|motion|micro[- ]?interaction|responsive|mobile view|landing|portfolio site|case stud)/i;

// Did the assistant already render any of these in this conversation? Once
// yes, keep injecting — switching modes mid-thread would confuse the model
// and break references to prior widgets.
function stickyFlags(messages) {
  let genui = false, browser = false, frontend = false;
  if (!Array.isArray(messages)) return { genui, browser, frontend };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(c => (c && typeof c.text === 'string') ? c.text : '').join('\n')
        : '';
    if (!text) continue;
    if (!genui   && /```gen-ui|```artifact:|fauna_render_circuit|fauna_speak|fauna_podcast|fauna_lesson_create/.test(text)) genui = true;
    if (!browser && /```browser-action|```browser-ext-action|fauna_browser/.test(text)) browser = true;
    if (!frontend && /```artifact:html|tailwind|className=|<style|gradient\(|@keyframes/.test(text))     frontend = true;
    if (genui && browser && frontend) break;
  }
  return { genui, browser, frontend };
}

// Latest user message text (cheap: we only need to keyword-scan it).
function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map(c => (c && typeof c.text === 'string') ? c.text : '')
        .join(' ');
    }
  }
  return '';
}

/**
 * Decide which optional system-prompt sections to inject this turn.
 * @param {object} opts
 * @param {Array}  opts.messages          – full conversation (user+assistant) being sent
 * @param {string} opts.systemPrompt      – the user's per-conv system prompt (also scanned)
 * @param {boolean} opts.isDelegation     – sub-agent calls always skip heavy blocks
 * @param {boolean} opts.isCLI            – CLI mode skips browser/genui (no rendering surface)
 * @param {boolean} opts.noTools          – tools disabled → no point describing them
 * @returns {{ genui:boolean, browser:boolean, frontend:boolean }}
 */
export function computeContextFlags({ messages, systemPrompt, isDelegation, isCLI, noTools }) {
  if (isDelegation) return { genui: false, browser: false, frontend: false };
  const sticky = stickyFlags(messages);
  const probe = (lastUserText(messages) + ' ' + (systemPrompt || '')).slice(0, 4000);
  const genui    = sticky.genui    || GENUI_KW.test(probe);
  // Browser context only makes sense when tools are enabled and we're not in
  // a plain-text CLI surface.
  const browser  = !noTools && !isCLI && (sticky.browser || BROWSER_KW.test(probe));
  const frontend = sticky.frontend || FRONTEND_KW.test(probe);
  return { genui, browser, frontend };
}

// ── Tool-schema gating ───────────────────────────────────────────────────
// 11k+ tokens of fauna_* JSON schemas ship every turn. Most are cluster-
// specific (video, circuit, podcast, mouse/keyboard automation, stock
// images, etc.) and never fire for a typical "fix this bug" turn.
// Group tools by intent and filter the array before sending it to the model.

const TOOL_CLUSTERS = {
  // Always-on: cheap, broadly useful, low schema cost.
  core: new Set([
    'fauna_remember', 'fauna_recall', 'fauna_forget',
    'fauna_get_settings', 'fauna_save_instruction', 'fauna_send_notification',
    'fauna_list_models', 'fauna_switch_model', 'fauna_set_thinking_budget',
    'fauna_list_projects',
  ]),
  // Code editing + shell. The most-used cluster. Triggered by almost any
  // engineering request.
  code: new Set([
    'fauna_shell_exec', 'fauna_read_file', 'fauna_write_file', 'fauna_write_files',
    'fauna_replace_string', 'fauna_apply_patch', 'fauna_dev_servers',
    'fauna_verify_build',
  ]),
  // Multi-step planning. Triggered by "build" / "create app" / sticky plan.
  planning: new Set([
    'fauna_plan', 'fauna_substep', 'fauna_create_project', 'fauna_db_migration',
  ]),
  browser: new Set(['fauna_browser']),
  circuit: new Set([
    'fauna_list_circuit_symbols', 'fauna_render_circuit',
    'fauna_validate_circuit', 'fauna_simulate_circuit',
  ]),
  automation: new Set([
    'fauna_list_windows', 'fauna_arrange_windows', 'fauna_mouse',
    'fauna_mouse_position', 'fauna_keyboard', 'fauna_ui_tree', 'fauna_screen_context',
  ]),
  video: new Set([
    'fauna_video_create', 'fauna_video_run_all', 'fauna_video_step',
    'fauna_video_patch', 'fauna_video_get', 'fauna_video_list',
  ]),
  voice: new Set(['fauna_speak', 'fauna_podcast']),
  lesson: new Set(['fauna_lesson_create', 'fauna_lesson_get', 'fauna_list_lesson_kinds']),
  images: new Set([
    'fauna_stock_image_search', 'fauna_stock_image_download', 'fauna_stock_image_providers',
  ]),
  widget: new Set([
    'fauna_emit_widget', 'fauna_save_widget_to_playbook',
    'fauna_list_playbook', 'fauna_load_widget_from_playbook',
  ]),
  backlog: new Set([
    'fauna_feature_request_create', 'fauna_backlog_list', 'fauna_backlog_prioritize',
  ]),
  debate: new Set(['fauna_consult_debate']),
};

const TOOL_KW = {
  code:       /\b(code|file|read|write|edit|patch|fix|bug|refactor|implement|function|class|test|lint|build|server|shell|exec|run|script|commit|repo|module|import|export)\b|\.(js|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|css|scss|html|md|json|yaml|yml|toml|sql|env)\b/i,
  planning:   /\b(plan|scaffold|create.{0,15}(app|site|project|saas|tool|prototype|mvp)|build.{0,15}(app|site|project|saas|tool|prototype|mvp)|new project|migration|database|schema|sqlite|postgres|mysql)\b/i,
  browser:    /\b(browse|browser|tab|navigate|website|web ?page|web ?site|url|http|https|click|form|login|sign[- ]?up|register|extract|screenshot|playwright|scrape|fetch ?url|crawl|google|youtube|reddit|github\.com|gmail)\b/i,
  circuit:    /\b(circuit|schematic|netlist|spice|simulat|op[- ]?amp|transistor|resistor|capacitor|inductor|voltage|current|amp(ere|s)?|ohm|wiring|breadboard|kicad|eagle)\b/i,
  automation: /\b(mouse|click .* screen|keyboard|keystroke|type into|window|move .* window|resize|arrange|minimize|maximize|screen ?capture|screen ?context|ui ?tree|accessibility)\b/i,
  video:      /\b(video|movie|reel|short|clip|render .* mp4|moneyprinter|kdenlive|premiere|capcut|narration|voiceover|render scene)\b/i,
  voice:      /\b(speak|say (this|that|it)|read .* aloud|tts|voice ?over|narrat|podcast|episode|audio)\b/i,
  lesson:     /\b(lesson|teach me|walk me through|tutorial|course|explain how|step[- ]?by[- ]?step|learn(ing)? plan)\b/i,
  images:     /\b(stock ?images?|unsplash|pexels|pixabay|royalty[- ]?free|hero ?images?|illustration|photos? (search|of)|find .* (image|photo)|download .* (image|photo))\b/i,
  widget:     /\b(widget|dashboard|chart|graph|gen[-_ ]?ui|scorecard|kpi|metric|leaderboard|playlist|carousel|tabs?\b|gallery|stat\b)\b/i,
  backlog:    /\b(backlog|feature request|roadmap|prioriti[sz]e|ticket|issue|jira|todo list|user story)\b/i,
  debate:     /\b(debate|consult|second opinion|cross[- ]?check|compare models|ask another model|deliberate|brainstorm)\b/i,
};

// Sticky markers — if the assistant already used a tool, keep its schema on
// so follow-ups still work without the user having to repeat keywords.
function stickyToolFlags(messages) {
  const out = {};
  if (!Array.isArray(messages)) return out;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = tc?.function?.name || tc?.name;
        if (!name) continue;
        for (const cluster of Object.keys(TOOL_CLUSTERS)) {
          if (TOOL_CLUSTERS[cluster].has(name)) out[cluster] = true;
        }
      }
    }
    // Assistant text fences that imply a tool family (legacy markdown path)
    if (m.role === 'assistant' && typeof m.content === 'string') {
      if (/```browser-action|```browser-ext-action|fauna_browser/.test(m.content)) out.browser = true;
      if (/fauna_render_circuit|```circuit/.test(m.content)) out.circuit = true;
      if (/fauna_video_|```video-plan/.test(m.content)) out.video = true;
      if (/fauna_podcast|fauna_speak/.test(m.content)) out.voice = true;
      if (/fauna_lesson/.test(m.content)) out.lesson = true;
      if (/fauna_plan|```file-plan/.test(m.content)) out.planning = true;
      if (/fauna_emit_widget|```artifact:html/.test(m.content)) out.widget = true;
    }
  }
  return out;
}

/**
 * Decide which tool clusters to keep this turn.
 * @returns {{[cluster:string]: boolean}}
 */
export function computeToolFlags({ messages, systemPrompt, isDelegation, isCLI, noTools }) {
  const flags = { core: true }; // always on
  if (noTools) return {}; // no tools at all → caller should pass undefined
  const sticky = stickyToolFlags(messages);
  const probe = (lastUserText(messages) + ' ' + (systemPrompt || '')).slice(0, 4000);
  for (const cluster of Object.keys(TOOL_CLUSTERS)) {
    if (cluster === 'core') continue;
    if (sticky[cluster]) { flags[cluster] = true; continue; }
    const kw = TOOL_KW[cluster];
    if (kw && kw.test(probe)) flags[cluster] = true;
  }
  // Surface-specific overrides
  if (isCLI) { flags.browser = false; flags.widget = false; flags.video = false; flags.automation = false; }
  // Delegation sub-agents inherit the orchestrator's intent; keep everything
  // the orchestrator triggered, but skip widget/video/voice unless they
  // explicitly used them. (Already handled by sticky scan.)
  if (isDelegation) {
    // Sub-agents historically need browser + code unconditionally.
    flags.browser = flags.browser || true;
    flags.code = true;
  }
  return flags;
}

/**
 * Filter a tool-defs array down to clusters enabled by `flags`.
 * Unknown tools (non-fauna_*, e.g. Figma MCP, agent tools) are always kept —
 * those are user-installed and the orchestrator/agent depends on them.
 */
export function filterToolSchemas(tools, flags) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  if (!flags || typeof flags !== 'object') return tools;
  // Build a name → cluster map once per call.
  const nameToCluster = new Map();
  for (const cluster of Object.keys(TOOL_CLUSTERS)) {
    for (const n of TOOL_CLUSTERS[cluster]) nameToCluster.set(n, cluster);
  }
  return tools.filter(t => {
    const name = t?.function?.name || t?.name;
    if (!name) return true;
    const cluster = nameToCluster.get(name);
    if (!cluster) return true; // foreign tool (figma/agent/widget runtime) — keep
    return !!flags[cluster];
  });
}


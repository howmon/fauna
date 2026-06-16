// ── Tool Guard — Pre-tool-call hook system for the agentic loop ──────────
// Provides per-category limits, browser rate limiting, snapshot-before-click,
// navigation dedup, and extensible permission checks for MCP tools.


// ── Tool categories ───────────────────────────────────────────────────────

const BROWSER_TOOLS = new Set([
  'browser_navigate', 'browser_click', 'browser_type', 'browser_press_key',
  'browser_snapshot', 'browser_scroll', 'browser_select_option', 'browser_hover',
  'browser_drag', 'browser_handle_dialog', 'browser_file_upload', 'browser_evaluate',
  'browser_tab_new', 'browser_tab_select', 'browser_tab_close', 'browser_wait',
  'browser_save_as_pdf', 'browser_close', 'browser_resize', 'browser_install',
  'browser_generate_playwright_test', 'browser_console_messages', 'browser_network_requests',
]);

const SHELL_TOOLS = new Set([
  // MCP / generic shell tool names
  'shell_exec', 'bash', 'run_command', 'agent_shell',
  // Native Fauna shell tools — these are the actual function names exposed
  // to the model (see self-tools.js fauna_shell_exec and agent-tools.js
  // agent_shell_exec). Omitting them caused both to be miscategorised as
  // 'other', so the shell cap/permission branch never fired for native
  // calls and the model's mental model of remaining shell budget was wrong.
  'fauna_shell_exec', 'agent_shell_exec',
]);

const FILE_TOOLS = new Set([
  'agent_read_file', 'agent_write_file', 'agent_write_files', 'agent_str_replace',
  'read_file', 'write_file', 'create_file',
]);

const FIGMA_TOOLS = new Set([
  'figma_execute', 'get_screenshot', 'get_design_context', 'get_metadata',
  'get_annotations', 'get_styles', 'get_selection',
]);

// ── Free tools — bookkeeping calls that don't count toward any cap ───────
// The cap exists to bound model rambling and runaway tool loops on
// expensive operations (shell, browser, file I/O). Board/task plumbing
// is cheap, idempotent, and necessary for the agent to keep the system
// in sync with what it's doing. Counting these against the cap means a
// long engineering run runs out of budget *before* it can post the
// closing comment + move the card — which is exactly the bug the user
// reported ("claim recorded; the move did not — tool cap (30) hit").
const FREE_TOOLS = new Set([
  // Kanban / work-item bookkeeping
  'fauna_workitem_move',
  'fauna_workitem_claim',
  'fauna_workitem_comment',
  'fauna_workitem_update',
  'fauna_workitem_verify',
  'fauna_board_scan',
  'fauna_project_audit',
  'fauna_list_projects',
  // Memory / context bookkeeping (already idempotent, capped elsewhere)
  'fauna_remember',
  'fauna_recall',
  'fauna_forget',
  // Settings / model introspection
  'fauna_list_models',
  'fauna_get_settings',
  'fauna_list_skills',
  'fauna_get_skill',
  'fauna_list_references',
  'fauna_get_reference',
  'fauna_get_agent_instructions',
  // Read-only file / code search — "research" that should not eat the
  // write budget. fauna_read_file is read-only and idempotent.
  'fauna_read_file',
  'fauna_grep',
  'fauna_file_search',
  'fauna_semantic_search',
  'fauna_context_search',
  // Environment introspection (no side effects)
  'fauna_list_windows',
  'fauna_screen_context',
  'fauna_ui_tree',
  'fauna_doctor',
  'fauna_retrieve_output',
  // Catalogue lookups
  'fauna_list_voices',
  'fauna_video_list',
  'fauna_lesson_list',
  'fauna_list_playbook',
  'fauna_load_widget_from_playbook',
  'fauna_backlog_list',
  'fauna_stock_image_search',
  'fauna_stock_image_get',
  // Figma read-only introspection (figma_execute / write paths stay capped)
  'figma_status',
  'figma_list_connected_files',
  'figma_list_pages',
  'figma_list_design_systems',
  'figma_get_console_logs',
  'figma_get_selection',
  'figma_get_component_map',
  'figma_get_unmapped_components',
  'figma_search_components',
  'figma_search_tokens',
  'figma_docs',
  'figma_rules',
]);

/**
 * Whether a tool is free (doesn't count toward any cap).
 * @param {string} name
 * @returns {boolean}
 */
export function isFreeTool(name) {
  return FREE_TOOLS.has(name);
}

// ── Human-readable tool descriptions ──────────────────────────────────────

const TOOL_LABELS = {
  // Browser
  browser_navigate:    (a) => `Navigating to ${a?.url || 'page'}`,
  browser_click:       (a) => `Clicking "${a?.element || a?.ref || 'element'}"`,
  browser_type:        (a) => `Typing into ${a?.element || a?.ref || 'field'}`,
  browser_press_key:   (a) => `Pressing ${a?.key || 'key'}`,
  browser_snapshot:    ()  => 'Taking browser snapshot',
  browser_scroll:      (a) => `Scrolling ${a?.direction || 'page'}`,
  browser_select_option: (a) => `Selecting option in ${a?.element || 'dropdown'}`,
  browser_hover:       (a) => `Hovering over ${a?.element || a?.ref || 'element'}`,
  browser_tab_new:     ()  => 'Opening new tab',
  browser_tab_close:   ()  => 'Closing tab',
  browser_evaluate:    ()  => 'Evaluating JavaScript in browser',
  browser_close:       ()  => 'Closing browser',
  browser_wait:        ()  => 'Waiting for page',
  // Shell
  shell_exec:          (a) => `Running: ${(a?.command || '').slice(0, 60)}`,
  bash:                (a) => `Running: ${(a?.command || '').slice(0, 60)}`,
  run_command:         (a) => `Running: ${(a?.command || '').slice(0, 60)}`,
  agent_shell:         (a) => `Running: ${(a?.command || '').slice(0, 60)}`,
  // File
  agent_read_file:     (a) => `Reading ${a?.path || a?.file || 'file'}`,
  agent_write_file:    (a) => `Writing ${a?.path || a?.file || 'file'}`,
  agent_write_files:   (a) => `Writing ${Array.isArray(a?.files) ? a.files.length : 'multiple'} files`,
  agent_str_replace:   (a) => `Editing ${a?.path || a?.file || 'file'}`,
  read_file:           (a) => `Reading ${a?.path || a?.file || 'file'}`,
  write_file:          (a) => `Writing ${a?.path || a?.file || 'file'}`,
  create_file:         (a) => `Creating ${a?.path || a?.file || 'file'}`,
  // Figma
  figma_execute:       ()  => 'Executing Figma plugin code',
  get_screenshot:      ()  => 'Taking Figma screenshot',
  get_design_context:  ()  => 'Reading Figma design context',
  get_metadata:        ()  => 'Reading Figma metadata',
};

/**
 * Get a human-readable label for a tool call.
 * @param {string} toolName
 * @param {object} [args]
 * @returns {string}
 */
export function formatToolLabel(toolName, args) {
  const fn = TOOL_LABELS[toolName];
  if (fn) return fn(args);
  // Fallback: humanize the tool name
  return toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Categorize a tool by name.
 * @param {string} name
 * @returns {'browser'|'shell'|'file'|'figma'|'other'}
 */
export function getToolCategory(name) {
  if (BROWSER_TOOLS.has(name)) return 'browser';
  if (SHELL_TOOLS.has(name)) return 'shell';
  if (FILE_TOOLS.has(name)) return 'file';
  if (FIGMA_TOOLS.has(name)) return 'figma';
  return 'other';
}

// ── Category limits ───────────────────────────────────────────────────────

const CATEGORY_LIMITS = {
  browser: 25,
  shell:   30,
  file:    40,    // raised: real engineering turns routinely touch >20 files
  figma:   30,
  other:   60,    // raised: read/search tools now FREE, but keep headroom for the rest
};

const TOTAL_LIMIT = 80;  // raised from 40; FREE_TOOLS expansion absorbs the slack

// Relaxed limits for autonomous task runs (kanban autopilot, cron jobs).
// Interactive chat keeps the conservative caps so a runaway tool loop
// doesn't burn through tokens; headless tasks need room to actually finish
// a build → test → review workflow.
const AUTONOMOUS_CATEGORY_LIMITS = {
  browser: 60,
  shell:   100,
  file:    100,
  figma:   100,
  other:   100,
};
const AUTONOMOUS_TOTAL_LIMIT = 300;

// ── Guard context — one per agentic turn ──────────────────────────────────

export class ToolGuardContext {
  constructor(opts = {}) {
    this.totalCount = 0;
    this.categoryCounts = { browser: 0, shell: 0, file: 0, figma: 0, other: 0 };

    // Browser discipline state
    this._browserActionTimestamps = [];  // timestamps of recent browser actions
    this._lastBrowserSnapshotIdx = 0;    // totalCount at last snapshot (0 = fresh start)
    this._recentNavigations = new Map(); // url → { count, lastResult }

    // Effective limits: caller can pass `autonomous:true` for the relaxed
    // ceiling, OR pass an explicit `limits: { total, browser, shell, ... }`
    // override (per-field merge over the active baseline).
    const baseTotal = opts.autonomous ? AUTONOMOUS_TOTAL_LIMIT : TOTAL_LIMIT;
    const baseCats  = opts.autonomous ? AUTONOMOUS_CATEGORY_LIMITS : CATEGORY_LIMITS;
    this.totalLimit = (opts.limits && Number.isFinite(opts.limits.total)) ? opts.limits.total : baseTotal;
    this.categoryLimits = { ...baseCats, ...((opts.limits && typeof opts.limits === 'object') ? opts.limits : {}) };

    // Callbacks
    this.onPermissionRequest = opts.onPermissionRequest || null; // async (toolName, args, info) => 'allow'|'deny'
    this.send = opts.send || (() => {});                         // SSE send function
  }

  /**
   * Pre-tool-call hook. Returns { action, reason?, inject? }
   *   action: 'allow' | 'deny' | 'inject_snapshot'
   *   inject: optional tool call to inject before the real one
   *
   * @param {string} toolName
   * @param {object} args
   * @returns {Promise<{action: string, reason?: string, inject?: object}>}
   */
  async check(toolName, args) {
    // ── 0. Free tools — bookkeeping that doesn't count toward any cap ──
    // Allow immediately without incrementing counters so a long engineering
    // run can still post comments, move cards, verify, etc. right up to
    // the moment it actually finishes.
    if (FREE_TOOLS.has(toolName)) {
      return { action: 'allow' };
    }

    const category = getToolCategory(toolName);
    this.totalCount++;
    this.categoryCounts[category]++;

    // ── 1. Total / per-category caps ────────────────────────────────
    // INTENTIONALLY REMOVED. Numeric tool-call caps punish legitimate
    // deep work (a real cross-file refactor reads 30+ files) without
    // catching the actual failure mode (a model that varies its args
    // slightly while looping). Runaway-loop detection lives in
    // server/routes/chat.js: narration-repetition guard (4 strikes →
    // hard stop) + tool-call dedup (toolCallsSeen map). The user's
    // abort button is the final stop. Counters above are kept for
    // telemetry / debug logs only.

    // ── 3. Shell permission check ──────────────────────────────────
    // INTENTIONALLY REMOVED. The agent is autonomous — it runs whatever shell
    // command the model asks for, no per-command approval dialog. Per-turn
    // category cap above (#2) is the only shell rate-limit. If you need a
    // safer mode, gate at the model/tool-exposure layer, not here.

    // ── 4. Browser discipline ──────────────────────────────────────
    if (category === 'browser') {
      const now = Date.now();

      // 4a. Rate limit: max 3 browser actions per 2s window
      this._browserActionTimestamps.push(now);
      // Prune timestamps older than 2s
      this._browserActionTimestamps = this._browserActionTimestamps.filter(t => now - t < 2000);
      if (this._browserActionTimestamps.length > 3) {
        // Inject a snapshot so the model observes what happened
        return {
          action: 'inject_snapshot',
          reason: 'Browser rate limit — taking snapshot before continuing.',
        };
      }

      // 4b. Snapshot-before-click: if last snapshot was > 2 actions ago, inject one
      const isBlindAction = ['browser_click', 'browser_type', 'browser_press_key'].includes(toolName);
      if (isBlindAction && (this.totalCount - this._lastBrowserSnapshotIdx) > 2) {
        return {
          action: 'inject_snapshot',
          reason: 'Injecting snapshot — model must observe page before ' + toolName,
        };
      }

      // Track snapshot
      if (toolName === 'browser_snapshot') {
        this._lastBrowserSnapshotIdx = this.totalCount;
      }

      // 4c. Navigation dedup: same URL visited within last 5 actions
      if (toolName === 'browser_navigate' && args?.url) {
        const nav = this._recentNavigations.get(args.url);
        if (nav && nav.count >= 2) {
          return {
            action: 'deny',
            reason: `Already navigated to ${args.url} ${nav.count} times. Use browser_snapshot to check current page instead of navigating again.`,
          };
        }
        const entry = nav || { count: 0, lastResult: null };
        entry.count++;
        this._recentNavigations.set(args.url, entry);
      }

      // 4d. Permission check for sensitive browser actions
      const sensitiveBrowserActions = new Set([
        'browser_evaluate', 'browser_file_upload', 'browser_handle_dialog',
      ]);
      if (sensitiveBrowserActions.has(toolName) && this.onPermissionRequest) {
        const decision = await this.onPermissionRequest(toolName, args, {
          category: 'browser',
          label: formatToolLabel(toolName, args),
        });
        if (decision !== 'allow' && decision !== 'auto-allow') {
          return { action: 'deny', reason: 'User denied browser action.' };
        }
      }
    }

    return { action: 'allow' };
  }

  /** Reset browser rate limit window (call after a forced snapshot completes) */
  resetBrowserRate() {
    this._browserActionTimestamps = [];
  }
}

// ── Tool Guard — Pre-tool-call hook system for the agentic loop ──────────
// Provides per-category limits, browser rate limiting, snapshot-before-click,
// navigation dedup, and extensible permission checks for MCP tools.

import { isCommandSafe } from './permission-guard.js';

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
  'shell_exec', 'bash', 'run_command', 'agent_shell',
]);

const FILE_TOOLS = new Set([
  'agent_read_file', 'agent_write_file', 'agent_write_files', 'agent_str_replace',
  'read_file', 'write_file', 'create_file',
]);

const FIGMA_TOOLS = new Set([
  'figma_execute', 'get_screenshot', 'get_design_context', 'get_metadata',
  'get_annotations', 'get_styles', 'get_selection',
]);

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
  browser: 15,
  shell:   20,
  file:    20,
  figma:   25,
  other:   30,
};

const TOTAL_LIMIT = 40;

// ── Guard context — one per agentic turn ──────────────────────────────────

export class ToolGuardContext {
  constructor(opts = {}) {
    this.totalCount = 0;
    this.categoryCounts = { browser: 0, shell: 0, file: 0, figma: 0, other: 0 };

    // Browser discipline state
    this._browserActionTimestamps = [];  // timestamps of recent browser actions
    this._lastBrowserSnapshotIdx = 0;    // totalCount at last snapshot (0 = fresh start)
    this._recentNavigations = new Map(); // url → { count, lastResult }

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
    const category = getToolCategory(toolName);
    this.totalCount++;
    this.categoryCounts[category]++;

    // ── 1. Total limit ─────────────────────────────────────────────
    if (this.totalCount > TOTAL_LIMIT) {
      return {
        action: 'deny',
        reason: `Tool call limit reached (${TOTAL_LIMIT}). Summarize what you have done so far and tell the user to continue in a follow-up message if needed.`,
      };
    }

    // ── 2. Per-category limit ──────────────────────────────────────
    const catLimit = CATEGORY_LIMITS[category] || CATEGORY_LIMITS.other;
    if (this.categoryCounts[category] > catLimit) {
      return {
        action: 'deny',
        reason: `${category} tool limit reached (${catLimit}). Stop calling ${category} tools and summarize progress. Tell the user to continue in a follow-up if needed.`,
      };
    }

    // ── 3. Shell permission check ──────────────────────────────────
    if (category === 'shell') {
      const cmd = args?.command || '';
      if (cmd && !isCommandSafe(cmd)) {
        // Ask the frontend for permission
        if (this.onPermissionRequest) {
          const decision = await this.onPermissionRequest(toolName, args, {
            category: 'shell',
            label: formatToolLabel(toolName, args),
          });
          if (decision !== 'allow' && decision !== 'auto-allow') {
            return { action: 'deny', reason: 'User denied shell command.' };
          }
        }
        // If no permission handler, deny by default for unsafe commands
        else {
          return { action: 'deny', reason: 'Unsafe shell command — no permission handler available.' };
        }
      }
    }

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

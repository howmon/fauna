// ── Self-Tools — LLM-callable tools that let the AI manage the Fauna app ──
// These tools let the AI introspect and control the application:
// memory, models, settings, projects, instructions, notifications.

/**
 * @typedef {{getModels: () => Array<{id: string, name: string}>, getSettings: () => object, sendToRenderer: (channel: string, ...args: any[]) => void, sendNotification: (title: string, body: string) => void}} SelfToolContext
 */

import {
  remember as factsRemember, recall as factsRecall, forget as factsForget,
  listFacts, getStats as factsGetStats,
} from './memory-store.js';
import {
  createProject, getAllProjects, getProject,
  addBacklogItem, listBacklog, prioritizeBacklog,
} from './project-manager.js';
import { renderCircuit } from './lib/circuit-renderer.js';
import { validateCircuit } from './lib/circuit-validate.js';
import { SYMBOLS, listSymbolTypes } from './lib/circuit-symbols.js';
import { simulateCircuit } from './lib/circuit-simulate.js';
import { packWidgetResult } from './lib/dynamic-widgets.js';
import {
  savePlaybookEntry, listPlaybookEntries, getPlaybookEntry,
  touchPlaybookEntry, deletePlaybookEntry,
} from './playbook-store.js';
import {
  listVisibleWindows as macListVisibleWindows,
  arrangeWindows as macArrangeWindows,
  getScreenBounds as macGetScreenBounds,
} from './server/lib/window-context.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const HOME = os.homedir();

function _resolveFaunaWritePath(filePath, cwd) {
  if (!filePath) throw new Error('path required');
  let resolved;
  if (String(filePath).startsWith('/')) resolved = String(filePath);
  else if (String(filePath).startsWith('~/')) resolved = String(filePath).replace(/^~/, HOME);
  else if (cwd) resolved = path.join(String(cwd).replace(/^~/, HOME), String(filePath));
  else resolved = path.join(HOME, String(filePath));
  resolved = path.resolve(resolved);
  if (!resolved.startsWith(HOME) && !resolved.startsWith('/tmp')) throw new Error('Path outside allowed directories: ' + resolved);
  return resolved;
}

function _atomicFastWrite(abs, buffer) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.~fauna-fast-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function _writeFastFile(args = {}) {
  const abs = _resolveFaunaWritePath(args.path, args.cwd);
  const encoding = args.encoding || 'utf8';
  const existed = fs.existsSync(abs);
  if (args.overwrite === false && existed && !args.append) throw new Error('Refusing to overwrite existing file: ' + abs);
  let content = String(args.content ?? '');
  if (args.append && existed) content = fs.readFileSync(abs, encoding) + content;
  const buffer = Buffer.from(content, encoding);
  const bytes = buffer.length;
  const lines = content.length ? content.split('\n').length : 0;
  if (args.reject_empty !== false && bytes === 0) throw new Error('Refusing to write empty file: ' + abs);
  if (args.minBytes != null && bytes < Number(args.minBytes)) throw new Error('Content too short for ' + abs + ': ' + bytes + ' bytes < ' + args.minBytes);
  if (args.minLines != null && lines < Number(args.minLines)) throw new Error('Content too short for ' + abs + ': ' + lines + ' lines < ' + args.minLines);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (args.sha256 && args.sha256 !== sha256) throw new Error('sha256 mismatch for ' + abs + ': expected ' + args.sha256 + ', got ' + sha256);
  let backup = null;
  if (args.backup && existed) {
    backup = abs + '.~fauna-backup-' + Date.now();
    fs.copyFileSync(abs, backup);
  }
  _atomicFastWrite(abs, buffer);
  return { path: abs, bytes, lines, sha256, existed, op: args.append ? 'append' : 'write', backup };
}

// ── Tool definitions ────────────────────────────────────────────────────

export const SELF_TOOL_DEFS = [
  // ── Memory tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_remember',
      description: 'Remember a fact about the user. Use when the user shares preferences, makes decisions, or gives context you should recall later. Categories: preference, fact, decision, context.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact to remember (max 500 chars)' },
          category: { type: 'string', enum: ['preference', 'fact', 'decision', 'context'], description: 'Category' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_recall',
      description: 'Search your memory for facts about the user. Returns matching facts scored by relevance and recency. Call with empty keywords for the most recent facts.',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: 'Space-separated keywords to search for' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_forget',
      description: 'Forget a specific fact by its ID. Use when the user asks you to forget something or a fact is no longer accurate.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The fact ID to forget' },
        },
        required: ['id'],
      },
    },
  },

  // ── Model tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_list_models',
      description: 'List all available AI models. Returns model IDs, names, and vendors.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_switch_model',
      description: 'Switch the active AI model. The change takes effect on the next message (not the current one).',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Model ID to switch to (e.g. "gpt-4o", "claude-sonnet-4-20250514")' },
        },
        required: ['model'],
      },
    },
  },

  // ── Settings tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_get_settings',
      description: 'Get current app settings: active model, thinking budget, max context turns, Figma MCP status.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_set_thinking_budget',
      description: 'Set the extended thinking budget for reasoning models. The change takes effect on the next message.',
      parameters: {
        type: 'object',
        properties: {
          budget: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'max'], description: 'Thinking budget level' },
        },
        required: ['budget'],
      },
    },
  },

  // ── Project tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_create_project',
      description: 'Create a new project in Fauna. Returns the project object with its ID.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name' },
          description: { type: 'string', description: 'Short description' },
          rootPath: { type: 'string', description: 'Absolute path to the project root directory' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_list_projects',
      description: 'List all projects. Returns project names, IDs, and root paths.',
      parameters: { type: 'object', properties: {} },
    },
  },

  // ── Instruction tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_save_instruction',
      description: 'Save a learned instruction to the Playbook. Use when you discover a successful strategy or pattern the user would want to reuse. The instruction persists across conversations.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the instruction' },
          body: { type: 'string', description: 'The full instruction text' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
        },
        required: ['title', 'body'],
      },
    },
  },

  // ── Notification tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_send_notification',
      description: 'Send a native OS notification to the user. Use for important alerts, completed background tasks, or urgent information that needs attention even if the user is not looking at the app.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title' },
          body: { type: 'string', description: 'Notification body text' },
        },
        required: ['title', 'body'],
      },
    },
  },

  // ── Fast file tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_write_file',
      description: 'Fast VS Code-style file write. Prefer this over markdown write-file blocks whenever tools are available. Writes server-side with temp+rename and returns path/bytes/sha256 without rendering file bytes in chat.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, ~/ path, or path relative to cwd' },
          cwd: { type: 'string', description: 'Optional working directory for relative paths' },
          content: { type: 'string', description: 'Full file content' },
          append: { type: 'boolean', description: 'Append content to existing file instead of replacing' },
          overwrite: { type: 'boolean', description: 'Set false to refuse overwriting existing files' },
          minBytes: { type: 'number', description: 'Optional minimum byte count guard' },
          minLines: { type: 'number', description: 'Optional minimum line count guard' },
          sha256: { type: 'string', description: 'Optional expected final content sha256' },
          backup: { type: 'boolean', description: 'Optional: create a backup copy before overwriting. Defaults false for speed.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_write_files',
      description: 'Fast VS Code-style bulk file write. Prefer this for projects and multi-file changes instead of file-plan markdown. Preflights all files, writes server-side with temp+rename, and returns compact results.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Optional working directory for relative file paths' },
          expected_file_count: { type: 'number', description: 'Optional guard for exact number of files' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                append: { type: 'boolean' },
                overwrite: { type: 'boolean' },
                minBytes: { type: 'number' },
                minLines: { type: 'number' },
                sha256: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
          backup: { type: 'boolean', description: 'Optional: create backup copies before overwriting. Defaults false for speed.' },
        },
        required: ['files'],
      },
    },
  },

  // ── Shell exec (native tool, server-side) ──
  {
    type: 'function',
    function: {
      name: 'fauna_shell_exec',
      description: 'Run a shell command server-side and get the result back in the SAME assistant turn (no client round-trip). PREFER this over markdown ```bash blocks whenever tools are available — it keeps the agent loop running so you can chain steps without asking the user to continue. Output is captured and returned. SAFE commands (ls, cat, grep, git status, npm test, etc.) execute immediately. UNSAFE/destructive commands (rm -rf, sudo, dd, mkfs, curl|sh, etc.) are refused and you must fall back to a ```bash markdown block so the user can review and approve.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run (single line or && / ; chained).' },
          cwd: { type: 'string', description: 'Optional working directory. Defaults to the user home.' },
          timeoutMs: { type: 'number', description: 'Optional timeout in ms. Default 300000 (5 min). Hard cap.' },
          reason: { type: 'string', description: 'Optional one-line reason this command is being run. Helps with audit and debugging.' },
        },
        required: ['command'],
      },
    },
  },

  // ── File read ──
  {
    type: 'function',
    function: {
      name: 'fauna_read_file',
      description: 'Read a UTF-8 text file from disk and get the contents back in the SAME assistant turn. PREFER this over running cat/head/tail via fauna_shell_exec — it returns structured data and is the canonical way to VERIFY edits before claiming a task is done.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, ~/path, or path relative to cwd.' },
          cwd: { type: 'string', description: 'Optional working directory for relative paths.' },
          startLine: { type: 'number', description: 'Optional 1-based start line. If omitted, reads from the beginning.' },
          endLine: { type: 'number', description: 'Optional 1-based inclusive end line. If omitted, reads to the end.' },
          maxBytes: { type: 'number', description: 'Optional hard cap on bytes returned. Defaults 200000.' },
        },
        required: ['path'],
      },
    },
  },

  // ── Exact-string replace ──
  {
    type: 'function',
    function: {
      name: 'fauna_replace_string',
      description: 'Replace the first occurrence of an exact string in a file. PREFER this over markdown ```replace-string blocks whenever tools are available — it commits server-side and returns the result in the SAME turn so you can verify and chain the next step. The old_string must be unique enough to match exactly once; include 3–5 lines of surrounding context to disambiguate.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, ~/path, or path relative to cwd.' },
          cwd: { type: 'string', description: 'Optional working directory for relative paths.' },
          old_string: { type: 'string', description: 'Exact literal text to replace (must match a single occurrence including whitespace/indentation).' },
          new_string: { type: 'string', description: 'Replacement text. Pass empty string to delete.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },

  // ── Multi-file patch ──
  {
    type: 'function',
    function: {
      name: 'fauna_apply_patch',
      description: 'Apply a VS Code-style apply_patch text across one or more files in a single transaction. Use for multi-file refactors, renames, or deletes. PREFER this over markdown ```apply-patch blocks when tools are available. Patch DSL: *** Begin Patch / *** Update File: <path> / @@ context / -removed / +added / *** End Patch.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'The full apply_patch text including *** Begin Patch and *** End Patch markers.' },
          cwd: { type: 'string', description: 'Optional working directory for relative paths inside the patch.' },
        },
        required: ['patch'],
      },
    },
  },

  // ── Browser actions (renderer-driven via client-tool RPC) ──
  {
    type: 'function',
    function: {
      name: 'fauna_browser',
      description: 'Drive the in-app browser webview (navigate, click, type, extract, screenshot, etc.) and get the result back in the SAME assistant turn. PREFER this over markdown ```browser-action blocks when tools are available — it keeps the agent loop running so you can chain web steps without bouncing back to the user. The webview reuses the existing tab; pass action-specific fields just like the browser-action JSON schema.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'One of: navigate, click, type, extract, evaluate, screenshot, scroll, wait, new-tab, switch-tab, close-tab, list-tabs.',
          },
          url: { type: 'string', description: 'URL for navigate / new-tab.' },
          selector: { type: 'string', description: 'CSS selector for click / type / extract / scroll.' },
          text: { type: 'string', description: 'Text to type for the type action.' },
          js: { type: 'string', description: 'JavaScript to run for the evaluate action.' },
          tabId: { type: 'string', description: 'Tab id for switch-tab / close-tab.' },
          waitMs: { type: 'number', description: 'Milliseconds to wait for the wait action.' },
        },
        required: ['action'],
      },
    },
  },

  // ── Circuit diagrams ──
  {
    type: 'function',
    function: {
      name: 'fauna_list_circuit_symbols',
      description: 'List the component types supported by fauna_render_circuit/fauna_validate_circuit, with their pin names and directions. Call this FIRST when the user asks for a circuit/schematic so you know the available symbols.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_render_circuit',
      description: 'Render a circuit schematic from a JSON DSL. Returns SVG markup the caller can embed in a gen-ui SVG block or an artifact. Component coords are in grid units (default 10 px). Wires reference "compId.pinName". Use fauna_list_circuit_symbols first to learn pin names.',
      parameters: {
        type: 'object',
        properties: {
          doc: {
            type: 'object',
            description: 'Circuit DSL document',
            properties: {
              title: { type: 'string' },
              grid: { type: 'number', description: 'Grid size in SVG units (default 10)' },
              components: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Unique component instance id, e.g. "r1"' },
                    type: { type: 'string', description: 'Symbol type, e.g. "resistor"' },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    rot: { type: 'number', enum: [0, 90, 180, 270] },
                    value: { type: 'string', description: 'Short display label (≤10 chars), e.g. "10k", "1uF", "5V". Long strings are truncated.' },
                    spice: { type: 'string', description: 'Optional. Full SPICE source expression for vsource (e.g. "PULSE(0 5 0 1u 1u 0.5m 1m)", "SIN(0 1 1k)"). Used only by the simulator; keep `value` short for display.' },
                    props: { type: 'object' },
                  },
                  required: ['id', 'type', 'x', 'y'],
                },
              },
              wires: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    from: { description: 'Either "compId.pinName" or { x, y } in grid units' },
                    to:   { description: 'Either "compId.pinName" or { x, y } in grid units' },
                  },
                  required: ['from', 'to'],
                },
              },
            },
            required: ['components'],
          },
        },
        required: ['doc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_validate_circuit',
      description: 'Structural lint of a circuit DSL (no simulation). Detects power shorts, dangling pins, floating islands, duplicate drivers, reversed polarized components, and missing decoupling. ALWAYS call this after fauna_render_circuit and surface errors/warnings to the user.',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'object', description: 'Circuit DSL document (same shape as fauna_render_circuit)' },
        },
        required: ['doc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_simulate_circuit',
      description: 'Compile the circuit DSL to a SPICE netlist and run ngspice to compute real behaviour (operating-point voltages/currents, transient waveforms, AC sweeps, DC sweeps). Requires `ngspice` on PATH; if missing, returns the netlist and an install hint. Use this for questions like "does it oscillate", "what is V_out", "what current flows".',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'object', description: 'Circuit DSL document (same shape as fauna_render_circuit)' },
          analysis: {
            type: 'object',
            description: 'Analysis spec. Defaults to operating point if omitted.',
            properties: {
              type: { type: 'string', enum: ['op', 'tran', 'ac', 'dc'] },
              step: { type: 'string', description: 'tran step, e.g. "1u"' },
              stop: { type: 'string', description: 'tran stop, e.g. "10m"' },
              start: { type: 'string' },
              uic: { type: 'boolean', description: 'tran: use initial conditions' },
              sweep: { type: 'string', enum: ['dec', 'oct', 'lin'], description: 'ac sweep mode' },
              points: { type: 'number', description: 'ac points per decade/octave or linear count' },
              fstart: { type: 'string', description: 'ac start frequency, e.g. "1"' },
              fstop: { type: 'string', description: 'ac stop frequency, e.g. "1Meg"' },
              source: { type: 'string', description: 'dc sweep source name (must match an emitted V<id>)' },
            },
            required: ['type'],
          },
        },
        required: ['doc'],
      },
    },
  },

  // ── Desktop window context (macOS) ──
  {
    type: 'function',
    function: {
      name: 'fauna_list_windows',
      description: 'List the apps the user currently has visible on their desktop, including each window\'s title, position (x,y) and size (w,h), plus which app is frontmost and the main screen bounds. Use this whenever the user asks "what apps are open", "which window is focused", "tile / arrange / move my windows", or you need spatial context before calling fauna_arrange_windows. Works on macOS (requires Accessibility permission for Fauna) and Windows (uses User32).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_arrange_windows',
      description: 'Move and/or resize specific app windows. Pass an array of moves; each move targets one app and sets {x,y,w,h} in screen coordinates. Use fauna_list_windows first to get exact app names and the screen size — then compute coords (e.g. half-screen split, quadrants). windowIndex defaults to 1 (frontmost window of that app); use windowTitle for exact-match targeting. Works on macOS (requires Accessibility permission) and Windows (uses User32 SetWindowPos).',
      parameters: {
        type: 'object',
        properties: {
          moves: {
            type: 'array',
            description: 'List of per-window placements.',
            items: {
              type: 'object',
              properties: {
                app: { type: 'string', description: 'Process name as shown by fauna_list_windows (e.g. "Safari", "Visual Studio Code").' },
                x: { type: 'number', description: 'Target left edge in screen pixels.' },
                y: { type: 'number', description: 'Target top edge in screen pixels.' },
                w: { type: 'number', description: 'Target width in pixels.' },
                h: { type: 'number', description: 'Target height in pixels.' },
                windowIndex: { type: 'number', description: '1-based window index for the app. Defaults to 1.' },
                windowTitle: { type: 'string', description: 'Exact window title to match instead of using windowIndex.' },
              },
              required: ['app'],
            },
          },
        },
        required: ['moves'],
      },
    },
  },
  // ── Backlog (feature intake + prioritization) ──────────────────────────
  {
    type: 'function',
    function: {
      name: 'fauna_feature_request_create',
      description: 'Append a feature request or backlog item to the active project backlog. Use when the user describes wanting something new, when reflection surfaces a gap, or when debate produces a follow-up. Returns the created item id.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title (<= 200 chars).' },
          body:  { type: 'string', description: 'Details, acceptance criteria, links (<= 4000 chars).' },
          tags:  { type: 'array', items: { type: 'string' }, description: 'Optional tags (e.g. must/should/could/wont for MoSCoW, or feature/bug/chore).' },
          rice:  {
            type: 'object',
            description: 'Optional RICE estimate. All numbers 0-10.',
            properties: {
              reach: { type: 'number' }, impact: { type: 'number' },
              confidence: { type: 'number' }, effort: { type: 'number' },
            },
          },
          projectId: { type: 'string', description: 'Project id. Defaults to the active project.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_backlog_list',
      description: 'List backlog items for a project, ordered by score when prioritized. Useful before triage or planning.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project id. Defaults to the active project.' },
          status:    { type: 'string', description: 'Filter: new | groomed | in-progress | done | dropped.' },
          limit:     { type: 'number', description: 'Max items (default 50).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_backlog_prioritize',
      description: 'Score and rank backlog items. method="rice" (default) computes RICE = reach*impact*confidence/effort. method="moscow" buckets by must/should/could/wont tags.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project id. Defaults to the active project.' },
          method:    { type: 'string', enum: ['rice', 'moscow'], description: 'Prioritization method.' },
        },
      },
    },
  },
  // ── Chain of debate (multi-perspective sub-agents + judge) ─────────────
  {
    type: 'function',
    function: {
      name: 'fauna_consult_debate',
      description: 'Run a structured chain-of-debate over a hard decision. Invokes N independent perspectives in parallel (no tools), cross-presents them for critique, then a judge synthesizes a recommendation. Use BEFORE committing to an ambiguous architectural choice or when the user explicitly asks for multiple opinions.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The decision or question to debate.' },
          context:  { type: 'string', description: 'Relevant background (existing approach, constraints). Optional but improves quality.' },
          perspectives: {
            type: 'array',
            items: { type: 'string' },
            description: 'Named perspectives, e.g. ["security", "performance", "simplicity"]. 2-5 recommended. Defaults to ["pragmatist","skeptic","architect"].',
          },
        },
        required: ['question'],
      },
    },
  },
];

// ── Dynamic Widget tool definitions (gated by enableDynamicWidgets flag) ──
// These are registered only when the user opts in via Settings.
export const DYNAMIC_WIDGET_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'fauna_emit_widget',
      description:
        'Render an interactive, sandboxed HTML/JS widget in the chat and register its actions as ephemeral tools for the rest of this conversation. Use this whenever the user wants something interactive (3D viewer, kanban, sliders, custom dashboard) — the widget defines the buttons/controls and YOU call them via the registered tool names (w_<id>__<name>). Bundle.html is the inner DOM, bundle.js is the widget script which calls `widget.on("toolName", async (args) => result)` to wire each tool, and `widget.emit(event, data)` to push state. No network access inside the widget. ' +
        'DO NOT use this for media playback or playlists — for audio, video, podcast lists, YouTube embeds, image carousels, or any "play these items" request, use the inline gen-ui ```gen-ui block with the built-in `MediaPlayer`, `Playlist`, or `Carousel` components instead (they are native, accessible, and savable to projects). Reserve `fauna_emit_widget` for genuinely interactive controls that have no gen-ui equivalent.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short human title shown above the widget.' },
          bundle: {
            type: 'object',
            description: 'The widget code bundle.',
            properties: {
              html: { type: 'string', description: 'Inner HTML for the widget body.' },
              css:  { type: 'string', description: 'Optional CSS for the widget.' },
              js:   { type: 'string', description: 'JS that calls widget.on(name, fn) for each declared tool.' },
            },
            required: ['html', 'js'],
          },
          tools: {
            type: 'array',
            description: 'Tool manifest — each entry becomes callable as w_<widgetId>__<name>.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Tool name, [a-z][a-z0-9_]*.' },
                description: { type: 'string' },
                parameters: { type: 'object', description: 'JSON Schema for the tool arguments.' },
              },
              required: ['name'],
            },
          },
        },
        required: ['bundle', 'tools'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_save_widget_to_playbook',
      description:
        'Save the most recently emitted widget (by widgetId) into the playbook under a memorable name so the user can re-launch it on future tasks. Optionally add a description and tags.',
      parameters: {
        type: 'object',
        properties: {
          widgetId: { type: 'string', description: 'The widgetId returned by fauna_emit_widget.' },
          name: { type: 'string', description: 'Human-readable name, e.g. "3D Model Viewer".' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['widgetId', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_list_playbook',
      description: 'List saved playbook widgets the user can re-launch. Returns metadata only (no bundle source).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional name/description filter.' },
          tag: { type: 'string', description: 'Optional tag filter.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_load_widget_from_playbook',
      description:
        'Re-mount a previously saved widget from the playbook. This calls fauna_emit_widget internally with the saved bundle and tool manifest — the widget will be live for the rest of this conversation.',
      parameters: {
        type: 'object',
        properties: {
          idOrName: { type: 'string', description: 'Playbook entry id or name.' },
        },
        required: ['idOrName'],
      },
    },
  },
];

// ── Tool executor ───────────────────────────────────────────────────────
// Returns { result: string } for each tool call.
// `context` provides access to runtime state (models list, IPC sender, etc.)

export function executeSelfTool(toolName, args, context = {}) {
  switch (toolName) {
    // ── Memory ──
    case 'fauna_remember':
      return JSON.stringify(factsRemember(args.text, args.category));
    case 'fauna_recall':
      return JSON.stringify(factsRecall(args.keywords));
    case 'fauna_forget':
      return JSON.stringify(factsForget(args.id));

    // ── Shell exec ──
    case 'fauna_shell_exec': {
      if (typeof context.runShell !== 'function') {
        return JSON.stringify({ ok: false, error: 'fauna_shell_exec is not available in this context.' });
      }
      return context.runShell(args);
    }

    // ── File read ──
    case 'fauna_read_file': {
      try {
        const abs = _resolveFaunaWritePath(args.path, args.cwd);
        if (!fs.existsSync(abs)) return JSON.stringify({ ok: false, error: 'File not found: ' + abs });
        const st = fs.statSync(abs);
        if (st.isDirectory()) return JSON.stringify({ ok: false, error: 'Path is a directory: ' + abs });
        const maxBytes = typeof args.maxBytes === 'number' && args.maxBytes > 0 ? Math.min(args.maxBytes, 1_000_000) : 200_000;
        let content = fs.readFileSync(abs, 'utf8');
        const totalLines = content.length ? content.split('\n').length : 0;
        let truncated = false;
        if (args.startLine || args.endLine) {
          const lines = content.split('\n');
          const start = Math.max(1, Number(args.startLine) || 1);
          const end = Math.min(lines.length, Number(args.endLine) || lines.length);
          content = lines.slice(start - 1, end).join('\n');
        }
        if (content.length > maxBytes) {
          content = content.slice(0, maxBytes);
          truncated = true;
        }
        return JSON.stringify({ ok: true, path: abs, bytes: st.size, totalLines, content, truncated });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }

    // ── Exact-string replace ──
    case 'fauna_replace_string': {
      try {
        const abs = _resolveFaunaWritePath(args.path, args.cwd);
        if (!fs.existsSync(abs)) return JSON.stringify({ ok: false, error: 'File not found: ' + abs });
        const oldStr = String(args.old_string ?? '');
        const newStr = String(args.new_string ?? '');
        if (!oldStr) return JSON.stringify({ ok: false, error: 'old_string must not be empty' });
        const original = fs.readFileSync(abs, 'utf8');
        const firstIdx = original.indexOf(oldStr);
        if (firstIdx === -1) {
          return JSON.stringify({ ok: false, error: 'old_string not found in file', code: 'OLD_STRING_NOT_FOUND', path: abs });
        }
        const occurrences = original.split(oldStr).length - 1;
        if (occurrences > 1) {
          return JSON.stringify({ ok: false, error: 'old_string matches ' + occurrences + ' times — add surrounding context lines to make it unique', code: 'OLD_STRING_AMBIGUOUS', path: abs, occurrences });
        }
        const updated = original.slice(0, firstIdx) + newStr + original.slice(firstIdx + oldStr.length);
        const buf = Buffer.from(updated, 'utf8');
        _atomicFastWrite(abs, buf);
        return JSON.stringify({ ok: true, path: abs, bytes: buf.length, lines: updated.split('\n').length });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }

    // ── Multi-file patch ──
    case 'fauna_apply_patch': {
      if (typeof context.applyPatch !== 'function') {
        return JSON.stringify({ ok: false, error: 'fauna_apply_patch is not available in this context.' });
      }
      try {
        const results = context.applyPatch({ patch: args.patch, cwd: args.cwd });
        return JSON.stringify({ ok: true, results });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message, blocked: !!e.blocked });
      }
    }

    // ── Browser action (renderer-driven via client-tool RPC) ──
    case 'fauna_browser': {
      if (typeof context.callClientTool !== 'function') {
        return JSON.stringify({ ok: false, error: 'fauna_browser is not available in this context (no renderer attached).' });
      }
      return context.callClientTool('browser', args, { timeoutMs: 60000 }).then(
        function(result) {
          if (typeof result === 'string' && result.length > 8000) {
            return result.slice(0, 8000) + '\n…[truncated ' + (result.length - 8000) + ' chars]';
          }
          return typeof result === 'string' ? result : JSON.stringify(result);
        },
        function(e) {
          return JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) });
        }
      );
    }

    // ── Models ──
    case 'fauna_list_models':
      return JSON.stringify(context.getModels?.() || []);
    case 'fauna_switch_model': {
      const models = context.getModels?.() || [];
      const valid = models.find(m => m.id === args.model);
      if (!valid) return JSON.stringify({ ok: false, error: `Model "${args.model}" not found. Use fauna_list_models to see available models.` });
      context.sendToRenderer?.('self-tool:switch-model', args.model);
      return JSON.stringify({ ok: true, model: args.model, note: 'Model change takes effect on the next message.' });
    }

    // ── Settings ──
    case 'fauna_get_settings':
      return JSON.stringify(context.getSettings?.() || {});
    case 'fauna_set_thinking_budget': {
      const valid = ['off', 'low', 'medium', 'high', 'max'].includes(args.budget);
      if (!valid) return JSON.stringify({ ok: false, error: 'Invalid budget. Use: off, low, medium, high, max' });
      context.sendToRenderer?.('self-tool:set-thinking-budget', args.budget);
      return JSON.stringify({ ok: true, budget: args.budget, note: 'Budget change takes effect on the next message.' });
    }

    // ── Projects ──
    case 'fauna_create_project': {
      const proj = createProject({ name: args.name, description: args.description, rootPath: args.rootPath });
      return JSON.stringify({ ok: true, project: { id: proj.id, name: proj.name, rootPath: proj.rootPath } });
    }
    case 'fauna_list_projects': {
      const all = getAllProjects();
      return JSON.stringify(all.map(p => ({ id: p.id, name: p.name, rootPath: p.rootPath, description: p.description })));
    }

    // ── Instructions ──
    case 'fauna_save_instruction': {
      // Server-side: write directly to playbook localStorage is client-only,
      // so we send an event to renderer to call addPlaybookFromAI()
      context.sendToRenderer?.('self-tool:save-instruction', {
        title: args.title,
        body: args.body,
        tags: args.tags || [],
      });
      return JSON.stringify({ ok: true, title: args.title });
    }

    // ── Notifications ──
    case 'fauna_send_notification': {
      context.sendNotification?.(args.title, args.body);
      return JSON.stringify({ ok: true, title: args.title });
    }

    // ── Fast file writes ──
    case 'fauna_write_file': {
      try {
        const started = Date.now();
        const result = _writeFastFile(args || {});
        return JSON.stringify({ ok: true, ms: Date.now() - started, result });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
    // ── Circuit tools ──
    case 'fauna_list_circuit_symbols': {
      const types = listSymbolTypes().map(t => {
        const s = SYMBOLS[t];
        return {
          type: t,
          pins: Object.entries(s.pins).map(([name, def]) => ({ name, dir: def.dir })),
          aliases: s.pinAliases ? Object.keys(s.pinAliases) : [],
          polarized: !!s.polarized,
          isPower: s.isPower || null,
        };
      });
      return JSON.stringify({ ok: true, types });
    }
    case 'fauna_render_circuit': {
      try {
        const result = renderCircuit(args.doc);
        return JSON.stringify({ ok: true, ...result });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
    case 'fauna_validate_circuit': {
      try {
        const result = validateCircuit(args.doc);
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
    case 'fauna_simulate_circuit': {
      return simulateCircuit(args.doc, args.analysis)
        .then(r => {
          // Trim data arrays to keep tool-output payloads reasonable.
          if (r.results && r.results.plots) {
            for (const p of r.results.plots) {
              if (p.points > 200) {
                const stride = Math.ceil(p.points / 200);
                const sampled = {};
                for (const v of p.variables) sampled[v] = p.data[v].filter((_, i) => i % stride === 0);
                p.data = sampled;
                p.sampledFrom = p.points;
                p.points = sampled[p.variables[0]].length;
              }
            }
          }
          return JSON.stringify(r);
        })
        .catch(e => JSON.stringify({ ok: false, error: e.message }));
    }

    case 'fauna_write_files': {
      try {
        const started = Date.now();
        const files = Array.isArray(args.files) ? args.files : [];
        if (!files.length) throw new Error('files array required');
        if (args.expected_file_count != null && Number(args.expected_file_count) !== files.length) {
          throw new Error('Expected ' + args.expected_file_count + ' files, received ' + files.length);
        }
        const seen = new Set();
        for (const file of files) {
          const abs = _resolveFaunaWritePath(file.path, args.cwd);
          if (seen.has(abs)) throw new Error('Duplicate write target: ' + abs);
          seen.add(abs);
          if (file.content === undefined) throw new Error('Missing content for ' + file.path);
        }
        const results = files.map(file => _writeFastFile({ ...file, cwd: args.cwd, backup: args.backup || file.backup }));
        return JSON.stringify({ ok: true, ms: Date.now() - started, results });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }

    // ── Dynamic Widgets ─────────────────────────────────────────────────
    case 'fauna_emit_widget':
      return _emitWidget(args, context);

    case 'fauna_save_widget_to_playbook': {
      try {
        const reg = context.getLiveWidget?.(args.widgetId);
        if (!reg) {
          return JSON.stringify({ ok: false, error: `Widget "${args.widgetId}" not found in this conversation. Emit it first with fauna_emit_widget.` });
        }
        const result = savePlaybookEntry({
          name: args.name,
          description: args.description,
          tags: args.tags,
          bundle: reg.bundle,
          tools: reg.tools,
        });
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }

    case 'fauna_list_playbook':
      return JSON.stringify(listPlaybookEntries({ tag: args.tag, query: args.query }));

    case 'fauna_load_widget_from_playbook': {
      const entry = getPlaybookEntry(args.idOrName);
      if (!entry) return JSON.stringify({ ok: false, error: `No playbook entry "${args.idOrName}"` });
      touchPlaybookEntry(entry.id);
      return _emitWidget({
        title: entry.name,
        bundle: entry.bundle,
        tools: entry.tools,
        _fromPlaybook: entry.id,
      }, context);
    }

    // ── Desktop window context (macOS) ──
    case 'fauna_list_windows': {
      return Promise.all([
        macListVisibleWindows().catch(e => ({ ok: false, error: e.message })),
        macGetScreenBounds().catch(() => ({ ok: false })),
      ]).then(([info, screen]) => JSON.stringify({
        ...info,
        screen: screen && screen.ok ? screen : null,
      }));
    }
    case 'fauna_arrange_windows': {
      const moves = Array.isArray(args && args.moves) ? args.moves : [];
      return macArrangeWindows(moves)
        .then(r => JSON.stringify(r))
        .catch(e => JSON.stringify({ ok: false, error: e.message }));
    }

    // ── Backlog ──
    case 'fauna_feature_request_create': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid) return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      const entry = addBacklogItem(pid, {
        title: args.title, body: args.body, tags: args.tags, rice: args.rice,
        source: 'agent',
      });
      if (!entry) return JSON.stringify({ ok: false, error: 'project not found' });
      return JSON.stringify({ ok: true, id: entry.id, projectId: pid, item: entry });
    }
    case 'fauna_backlog_list': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid) return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      return JSON.stringify({ ok: true, items: listBacklog(pid, { status: args.status, limit: args.limit }) });
    }
    case 'fauna_backlog_prioritize': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid) return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      const r = prioritizeBacklog(pid, { method: args.method || 'rice' });
      if (!r) return JSON.stringify({ ok: false, error: 'project not found' });
      return JSON.stringify(r);
    }

    // ── Chain of debate ──
    case 'fauna_consult_debate': {
      if (typeof context.callLLM !== 'function') {
        return JSON.stringify({ ok: false, error: 'LLM bridge not available in this context' });
      }
      const question = String(args.question || '').trim();
      if (!question) return JSON.stringify({ ok: false, error: 'question required' });
      const ctx = String(args.context || '');
      const perspectives = Array.isArray(args.perspectives) && args.perspectives.length
        ? args.perspectives.slice(0, 5).map(String)
        : ['pragmatist', 'skeptic', 'architect'];

      return (async () => {
        const round1 = await Promise.all(perspectives.map(p => context.callLLM({
          system: `You are the "${p}" perspective in a structured debate. Give a sharp, opinionated 4-6 sentence answer from your perspective only. Do not hedge. No preamble.`,
          user: (ctx ? `Context:\n${ctx}\n\n` : '') + `Question: ${question}`,
          maxTokens: 350,
          temperature: 0.6,
        }).then(text => ({ perspective: p, text }))));

        const proposalsText = round1.map(r => `### ${r.perspective}\n${r.text}`).join('\n\n');

        const round2 = await Promise.all(round1.map(r => context.callLLM({
          system: `You are the "${r.perspective}" perspective. Critique the OTHER perspectives' proposals below. 3-5 sentences. Where do they fail? What did they miss? Be specific. No preamble.`,
          user: `Question: ${question}\n\nAll proposals:\n${proposalsText}\n\nYour own proposal was:\n${r.text}\n\nCritique the others.`,
          maxTokens: 300,
          temperature: 0.5,
        }).then(text => ({ perspective: r.perspective, text }))));

        const critiquesText = round2.map(c => `### ${c.perspective} critiques\n${c.text}`).join('\n\n');

        const judge = await context.callLLM({
          system: 'You are an impartial judge. Read the proposals and critiques, then output: (1) the single recommended decision in one sentence, (2) the top 2-3 reasons, (3) explicit risks/tradeoffs, (4) any open questions. Be concrete and short.',
          user: `Question: ${question}\n\nProposals:\n${proposalsText}\n\nCritiques:\n${critiquesText}`,
          maxTokens: 500,
          temperature: 0.3,
        });

        return JSON.stringify({
          ok: true,
          question,
          perspectives: round1,
          critiques: round2,
          recommendation: judge,
        });
      })();
    }

    default:
      return JSON.stringify({ ok: false, error: `Unknown self-tool: ${toolName}` });
  }
}

// ── Dynamic Widget helpers ────────────────────────────────────────────
function _emitWidget(args, context) {
  try {
    if (!args?.bundle?.html || !args?.bundle?.js) {
      return JSON.stringify({ ok: false, error: 'bundle.html and bundle.js required' });
    }
    if (!Array.isArray(args.tools)) {
      return JSON.stringify({ ok: false, error: 'tools array required' });
    }
    const widgetId = 'w' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    const tools = args.tools.map(t => ({
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    }));
    const registration = { widgetId, tools, bundle: args.bundle };

    // Mirror the bundle to a temp folder inside ~/Documents/Fauna so the user
    // can inspect / re-open / share the generated widget files outside the
    // chat UI. This is best-effort — failure here must not break emission.
    let savedPath = null;
    try {
      const root = process.env.FAUNA_DOCS || path.join(os.homedir(), 'Documents', 'Fauna');
      const dir = path.join(root, '.widgets-temp', widgetId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), String(args.bundle.html || ''), 'utf8');
      fs.writeFileSync(path.join(dir, 'widget.js'),  String(args.bundle.js   || ''), 'utf8');
      if (args.bundle.css) fs.writeFileSync(path.join(dir, 'widget.css'), String(args.bundle.css), 'utf8');
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        widgetId,
        title: args.title || null,
        createdAt: new Date().toISOString(),
        tools: tools.map(t => ({ name: t.name, description: t.description })),
      }, null, 2), 'utf8');
      savedPath = dir;
    } catch (e) {
      console.warn('[fauna_emit_widget] could not mirror widget to disk:', e.message);
    }

    // Register the live widget so subsequent save-to-playbook / RPC routing
    // can find its bundle. The context wires both functions in chat.js.
    context.registerLiveWidget?.(widgetId, registration);

    // Notify the frontend via SSE so the iframe is mounted in the chat UI.
    context.sendSse?.({
      type: 'widget_emitted',
      widgetId,
      title: args.title || null,
      bundle: args.bundle,
      tools: tools.map(t => ({ name: t.name, description: t.description })),
      fromPlaybook: args._fromPlaybook || null,
    });

    // Pack a tool_result the model can see. We strip the bundle from the
    // model-visible payload — the model doesn't need to re-read its own code,
    // and including it would balloon the context window.
    return packWidgetResult(
      {
        ok: true,
        widgetId,
        title: args.title || null,
        exposed: tools.map(t => `w_${widgetId.replace(/[^a-z0-9]/gi,'').slice(0,24)}__${t.name}`),
        savedPath,
        note: 'Widget is now live. Call the exposed tool names to interact with it.' +
          (savedPath ? ` Files mirrored to ${savedPath}` : ''),
      },
      { widgetId, tools },
    );
  } catch (e) {
    return JSON.stringify({ ok: false, error: e.message });
  }
}

// ── Check if a tool name is a self-tool ─────────────────────────────────

const SELF_TOOL_NAMES = new Set([
  ...SELF_TOOL_DEFS.map(d => d.function.name),
  ...DYNAMIC_WIDGET_TOOL_DEFS.map(d => d.function.name),
]);
export function isSelfTool(name) {
  return SELF_TOOL_NAMES.has(name);
}

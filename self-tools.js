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
];

// ── Dynamic Widget tool definitions (gated by enableDynamicWidgets flag) ──
// These are registered only when the user opts in via Settings.
export const DYNAMIC_WIDGET_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'fauna_emit_widget',
      description:
        'Render an interactive, sandboxed HTML/JS widget in the chat and register its actions as ephemeral tools for the rest of this conversation. Use this whenever the user wants something interactive (3D viewer, kanban, sliders, custom dashboard) — the widget defines the buttons/controls and YOU call them via the registered tool names (w_<id>__<name>). Bundle.html is the inner DOM, bundle.js is the widget script which calls `widget.on("toolName", async (args) => result)` to wire each tool, and `widget.emit(event, data)` to push state. No network access inside the widget.',
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
        note: 'Widget is now live. Call the exposed tool names to interact with it.',
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

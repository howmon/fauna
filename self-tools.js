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

    default:
      return JSON.stringify({ ok: false, error: `Unknown self-tool: ${toolName}` });
  }
}

// ── Check if a tool name is a self-tool ─────────────────────────────────

const SELF_TOOL_NAMES = new Set(SELF_TOOL_DEFS.map(d => d.function.name));
export function isSelfTool(name) {
  return SELF_TOOL_NAMES.has(name);
}

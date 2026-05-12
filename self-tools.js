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

    default:
      return JSON.stringify({ ok: false, error: `Unknown self-tool: ${toolName}` });
  }
}

// ── Check if a tool name is a self-tool ─────────────────────────────────

const SELF_TOOL_NAMES = new Set(SELF_TOOL_DEFS.map(d => d.function.name));
export function isSelfTool(name) {
  return SELF_TOOL_NAMES.has(name);
}

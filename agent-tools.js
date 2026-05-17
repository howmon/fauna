// ── Agent Tools — Custom tool loader, built-in tool wrappers, MCP auto-start ──
// Provides the tool infrastructure for the agent system:
// 1. Load custom JS tools from agent directories and run them in a VM sandbox
// 2. Generate scoped built-in tool definitions (shell, file, browser, fetch)
// 3. Auto-start MCP servers declared by agents
// 4. Execute tool calls and return results

import { createRequire } from 'module';
import vm from 'vm';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { checkFilePath, checkNetworkAccess, checkShellCommand, getSandboxedEnv, getResourceLimits, audit } from './agent-sandbox.js';

const _require = createRequire(import.meta.url);
const { exec: _exec, spawn: _spawn } = _require('child_process');

const HOME = os.homedir();

// ── Custom tool loader ──────────────────────────────────────────────────

/**
 * Load custom tools from an agent's tools/ directory.
 * Each tool JS file should export: { name, description, parameters, execute }
 * Returns array of { definition, execute } objects.
 */
function loadCustomTools(agentDir, manifest) {
  const toolDefs = manifest.tools || [];
  const loaded = [];

  for (const toolRef of toolDefs) {
    const toolPath = path.resolve(agentDir, toolRef.file);
    // Security: ensure the tool file is inside the agent directory
    if (!toolPath.startsWith(path.resolve(agentDir) + path.sep)) {
      console.warn(`[agent-tools] Skipping tool with path outside agent dir: ${toolRef.file}`);
      continue;
    }
    if (!fs.existsSync(toolPath)) {
      console.warn(`[agent-tools] Tool file not found: ${toolPath}`);
      continue;
    }

    try {
      const code = fs.readFileSync(toolPath, 'utf8');
      const toolModule = loadToolInSandbox(code, toolPath, manifest);
      if (toolModule && toolModule.name && toolModule.execute) {
        loaded.push({
          name: toolModule.name,
          source: 'custom',
          definition: {
            type: 'function',
            function: {
              name: toolModule.name,
              description: toolModule.description || toolRef.name || toolModule.name,
              parameters: toolModule.parameters || { type: 'object', properties: {} },
            },
          },
          execute: toolModule.execute,
        });
      }
    } catch (e) {
      console.error(`[agent-tools] Failed to load tool ${toolRef.file}: ${e.message}`);
    }
  }

  return loaded;
}

/**
 * Load a tool's JS code in a restricted VM context.
 * The tool gets a minimal sandbox: no process, no require, no network access.
 */
function loadToolInSandbox(code, filePath, manifest) {
  const exports = {};
  const module = { exports };

  const sandbox = {
    module,
    exports,
    console: {
      log: (...args) => console.log(`[tool:${path.basename(filePath)}]`, ...args),
      warn: (...args) => console.warn(`[tool:${path.basename(filePath)}]`, ...args),
      error: (...args) => console.error(`[tool:${path.basename(filePath)}]`, ...args),
    },
    // Safe globals
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Promise,
    Symbol,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    // URL parsing (safe read-only utility)
    URL,
    URLSearchParams,
    // Timers (bounded)
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30000)),
    clearTimeout,
    // TextEncoder/Decoder for data handling
    TextEncoder,
    TextDecoder,
  };

  const ctx = vm.createContext(sandbox);
  const script = new vm.Script(code, {
    filename: filePath,
    timeout: 5000, // 5s compilation timeout
  });
  script.runInContext(ctx, { timeout: 5000 });

  return module.exports && module.exports.name ? module.exports : exports;
}

// ── Tool execution context ──────────────────────────────────────────────

/**
 * Create a scoped execution context for a custom tool.
 * This provides the `context` object passed to tool.execute().
 */
function createToolContext(manifest, agentName) {
  const permissions = manifest.permissions || {};

  return {
    // Scoped fetch — only allowed domains
    fetch: async (url, opts = {}) => {
      const check = checkNetworkAccess(url, permissions, agentName);
      if (!check.allowed) throw new Error('Network blocked: ' + check.reason);

      const response = await fetch(url, {
        ...opts,
        headers: { ...opts.headers, 'User-Agent': 'Fauna-Agent/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, content: text, headers: Object.fromEntries(response.headers) };
    },

    // Scoped file read
    readFile: async (filePath) => {
      const abs = path.resolve(filePath.replace(/^~/, HOME));
      const check = checkFilePath(abs, 'read', permissions, agentName);
      if (!check.allowed) throw new Error('File read blocked: ' + check.reason);
      return fs.readFileSync(abs, 'utf8');
    },

    // Scoped file write
    writeFile: async (filePath, content) => {
      const abs = path.resolve(filePath.replace(/^~/, HOME));
      const check = checkFilePath(abs, 'write', permissions, agentName);
      if (!check.allowed) throw new Error('File write blocked: ' + check.reason);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      return { ok: true, path: abs, bytes: Buffer.byteLength(content) };
    },

    // Key-value store scoped to this agent
    store: createAgentStore(agentName),

    // Agent metadata
    agent: {
      name: agentName,
      permissions: { ...permissions },
    },
  };
}

/**
 * Simple key-value store scoped to each agent.
 * Stored at ~/.config/fauna/agents/<name>/.store.json
 */
function createAgentStore(agentName) {
  const CONFIG_DIR = path.join(HOME, '.config', 'fauna');
  const storePath = path.join(CONFIG_DIR, 'agents', agentName, '.store.json');

  const load = () => {
    try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch (_) { return {}; }
  };
  const save = (data) => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');
  };

  return {
    get: (key) => { const d = load(); return d[key] ?? null; },
    set: (key, value) => { const d = load(); d[key] = value; save(d); },
    delete: (key) => { const d = load(); delete d[key]; save(d); },
    keys: () => Object.keys(load()),
  };
}

// ── Execute a custom tool call ──────────────────────────────────────────

/**
 * Execute a loaded custom tool with the given arguments.
 * Runs the tool's execute() function with a scoped context.
 * Returns the result as a string for the AI.
 */
async function executeCustomTool(tool, args, manifest, agentName) {
  const limits = getResourceLimits(manifest);
  const context = createToolContext(manifest, agentName);

  // Wrap execution with a timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Tool execution timed out')), limits.timeout);
  });

  try {
    const result = await Promise.race([
      tool.execute(args, context),
      timeoutPromise,
    ]);

    audit(agentName, 'tool-exec', tool.name, true);

    // Stringify result for the AI
    if (typeof result === 'string') return result;
    return JSON.stringify(result, null, 2);
  } catch (e) {
    audit(agentName, 'tool-exec', tool.name + ': ' + e.message, false);
    throw e;
  }
}

// ── Built-in tool definitions ───────────────────────────────────────────

/**
 * Generate scoped built-in tool definitions for an agent based on permissions.
 * These are OpenAI function-calling tool definitions that the AI model can use.
 */
function getBuiltInToolDefinitions(permissions) {
  const tools = [];

  if (permissions.shell) {
    tools.push({
      type: 'function',
      function: {
        name: 'agent_shell_exec',
        description: 'Execute a shell command in a zsh shell. Subprocess spawning is fully supported — npx, node, python, pip, brew, etc. all work and can spawn their own subprocesses. Commands are checked against a security allowlist; sensitive env vars are sanitised but npm/node tooling env vars are preserved so package managers work correctly.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to execute' },
            cwd: { type: 'string', description: 'Working directory (optional, defaults to home)' },
          },
          required: ['command'],
        },
      },
    });
  }

  if (permissions.fileRead && permissions.fileRead.length > 0) {
    tools.push({
      type: 'function',
      function: {
        name: 'agent_read_file',
        description: 'Read the contents of a file. Access is restricted to the agent\'s allowed read paths: ' + permissions.fileRead.join(', '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read' },
          },
          required: ['path'],
        },
      },
    });
  }

  if (permissions.fileWrite && permissions.fileWrite.length > 0) {
    tools.push({
      type: 'function',
      function: {
        name: 'agent_write_file',
        description: 'Write content to one file (full overwrite). Prefer agent_write_files for multiple new project files, and agent_str_replace for targeted edits. Access is restricted to: ' + permissions.fileWrite.join(', '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to write' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['path', 'content'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'agent_write_files',
        description: 'Write multiple project files in one structured operation. This avoids markdown fence truncation for complex projects. Each entry may include sha256 for final content verification. Access is restricted to: ' + permissions.fileWrite.join(', '),
        parameters: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'File path to write' },
                  content: { type: 'string', description: 'Full file content' },
                  append: { type: 'boolean', description: 'Append instead of overwrite' },
                  sha256: { type: 'string', description: 'Optional SHA-256 of the final on-disk content' },
                },
                required: ['path', 'content'],
              },
            },
          },
          required: ['files'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'agent_str_replace',
        description: 'Replace an exact string in a file with new content. Reads the file, substitutes old_str → new_str exactly once, writes back. Fails if old_str is not found or appears more than once. Prefer this over agent_write_file for targeted edits. Access is restricted to: ' + permissions.fileWrite.join(', '),
        parameters: {
          type: 'object',
          properties: {
            path:    { type: 'string', description: 'File path to edit' },
            old_str: { type: 'string', description: 'Exact string to find and replace (must appear exactly once)' },
            new_str: { type: 'string', description: 'Replacement string' },
          },
          required: ['path', 'old_str', 'new_str'],
        },
      },
    });
  }

  if (permissions.browser) {
    tools.push({
      type: 'function',
      function: {
        name: 'agent_fetch_url',
        description: 'Fetch a web page and return its content. Network access is restricted to allowed domains.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch' },
          },
          required: ['url'],
        },
      },
    });
  }

  return tools;
}

/**
 * Execute a built-in agent tool call. Routes through the sandbox.
 * @param {Function} [onOutput] - optional callback(chunk) for streaming shell output
 * @param {object} [opts] - optional { onWaitingForInput(killId, hint), registerProcess(killId, child) }
 */
async function executeBuiltInTool(toolName, args, permissions, agentName, onOutput, opts) {
  switch (toolName) {
    case 'agent_shell_exec': {
      const check = checkShellCommand(args.command, permissions, agentName);
      if (!check.allowed) return 'BLOCKED: ' + check.reason;

      const env = getSandboxedEnv(permissions);
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh';
      const cwd = args.cwd || HOME;

      return new Promise((resolve) => {
        const shellFlag = process.platform === 'win32' ? '-Command' : '-c';
        const child = _spawn(shell, [shellFlag, args.command], {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Register process for stdin support
        const killId = 'agent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        if (opts && opts.registerProcess) opts.registerProcess(killId, child);

        let stdout = '';
        let stderr = '';
        let recentOutput = ''; // rolling last ~500 chars of output for hint context
        let idleTimer = null;
        const MAX_BUF = 10 * 1024 * 1024;
        const IDLE_MS = 4000;

        function resetIdleTimer() {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (!child.killed && child.exitCode === null) {
              // Use the last 3 non-empty lines of recent output as the hint
              const lines = recentOutput.split('\n').map(l => l.trim()).filter(Boolean);
              const hint = lines.slice(-3).join('\n');
              if (opts && opts.onWaitingForInput) {
                opts.onWaitingForInput(killId, hint, recentOutput);
              } else if (onOutput) {
                onOutput('\n⏳ Process appears to be waiting for input: ' + hint + '\n');
              }
            }
          }, IDLE_MS);
        }

        child.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          recentOutput = (recentOutput + text).slice(-500);
          if (stdout.length < MAX_BUF) stdout += text;
          if (onOutput) onOutput(text);
          resetIdleTimer();
        });

        child.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          recentOutput = (recentOutput + text).slice(-500);
          if (stderr.length < MAX_BUF) stderr += text;
          if (onOutput) onOutput(text);
          resetIdleTimer();
        });

        resetIdleTimer();

        const timeout = setTimeout(() => {
          if (idleTimer) clearTimeout(idleTimer);
          try { child.kill('SIGTERM'); } catch (_) {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
        }, 300000);

        child.on('close', (code) => {
          clearTimeout(timeout);
          if (idleTimer) clearTimeout(idleTimer);
          if (opts && opts.unregisterProcess) opts.unregisterProcess(killId);
          const exitCode = code ?? 0;
          let result = '';
          if (stdout) result += stdout;
          if (stderr) result += (result ? '\n\nSTDERR:\n' : '') + stderr;
          if (!stdout && !stderr) result = exitCode === 0 ? '(no output)' : 'Process exited with no output';
          result += '\n\n[exit code: ' + exitCode + ']';
          resolve(result);
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          if (idleTimer) clearTimeout(idleTimer);
          if (opts && opts.unregisterProcess) opts.unregisterProcess(killId);
          resolve('Error: ' + err.message + '\n\n[exit code: 1]');
        });
      });
    }

    case 'agent_read_file': {
      const abs = path.resolve((args.path || '').replace(/^~/, HOME));
      const check = checkFilePath(abs, 'read', permissions, agentName);
      if (!check.allowed) return 'BLOCKED: ' + check.reason;
      try {
        return fs.readFileSync(abs, 'utf8');
      } catch (e) {
        return 'Error reading file: ' + e.message;
      }
    }

    case 'agent_write_file': {
      const abs = path.resolve((args.path || '').replace(/^~/, HOME));
      const check = checkFilePath(abs, 'write', permissions, agentName);
      if (!check.allowed) return 'BLOCKED: ' + check.reason;
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, args.content || '', 'utf8');
        return 'File written: ' + abs + ' (' + Buffer.byteLength(args.content || '') + ' bytes)';
      } catch (e) {
        return 'Error writing file: ' + e.message;
      }
    }

    case 'agent_write_files': {
      const files = Array.isArray(args.files) ? args.files : [];
      if (!files.length) return 'Error: files array is required';
      const results = [];
      try {
        for (const item of files) {
          if (!item || !item.path) return 'Error: each file entry requires path';
          if (item.content === undefined) return 'Error: missing content for ' + item.path;
          const abs = path.resolve(String(item.path).replace(/^~/, HOME));
          const check = checkFilePath(abs, 'write', permissions, agentName);
          if (!check.allowed) return 'BLOCKED: ' + check.reason;
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          let finalContent = String(item.content ?? '');
          if (item.append && fs.existsSync(abs)) finalContent = fs.readFileSync(abs, 'utf8') + finalContent;
          const sha256 = crypto.createHash('sha256').update(Buffer.from(finalContent, 'utf8')).digest('hex');
          if (item.sha256 && item.sha256 !== sha256) return 'Error: sha256 mismatch for ' + abs + ': expected ' + item.sha256 + ', got ' + sha256;
          fs.writeFileSync(abs, finalContent, 'utf8');
          results.push({ path: abs, bytes: Buffer.byteLength(finalContent), sha256, op: item.append ? 'append' : 'write' });
        }
        return 'Files written: ' + JSON.stringify(results);
      } catch (e) {
        return 'Error writing files: ' + e.message;
      }
    }

    case 'agent_str_replace': {
      const abs = path.resolve((args.path || '').replace(/^~/, HOME));
      const checkR = checkFilePath(abs, 'read', permissions, agentName);
      if (!checkR.allowed) return 'BLOCKED: ' + checkR.reason;
      const checkW = checkFilePath(abs, 'write', permissions, agentName);
      if (!checkW.allowed) return 'BLOCKED: ' + checkW.reason;
      if (!args.old_str) return 'Error: old_str is required';
      let original;
      try {
        original = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        return 'Error reading file: ' + e.message;
      }
      const count = original.split(args.old_str).length - 1;
      if (count === 0) return 'Error: old_str not found in ' + abs;
      if (count > 1) return 'Error: old_str appears ' + count + ' times — must be unique. Add more context to make it unambiguous.';
      const updated = original.replace(args.old_str, args.new_str);
      try {
        fs.writeFileSync(abs, updated, 'utf8');
        return 'Replaced in ' + abs + ' — ' + Buffer.byteLength(updated) + ' bytes written';
      } catch (e) {
        return 'Error writing file: ' + e.message;
      }
    }

    case 'agent_fetch_url': {
      const check = checkNetworkAccess(args.url, permissions, agentName);
      if (!check.allowed) return 'BLOCKED: ' + check.reason;
      try {
        const response = await globalThis.fetch(args.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Fauna-Agent/1.0)' },
          signal: AbortSignal.timeout(15000),
          redirect: 'follow',
        });
        const text = await response.text();
        // Truncate large responses
        const maxLen = 50000;
        const content = text.length > maxLen ? text.slice(0, maxLen) + '\n\n[Truncated — ' + text.length + ' chars total]' : text;
        return 'HTTP ' + response.status + '\n\n' + content;
      } catch (e) {
        return 'Fetch error: ' + e.message;
      }
    }

    default:
      return 'Unknown tool: ' + toolName;
  }
}

// ── MCP server auto-start ───────────────────────────────────────────────

const _agentMCPProcesses = new Map(); // agentName → { name, process }[]

/**
 * Start MCP servers declared by an agent manifest.
 * Returns an array of { name, port, ready } objects.
 */
async function startAgentMCPServers(manifest, agentName) {
  const mcpDefs = manifest.permissions?.mcp || [];
  if (!mcpDefs.length) return [];

  const started = [];

  for (const mcp of mcpDefs) {
    if (!mcp.name || !mcp.command) continue;

    // Check if already running for this agent
    const existing = _agentMCPProcesses.get(agentName);
    if (existing?.find(p => p.name === mcp.name)) {
      started.push({ name: mcp.name, status: 'already-running' });
      continue;
    }

    try {
      const args = mcp.args || [];
      const env = { ...process.env, ...(mcp.env || {}) };

      const proc = _require('child_process').spawn(mcp.command, args, {
        env,
        cwd: mcp.cwd || HOME,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Track the process
      const procs = _agentMCPProcesses.get(agentName) || [];
      procs.push({ name: mcp.name, process: proc });
      _agentMCPProcesses.set(agentName, procs);

      // Log stderr
      proc.stderr.on('data', (data) => {
        console.log(`[MCP:${mcp.name}] ${data.toString().trim()}`);
      });

      proc.on('exit', (code) => {
        console.log(`[MCP:${mcp.name}] exited with code ${code}`);
        const p = _agentMCPProcesses.get(agentName);
        if (p) {
          const idx = p.findIndex(x => x.name === mcp.name);
          if (idx >= 0) p.splice(idx, 1);
        }
      });

      audit(agentName, 'mcp-start', mcp.name, true);
      started.push({ name: mcp.name, status: 'started', pid: proc.pid });
    } catch (e) {
      console.error(`[agent-tools] Failed to start MCP server ${mcp.name}: ${e.message}`);
      audit(agentName, 'mcp-start', mcp.name + ': ' + e.message, false);
      started.push({ name: mcp.name, status: 'error', error: e.message });
    }
  }

  return started;
}

/**
 * Stop all MCP servers for a given agent.
 */
function stopAgentMCPServers(agentName) {
  const procs = _agentMCPProcesses.get(agentName);
  if (!procs) return;

  for (const p of procs) {
    try {
      p.process.kill('SIGTERM');
      console.log(`[MCP:${p.name}] stopped`);
      audit(agentName, 'mcp-stop', p.name, true);
    } catch (_) {}
  }

  _agentMCPProcesses.delete(agentName);
}

// ── Get all tools for an agent ──────────────────────────────────────────

/**
 * Assemble the complete tool set for an agent:
 * - Built-in tools (based on permissions)
 * - Custom tools (from agent's tools/ directory)
 * Returns { definitions: toolDef[], handlers: Map<name, executeFn> }
 */
function getAgentTools(agentDir, manifest, agentName) {
  const permissions = manifest.permissions || {};

  // Collect built-in tool definitions
  const builtInDefs = getBuiltInToolDefinitions(permissions);

  // Load custom tools
  const customTools = agentDir ? loadCustomTools(agentDir, manifest) : [];

  // Merge all definitions
  const definitions = [
    ...builtInDefs,
    ...customTools.map(t => t.definition),
  ];

  // Build handler map
  const handlers = new Map();
  // Built-in handlers
  for (const def of builtInDefs) {
    const name = def.function.name;
    handlers.set(name, (args, onOutput, opts) => executeBuiltInTool(name, args, permissions, agentName, onOutput, opts));
  }
  // Custom tool handlers
  for (const tool of customTools) {
    handlers.set(tool.name, (args) => executeCustomTool(tool, args, manifest, agentName));
  }

  return { definitions, handlers };
}

// ── Exports ──────────────────────────────────────────────────────────────

export {
  loadCustomTools,
  getBuiltInToolDefinitions,
  executeBuiltInTool,
  executeCustomTool,
  createToolContext,
  startAgentMCPServers,
  stopAgentMCPServers,
  getAgentTools,
};

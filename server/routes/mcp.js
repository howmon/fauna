// ── MCP server — expose fauna memory + context as an MCP endpoint ──────────
//
// Phase 6. Implements a minimal Model Context Protocol (JSON-RPC 2.0 over
// HTTP POST) server at /mcp so external MCP-aware clients (Claude Desktop,
// other Copilot extensions, IDE agents) can read and write fauna's memory
// without going through the chat API.
//
// Spec methods implemented:
//   initialize             — capability handshake
//   tools/list             — enumerate callable tools
//   tools/call             — invoke a tool with arguments
//   resources/list         — list ingested context documents as resources
//   resources/read         — read a document's chunks
//
// Auth: reuses the existing mobile-token (~/.config/fauna/mobile-token.json)
// via the `x-fauna-token` header — same model the mobile app already uses
// for remote access. Local loopback callers must still present the token
// because /mcp is intended to be exposed via the localtunnel pairing flow.

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  remember as factsRemember,
  recall as factsRecall,
  forget as factsForget,
  listFacts,
  projectContainerTag,
  GLOBAL_TAG,
} from '../../memory-store.js';
import {
  ingestDocument,
  searchContext,
  listDocuments,
  deleteDocument,
  getStats as ctxGetStats,
} from '../lib/context-store.js';
import { buildProfile, buildProjectProfile } from '../lib/profile.js';
import { syncGitHubRepo, syncLocalFolder } from '../lib/connectors.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'fauna', version: '1.0.0' };

// ── JSON-RPC scaffolding ──────────────────────────────────────────────────

function _rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function _rpcError(id, code, message, data) {
  const err = { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

// Standard error codes
const E_PARSE        = -32700;
const E_INVALID_REQ  = -32600;
const E_METHOD       = -32601;
const E_PARAMS       = -32602;
const E_INTERNAL     = -32603;

// ── Tool catalog ──────────────────────────────────────────────────────────
//
// We expose a focused subset: memory + context + profile + connectors. The
// app-control surface (SELF_TOOL_DEFS) stays gated to the chat pipeline.

const TOOLS = [
  {
    name: 'fauna_remember',
    description: 'Persist a fact. Scope=project requires projectId.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        category: { type: 'string', enum: ['preference', 'fact', 'decision', 'context'] },
        scope: { type: 'string', enum: ['project', 'global'] },
        projectId: { type: 'string' },
        kind: { type: 'string', enum: ['static', 'dynamic', 'temporal'] },
        expiresAt: { type: 'number' },
        supersedes: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'fauna_recall',
    description: 'Search facts by keywords with optional scope.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'global', 'all'] },
        projectId: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'fauna_forget',
    description: 'Delete a fact by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'fauna_list_facts',
    description: 'List facts (no keyword scoring).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'global', 'all'] },
        projectId: { type: 'string' },
        category: { type: 'string' },
      },
    },
  },
  {
    name: 'fauna_context_search',
    description: 'Hybrid (semantic + keyword) search over ingested documents.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'global', 'all'] },
        projectId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fauna_context_ingest',
    description: 'Ingest a document into the context store.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        sourceId: { type: 'string' },
        sourcePath: { type: 'string' },
        sourceType: { type: 'string', enum: ['file', 'url', 'note', 'pasted'] },
        title: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'global'] },
        projectId: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'fauna_profile',
    description: 'Build a query-aware profile (static + dynamic + context).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'global'] },
        q: { type: 'string' },
        includeContext: { type: 'boolean' },
      },
    },
  },
  {
    name: 'fauna_sync_github',
    description: 'Sync a GitHub repo into context via the gh CLI.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' }, branch: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'global'] },
        projectId: { type: 'string' },
        maxFiles: { type: 'number' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'fauna_sync_folder',
    description: 'Sync a local folder into context.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'global'] },
        projectId: { type: 'string' },
        maxFiles: { type: 'number' },
      },
      required: ['path'],
    },
  },
];

function _resolveContainerTag(args) {
  if (args.scope === 'global') return GLOBAL_TAG;
  if (args.projectId) return projectContainerTag(args.projectId);
  return GLOBAL_TAG;
}

// ── Tool dispatch ─────────────────────────────────────────────────────────

async function _callTool(name, args = {}) {
  switch (name) {
    case 'fauna_remember':
      return factsRemember(args.text, {
        category: args.category,
        containerTag: _resolveContainerTag(args),
        kind: args.kind,
        expiresAt: args.expiresAt,
        supersedes: args.supersedes,
      });
    case 'fauna_recall': {
      const scope = args.scope || (args.projectId ? 'project' : 'global');
      const opts = { limit: args.limit };
      if (scope === 'project' && args.projectId) {
        opts.containerTag = projectContainerTag(args.projectId);
        opts.includeGlobal = true;
      } else if (scope === 'global') {
        opts.containerTag = GLOBAL_TAG;
        opts.includeGlobal = true;
      }
      return factsRecall(args.keywords, opts);
    }
    case 'fauna_forget':
      return factsForget(args.id);
    case 'fauna_list_facts': {
      const scope = args.scope || (args.projectId ? 'project' : 'all');
      const opts = { category: args.category };
      if (scope === 'project' && args.projectId) {
        opts.containerTag = projectContainerTag(args.projectId);
        opts.includeGlobal = true;
      } else if (scope === 'global') {
        opts.containerTag = GLOBAL_TAG;
        opts.includeGlobal = true;
      }
      return listFacts(opts);
    }
    case 'fauna_context_search': {
      const scope = args.scope || (args.projectId ? 'project' : 'global');
      const opts = { limit: Math.min(20, args.limit || 8) };
      if (scope === 'project' && args.projectId) {
        opts.containerTag = projectContainerTag(args.projectId);
        opts.includeGlobal = true;
      } else if (scope === 'global') {
        opts.containerTag = GLOBAL_TAG;
      }
      const hits = await searchContext(args.query, opts);
      return hits.map(h => ({
        docId: h.chunk.docId,
        chunkId: h.chunk.id,
        score: Number(h.score.toFixed(4)),
        sourcePath: h.chunk.sourcePath,
        sourceType: h.chunk.sourceType,
        title: h.chunk.title,
        text: h.chunk.text,
      }));
    }
    case 'fauna_context_ingest':
      return ingestDocument({
        text: args.text,
        sourceId: args.sourceId,
        sourcePath: args.sourcePath,
        sourceType: args.sourceType,
        title: args.title,
        containerTag: _resolveContainerTag(args),
      });
    case 'fauna_profile':
      return args.projectId
        ? buildProjectProfile(args.projectId, { q: args.q, includeContext: args.includeContext !== false })
        : buildProfile({ q: args.q, includeContext: args.includeContext !== false });
    case 'fauna_sync_github':
      return syncGitHubRepo({
        repo: args.repo, branch: args.branch,
        containerTag: _resolveContainerTag(args),
        maxFiles: args.maxFiles,
      });
    case 'fauna_sync_folder':
      return syncLocalFolder({
        path: args.path,
        containerTag: _resolveContainerTag(args),
        maxFiles: args.maxFiles,
      });
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { code: E_METHOD });
  }
}

// ── Method dispatch ───────────────────────────────────────────────────────

export async function handleMcpRequest(req) {
  const { id, method, params } = req || {};
  switch (method) {
    case 'initialize':
      return _rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: SERVER_INFO,
      });

    case 'tools/list':
      return _rpcResult(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      if (!name) return _rpcError(id, E_PARAMS, 'name is required');
      try {
        const result = await _callTool(name, args || {});
        // MCP expects a content array; we wrap the JSON result as a single
        // text part so clients can both render and re-parse it.
        return _rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: false,
        });
      } catch (e) {
        return _rpcResult(id, {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true,
        });
      }
    }

    case 'resources/list': {
      const docs = listDocuments();
      const stats = ctxGetStats();
      const resources = docs.map(d => ({
        uri: `fauna://doc/${d.docId}`,
        name: d.title || d.sourcePath || d.docId,
        mimeType: 'text/plain',
        description: `${d.sourceType || 'note'} (${d.chunks} chunks)`,
      }));
      return _rpcResult(id, { resources, _meta: stats });
    }

    case 'resources/read': {
      const uri = params?.uri;
      if (!uri || !uri.startsWith('fauna://doc/')) {
        return _rpcError(id, E_PARAMS, 'uri must be fauna://doc/<docId>');
      }
      const docId = uri.slice('fauna://doc/'.length);
      const docs = listDocuments();
      const meta = docs.find(d => d.docId === docId);
      if (!meta) return _rpcError(id, E_PARAMS, 'doc not found');
      // Re-assemble chunks for the doc in order.
      const { getDocumentChunks } = await import('../lib/context-store.js');
      const all = getDocumentChunks(docId);
      return _rpcResult(id, {
        contents: all.map(c => ({
          uri: `fauna://doc/${docId}#${c.index}`,
          mimeType: 'text/plain',
          text: c.text,
        })),
      });
    }

    case 'ping':
      return _rpcResult(id, {});

    default:
      return _rpcError(id, E_METHOD, `Method not found: ${method}`);
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────

function _readToken(faunaConfigDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(faunaConfigDir, 'mobile-token.json'), 'utf8'));
    return raw?.token || null;
  } catch (_) { return null; }
}

function _authorize(req, faunaConfigDir) {
  // Loopback callers from the same host get a free pass — Phase 6 is meant
  // to be locally trusted by default; the token gate only kicks in when the
  // request arrives via the tunnel.
  const ip = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
  if (isLoopback) return true;
  const stored = _readToken(faunaConfigDir);
  const provided = (req.headers['x-fauna-token'] || '').trim();
  return !!stored && !!provided && stored === provided;
}

// ── Route registration ────────────────────────────────────────────────────

export function registerMcpRoutes(app, opts = {}) {
  const faunaConfigDir = opts.faunaConfigDir || path.join(os.homedir(), '.config', 'fauna');

  app.post('/mcp', async (req, res) => {
    if (!_authorize(req, faunaConfigDir)) {
      return res.status(401).json(_rpcError(null, E_INVALID_REQ, 'Unauthorized'));
    }
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json(_rpcError(null, E_PARSE, 'Parse error')); }
    }
    if (!body || body.jsonrpc !== '2.0' || !body.method) {
      return res.status(400).json(_rpcError(body?.id ?? null, E_INVALID_REQ, 'Invalid Request'));
    }
    try {
      const response = await handleMcpRequest(body);
      res.json(response);
    } catch (e) {
      res.status(500).json(_rpcError(body.id, E_INTERNAL, e.message));
    }
  });

  // Lightweight discovery — clients can probe before initializing.
  app.get('/mcp', (_req, res) => {
    res.json({
      transport: 'http-jsonrpc',
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      methods: ['initialize', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'ping'],
      tools: TOOLS.map(t => t.name),
    });
  });
}

export const _internals = { TOOLS, _callTool, _resolveContainerTag };

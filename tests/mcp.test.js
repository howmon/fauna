import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.__memFs = globalThis.__memFs || new Map();
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const memFs = globalThis.__memFs;
  const api = {
    readFileSync: vi.fn((p) => { if (memFs.has(p)) return memFs.get(p); throw enoent(); }),
    writeFileSync: vi.fn((p, d) => { memFs.set(p, d); }),
    mkdirSync: vi.fn(),
    renameSync: vi.fn((from, to) => { if (!memFs.has(from)) throw enoent(); memFs.set(to, memFs.get(from)); memFs.delete(from); }),
    chmodSync: vi.fn(),
    existsSync: vi.fn((p) => memFs.has(p)),
    unlinkSync: vi.fn((p) => { memFs.delete(p); }),
  };
  return { ...actual, default: { ...actual, ...api }, ...api };
});

const { _resetCache: resetFacts, remember, projectContainerTag } = await import('../memory-store.js');
const { _resetCache: resetCtx, ingestDocument } = await import('../server/lib/context-store.js');
const { _resetCache: resetEmbed } = await import('../server/lib/embeddings.js');
const { invalidateStaticCache } = await import('../server/lib/profile.js');
const { handleMcpRequest, _internals } = await import('../server/routes/mcp.js');
const { createCustomMcpBridge } = await import('../server/bridges/custom-mcp.js');
const { _resetCache: resetCreds } = await import('../credentials-store.js');

const VOCAB = ['postgres', 'react', 'typescript'];
const stubEmbed = (texts) => texts.map(t => VOCAB.map(v => String(t).toLowerCase().includes(v) ? 1 : 0));

beforeEach(() => {
  globalThis.__memFs.clear();
  resetFacts();
  resetCtx();
  resetEmbed();
  resetCreds();
  invalidateStaticCache();
  vi.clearAllMocks();
});

function rpc(method, params, id = 1) {
  return handleMcpRequest({ jsonrpc: '2.0', id, method, params });
}

describe('MCP server', () => {
  it('initialize returns protocol version + capabilities', async () => {
    const r = await rpc('initialize');
    expect(r.result.protocolVersion).toBe('2024-11-05');
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe('fauna');
  });

  it('tools/list returns the curated tool catalog', async () => {
    const r = await rpc('tools/list');
    const names = r.result.tools.map(t => t.name);
    expect(names).toContain('fauna_remember');
    expect(names).toContain('fauna_recall');
    expect(names).toContain('fauna_context_search');
    expect(names).toContain('fauna_profile');
    expect(names).toContain('fauna_sync_github');
  });

  it('ping returns empty result', async () => {
    const r = await rpc('ping');
    expect(r.result).toEqual({});
  });

  it('returns method-not-found for unknown methods', async () => {
    const r = await rpc('totally/madeup');
    expect(r.error.code).toBe(-32601);
  });

  it('tools/call rejects missing name', async () => {
    const r = await rpc('tools/call', {});
    expect(r.error.code).toBe(-32602);
  });

  it('tools/call -> fauna_remember persists a fact', async () => {
    const r = await rpc('tools/call', {
      name: 'fauna_remember',
      arguments: { text: 'user prefers TypeScript', projectId: 'p1' },
    });
    expect(r.result.isError).toBe(false);
    const parsed = JSON.parse(r.result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toMatch(/^fact-/);
  });

  it('tools/call -> fauna_recall returns matching facts', async () => {
    remember('user uses Postgres', { containerTag: projectContainerTag('p2') });
    remember('weather is sunny', { containerTag: projectContainerTag('p2') });
    const r = await rpc('tools/call', {
      name: 'fauna_recall',
      arguments: { keywords: 'postgres', projectId: 'p2' },
    });
    const parsed = JSON.parse(r.result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toMatch(/Postgres/);
  });

  it('tools/call -> fauna_context_search returns chunks', async () => {
    await ingestDocument({
      text: 'Postgres tuning and pooling tips.',
      sourceId: 'd1', containerTag: 'global',
    }, { embedder: stubEmbed });
    const r = await rpc('tools/call', {
      name: 'fauna_context_search',
      arguments: { query: 'postgres', scope: 'global' },
    });
    const hits = JSON.parse(r.result.content[0].text);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sourceType).toBe('note');
  });

  it('tools/call -> unknown tool reports isError=true', async () => {
    const r = await rpc('tools/call', { name: 'fauna_does_not_exist', arguments: {} });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/unknown tool/);
  });

  it('tools/call -> fauna_profile returns three buckets', async () => {
    remember('static thing', { containerTag: projectContainerTag('p3'), kind: 'static' });
    remember('dynamic thing', { containerTag: projectContainerTag('p3'), kind: 'dynamic' });
    const r = await rpc('tools/call', {
      name: 'fauna_profile',
      arguments: { projectId: 'p3' },
    });
    const profile = JSON.parse(r.result.content[0].text);
    expect(profile.containerTag).toBe('project:p3');
    expect(profile.static.length).toBeGreaterThan(0);
    expect(profile.dynamic.length).toBeGreaterThan(0);
  });

  it('resources/list enumerates ingested docs as fauna:// URIs', async () => {
    await ingestDocument({
      text: 'doc body', sourceId: 'src-1', sourcePath: '/notes/a.md',
      title: 'Note A', containerTag: 'global',
    }, { embedder: stubEmbed });
    const r = await rpc('resources/list');
    expect(r.result.resources.length).toBe(1);
    expect(r.result.resources[0].uri).toMatch(/^fauna:\/\/doc\//);
    expect(r.result.resources[0].name).toBe('Note A');
  });

  it('resources/read reassembles chunks in order', async () => {
    // Long enough to split into multiple chunks.
    const para = 'Postgres '.repeat(300);
    const ing = await ingestDocument({
      text: para, sourceId: 'big', containerTag: 'global',
    }, { embedder: stubEmbed });
    const r = await rpc('resources/read', { uri: `fauna://doc/${ing.docId}` });
    expect(r.result.contents.length).toBeGreaterThan(0);
    expect(r.result.contents[0].text).toMatch(/Postgres/);
  });

  it('resources/read rejects bad URIs', async () => {
    const r = await rpc('resources/read', { uri: 'http://nope' });
    expect(r.error.code).toBe(-32602);
  });

  it('resources/read returns error for unknown docId', async () => {
    const r = await rpc('resources/read', { uri: 'fauna://doc/nonexistent' });
    expect(r.error.code).toBe(-32602);
  });

  it('_resolveContainerTag picks global vs project scope', () => {
    expect(_internals._resolveContainerTag({ scope: 'global' })).toBe('global');
    expect(_internals._resolveContainerTag({ projectId: 'x' })).toBe('project:x');
    expect(_internals._resolveContainerTag({})).toBe('global');
  });
});

describe('custom MCP bridge', () => {
  it('auto-connects enabled HTTP servers during chat tool discovery', async () => {
    const configDir = '/tmp/fauna-test';
    const configPath = configDir + '/custom-mcp-servers.json';
    globalThis.__memFs.set(configPath, JSON.stringify([{
      id: 'mcp-figma-dev-mode',
      name: 'Figma dev mode',
      transport: 'http',
      url: 'http://127.0.0.1:3845/mcp',
      enabled: true,
      running: false,
      auth: { authorized: true },
    }]));

    const sse = (payload, headers = {}) => new Response(
      'event: message\n' + 'data: ' + JSON.stringify(payload) + '\n\n',
      { status: 200, headers },
    );
    const fetchMock = vi.fn(async (_url, options = {}) => {
      const body = JSON.parse(options.body || '{}');
      if (body.method === 'initialize') {
        return sse({ jsonrpc: '2.0', id: body.id, result: {} }, { 'mcp-session-id': 'session-1' });
      }
      if (body.method === 'tools/list') {
        return sse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [{
              name: 'get_design_context',
              description: 'Read selected Figma design context',
              inputSchema: { type: 'object', properties: {} },
            }],
          },
        });
      }
      throw new Error('unexpected method ' + body.method);
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const bridge = createCustomMcpBridge({
        faunaConfigDir: configDir,
        extBridge: { broadcastStatus: vi.fn(), setRelayBrowsers: vi.fn() },
      });
      const tools = await bridge.getTools({ autoStartEnabled: true });
      expect(tools.map(t => t.function.name)).toEqual(['get_design_context']);
      const saved = JSON.parse(globalThis.__memFs.get(configPath));
      expect(saved[0].running).toBe(true);

      const status = await bridge.getStatus({ includeTools: true });
      expect(status.runningCount).toBe(1);
      expect(status.servers[0].tools).toEqual(['get_design_context']);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('records HTTP auth challenge metadata when startup gets 401', async () => {
    const configDir = '/tmp/fauna-test-auth';
    const configPath = configDir + '/custom-mcp-servers.json';
    globalThis.__memFs.set(configPath, JSON.stringify([{
      id: 'mcp-hits',
      name: 'HITS',
      transport: 'http',
      url: 'https://hits.example.test/mcp',
      enabled: true,
      running: false,
      auth: { authorized: false },
    }]));

    const fetchMock = vi.fn(async (url, options = {}) => {
      if (String(url).includes('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify({
          issuer: 'https://hits.example.test',
          authorization_endpoint: 'https://hits.example.test/oauth/authorize',
          token_endpoint: 'https://hits.example.test/oauth/token',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('/.well-known/')) {
        return new Response('not found', { status: 404 });
      }
      const body = JSON.parse(options.body || '{}');
      if (body.method === 'initialize') {
        return new Response('missing token', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer resource_metadata="https://hits.example.test/.well-known/oauth-authorization-server"' },
        });
      }
      throw new Error('unexpected request ' + url);
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const bridge = createCustomMcpBridge({
        faunaConfigDir: configDir,
        extBridge: { broadcastStatus: vi.fn(), setRelayBrowsers: vi.fn() },
      });
      await expect(bridge.getTools({ autoStartEnabled: true })).resolves.toEqual([]);

      const saved = JSON.parse(globalThis.__memFs.get(configPath));
      expect(saved[0].running).toBe(false);
      expect(saved[0].lifecycle.state).toBe('needs_auth');
      expect(saved[0].lifecycle.wwwAuthenticate).toMatch(/resource_metadata/);
      expect(saved[0].lifecycle.authDiscovery.authorizationEndpoint).toBe('https://hits.example.test/oauth/authorize');

      const status = await bridge.getStatus({ includeTools: true });
      expect(status.servers[0].lifecycle.state).toBe('needs_auth');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('follows Microsoft issuer-style authorization server metadata', async () => {
    const configDir = '/tmp/fauna-test-ms-auth';
    const configPath = configDir + '/custom-mcp-servers.json';
    globalThis.__memFs.set(configPath, JSON.stringify([{
      id: 'mcp-hits',
      name: 'HITS',
      transport: 'http',
      url: 'https://mcp.hits-uat.microsoft.com',
      enabled: true,
      running: false,
      auth: { authorized: false },
    }]));

    const fetchMock = vi.fn(async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl === 'https://mcp.hits-uat.microsoft.com/.well-known/oauth-protected-resource/') {
        return new Response(JSON.stringify({
          resource: 'https://mcp.hits-uat.microsoft.com/',
          authorization_servers: ['https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0'],
          scopes_supported: ['api://7c79089e-8804-4043-b16c-4672754e66cb/.default'],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (requestUrl === 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0/.well-known/openid-configuration') {
        return new Response(JSON.stringify({
          issuer: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0',
          authorization_endpoint: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/authorize',
          token_endpoint: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/token',
          device_authorization_endpoint: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/devicecode',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (requestUrl.includes('/.well-known/')) {
        return new Response('not found', { status: 404 });
      }
      const body = JSON.parse(options.body || '{}');
      if (body.method === 'initialize') {
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.hits-uat.microsoft.com/.well-known/oauth-protected-resource/"' },
        });
      }
      throw new Error('unexpected request ' + requestUrl);
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const bridge = createCustomMcpBridge({
        faunaConfigDir: configDir,
        extBridge: { broadcastStatus: vi.fn(), setRelayBrowsers: vi.fn() },
      });
      await expect(bridge.getTools({ autoStartEnabled: true })).resolves.toEqual([]);

      const saved = JSON.parse(globalThis.__memFs.get(configPath));
      expect(saved[0].lifecycle.state).toBe('needs_auth');
      expect(saved[0].lifecycle.authDiscovery.authorizationEndpoint).toBe('https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/authorize');
      expect(saved[0].lifecycle.authDiscovery.tokenEndpoint).toBe('https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/token');
      expect(saved[0].lifecycle.authDiscovery.scopesSupported).toEqual(['api://7c79089e-8804-4043-b16c-4672754e66cb/.default']);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('auth-stream completes Microsoft device-code auth and stores the token', async () => {
    const configDir = '/tmp/fauna-test-device-auth';
    const configPath = configDir + '/custom-mcp-servers.json';
    process.env.FAUNA_CREDENTIALS_FILE = configDir + '/credentials.json';
    globalThis.__memFs.set(configPath, JSON.stringify([{
      id: 'mcp-hits',
      name: 'HITS',
      transport: 'http',
      url: 'https://mcp.hits-uat.microsoft.com',
      enabled: true,
      running: false,
      auth: { authorized: false },
      lifecycle: {
        state: 'needs_auth',
        authDiscovery: {
          deviceAuthorizationEndpoint: 'https://login.example.test/devicecode',
          tokenEndpoint: 'https://login.example.test/token',
          scopesSupported: ['api://hits/.default'],
        },
      },
    }]));

    const fetchMock = vi.fn(async (url) => {
      if (String(url) === 'https://login.example.test/devicecode') {
        return new Response(JSON.stringify({
          device_code: 'device-123',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://microsoft.com/devicelogin',
          interval: 1,
          expires_in: 60,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === 'https://login.example.test/token') {
        return new Response(JSON.stringify({ access_token: 'hits-access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('unexpected request ' + url);
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const routes = { get: new Map(), post: new Map() };
      const app = {
        get: (path, handler) => routes.get.set(path, handler),
        post: (path, handler) => routes.post.set(path, handler),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const bridge = createCustomMcpBridge({
        faunaConfigDir: configDir,
        extBridge: { broadcastStatus: vi.fn(), setRelayBrowsers: vi.fn() },
      });
      bridge.register(app);

      const chunks = [];
      const req = Object.assign(new EventEmitter(), { params: { id: 'mcp-hits' } });
      const res = {
        writeHead: vi.fn(),
        write: vi.fn(chunk => chunks.push(chunk)),
        end: vi.fn(),
      };
      await routes.get.get('/api/custom-mcp-servers/:id/auth-stream')(req, res);

      expect(chunks.join('')).toContain('deviceCode');
      expect(chunks.join('')).toContain('ABCD-EFGH');
      expect(chunks.join('')).toContain('"exit","data":0');
      const saved = JSON.parse(globalThis.__memFs.get(configPath));
      expect(saved[0].auth.authorized).toBe(true);
      expect(saved[0].lifecycle.state).toBe('authorized');
    } finally {
      globalThis.fetch = previousFetch;
      delete process.env.FAUNA_CREDENTIALS_FILE;
      resetCreds();
    }
  });
});

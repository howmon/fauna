import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.__customMcpMemFs = globalThis.__customMcpMemFs || new Map();

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  const memFs = globalThis.__customMcpMemFs;
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const api = {
    readFileSync: vi.fn((p) => { if (memFs.has(p)) return memFs.get(p); throw enoent(); }),
    writeFileSync: vi.fn((p, d) => { memFs.set(p, d); }),
    mkdirSync: vi.fn(),
    existsSync: vi.fn((p) => memFs.has(p)),
  };
  return { ...actual, default: { ...actual, ...api }, ...api };
});

const spawnMock = vi.fn(() => {
  const proc = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return { ...actual, spawn: spawnMock };
});

const { createCustomMcpBridge } = await import('../server/bridges/custom-mcp.js');

describe('custom MCP browser autodetect', () => {
  let previousFetch;

  beforeEach(() => {
    globalThis.__customMcpMemFs.clear();
    globalThis.__customMcpMemFs.set('/tmp/fauna-autodetect/custom-mcp-servers.json', '[]');
    globalThis.__customMcpMemFs.set('/tmp/fauna-browser-server.js', '');
    previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw new Error('relay unavailable'); });
    spawnMock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  it('does not spawn the bundled browser fallback when fallback spawning is disabled', async () => {
    const bridge = createCustomMcpBridge({
      faunaConfigDir: '/tmp/fauna-autodetect',
      bundledBrowserServerPath: '/tmp/fauna-browser-server.js',
      extBridge: { broadcastStatus: vi.fn(), setRelayBrowsers: vi.fn() },
    });

    bridge.startAutoDetect({ spawnFallback: false });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    bridge.cleanup();

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns the bundled browser fallback when fallback spawning is enabled', async () => {
    const bridge = createCustomMcpBridge({
      faunaConfigDir: '/tmp/fauna-autodetect',
      bundledBrowserServerPath: '/tmp/fauna-browser-server.js',
      extBridge: { broadcastStatus: vi.fn(), setRelayBrowsers: vi.fn() },
    });

    bridge.startAutoDetect({ spawnFallback: true });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    bridge.cleanup();

    expect(spawnMock.mock.calls[0][1]).toEqual(['/tmp/fauna-browser-server.js']);
  });
});
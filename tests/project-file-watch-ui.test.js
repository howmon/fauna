import fs from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../public/js/projects.js', import.meta.url), 'utf8');

function setup() {
  const streams = [];
  class EventSource {
    constructor(url) { this.url = url; this.close = vi.fn(); streams.push(this); }
    emit(data) { this.onmessage({ data: JSON.stringify(data) }); }
  }
  const st = {
    srcId: 's', dirCache: { '': [{ name: 'nested' }], nested: [{ name: 'old.txt' }], collapsed: [] },
    expanded: { nested: true }, openedFiles: { 'nested/old.txt': true },
  };
  const el = { scrollTop: 72 };
  const windowEvents = new EventTarget();
  const context = {
    state: { activeProjectId: 'p', projSidebarPanelOpen: true }, _projSidebarTreeState: st,
    window: {
      EventSource, faunaStreamUrl: url => url + '?auth=fixture',
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
      dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
    }, EventSource,
    AbortController, setTimeout, clearTimeout, console: { warn: vi.fn() },
    fetch: vi.fn(async () => ({ ok: true, json: async () => [{ name: 'new.txt' }] })),
    _treeGetEl: () => el, _treeRender: vi.fn(() => { el.scrollTop = 0; }), _showToast: vi.fn(),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('var _projSpFileWatch ='), source.indexOf('function _projSpRenderConvs')), context);
  context._projSpStartAutoRefresh();
  return { context, st, el, streams };
}

afterEach(() => vi.useRealTimers());

describe('live project sidebar', () => {
  it('recovers missed events on focus, coalesces refreshes, and removes the listener on close', async () => {
    vi.useFakeTimers();
    const { context, st } = setup();
    const expanded = st.expanded;
    context.window.dispatchEvent(new Event('focus'));
    context.window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(100);
    expect(context.fetch).toHaveBeenCalledTimes(2);
    expect(st.dirCache.nested).toEqual([{ name: 'new.txt' }]);
    expect(st.expanded).toBe(expanded);
    context._projSpStopAutoRefresh();
    context.window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(100);
    expect(context.fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes only affected listings and preserves expansion, opened files, and scroll', async () => {
    vi.useFakeTimers();
    const { context, st, el, streams } = setup();
    const expanded = st.expanded;
    const opened = st.openedFiles;
    streams[0].emit({ type: 'change', paths: ['nested/new.txt', 'nested/old.txt'] });
    streams[0].emit({ type: 'change', paths: ['nested/renamed.txt'] });
    await vi.advanceTimersByTimeAsync(100);
    expect(context.fetch).toHaveBeenCalledTimes(1);
    expect(context.fetch.mock.calls[0][0]).toContain('/files?path=nested');
    expect(st.dirCache.nested).toEqual([{ name: 'new.txt' }]);
    expect(st.dirCache['']).toEqual([{ name: 'nested' }]);
    expect(st.expanded).toBe(expanded);
    expect(st.openedFiles).toBe(opened);
    expect(el.scrollTop).toBe(72);
    context._projSpStopAutoRefresh();
  });

  it('invalidates collapsed caches without fetching them and recovers missed changes on reconnect', async () => {
    vi.useFakeTimers();
    const { context, st, streams } = setup();
    streams[0].emit({ type: 'change', paths: ['collapsed/new.txt'] });
    await vi.advanceTimersByTimeAsync(100);
    expect(st.dirCache.collapsed).toBeUndefined();
    expect(context.fetch).not.toHaveBeenCalled();
    streams[0].emit({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);
    expect(context.fetch).toHaveBeenCalledTimes(2);
    expect(context._treeRender).toHaveBeenCalledTimes(1);
    context._projSpStopAutoRefresh();
  });

  it('ignores stale requests after switching sources and closes the old stream', async () => {
    vi.useFakeTimers();
    const { context, st, streams } = setup();
    let resolve;
    context.fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    streams[0].emit({ type: 'change', paths: ['nested/new.txt'] });
    await vi.advanceTimersByTimeAsync(100);
    st.srcId = 'other';
    context._projSpStartAutoRefresh();
    resolve({ ok: true, json: async () => [{ name: 'wrong-source.txt' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(streams[0].close).toHaveBeenCalledTimes(1);
    expect(streams[1].url).toBe('/api/projects/p/sources/other/events?auth=fixture');
    expect(st.dirCache.nested).toEqual([{ name: 'old.txt' }]);
    expect(context._treeRender).not.toHaveBeenCalled();
    context._projSpStopAutoRefresh();
  });

  it('keeps processing changes that arrive during an in-flight refresh', async () => {
    vi.useFakeTimers();
    const { context, streams } = setup();
    let resolve;
    context.fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    streams[0].emit({ type: 'change', paths: ['nested/one.txt'] });
    await vi.advanceTimersByTimeAsync(100);
    streams[0].emit({ type: 'change', paths: ['nested/two.txt'] });
    await vi.advanceTimersByTimeAsync(100);
    expect(context.fetch).toHaveBeenCalledTimes(1);
    resolve({ ok: true, json: async () => [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(context.fetch).toHaveBeenCalledTimes(2);
    context._projSpStopAutoRefresh();
  });

  it('preserves cached listings and reports refresh failures; disconnecting cancels queued work', async () => {
    vi.useFakeTimers();
    const { context, st, streams } = setup();
    context.fetch.mockRejectedValueOnce(new Error('offline'));
    streams[0].emit({ type: 'change', paths: ['nested/new.txt'] });
    await vi.advanceTimersByTimeAsync(100);
    expect(st.dirCache.nested).toEqual([{ name: 'old.txt' }]);
    expect(context._showToast).toHaveBeenCalledWith('Live file updates unavailable: offline', true);
    streams[0].emit({ type: 'change', paths: ['another.txt'] });
    context._projSpStopAutoRefresh();
    await vi.advanceTimersByTimeAsync(100);
    expect(context.fetch).toHaveBeenCalledTimes(1);
    expect(streams[0].close).toHaveBeenCalledTimes(1);
  });

  it('handles deleted expanded directories without losing other listings', async () => {
    vi.useFakeTimers();
    const { context, st, streams } = setup();
    context.fetch.mockImplementation(async url => ({
      ok: !url.endsWith('path=nested'),
      json: async () => url.endsWith('path=nested') ? { error: 'Path not found' } : [{ name: 'keep.txt' }],
    }));
    streams[0].emit({ type: 'change', paths: ['nested'] });
    await vi.advanceTimersByTimeAsync(100);
    expect(st.dirCache['']).toEqual([{ name: 'keep.txt' }]);
    expect(st.dirCache.nested).toEqual([]);
    expect(context._showToast).not.toHaveBeenCalled();
    context._projSpStopAutoRefresh();
  });

  it('times out a stalled refresh and can process the next filesystem change', async () => {
    vi.useFakeTimers();
    const { context, streams } = setup();
    context.fetch.mockImplementationOnce((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Refresh aborted')));
    }));
    streams[0].emit({ type: 'change', paths: ['nested/stalled.txt'] });
    await vi.advanceTimersByTimeAsync(8100);
    expect(context._showToast).toHaveBeenCalledWith('Live file updates unavailable: Refresh aborted', true);
    streams[0].emit({ type: 'change', paths: ['nested/retry.txt'] });
    await vi.advanceTimersByTimeAsync(100);
    expect(context.fetch).toHaveBeenCalledTimes(2);
    expect(context._treeRender).toHaveBeenCalledTimes(1);
    context._projSpStopAutoRefresh();
  });
});

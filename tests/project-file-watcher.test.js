import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeProjectFiles } from '../server/lib/project-file-watcher.js';
import { registerProjectRoutes } from '../server/routes/projects.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mockWatcher() {
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
  let notify;
  const spy = vi.spyOn(fs, 'watch').mockImplementation((_root, _options, callback) => {
    notify = callback;
    return watcher;
  });
  return { watcher, spy, notify: filename => notify('rename', filename) };
}

describe('project file notifications', () => {
  it('shares a watcher, batches paths, ignores noisy children, and releases the final subscription', async () => {
    vi.useFakeTimers();
    const { watcher, spy, notify } = mockWatcher();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeProjectFiles('/tmp/fauna-watch-shared', first, vi.fn());
    const stopSecond = subscribeProjectFiles('/tmp/fauna-watch-shared', second, vi.fn());
    cleanups.push(stopFirst, stopSecond);
    expect(spy).toHaveBeenCalledTimes(1);
    notify('src/new.js');
    notify('src/new.js');
    notify('src/renamed.js');
    notify('node_modules/pkg/index.js');
    notify('.git/index');
    await vi.advanceTimersByTimeAsync(150);
    expect(first).toHaveBeenCalledExactlyOnceWith({ paths: ['src/new.js', 'src/renamed.js'], reset: false });
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    expect(watcher.close).not.toHaveBeenCalled();
    notify('deleted.txt');
    stopSecond();
    await vi.advanceTimersByTimeAsync(150);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('bounds large bursts and reports watcher errors to subscribers', async () => {
    vi.useFakeTimers();
    const { watcher, notify } = mockWatcher();
    const changed = vi.fn();
    const failed = vi.fn();
    cleanups.push(subscribeProjectFiles('/tmp/fauna-watch-burst', changed, failed));
    for (let i = 0; i < 300; i++) notify('file-' + i);
    await vi.advanceTimersByTimeAsync(150);
    expect(changed).toHaveBeenCalledExactlyOnceWith({ paths: [], reset: true });
    const error = new Error('watch stopped');
    watcher.emit('error', error);
    expect(failed).toHaveBeenCalledExactlyOnceWith(error);
    expect(watcher.close).toHaveBeenCalled();
  });

  it('streams real external additions, edits, renames, and deletions and cleans up on disconnect', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-project-events-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'nested'));
    const app = express();
    const resolveRoot = vi.fn(() => ({ root }));
    registerProjectRoutes(app, { resolveProjectSourceRoot: resolveRoot });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    cleanups.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const watchSpy = vi.spyOn(fs, 'watch');
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/p/sources/s/events`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(resolveRoot).toHaveBeenCalledWith('p', 's');
    const watcher = watchSpy.mock.results[0].value;
    const closeSpy = vi.spyOn(watcher, 'close');
    const events = [];
    const reader = response.body.getReader();
    const reading = (async () => {
      let buffer = '';
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            events.push(JSON.parse(buffer.slice(0, boundary).replace(/^data: /, '')));
            buffer = buffer.slice(boundary + 2);
          }
        }
      } catch (error) {
        if (error.name !== 'AbortError') throw error;
      }
    })();
    cleanups.push(async () => { controller.abort(); await reading; });
    await vi.waitFor(() => expect(events.some(event => event.type === 'ready')).toBe(true));
    async function change(action, expectedPath) {
      events.length = 0;
      action();
      await vi.waitFor(() => expect(events.some(event => event.paths?.includes(expectedPath) || event.reset)).toBe(true), { timeout: 3000 });
    }
    const file = path.join(root, 'nested', 'new.txt');
    await change(() => fs.writeFileSync(file, 'created'), 'nested/new.txt');
    await change(() => fs.appendFileSync(file, ' updated'), 'nested/new.txt');
    const renamed = path.join(root, 'nested', 'renamed.txt');
    await change(() => fs.renameSync(file, renamed), 'nested/renamed.txt');
    await change(() => fs.unlinkSync(renamed), 'nested/renamed.txt');
    await change(() => fs.rmdirSync(path.join(root, 'nested')), 'nested');
    controller.abort();
    await reading;
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
  });

  it('returns an explicit error when the project source cannot be resolved', async () => {
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method =>
      [method, (route, ...callbacks) => handlers.set(method + ' ' + route, callbacks.at(-1))]));
    registerProjectRoutes(app, { resolveProjectSourceRoot() { throw new Error('Source not found'); } });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    handlers.get('get /api/projects/:id/sources/:srcId/events')({ params: { id: 'p', srcId: 'missing' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Source not found' });
  });
});

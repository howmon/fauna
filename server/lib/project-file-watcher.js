import fs from 'fs';
import path from 'path';

const watchers = new Map();
const noisyDirectories = new Set(['.git', 'node_modules', '.cache', '.next', 'coverage']);
const MAX_PENDING_PATHS = 256;

export function subscribeProjectFiles(root, onChange, onError) {
  root = path.resolve(root);
  let entry = watchers.get(root);
  if (!entry) {
    entry = { listeners: new Set(), paths: new Set(), reset: false, timer: null, watcher: null };
    entry.watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      const relative = filename ? String(filename).split(path.sep).join('/') : '';
      if (relative.split('/').slice(0, -1).some(part => noisyDirectories.has(part))) return;
      if (!relative || entry.paths.size >= MAX_PENDING_PATHS) {
        entry.reset = true;
        entry.paths.clear();
      } else if (!entry.reset) {
        entry.paths.add(relative);
      }
      if (entry.timer) return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        const change = { paths: [...entry.paths], reset: entry.reset };
        entry.paths.clear();
        entry.reset = false;
        for (const listener of entry.listeners) listener.onChange(change);
      }, 150);
      entry.timer.unref?.();
    });
    entry.watcher.on('error', error => {
      clearTimeout(entry.timer);
      entry.watcher.close();
      if (watchers.get(root) === entry) watchers.delete(root);
      const listeners = [...entry.listeners];
      entry.listeners.clear();
      for (const listener of listeners) listener.onError(error);
    });
    entry.watcher.unref?.();
    watchers.set(root, entry);
  }
  const listener = { onChange, onError };
  entry.listeners.add(listener);
  return () => {
    if (!entry.listeners.delete(listener)) return;
    if (entry.listeners.size) return;
    clearTimeout(entry.timer);
    entry.watcher.close();
    if (watchers.get(root) === entry) watchers.delete(root);
  };
}

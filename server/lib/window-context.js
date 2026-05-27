// Platform dispatcher for window context. Picks mac (osascript) or
// Windows (PowerShell + User32) at import time. Callers stay platform-
// agnostic.

import * as mac from './mac-window-context.js';
import * as win from './win-window-context.js';

const impl = process.platform === 'darwin' ? mac
  : process.platform === 'win32' ? win
  : null;

export async function listVisibleWindows(opts) {
  if (!impl) return { ok: false, error: 'unsupported platform: ' + process.platform, apps: [] };
  return impl.listVisibleWindows(opts);
}

export async function arrangeWindows(moves, opts) {
  if (!impl) return { ok: false, error: 'unsupported platform: ' + process.platform, results: [] };
  return impl.arrangeWindows(moves, opts);
}

export async function getScreenBounds(opts) {
  if (!impl) return { ok: false, error: 'unsupported platform: ' + process.platform };
  return impl.getScreenBounds(opts);
}

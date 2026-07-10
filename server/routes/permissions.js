// Helpers and routes for macOS permission state.
//
// `computePermissions(opts)` is exported so other modules (e.g. system-context)
// can read the same shape without going through HTTP.

import fs from 'fs';
import os from 'os';
import path from 'path';

const PERMISSION_STATE_FILE = process.env.FAUNA_PERMISSION_STATE_FILE
  || path.join(os.homedir(), '.config', 'fauna', 'permission-state.json');

function readPermissionState() {
  try {
    return JSON.parse(fs.readFileSync(PERMISSION_STATE_FILE, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function writePermissionState(state) {
  try {
    fs.mkdirSync(path.dirname(PERMISSION_STATE_FILE), { recursive: true });
    fs.writeFileSync(PERMISSION_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_) {}
}

function withLastKnownGrants(result) {
  const state = readPermissionState();
  const lastGranted = state.lastGranted && typeof state.lastGranted === 'object'
    ? state.lastGranted
    : {};
  let changed = false;

  for (const key of ['fullDiskAccess', 'screenRecording', 'accessibility', 'automation']) {
    if (result[key] === 'granted') {
      if (!lastGranted[key]) {
        lastGranted[key] = new Date().toISOString();
        changed = true;
      }
    } else if (lastGranted[key] && (result[key] === 'denied' || result[key] === 'not-determined' || result[key] === 'unknown')) {
      result[key] = 'previously-granted';
    }
  }

  if (changed) writePermissionState({ ...state, lastGranted });
  return result;
}

export function checkFullDiskAccess(isWin) {
  if (isWin) return 'not-applicable';
  const probes = [
    path.join(os.homedir(), 'Library', 'Safari', 'History.db'),
    path.join(os.homedir(), 'Library', 'Messages', 'chat.db'),
    '/Library/Application Support/com.apple.TCC/TCC.db',
  ];
  for (const p of probes) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return 'granted';
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return 'denied';
      // ENOENT = file doesn't exist but we had access — try next probe
    }
  }
  return 'not-determined';
}

export function computePermissions({ isWin, getGhToken, systemPreferences }) {
  const result = {};
  try { getGhToken(); result.auth = 'granted'; }
  catch (_) { result.auth = 'denied'; }

  if (isWin) {
    result.screenRecording = 'not-applicable';
    result.accessibility   = 'not-applicable';
    result.fullDiskAccess  = 'not-applicable';
    result.automation      = 'not-applicable';
  } else {
    result.screenRecording = systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown';
    result.accessibility = (systemPreferences?.isTrustedAccessibilityClient?.(false) === true)
      ? 'granted' : 'denied';
    result.fullDiskAccess = checkFullDiskAccess(isWin);
    result.automation = 'auto-prompted';
  }
  return withLastKnownGrants(result);
}

export function registerPermissionsRoutes(app, {
  isWin,
  getGhToken,
  getSystemPreferences,
  getDesktopCapturer,
}) {
  app.get('/api/permissions', (req, res) => {
    res.json(computePermissions({
      isWin,
      getGhToken,
      systemPreferences: getSystemPreferences(),
    }));
  });

  // Trigger Screen Recording permission prompt via desktopCapturer
  app.post('/api/permissions/request-screen', async (req, res) => {
    const systemPreferences = getSystemPreferences();
    try {
      const desktopCapturer = getDesktopCapturer();
      if (!desktopCapturer) throw new Error('desktopCapturer not available');
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      const status = systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown';
      res.json({ status });
    } catch (e) {
      res.json({ status: systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown', error: e.message });
    }
  });
}

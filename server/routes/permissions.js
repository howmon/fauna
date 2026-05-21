// macOS permissions check routes (no-ops on Windows).
//
// /api/permissions reports GitHub auth, Screen Recording, Accessibility,
// Full Disk Access (file-probe), and Automation. /api/permissions/request-screen
// triggers the Screen Recording prompt via desktopCapturer.getSources.

import fs from 'fs';
import os from 'os';
import path from 'path';

export function registerPermissionsRoutes(app, {
  isWin,
  getGhToken,
  getSystemPreferences,
  getDesktopCapturer,
}) {
  function checkFullDiskAccess() {
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

  app.get('/api/permissions', (req, res) => {
    const result = {};

    // GitHub auth
    try { getGhToken(); result.auth = 'granted'; }
    catch (_) { result.auth = 'denied'; }

    if (isWin) {
      result.screenRecording = 'not-applicable';
      result.accessibility   = 'not-applicable';
      result.fullDiskAccess  = 'not-applicable';
      result.automation      = 'not-applicable';
    } else {
      const systemPreferences = getSystemPreferences();
      result.screenRecording = systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown';
      result.accessibility = (systemPreferences?.isTrustedAccessibilityClient?.(false) === true)
        ? 'granted' : 'denied';
      result.fullDiskAccess = checkFullDiskAccess();
      result.automation = 'auto-prompted';
    }

    res.json(result);
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

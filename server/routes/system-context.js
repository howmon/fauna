// /api/system-context — returns enough system info for the AI to build
// an accurate context prompt (OS info, shell, desktop path, permissions
// snapshot, list of installed agents).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { computePermissions } from './permissions.js';
import { listVisibleWindows } from '../lib/window-context.js';

export function registerSystemContextRoutes(app, {
  isWin,
  shellBin,
  agentsDir,
  getGhToken,
  getSystemPreferences,
}) {
  app.get('/api/system-context', async (req, res) => {
    const { auth, screenRecording, accessibility, fullDiskAccess, automation } =
      computePermissions({ isWin, getGhToken, systemPreferences: getSystemPreferences() });

    // Collect installed agents (name + displayName only)
    const installedAgents = [];
    try {
      for (const entry of fs.readdirSync(agentsDir)) {
        const mp = path.join(agentsDir, entry, 'agent.json');
        if (fs.existsSync(mp)) {
          try {
            const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
            if (!m._parentAgent) installedAgents.push({ name: m.name || entry, displayName: m.displayName || m.name || entry });
          } catch (_) {}
        }
      }
    } catch (_) {}

    // Optional: include a compact summary of visible apps (Codex-style
    // "what's open" context). Opt-in via ?apps=1 so the default GET stays
    // cheap; pulling this requires Accessibility permission on macOS.
    let runningApps = null;
    if (req.query?.apps) {
      try {
        const info = await listVisibleWindows({ timeoutMs: 4000 });
        if (info.ok) {
          runningApps = info.apps.map(a => ({
            name: a.name,
            pid: a.pid,
            frontmost: !!a.frontmost,
            windowCount: (a.windows || []).length,
            windows: (a.windows || []).slice(0, 5).map(w => ({
              title: w.title, x: w.x, y: w.y, w: w.w, h: w.h,
            })),
          }));
        }
      } catch (_) {}
    }

    res.json({
      os:       isWin ? 'Windows' : 'macOS',
      release:  os.release(),
      hostname: os.hostname(),
      user:     os.userInfo().username,
      home:     os.homedir(),
      desktop:  path.join(os.homedir(), 'Desktop'),
      faunaDocs: process.env.FAUNA_DOCS || path.join(os.homedir(), 'Documents', 'Fauna'),
      cwd:      process.cwd(),
      shell:    shellBin,
      permissions: { auth, screenRecording, accessibility, fullDiskAccess, automation },
      installedAgents,
      runningApps,
    });
  });
}

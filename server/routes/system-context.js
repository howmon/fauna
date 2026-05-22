// /api/system-context — returns enough system info for the AI to build
// an accurate context prompt (OS info, shell, desktop path, permissions
// snapshot, list of installed agents).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { computePermissions } from './permissions.js';

export function registerSystemContextRoutes(app, {
  isWin,
  shellBin,
  agentsDir,
  getGhToken,
  getSystemPreferences,
}) {
  app.get('/api/system-context', (req, res) => {
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
    });
  });
}

// Shared iterator over installed agent directories.
// Visits primary (~/.config/fauna/agents), legacy (~/.config/copilot-chat/agents),
// and local (bundled app) agents/ directories. Earlier dirs take precedence on name collision.

import fs from 'fs';
import path from 'path';

export function createAgentDirIterator({ agentsDir, legacyAgentsDir, localAgentsDir }) {
  return function* iterAgentDirs() {
    const seen = new Set();
    const sources = [
      [agentsDir, 'user'],
      [legacyAgentsDir, 'user'],
      [localAgentsDir, 'local'],
    ];
    for (const [dir, src] of sources) {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (seen.has(name)) continue;
        seen.add(name);
        yield { name, agentDir: path.join(dir, name), source: src };
      }
    }
  };
}

// Shell execution environment constants.
//
// `AUGMENTED_PATH` extends PATH with Homebrew + common Unix locations so
// shelled-out commands like `git`, `gh`, `npm`, `node` can find binaries
// installed outside the Electron app's reduced PATH. `SHELL_BIN` picks
// PowerShell on Windows and zsh elsewhere.
//
// NPM registry forwarding:
// Corporate environments (e.g. Microsoft Defender-enforced blocks) may prevent
// direct access to registry.npmjs.org. We resolve the effective npm registry in
// priority order:
//   1. process.env.npm_config_registry  — already set (parent npm process / CI)
//   2. ~/.npmrc registry= line          — global npm config the user has set
//   3. ~/.config/fauna/config.json npmRegistry — Fauna-level override
// If any of these is set to a non-default value, inject it as
// `npm_config_registry` into every child shell so npm/pnpm/yarn commands
// automatically route through the configured feed without requiring the user to
// pre-configure each tool.

import fs from 'fs';
import path from 'path';
import os from 'os';

const NPM_DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

// Resolve the effective npm registry URL (null = use default / already set).
function _resolveNpmRegistry() {
  // 1. Already forwarded by a parent npm process.
  const envReg = process.env.npm_config_registry;
  if (envReg && !envReg.startsWith(NPM_DEFAULT_REGISTRY.replace(/\/$/, ''))) return envReg;

  // 2. User's global ~/.npmrc — look for a `registry=` line.
  try {
    const npmrc = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8');
    const m = npmrc.match(/^registry\s*=\s*(\S+)/m);
    if (m && m[1] && !m[1].startsWith(NPM_DEFAULT_REGISTRY.replace(/\/$/, ''))) return m[1];
  } catch (_) {}

  // 3. Fauna config override.
  try {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.config', 'fauna', 'config.json'), 'utf8'));
    if (cfg && cfg.npmRegistry && !cfg.npmRegistry.startsWith(NPM_DEFAULT_REGISTRY.replace(/\/$/, ''))) {
      return cfg.npmRegistry;
    }
  } catch (_) {}

  return null;
}

// Cached at module load — registry doesn't change during a session.
const _npmRegistry = _resolveNpmRegistry();

export function buildShellEnv(isWin) {
  const augmentedPath = isWin
    ? (process.env.PATH || '')
    : [
        '/opt/homebrew/bin', '/opt/homebrew/sbin',
        '/usr/local/bin', '/usr/local/sbin',
        '/usr/bin', '/usr/sbin', '/bin', '/sbin',
        process.env.PATH || ''
      ].join(':');
  const shellBin = isWin ? 'powershell.exe' : '/bin/zsh';
  // Inject registry env var so all npm/pnpm/yarn calls in child shells use it.
  const npmEnv = _npmRegistry ? { npm_config_registry: _npmRegistry } : {};
  return { augmentedPath, shellBin, npmEnv };
}

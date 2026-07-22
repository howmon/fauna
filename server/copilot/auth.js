// GitHub Copilot token discovery + OpenAI client factory.
// Resolution order (see getGhToken):
//   1. User-saved PAT (CONFIG_FILE)
//   2. GH_TOKEN / GITHUB_TOKEN env vars
//   3. macOS Keychain (gh:github.com)
//   4. gh binary auth token
//   5. ~/.config/gh/hosts.yml oauth_token
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import OpenAI from 'openai';
import { nativeHttpsFetch } from './native-https-fetch.js';

const IS_WIN = process.platform === 'win32';
const PATH_SEP = IS_WIN ? ';' : ':';

export const CONFIG_DIR   = path.join(os.homedir(), '.config', 'copilot-chat');
export const CONFIG_FILE  = path.join(CONFIG_DIR, 'config.json');
export const RECOVERY_DIR = path.join(os.homedir(), '.copilotchat-recovery');

export function findGhBinary() {
  const candidates = IS_WIN ? [
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'GitHub CLI', 'gh.exe'),
    path.join(os.homedir(), 'scoop', 'shims', 'gh.exe'),
  ] : [
    '/opt/homebrew/bin/gh',        // Apple Silicon Homebrew
    '/usr/local/bin/gh',           // Intel Homebrew
    '/usr/bin/gh',
    '/snap/bin/gh',
  ];
  // Also try PATH entries
  const binName = IS_WIN ? 'gh.exe' : 'gh';
  const pathDirs = (process.env.PATH || '').split(PATH_SEP);
  for (const dir of pathDirs) candidates.push(path.join(dir, binName));

  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {}
  }
  return null;
}

export function readTokenFromKeychain() {
  if (IS_WIN) return null;  // macOS Keychain not available on Windows
  // gh stores tokens as base64 in the macOS Keychain under service "gh:github.com"
  // /usr/bin/security is always available even in Electron's stripped PATH
  try {
    const raw = execSync(
      '/usr/bin/security find-generic-password -s "gh:github.com" -w',
      { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }
    ).trim();
    // gh encodes tokens as "go-keyring-base64:<base64>"
    if (raw.startsWith('go-keyring-base64:')) {
      return Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf8').trim();
    }
    return raw;
  } catch (_) { return null; }
}

export function readTokenFromConfig() {
  // Fallback: parse ~/.config/gh/hosts.yml for oauth_token
  try {
    const yml = fs.readFileSync(path.join(os.homedir(), '.config', 'gh', 'hosts.yml'), 'utf8');
    const match = yml.match(/oauth_token:\s*(\S+)/);
    return match ? match[1].trim() : null;
  } catch (_) { return null; }
}

export function readSavedConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) { return {}; }
}

export function writeSavedConfig(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

export function getGhToken() {
  // 0. User-saved PAT (highest priority — explicitly set by user in UI)
  const cfg = readSavedConfig();
  if (cfg.pat && cfg.pat.trim()) return cfg.pat.trim();

  // 1. Env vars
  if (process.env.GH_TOKEN)     return process.env.GH_TOKEN.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();

  // 2. macOS Keychain (most reliable in Electron)
  const keychainToken = readTokenFromKeychain();
  if (keychainToken) return keychainToken;

  // 3. gh binary (fallback, may fail in Electron .app)
  const gh = findGhBinary();
  if (gh) {
    try {
      return execSync(`"${gh}" auth token`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    } catch (_) {}
  }

  // 4. Config file oauth_token
  const cfgToken = readTokenFromConfig();
  if (cfgToken) return cfgToken;

  throw new Error('GitHub token not found. Run: gh auth login');
}

export function getCopilotClient() {
  const token = getGhToken();
  return new OpenAI({
    baseURL: 'https://api.githubcopilot.com',
    apiKey:  token,
    fetch: typeof WebAssembly === 'undefined' ? nativeHttpsFetch : undefined,
    defaultHeaders: {
      'Editor-Version':        'vscode/1.85.0',
      'Copilot-Integration-Id': 'vscode-chat'
    }
  });
}

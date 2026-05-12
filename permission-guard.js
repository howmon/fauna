// ── Permission Guard — LLM-explained command permission dialogs ───────────
// Before executing shell commands, checks against a safe-list of read-only
// commands. Unknown commands get a one-sentence LLM explanation and show a
// native dialog with Allow / Auto-allow / Deny buttons.

/**
 * @typedef {(prompt: string, model?: string) => Promise<string>} AICaller
 * @typedef {(command: string, explanation: string) => Promise<'allow'|'deny'|'auto-allow'>} ShowDialog
 * @typedef {{showDialog?: ShowDialog, aiCaller?: AICaller}} PermissionOptions
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const PERMS_FILE = path.join(CONFIG_DIR, 'permissions.json');

// ── Known-safe read-only command patterns ─────────────────────────────

const SAFE_PATTERNS = [
  // File listing & reading
  /^ls\b/, /^ll\b/, /^la\b/, /^dir\b/, /^cat\b/, /^head\b/, /^tail\b/, /^less\b/, /^more\b/,
  /^wc\b/, /^file\b/, /^stat\b/, /^du\b/, /^df\b/, /^find\b.*-print/, /^find\b.*-name/,
  /^tree\b/, /^exa\b/, /^bat\b/, /^fd\b/,
  // Search
  /^grep\b/, /^rg\b/, /^ag\b/, /^ack\b/, /^fgrep\b/, /^egrep\b/,
  // Git read-only
  /^git\s+(status|log|diff|show|branch|tag|remote|stash\s+list|ls-files|rev-parse|describe|shortlog|blame|reflog)(\s|$)/,
  /^git\s+--no-pager\b/,
  // System info
  /^uname\b/, /^hostname\b/, /^whoami\b/, /^id\b/, /^env\b/, /^printenv\b/,
  /^uptime\b/, /^date\b/, /^cal\b/, /^arch\b/, /^sw_vers\b/, /^system_profiler\b/,
  /^sysctl\b.*-a/, /^top\s+-l\s*1\b/, /^vm_stat\b/,
  // Process info
  /^ps\b/, /^pgrep\b/, /^lsof\b/, /^netstat\b/, /^ss\b/,
  // Network read-only
  /^ping\b/, /^dig\b/, /^nslookup\b/, /^host\b/, /^traceroute\b/, /^ifconfig\b/,
  /^curl\s.*--head\b/, /^curl\s.*-I\b/, /^wget\s.*--spider\b/,
  // Package info (read-only)
  /^npm\s+(ls|list|outdated|info|show|view|search|audit|why)(\s|$)/,
  /^npx\s/, /^yarn\s+(list|info|why)(\s|$)/,
  /^pip\s+(list|show|freeze)(\s|$)/, /^pip3\s+(list|show|freeze)(\s|$)/,
  /^brew\s+(list|info|search|outdated|doctor|config)(\s|$)/,
  /^gem\s+(list|info|search)(\s|$)/,
  // Dev tools (read-only)
  /^node\s+(-e\s+|--eval\s+)?["'].*["']$/, /^node\s+-v/, /^node\s+--version/,
  /^python3?\s+(-c\s+)?["'].*["']$/, /^python3?\s+-V/, /^python3?\s+--version/,
  /^ruby\s+-v/, /^go\s+version/, /^rustc\s+--version/, /^java\s+-version/,
  /^which\b/, /^where\b/, /^type\b/, /^command\s+-v\b/, /^man\b/, /^help\b/,
  // Editor/pager
  /^echo\b/, /^printf\b/, /^test\b/, /^\[\[/, /^true$/, /^false$/,
  // JSON/YAML tools
  /^jq\b/, /^yq\b/, /^xq\b/,
  // Disk/mount info
  /^mount$/, /^diskutil\s+(list|info)(\s|$)/,
  // Xcode
  /^xcodebuild\s+-showsdks/, /^xcrun\b/, /^xcode-select\s+-p/,
  // Docker read-only
  /^docker\s+(ps|images|info|version|inspect|logs|top|stats|network\s+ls|volume\s+ls)(\s|$)/,
  /^docker\s+compose\s+(ps|logs|config)(\s|$)/,
  // Kubernetes read-only
  /^kubectl\s+(get|describe|logs|top|config\s+view|cluster-info|api-resources|api-versions|version)(\s|$)/,
];

// ── Persistence — auto-allow list ─────────────────────────────────────

let _autoAllowed = null;

function _loadAutoAllowed() {
  if (_autoAllowed) return _autoAllowed;
  try {
    const data = JSON.parse(fs.readFileSync(PERMS_FILE, 'utf8'));
    _autoAllowed = new Set(Array.isArray(data.autoAllowed) ? data.autoAllowed : []);
  } catch (_) {
    _autoAllowed = new Set();
  }
  return _autoAllowed;
}

function _saveAutoAllowed() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PERMS_FILE, JSON.stringify({ autoAllowed: [..._autoAllowed] }, null, 2));
}

// ── Public API ──────────────────────────────────────────────────────────

export function isCommandSafe(command) {
  const trimmed = (command || '').trim();
  // Check safe patterns
  for (const pattern of SAFE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  // Check auto-allowed
  const aa = _loadAutoAllowed();
  // Match by command prefix (first word)
  const firstWord = trimmed.split(/\s/)[0];
  if (aa.has(firstWord)) return true;
  if (aa.has(trimmed)) return true;

  return false;
}

export function addAutoAllow(command) {
  _loadAutoAllowed();
  _autoAllowed.add(command);
  _saveAutoAllowed();
}

export function getAutoAllowList() {
  return [..._loadAutoAllowed()];
}

export function removeAutoAllow(command) {
  _loadAutoAllowed();
  _autoAllowed.delete(command);
  _saveAutoAllowed();
}

export function clearAutoAllow() {
  _autoAllowed = new Set();
  _saveAutoAllowed();
}

// ── LLM explanation for unknown commands ───────────────────────────────

export async function explainCommand(command, aiCaller) {
  if (!aiCaller) return 'Unable to explain — no AI caller available.';
  try {
    const prompt = `In ONE sentence (max 30 words), explain what this shell command does and whether it modifies anything on the system. Be specific about side effects. Command: ${command}`;
    return await aiCaller(prompt, 'gpt-4.1-mini');
  } catch (_) {
    return 'Unable to explain this command.';
  }
}

// ── Permission check flow ──────────────────────────────────────────────
// Returns: 'allow' | 'deny'
// For unsafe commands, calls the IPC dialog handler

export async function checkCommandPermission(command, options = {}) {
  // Safe commands always allowed
  if (isCommandSafe(command)) return 'allow';

  const { showDialog, aiCaller } = options;

  // Get explanation
  let explanation = '';
  if (aiCaller) {
    try { explanation = await explainCommand(command, aiCaller); } catch (_) {}
  }

  // Show dialog
  if (showDialog) {
    const result = await showDialog(command, explanation);
    if (result === 'auto-allow') {
      const firstWord = command.trim().split(/\s/)[0];
      addAutoAllow(firstWord);
      return 'allow';
    }
    return result === 'allow' ? 'allow' : 'deny';
  }

  // No dialog available — deny by default
  return 'deny';
}

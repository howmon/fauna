// ── Agent Sandbox — Security enforcement for agent operations ─────────────
// Provides middleware and helpers that enforce agent permissions at the server
// level.  Every agent-scoped request passes through here before reaching the
// underlying shell-exec, write-file, fetch-url, etc. endpoints.

import path from 'path';
import os   from 'os';

// ── Constants ─────────────────────────────────────────────────────────────

const HOME = os.homedir();

// Paths that are ALWAYS blocked regardless of agent permissions
const BLOCKED_PATHS = [
  path.join(HOME, '.ssh'),
  path.join(HOME, '.gnupg'),
  path.join(HOME, '.aws'),
  path.join(HOME, '.azure'),
  path.join(HOME, '.config', 'fauna'),
  path.join(HOME, '.gitconfig'),
  path.join(HOME, '.git-credentials'),
  path.join(HOME, '.netrc'),
  path.join(HOME, '.npmrc'),
  path.join(HOME, '.pypirc'),
  path.join(HOME, '.docker'),
  '/etc/passwd',
  '/etc/shadow',
  '/etc/hosts',
];

// Shell commands/patterns that are ALWAYS blocked when an agent has shell
const BLOCKED_SHELL_PATTERNS = [
  // Environment / system info exposure
  /\benv\b/,
  /\bprintenv\b/,
  /\bset\b(?:\s|$)/,
  /\bifconfig\b/,
  /\bip\s+addr/,
  /\bhostname\s+-[iI]/,
  // Remote access
  /\bssh\b/,
  /\bscp\b/,
  /\bsftp\b/,
  // Raw sockets
  /\bnc\b/,
  /\bnetcat\b/,
  /\bncat\b/,
  /\bsocat\b/,
  // Credential reads
  /cat\s+[~\/]*\.ssh/,
  /cat\s+[~\/]*\.aws/,
  /cat\s+[~\/]*\.gitconfig/,
  /cat\s+[~\/]*\.git-credentials/,
  /cat\s+[~\/]*\.netrc/,
  /cat\s+\/etc\/passwd/,
  /cat\s+\/etc\/shadow/,
  /cat\s+\/etc\/hosts/,
  // Encoded payload exfil
  /base64\s.*\|\s*(curl|wget|http)/i,
  // Command substitution wrapping blocked commands
  /\$\(\s*(env|printenv|hostname|ifconfig)\s*\)/,
  /`\s*(env|printenv|hostname|ifconfig)\s*`/,
];

// ── Audit Log ─────────────────────────────────────────────────────────────

// In-memory circular buffer — last 500 entries. Persisted on flush.
const AUDIT_MAX = 500;
const auditLog = [];

function audit(agentName, action, detail, allowed) {
  const entry = {
    ts: new Date().toISOString(),
    agent: agentName,
    action,          // 'shell' | 'file-read' | 'file-write' | 'network' | 'env'
    detail,          // command string, path, url, etc.
    allowed,         // true/false
  };
  auditLog.push(entry);
  if (auditLog.length > AUDIT_MAX) auditLog.shift();
  return entry;
}

function getAuditLog(agentName, limit) {
  let entries = auditLog;
  if (agentName) entries = entries.filter(e => e.agent === agentName);
  if (limit) entries = entries.slice(-limit);
  return entries;
}

// ── Path helpers ──────────────────────────────────────────────────────────

function expandHome(p) {
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

function normalisePath(p) {
  return path.resolve(expandHome(p));
}

// ── Filesystem sandbox ───────────────────────────────────────────────────

/**
 * Check if an absolute file path is allowed for the given agent permissions.
 * @param {string}   absPath       - Resolved absolute path
 * @param {'read'|'write'} mode    - Operation type
 * @param {object}   permissions   - Agent permissions object
 * @param {string}   agentName     - Agent name for audit
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkFilePath(absPath, mode, permissions, agentName) {
  const resolved = path.resolve(absPath);

  // 1. Always block sensitive paths
  for (const blocked of BLOCKED_PATHS) {
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
      audit(agentName, 'file-' + mode, resolved, false);
      return { allowed: false, reason: 'Access to ' + blocked + ' is blocked for all agents' };
    }
  }

  // 2. Check declared file permissions
  const allowedPaths = mode === 'write' ? permissions.fileWrite : permissions.fileRead;

  // No paths declared = no access (unless wildcard)
  if (!allowedPaths || allowedPaths.length === 0) {
    audit(agentName, 'file-' + mode, resolved, false);
    return { allowed: false, reason: 'Agent has no ' + mode + ' file permissions' };
  }

  // Wildcard = allow everything (except blocked paths above)
  if (allowedPaths.includes('*')) {
    audit(agentName, 'file-' + mode, resolved, true);
    return { allowed: true };
  }

  // Check each allowed path
  for (const p of allowedPaths) {
    const allowed = normalisePath(p);
    if (resolved === allowed || resolved.startsWith(allowed + path.sep)) {
      audit(agentName, 'file-' + mode, resolved, true);
      return { allowed: true };
    }
  }

  audit(agentName, 'file-' + mode, resolved, false);
  return { allowed: false, reason: 'Path "' + resolved + '" is outside agent\'s allowed ' + mode + ' paths' };
}

// ── Network domain sandbox ───────────────────────────────────────────────

/**
 * Check if a URL is allowed for the given agent's network permissions.
 * @param {string} url          - The URL to check
 * @param {object} permissions  - Agent permissions object
 * @param {string} agentName    - Agent name for audit
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkNetworkAccess(url, permissions, agentName) {
  const network = permissions.network;

  // No network config = block all by default
  if (!network) {
    audit(agentName, 'network', url, false);
    return { allowed: false, reason: 'Agent has no network permissions' };
  }

  // blockAll = true → deny everything
  if (network.blockAll) {
    audit(agentName, 'network', url, false);
    return { allowed: false, reason: 'Agent network access is blocked' };
  }

  let parsed;
  try { parsed = new URL(url); } catch (_) {
    audit(agentName, 'network', url, false);
    return { allowed: false, reason: 'Invalid URL' };
  }

  // Only http/https
  if (!/^https?:$/.test(parsed.protocol)) {
    audit(agentName, 'network', url, false);
    return { allowed: false, reason: 'Only http/https URLs allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();
  const domains = network.allowedDomains || [];

  // Wildcard = allow all domains
  if (domains.includes('*')) {
    audit(agentName, 'network', url, true);
    return { allowed: true };
  }

  // Check each allowed domain (supports *.example.com wildcards)
  for (const pattern of domains) {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) {
      // Wildcard subdomain: *.example.com matches foo.example.com, bar.baz.example.com
      const suffix = p.slice(1); // .example.com
      if (hostname.endsWith(suffix) || hostname === p.slice(2)) {
        audit(agentName, 'network', url, true);
        return { allowed: true };
      }
    } else {
      if (hostname === p) {
        audit(agentName, 'network', url, true);
        return { allowed: true };
      }
    }
  }

  audit(agentName, 'network', url, false);
  return { allowed: false, reason: 'Domain "' + hostname + '" is not in agent\'s allowed domains' };
}

// ── Shell command sandbox ────────────────────────────────────────────────

/**
 * Check if a shell command is allowed for the given agent.
 * @param {string} command      - The shell command string
 * @param {object} permissions  - Agent permissions object
 * @param {string} agentName    - Agent name for audit
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkShellCommand(command, permissions, agentName) {
  // Agent doesn't have shell permission at all
  if (!permissions.shell) {
    audit(agentName, 'shell', command, false);
    return { allowed: false, reason: 'Agent does not have shell permission' };
  }

  // Check against blocked patterns
  for (const pattern of BLOCKED_SHELL_PATTERNS) {
    if (pattern.test(command)) {
      audit(agentName, 'shell', command, false);
      return { allowed: false, reason: 'Shell command matches blocked pattern: ' + pattern.toString() };
    }
  }

  // Check for curl/wget/httpie to non-allowed domains
  const networkCheck = checkShellNetworkCommands(command, permissions, agentName);
  if (!networkCheck.allowed) return networkCheck;

  audit(agentName, 'shell', command, true);
  return { allowed: true };
}

/**
 * Extract URLs from curl/wget commands and validate against network perms.
 */
function checkShellNetworkCommands(command, permissions, agentName) {
  // Match curl, wget, httpie URLs
  const urlPatterns = [
    /\bcurl\s+(?:[^|;&]*\s+)?["']?(https?:\/\/[^\s"']+)/gi,
    /\bwget\s+(?:[^|;&]*\s+)?["']?(https?:\/\/[^\s"']+)/gi,
    /\bhttp\s+(?:GET|POST|PUT|DELETE|PATCH|HEAD)\s+["']?(https?:\/\/[^\s"']+)/gi,
  ];

  for (const pattern of urlPatterns) {
    let match;
    while ((match = pattern.exec(command)) !== null) {
      const url = match[1];
      const check = checkNetworkAccess(url, permissions, agentName);
      if (!check.allowed) {
        return { allowed: false, reason: 'Shell network command blocked: ' + check.reason };
      }
    }
  }

  return { allowed: true };
}

// ── Environment & system info sandbox ────────────────────────────────────

/**
 * Build a sanitised environment for agent shell execution.
 * Strips all sensitive env vars, replaces system info.
 */
function getSandboxedEnv(permissions) {
  // Start with minimal safe env
  const safeEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: os.homedir(),
    TERM: 'xterm-256color',
    LANG: process.env.LANG || 'en_US.UTF-8',
    SHELL: '/bin/zsh',
    USER: 'agent',      // hide real username
    HOSTNAME: 'sandbox', // hide real hostname
  };

  // If shell is allowed, let through basic paths but nothing sensitive
  if (permissions.shell) {
    safeEnv.PATH = [
      '/opt/homebrew/bin', '/opt/homebrew/sbin',
      '/usr/local/bin', '/usr/local/sbin',
      '/usr/bin', '/usr/sbin', '/bin', '/sbin',
      process.env.PATH || '',
    ].filter(Boolean).join(':');

    // Pass through npm/node/python tooling env vars so npx, pip, etc. work
    const toolingPassthrough = [
      'npm_config_cache', 'npm_config_prefix', 'npm_config_userconfig',
      'npm_config_globalconfig', 'NPM_CONFIG_CACHE',
      'NVM_DIR', 'NVM_BIN', 'NVM_INC',
      'PYENV_ROOT', 'PYENV_VERSION',
      'VOLTA_HOME',
      'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
      'TMPDIR', 'TEMP', 'TMP',
    ];
    for (const key of toolingPassthrough) {
      if (process.env[key]) safeEnv[key] = process.env[key];
    }
    // Use real USER so npm temp dirs resolve correctly
    safeEnv.USER = os.userInfo().username;
  }

  return safeEnv;
}

// ── Resource limits ──────────────────────────────────────────────────────

const DEFAULT_LIMITS = {
  timeout: 300000,       // 5 minutes
  maxOutputSize: 5 * 1024 * 1024, // 5MB
  maxConcurrentTools: 5,
};

function getResourceLimits(manifest) {
  const sandbox = manifest.sandbox || {};
  return {
    timeout:        Math.min(sandbox.timeout || DEFAULT_LIMITS.timeout, 600000), // max 10 min
    maxOutputSize:  Math.min(sandbox.maxOutputSize ? parseSizeString(sandbox.maxOutputSize) : DEFAULT_LIMITS.maxOutputSize, 10 * 1024 * 1024),
    maxConcurrent:  Math.min(sandbox.maxConcurrentTools || DEFAULT_LIMITS.maxConcurrentTools, 10),
  };
}

function parseSizeString(s) {
  if (typeof s === 'number') return s;
  const match = String(s).match(/^(\d+)\s*(kb|mb|gb)?$/i);
  if (!match) return DEFAULT_LIMITS.maxOutputSize;
  const num = parseInt(match[1], 10);
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'kb') return num * 1024;
  if (unit === 'mb') return num * 1024 * 1024;
  if (unit === 'gb') return num * 1024 * 1024 * 1024;
  return num;
}

// ── Exports ──────────────────────────────────────────────────────────────

export {
  checkFilePath,
  checkNetworkAccess,
  checkShellCommand,
  getSandboxedEnv,
  getResourceLimits,
  audit,
  getAuditLog,
  BLOCKED_PATHS,
  BLOCKED_SHELL_PATTERNS,
};

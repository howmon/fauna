/**
 * Teams Bot Manager — spawns/stops the fauna-bot server as a child process.
 *
 * Config is stored in ~/.config/fauna/teams-bot-config.json and passed to
 * the child process as environment variables. The child's health endpoint
 * is polled to surface the live tunnel URL back to the Fauna UI.
 */

import fs         from 'fs';
import path       from 'path';
import os         from 'os';
import crypto     from 'crypto';
import { spawn }  from 'child_process';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR  = path.join(os.homedir(), '.config', 'fauna');
const CONFIG_FILE = path.join(CONFIG_DIR, 'teams-bot-config.json');
const BOT_PORT    = 3978;
const IS_WIN      = process.platform === 'win32';
const PATH_SEP    = IS_WIN ? ';' : ':';

const DEFAULTS = {
  mode:        'gateway', // standalone | gateway
  appId:       '',
  appPassword: '',
  tenantId:    '',
  subdomain:   'fauna-bot',
  gatewayUrl:  'https://bot.pointlabel.com',
  gatewayRouteKey: '',
  gatewayAdminToken: '',
  autoStart:   false,
};

let _config  = null;
let _proc    = null;   // child process
let _domain  = null;   // live tunnel domain (parsed from child stdout)
let _status  = 'stopped'; // stopped | starting | running | error
let _lastErr = null;

// ── Config persistence ─────────────────────────────────────────────────────

function loadConfig() {
  if (_config) return _config;
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    _config = { ...DEFAULTS, ...saved };
    if (saved.mode === undefined && _config.appId && _config.appPassword) _config.mode = 'standalone';
  } catch {
    _config = { ...DEFAULTS };
  }
  return _config;
}

function saveConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(_config, null, 2));
}

export function getBotConfig() {
  const c = { ...loadConfig() };
  if (c.appPassword) c.appPassword = c.appPassword.slice(0, 4) + '…'; // mask
  if (c.gatewayAdminToken) c.gatewayAdminToken = c.gatewayAdminToken.slice(0, 4) + '…';
  return c;
}

export function updateBotConfig(patch) {
  loadConfig();
  if (patch.mode        !== undefined) _config.mode        = patch.mode === 'gateway' ? 'gateway' : 'standalone';
  if (patch.appId       !== undefined) _config.appId       = String(patch.appId);
  if (patch.appPassword !== undefined) _config.appPassword = String(patch.appPassword);
  if (patch.tenantId    !== undefined) _config.tenantId    = String(patch.tenantId);
  if (patch.subdomain   !== undefined) _config.subdomain   = String(patch.subdomain).replace(/[^a-z0-9-]/g, '');
  if (patch.gatewayUrl  !== undefined) _config.gatewayUrl  = String(patch.gatewayUrl).replace(/\/+$/, '');
  if (patch.gatewayRouteKey !== undefined) _config.gatewayRouteKey = String(patch.gatewayRouteKey).trim();
  if (patch.gatewayAdminToken !== undefined) _config.gatewayAdminToken = String(patch.gatewayAdminToken);
  if (patch.autoStart   !== undefined) _config.autoStart   = !!patch.autoStart;
  saveConfig();
  return getBotConfig();
}

// ── Process management ─────────────────────────────────────────────────────

export function getBotStatus() {
  const config = loadConfig();
  const gatewayMode = config.mode === 'gateway';
  const gatewayUrl = (config.gatewayUrl || DEFAULTS.gatewayUrl).replace(/\/+$/, '');

  return {
    status:           _status,
    domain:           _domain,
    mode:             config.mode,
    routeKey:         config.gatewayRouteKey || null,
    messagingEndpoint: gatewayMode ? `${gatewayUrl}/api/messages` : (_domain ? `https://${_domain}/api/messages` : null),
    downloadUrl:      gatewayMode ? `${gatewayUrl}/download-app` : (_status === 'running' ? `http://localhost:${BOT_PORT}/download-app` : null),
    pid:              _proc?.pid ?? null,
    error:            _lastErr,
  };
}

export function startBot() {
  loadConfig();

  if (_proc) return getBotStatus(); // already running

  const gatewayMode = _config.mode === 'gateway';

  if (!gatewayMode && (!_config.appId || !_config.appPassword)) {
    _status  = 'error';
    _lastErr = 'App ID and App Password are required';
    return getBotStatus();
  }

  if (gatewayMode && (!_config.gatewayUrl || !_config.gatewayRouteKey || !_config.gatewayAdminToken)) {
    _status  = 'error';
    _lastErr = 'Gateway URL, route key, and registration token are required in gateway mode';
    return getBotStatus();
  }

  _status  = 'starting';
  _domain  = null;
  _lastErr = null;

  const routeSecret = crypto.randomBytes(32).toString('hex');

  const env = {
    ...process.env,
    MicrosoftAppId:       gatewayMode ? '' : _config.appId,
    MicrosoftAppPassword: gatewayMode ? '' : _config.appPassword,
    MicrosoftAppTenantId: _config.tenantId || '',
    TUNNEL_SUBDOMAIN:     _config.subdomain || 'fauna-bot',
    PORT:                 String(BOT_PORT),
    FAUNA_WS_URL:         `ws://localhost:${process.env.FAUNA_PORT || 3737}/api/teams-relay`,
    FAUNA_GATEWAY_MODE:   gatewayMode ? '1' : '0',
    FAUNA_GATEWAY_SECRET: gatewayMode ? routeSecret : '',
  };

  // Remove BOT_DOMAIN so the child always auto-starts the tunnel
  delete env.BOT_DOMAIN;

  const botEntry = _getBotEntryPath();
  const nodeBin = _getNodeBinary();

  if (process.versions?.electron && nodeBin === process.execPath) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  env.PATH = IS_WIN
    ? (env.PATH || '')
    : `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${env.PATH || ''}`;

  _proc = spawn(nodeBin, [botEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  _proc.on('error', (err) => {
    _proc = null;
    _domain = null;
    _status = 'error';
    _lastErr = `Could not start Teams bot process: ${err.message}`;
    console.error('[fauna-bot] Spawn failed:', err);
  });

  _proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[fauna-bot] ${text}`);

    // Parse tunnel URL from child stdout:  ✅ Public URL: https://fauna-bot.loca.lt
    const m = text.match(/Public URL:\s*(https:\/\/[^\s]+)/);
    if (m) {
      _domain = m[1].replace('https://', '');
      if (gatewayMode) {
        _registerGatewayRoute(routeSecret).then(() => {
          _status = 'running';
        }).catch((err) => {
          _status = 'error';
          _lastErr = `Gateway route registration failed: ${err.message}`;
        });
      } else {
        _status = 'running';
      }
    }

    // Fallback: bot announced it started without a tunnel (BOT_DOMAIN was set)
    if (text.includes('running on port')) {
      if (_status === 'starting') {
        setTimeout(() => { if (_status === 'starting') _status = 'running'; }, 5000);
      }
    }
  });

  _proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    process.stderr.write(`[fauna-bot:err] ${text}`);
  });

  _proc.on('exit', (code) => {
    _proc    = null;
    _domain  = null;
    _status  = code === 0 ? 'stopped' : 'error';
    _lastErr = code !== 0 ? `Process exited with code ${code}` : null;
    console.log(`[fauna-bot] Process exited (code ${code})`);
  });

  return getBotStatus();
}

export function stopBot() {
  if (_proc) {
    _proc.kill('SIGTERM');
    _proc    = null;
    _domain  = null;
    _status  = 'stopped';
    _lastErr = null;
  }
  return getBotStatus();
}

export function initBotManager() {
  loadConfig();
  const standaloneReady = _config.mode !== 'gateway' && _config.appId && _config.appPassword;
  const gatewayReady = _config.mode === 'gateway' && _config.gatewayUrl && _config.gatewayRouteKey && _config.gatewayAdminToken;

  if (_config.autoStart && (standaloneReady || gatewayReady)) {
    console.log('[fauna-bot] Auto-starting Teams bot…');
    startBot();
  }
}

async function _registerGatewayRoute(routeSecret) {
  const gatewayUrl = (_config.gatewayUrl || DEFAULTS.gatewayUrl).replace(/\/+$/, '');
  const target = `https://${_domain}/api/messages`;
  const res = await fetch(`${gatewayUrl}/api/routes/register`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${_config.gatewayAdminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      routeKey: _config.gatewayRouteKey,
      target,
      routeSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body}`);
  }
}

function _getBotEntryPath() {
  const entry = path.join(__dirname, 'fauna-bot', 'server', 'index.js');
  if (entry.includes('app.asar')) {
    const unpacked = entry.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return entry;
}

function _getNodeBinary() {
  const candidates = IS_WIN ? [
    'C:\\Program Files\\nodejs\\node.exe',
    path.join(os.homedir(), 'AppData', 'Roaming', 'nvm', 'current', 'node.exe'),
    path.join(os.homedir(), 'scoop', 'shims', 'node.exe'),
  ] : [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/opt/homebrew/opt/node/bin/node',
    '/usr/bin/node',
  ];

  const binName = IS_WIN ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH || '').split(PATH_SEP)) {
    if (dir) candidates.push(path.join(dir, binName));
  }

  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) {}
  }

  return process.execPath;
}

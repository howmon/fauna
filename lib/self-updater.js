// Self-updater with two explicit channels:
//   stable (default) installs artifacts from the latest GitHub release;
//   beta (opt-in) tracks `main` and rebuilds it from source.
//
// Ported from faunaMCP-main/main.js — same state machine, refactored into
// an ESM module with no Electron import-time coupling so it can be unit
// tested by injecting a fake `app`.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { spawn, execSync } from 'child_process';

const USER_AGENT = 'fauna-self-updater';
const MAX_LOG_ENTRIES = 160;
const UPDATERS_BY_APP = new WeakMap();

/**
 * Parse owner/repo out of package.json's `repository.url`. Handles the three
 * shapes npm tolerates: `git+https://github.com/owner/repo.git`,
 * `https://github.com/owner/repo.git`, `git@github.com:owner/repo.git`.
 * Returns null if the URL is not a github.com shape — caller must surface
 * "self-update unavailable" to the user instead of guessing a repo.
 * @param {string|undefined} url
 * @returns {{owner:string, repo:string}|null}
 */
export function parseGithubRepo(url) {
  if (!url || typeof url !== 'string') return null;
  // git@github.com:owner/repo.git
  let m = url.match(/git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  // any https/git+https form
  m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/**
 * Derive the installed `.app` bundle path from any path inside it. Walks up
 * until we hit a directory ending in `.app`. Returns null if the running
 * process isn't inside an .app bundle (typical for `electron .` dev runs).
 * @param {string} startPath
 * @returns {string|null}
 */
export function findAppBundlePath(startPath) {
  if (!startPath || typeof startPath !== 'string') return null;
  let cur = path.resolve(startPath);
  // Walk up at most 12 levels — typical depth is Fauna.app/Contents/MacOS/<bin>
  for (let i = 0; i < 12; i++) {
    if (cur.endsWith('.app')) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

export function compareVersions(left, right) {
  const parse = value => String(value || '').replace(/^v/i, '').split('-')[0].split('.').map(part => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
  }
  return 0;
}

export function selectReleaseAsset(assets, { platform = process.platform, arch = process.arch, product = 'Fauna' } = {}) {
  const list = Array.isArray(assets) ? assets : [];
  const escapedProduct = product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const productPattern = new RegExp(`^${escapedProduct}[-.]`, 'i');
  const candidates = list.filter(asset => productPattern.test(asset?.name || '') && !/^FaunaMCP[-.]/i.test(asset.name));
  if (platform === 'darwin') {
    const dmgs = candidates.filter(asset => /\.dmg$/i.test(asset.name));
    return arch === 'arm64'
      ? dmgs.find(asset => /-arm64\.dmg$/i.test(asset.name)) || null
      : dmgs.find(asset => !/-arm64\.dmg$/i.test(asset.name)) || null;
  }
  if (platform === 'win32') {
    return candidates.find(asset => /\.exe$/i.test(asset.name) && (arch !== 'arm64' || /arm64/i.test(asset.name))) || null;
  }
  return null;
}

export function selectLatestRelease(releases, options = {}) {
  return (Array.isArray(releases) ? releases : [])
    .filter(release => !release?.draft && !release?.prerelease && /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(release?.tag_name || ''))
    .filter(release => selectReleaseAsset(release.assets, options))
    .sort((left, right) => compareVersions(right.tag_name, left.tag_name))[0] || null;
}

/**
 * Pure state machine. Caller passes the previous state + an event; we
 * return the next state. Split out so the tricky transitions are unit-
 * testable without a real Electron app.
 */
export function nextUpdateState(prev, evt) {
  const base = { ...prev };
  switch (evt.type) {
    case 'check_start':
      return { ...base, checking: true, error: null, phase: 'checking', message: evt.message || 'Checking for updates...' };
    case 'check_result':
      return {
        ...base,
        checking: false,
        latestSha: evt.latestSha,
        latestVersion: evt.latestVersion ?? base.latestVersion,
        releaseAsset: evt.releaseAsset ?? base.releaseAsset,
        currentSha: evt.currentSha ?? base.currentSha,
        updateAvailable: evt.updateAvailable ?? (!!evt.latestSha && evt.latestSha !== (evt.currentSha ?? base.currentSha)),
        phase: (evt.updateAvailable ?? (!!evt.latestSha && evt.latestSha !== (evt.currentSha ?? base.currentSha))) ? 'available' : 'current',
        message: (evt.updateAvailable ?? (!!evt.latestSha && evt.latestSha !== (evt.currentSha ?? base.currentSha)))
          ? (evt.message || `Update available: ${(evt.latestVersion || evt.latestSha || '').replace(/^v/, '').slice(0, 12)}`)
          : 'Fauna is up to date',
        checkedAt: Date.now(),
      };
    case 'check_error':
      return { ...base, checking: false, phase: 'error', error: evt.message, message: 'Update check failed: ' + evt.message };
    case 'install_start':
      return { ...base, running: true, checking: false, phase: 'starting', error: null, message: 'Starting update', logs: [] };
    case 'install_log': {
      const logs = (base.logs || []).slice();
      logs.push({ ts: Date.now(), message: evt.message });
      if (logs.length > MAX_LOG_ENTRIES) logs.shift();
      return { ...base, logs, phase: evt.phase || base.phase, message: evt.message };
    }
    case 'install_complete':
      return { ...base, running: false, phase: 'complete', message: 'Update installed', currentSha: evt.installedSha || base.currentSha, currentVersion: evt.installedVersion || base.currentVersion, updateAvailable: false };
    case 'channel_change':
      return { ...INITIAL_STATE, channel: evt.channel, currentSha: evt.currentSha ?? null, currentVersion: evt.currentVersion ?? base.currentVersion };
    case 'install_error':
      return { ...base, running: false, phase: 'error', error: evt.message, message: 'Update failed: ' + evt.message };
    default:
      return base;
  }
}

export const INITIAL_STATE = Object.freeze({
  checking: false,
  running: false,
  phase: 'idle',
  message: 'Idle',
  error: null,
  currentSha: null,
  latestSha: null,
  currentVersion: null,
  latestVersion: null,
  releaseAsset: null,
  channel: 'stable',
  updateAvailable: false,
  checkedAt: null,
  logs: [],
});

// ── HTTP helpers (small, no axios — keep the module dependency-free) ──────

async function requestJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github+json' } });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

async function downloadFile(url, dest) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const source = Readable.fromWeb(response.body);
    source.on('error', error => {
      file.destroy();
      reject(error);
    });
    source.pipe(file);
    file.on('finish', () => file.close(() => resolve()));
    file.on('error', reject);
  });
}

async function verifyFileDigest(filePath, digest) {
  if (!digest) return;
  const match = String(digest).match(/^sha256:([a-f0-9]{64})$/i);
  if (!match) throw new Error('Release asset has an unsupported digest');
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const actual = hash.digest('hex');
  if (actual.toLowerCase() !== match[1].toLowerCase()) throw new Error('Downloaded release failed SHA-256 verification');
}

// ── Tool discovery (node + npm, packaged-electron-safe) ───────────────────
//
// When Fauna runs from an .app bundle, $PATH inherited from launchd is
// often missing /opt/homebrew/bin and /usr/local/bin — AND version-manager
// shims (nvm/fnm/volta/asdf) live under $HOME in dirs we can't hardcode. A
// bare `npm` spawn then fails with ENOENT. To be robust we ask the user's
// own login+interactive shell for its resolved PATH (which sources the rc
// files that set up nvm/fnm/etc.) and probe known locations on top of that.

let _loginShellPathCache;
function loginShellPath() {
  if (process.platform === 'win32') return process.env.PATH || '';
  if (_loginShellPathCache !== undefined) return _loginShellPathCache;
  let resolved = '';
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    // -l sources profile/zprofile, -i sources rc files (where nvm/fnm hook in).
    const out = execSync(`${JSON.stringify(shell)} -lic 'printf "%s" "$PATH"'`, {
      encoding: 'utf8', timeout: 6000,
    });
    // rc files may echo noise; the PATH is the last non-empty colon-list line.
    resolved = (out || '')
      .split('\n')
      .map(s => s.trim())
      .filter(s => s && s.includes('/'))
      .pop() || '';
  } catch (_) { /* fall back below */ }
  _loginShellPathCache = resolved;
  return resolved;
}

// A PATH that combines the login-shell PATH, common toolchain dirs, and the
// process PATH — de-duped, order-preserving. Used both to locate npm and as
// the spawn env so npm can in turn find `node`.
function toolchainPath() {
  const home = process.env.HOME || '';
  const extras = [
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    home && path.join(home, '.volta', 'bin'),
    home && path.join(home, '.local', 'bin'),
    home && path.join(home, '.asdf', 'shims'),
    home && path.join(home, 'bin'),
  ].filter(Boolean);
  const parts = [];
  const push = (p) => { if (p && !parts.includes(p)) parts.push(p); };
  loginShellPath().split(path.delimiter).forEach(push);
  extras.forEach(push);
  (process.env.PATH || '').split(path.delimiter).forEach(push);
  return parts.join(path.delimiter);
}

function findExec(candidates, fallback, env) {
  for (const p of candidates) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) {
        execSync(`"${p}" --version`, { stdio: 'ignore', timeout: 4000, env: env || process.env });
        return p;
      }
    } catch (_) { /* try next */ }
  }
  return fallback;
}

function getNpmBin() {
  if (process.platform === 'win32') return process.env.NPM_BINARY || 'npm.cmd';
  const env = { ...process.env, PATH: toolchainPath() };
  // Preferred: resolve via the augmented PATH — respects nvm/fnm/volta/asdf.
  try {
    const resolved = execSync('command -v npm', { encoding: 'utf8', timeout: 4000, env }).trim();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch (_) { /* fall through to explicit probing */ }
  return findExec([
    process.env.NPM_BINARY,
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
    '/usr/bin/npm',
  ], 'npm', env);
}

// ── Update orchestrator factory ───────────────────────────────────────────

/**
 * Build a self-updater bound to a specific Electron `app` and product.
 *
 * @param {object} opts
 * @param {import('electron').App} opts.app   – the Electron app instance
 * @param {object} opts.packageJson           – parsed package.json (for repo URL + product name)
 * @param {string} [opts.appName]             – display name (default: packageJson.build?.productName || 'Fauna')
 * @param {(s:object)=>void} [opts.onStateChange] – fired after every state mutation
 * @param {(...args:any[])=>void} [opts.log]  – optional logger (default: console.log with prefix)
 */
export function createSelfUpdater({ app, packageJson, appName, onStateChange, log }) {
  if (!app) throw new Error('createSelfUpdater requires { app }');
  const existing = UPDATERS_BY_APP.get(app);
  if (existing) {
    if (onStateChange) existing.setOnStateChange(onStateChange);
    return existing;
  }
  const product = appName || packageJson?.build?.productName || 'Fauna';
  const repo = parseGithubRepo(packageJson?.repository?.url);
  const branchApiUrl = repo ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/main` : null;
  const releaseApiUrl = repo ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=20` : null;
  const sourceZipUrl = repo ? `https://codeload.github.com/${repo.owner}/${repo.repo}/zip/refs/heads/main` : null;
  const sourceFolderInZip = repo ? `${repo.repo}-main` : null;
  const logger = log || ((...args) => console.log(`[self-updater]`, ...args));

  let state = { ...INITIAL_STATE, channel: loadChannel(), currentVersion: app.getVersion?.() || packageJson?.version || null };
  state.currentSha = loadInstalledSha();
  const changeListeners = new Set();
  if (onStateChange) changeListeners.add(onStateChange);

  function emit() {
    for (const listener of changeListeners) {
      try { listener({ ...state }); } catch (_) {}
    }
  }
  function apply(evt) { state = nextUpdateState(state, evt); emit(); }

  function updateRoot()      { return path.join(app.getPath('userData'), 'self-update'); }
  function updateZipPath()   { return path.join(updateRoot(), 'source.zip'); }
  function updateSourceDir() { return path.join(updateRoot(), 'source'); }
  function shaStatePath()    { return path.join(updateRoot(), 'installed.json'); }
  function preferencesPath() { return path.join(updateRoot(), 'preferences.json'); }

  function loadChannel() {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'self-update', 'preferences.json'), 'utf8')).channel;
      return saved === 'beta' ? 'beta' : 'stable';
    } catch (_) { return 'stable'; }
  }

  function setChannel(channel) {
    if (channel !== 'stable' && channel !== 'beta') throw new Error('Update channel must be stable or beta');
    fs.mkdirSync(updateRoot(), { recursive: true });
    fs.writeFileSync(preferencesPath(), JSON.stringify({ channel, updatedAt: new Date().toISOString() }, null, 2));
    apply({ type: 'channel_change', channel, currentSha: loadInstalledSha(), currentVersion: app.getVersion?.() || packageJson?.version || null });
    return getState();
  }

  function syncChannel() {
    const channel = loadChannel();
    if (channel !== state.channel) {
      apply({ type: 'channel_change', channel, currentSha: loadInstalledSha(), currentVersion: app.getVersion?.() || packageJson?.version || null });
    }
  }

  function loadInstalledSha() {
    try {
      const raw = fs.readFileSync(path.join(app.getPath('userData'), 'self-update', 'installed.json'), 'utf8');
      return JSON.parse(raw).installedSha || null;
    } catch (_) { return null; }
  }

  function saveInstalledSha(sha) {
    try {
      fs.mkdirSync(updateRoot(), { recursive: true });
      fs.writeFileSync(shaStatePath(), JSON.stringify({ installedSha: sha, updatedAt: new Date().toISOString() }, null, 2));
    } catch (e) { logger('saveInstalledSha failed:', e.message); }
  }

  function installedAppPath() {
    if (process.platform !== 'darwin') return null; // win/linux paths not implemented yet
    // app.getAppPath() = .../Fauna.app/Contents/Resources/app.asar
    return findAppBundlePath(app.getAppPath()) || `/Applications/${product}.app`;
  }

  async function checkStableUpdates() {
    const releases = await requestJson(releaseApiUrl);
    const release = selectLatestRelease(releases, { product });
    if (!release) throw new Error(`No stable ${product} release is available for ${process.platform}/${process.arch}`);
    const latestVersion = String(release?.tag_name || '').replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(latestVersion)) throw new Error('Latest GitHub release has no valid version tag');
    const releaseAsset = selectReleaseAsset(release.assets, { product });
    if (!releaseAsset?.browser_download_url) throw new Error(`No ${product} update is available for ${process.platform}/${process.arch}`);
    const updateAvailable = compareVersions(latestVersion, state.currentVersion) > 0;
    apply({
      type: 'check_result',
      latestSha: release.target_commitish || null,
      latestVersion,
      releaseAsset: { name: releaseAsset.name, url: releaseAsset.browser_download_url, digest: releaseAsset.digest || null },
      updateAvailable,
      message: `Fauna ${latestVersion} is available`,
    });
  }

  async function checkBetaUpdates() {
    const data = await requestJson(branchApiUrl);
    apply({ type: 'check_result', latestSha: data?.sha || null, currentSha: state.currentSha });
  }

  function runProc(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const onLine = (line) => apply({ type: 'install_log', message: line.slice(0, 500), phase: state.phase });
      child.stdout.on('data', c => {
        const t = c.toString(); stdout += t;
        for (const line of t.split('\n').filter(Boolean)) onLine(line);
      });
      child.stderr.on('data', c => {
        const t = c.toString(); stderr += t;
        for (const line of t.split('\n').filter(Boolean)) onLine(line);
      });
      child.on('error', reject);
      child.on('close', code => code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${(stderr || stdout).slice(-1000)}`))
      );
    });
  }

  async function checkForUpdates(showResult = true) {
    if (!branchApiUrl || !releaseApiUrl) {
      apply({ type: 'check_error', message: 'No github repository configured in package.json' });
      return state;
    }
    if (state.checking || state.running) return state;
    syncChannel();
    apply({ type: 'check_start', message: state.channel === 'beta' ? 'Checking GitHub main...' : 'Checking stable releases...' });
    try {
      if (state.channel === 'beta') await checkBetaUpdates();
      else await checkStableUpdates();
      if (!state.updateAvailable && !showResult) {
        // Quiet background check — leave the message generic.
      }
    } catch (e) {
      apply({ type: 'check_error', message: e.message });
    }
    return state;
  }

  async function installStableUpdate() {
    if (!state.releaseAsset?.url || !state.latestVersion) await checkStableUpdates();
    if (!state.releaseAsset?.url) throw new Error('No stable release artifact is available');
    fs.mkdirSync(updateRoot(), { recursive: true });
    const artifactPath = path.join(updateRoot(), state.releaseAsset.name);
    try { fs.rmSync(artifactPath, { force: true }); } catch (_) {}
    apply({ type: 'install_log', message: `Downloading ${state.releaseAsset.name}...`, phase: 'download' });
    await downloadFile(state.releaseAsset.url, artifactPath);
    apply({ type: 'install_log', message: 'Verifying release download...', phase: 'verify' });
    await verifyFileDigest(artifactPath, state.releaseAsset.digest);

    if (process.platform === 'win32') {
      apply({ type: 'install_log', message: 'Launching release installer...', phase: 'relaunch' });
      spawn(artifactPath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
      apply({ type: 'install_complete', installedVersion: state.latestVersion });
      setTimeout(() => { try { app.quit(); } catch (_) {} }, 250);
      return;
    }
    if (process.platform !== 'darwin') throw new Error('Automatic stable updates are not available on this platform');

    const mountPath = path.join(updateRoot(), 'release-volume');
    const stagedApp = path.join(updateRoot(), `${product}.app`);
    fs.rmSync(mountPath, { recursive: true, force: true });
    fs.rmSync(stagedApp, { recursive: true, force: true });
    fs.mkdirSync(mountPath, { recursive: true });
    apply({ type: 'install_log', message: 'Opening signed release...', phase: 'extract' });
    await runProc('/usr/bin/hdiutil', ['attach', artifactPath, '-nobrowse', '-readonly', '-mountpoint', mountPath]);
    try {
      const mountedApp = path.join(mountPath, `${product}.app`);
      if (!fs.existsSync(mountedApp)) throw new Error(`Release did not contain ${product}.app`);
      await runProc('/usr/bin/ditto', [mountedApp, stagedApp]);
    } finally {
      await runProc('/usr/bin/hdiutil', ['detach', mountPath]);
    }

    apply({ type: 'install_log', message: 'Verifying app signature...', phase: 'verify' });
    await runProc('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', stagedApp]);
    const expectedAppId = packageJson?.build?.appId;
    if (expectedAppId) {
      const plist = path.join(stagedApp, 'Contents', 'Info.plist');
      const { stdout } = await runProc('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]);
      if (stdout.trim() !== expectedAppId) throw new Error(`Release bundle identifier ${stdout.trim()} does not match ${expectedAppId}`);
    }

    const installPath = installedAppPath();
    if (!installPath) throw new Error(`Could not determine installed ${product}.app path`);
    const currentSignature = await runProc('/usr/bin/codesign', ['-dv', '--verbose=4', installPath]);
    const stagedSignature = await runProc('/usr/bin/codesign', ['-dv', '--verbose=4', stagedApp]);
    const currentTeam = (currentSignature.stderr.match(/TeamIdentifier=([^\s]+)/) || [])[1];
    const stagedTeam = (stagedSignature.stderr.match(/TeamIdentifier=([^\s]+)/) || [])[1];
    if (!currentTeam || stagedTeam !== currentTeam) throw new Error('Release signing team does not match the installed app');
    const backupPath = `${installPath}.update-backup`;
    const scriptPath = path.join(updateRoot(), 'install-stable-mac.sh');
    const script = [
      '#!/bin/zsh',
      'set -e',
      'sleep 2',
      `rm -rf ${JSON.stringify(backupPath)}`,
      `mv ${JSON.stringify(installPath)} ${JSON.stringify(backupPath)}`,
      `if /usr/bin/ditto ${JSON.stringify(stagedApp)} ${JSON.stringify(installPath)}; then`,
      `  rm -rf ${JSON.stringify(backupPath)}`,
      `  open ${JSON.stringify(installPath)}`,
      'else',
      `  rm -rf ${JSON.stringify(installPath)}`,
      `  mv ${JSON.stringify(backupPath)} ${JSON.stringify(installPath)}`,
      '  exit 1',
      'fi',
      '',
    ].join('\n');
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    apply({ type: 'install_log', message: 'Relaunching with the stable update...', phase: 'relaunch' });
    spawn('/bin/zsh', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
    apply({ type: 'install_complete', installedVersion: state.latestVersion });
    setTimeout(() => { try { app.quit(); } catch (_) {} }, 250);
  }

  async function installUpdate() {
    if (!branchApiUrl) {
      apply({ type: 'install_error', message: 'No github repository configured in package.json' });
      return state;
    }
    if (state.running) return state;
    syncChannel();
    apply({ type: 'install_start' });
    try {
      if (state.channel === 'stable') {
        await installStableUpdate();
        return state;
      }
      if (!state.latestSha) await checkForUpdates(false);
      const targetSha = state.latestSha;
      if (!targetSha) throw new Error('No main branch SHA available');

      fs.mkdirSync(updateRoot(), { recursive: true });

      apply({ type: 'install_log', message: 'Downloading main branch source...', phase: 'download' });
      // Clear any stale zip so a partial download can't poison the extract.
      try { fs.rmSync(updateZipPath(), { force: true }); } catch (_) {}
      await downloadFile(sourceZipUrl, updateZipPath());

      apply({ type: 'install_log', message: 'Extracting source...', phase: 'extract' });
      // Remove prior extraction site AND any leftover top-level folder from
      // the zip (codeload always wraps content in `<repo>-main/`).
      fs.rmSync(updateSourceDir(), { recursive: true, force: true });
      const extracted = path.join(updateRoot(), sourceFolderInZip);
      fs.rmSync(extracted, { recursive: true, force: true });
      if (process.platform === 'win32') {
        await runProc('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `Expand-Archive -LiteralPath ${JSON.stringify(updateZipPath())} -DestinationPath ${JSON.stringify(updateRoot())} -Force`]);
      } else {
        await runProc('unzip', ['-q', '-o', updateZipPath(), '-d', updateRoot()]);
      }
      if (!fs.existsSync(extracted)) throw new Error(`Zip did not contain ${sourceFolderInZip}`);
      fs.renameSync(extracted, updateSourceDir());

      const npmBin = getNpmBin();
      const env = { ...process.env };
      // Strip ELECTRON_RUN_AS_NODE so nested npm doesn't think it's electron.
      delete env.ELECTRON_RUN_AS_NODE;
      // Ensure the child sees a real toolchain PATH: launched from Finder the
      // app inherits a bare launchd PATH, so npm (a node script) would fail to
      // find `node`. Prepend the resolved npm's own dir + the login-shell PATH.
      const npmDir = (npmBin && npmBin !== 'npm' && npmBin.includes(path.sep)) ? path.dirname(npmBin) : '';
      env.PATH = [npmDir, toolchainPath()].filter(Boolean).join(path.delimiter);

      // Preflight: fail early with an actionable message if the toolchain is
      // missing, instead of a cryptic "spawn npm ENOENT".
      try {
        execSync(`${JSON.stringify(npmBin)} --version`, { stdio: 'ignore', timeout: 8000, env });
      } catch (_) {
        throw new Error('Could not find a working npm / Node.js toolchain. Install Node.js from https://nodejs.org (or make sure `npm` is on your PATH), then try updating again.');
      }

      apply({ type: 'install_log', message: 'Installing dependencies (this can take 2–3 minutes)...', phase: 'dependencies' });
      await runProc(npmBin, ['install'], { cwd: updateSourceDir(), env });

      const buildScript = process.platform === 'darwin' ? 'dist:mac'
        : process.platform === 'win32' ? 'dist:win'
        : 'dist';
      apply({ type: 'install_log', message: `Building (npm run ${buildScript})...`, phase: 'build' });
      await runProc(npmBin, ['run', buildScript], { cwd: updateSourceDir(), env });

      apply({ type: 'install_log', message: 'Installing the new version...', phase: 'install' });
      if (process.platform === 'darwin') {
        // electron-builder writes to dist/mac/<product>.app for x64 and
        // dist/mac-arm64/<product>.app for arm64 — pick whichever exists.
        const candidates = [
          path.join(updateSourceDir(), 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', `${product}.app`),
          path.join(updateSourceDir(), 'dist', 'mac-arm64', `${product}.app`),
          path.join(updateSourceDir(), 'dist', 'mac', `${product}.app`),
        ];
        const builtApp = candidates.find(p => fs.existsSync(p));
        if (!builtApp) throw new Error(`Build completed but no ${product}.app found in dist/mac{,-arm64}/`);

        const installPath = installedAppPath();
        if (!installPath) throw new Error('Could not determine installed app path — is Fauna running from an .app bundle?');

        // Spawn a detached shell to swap the bundle AFTER we quit, then
        // relaunch. We must NOT do this in-process — macOS will refuse to
        // overwrite a running .app.
        const scriptPath = path.join(updateRoot(), 'install-mac.sh');
        const script = [
          '#!/bin/zsh',
          'set -e',
          'sleep 2',
          `rm -rf ${JSON.stringify(installPath)}`,
          `cp -R ${JSON.stringify(builtApp)} ${JSON.stringify(installPath)}`,
          // Clear the quarantine xattr so Gatekeeper doesn't re-prompt on
          // a self-built (ad-hoc-signed) bundle.
          `xattr -dr com.apple.quarantine ${JSON.stringify(installPath)} 2>/dev/null || true`,
          `open ${JSON.stringify(installPath)}`,
          '',
        ].join('\n');
        fs.writeFileSync(scriptPath, script, { mode: 0o755 });
        saveInstalledSha(targetSha);
        apply({ type: 'install_log', message: 'Relaunching with the updated app...', phase: 'relaunch' });
        spawn('/bin/zsh', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
        apply({ type: 'install_complete', installedSha: targetSha });
        // Give the IPC channel a beat to flush "complete" before we quit.
        setTimeout(() => { try { app.quit(); } catch (_) {} }, 250);
        return state;
      }

      if (process.platform === 'win32') {
        // Find the produced installer .exe; relaunch silently.
        const distDir = path.join(updateSourceDir(), 'dist');
        const installer = fs.existsSync(distDir)
          ? fs.readdirSync(distDir).find(n => /\.exe$/i.test(n) && /setup|fauna/i.test(n))
          : null;
        if (!installer) throw new Error('Build completed but no Windows installer .exe was found in dist/');
        saveInstalledSha(targetSha);
        apply({ type: 'install_log', message: 'Launching Windows installer...', phase: 'relaunch' });
        spawn(path.join(distDir, installer), ['/S'], { detached: true, stdio: 'ignore' }).unref();
        apply({ type: 'install_complete', installedSha: targetSha });
        setTimeout(() => { try { app.quit(); } catch (_) {} }, 250);
        return state;
      }

      // Linux: leave the rebuilt dist on disk; user installs manually.
      saveInstalledSha(targetSha);
      apply({ type: 'install_log', message: `Built into ${updateSourceDir()}/dist — install manually`, phase: 'complete' });
      apply({ type: 'install_complete', installedSha: targetSha });
    } catch (e) {
      logger('install failed:', e.message);
      apply({ type: 'install_error', message: e.message });
    }
    return state;
  }

  function getState() { return { ...state, repo, hasRepo: !!repo }; }
  function setOnStateChange(fn) {
    if (typeof fn === 'function') changeListeners.add(fn);
    return () => changeListeners.delete(fn);
  }

  const updater = { getState, getChannel: () => state.channel, setChannel, checkForUpdates, installUpdate, setOnStateChange };
  UPDATERS_BY_APP.set(app, updater);
  return updater;
}

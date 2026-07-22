// Fauna self-update routes.
//
// Update endpoints:
//   GET  /api/fauna/update-status  — returns the current update job state
//   POST /api/fauna/update-channel — persists stable (default) or beta
//   POST /api/fauna/check-update   — compares local git SHA / build-info.sha
//                                    against the selected channel
//   POST /api/fauna/install-update — updates from origin/main in dev/git
//                                    checkouts; packaged builds rebuild from
//                                    the main branch source zip.

import fs from 'fs';
import path from 'path';
import { execSync, exec as _exec } from 'child_process';
import { createSelfUpdater } from '../../lib/self-updater.js';

const FAUNA_REPO_OWNER = 'howmon';
const FAUNA_REPO_NAME  = 'fauna';

export function registerFaunaUpdateRoutes(app, {
  express,
  appDir,
  getElectronApp,
  getElectronShell,
}) {
  let _faunaUpdateJob = null;
  let _sourceUpdater = null;

  function _faunaAppVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      if (pkg && pkg.version) return pkg.version;
    } catch (_) {}
    try {
      const _electronApp = getElectronApp();
      if (_electronApp && typeof _electronApp.getVersion === 'function') return _electronApp.getVersion();
    } catch (_) {}
    return null;
  }

  function _faunaLog(msg) {
    if (!_faunaUpdateJob) return;
    _faunaUpdateJob.logs = _faunaUpdateJob.logs || [];
    _faunaUpdateJob.logs.push({ message: msg, ts: Date.now() });
    _faunaUpdateJob.message = msg;
  }

  function _faunaIsPackaged() {
    const _electronApp = getElectronApp();
    return !!(_electronApp && _electronApp.isPackaged);
  }

  function _faunaJobFromSourceState(state) {
    return {
      phase: state?.phase || 'idle',
      checking: !!state?.checking,
      running: !!state?.running,
      updateAvailable: !!state?.updateAvailable,
      currentSha: state?.currentSha || null,
      latestSha: state?.latestSha || null,
      currentVersion: state?.currentVersion || null,
      latestVersion: state?.latestVersion || null,
      channel: state?.channel === 'beta' ? 'beta' : 'stable',
      error: state?.error || null,
      message: state?.message || null,
      logs: Array.isArray(state?.logs) ? state.logs : [],
    };
  }

  function _faunaSourceUpdater() {
    const _electronApp = getElectronApp();
    if (!_electronApp) return null;
    if (_sourceUpdater) return _sourceUpdater;
    const packageJson = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    _sourceUpdater = createSelfUpdater({
      app: _electronApp,
      packageJson,
      appName: packageJson?.build?.productName || 'Fauna',
      onStateChange: (state) => { _faunaUpdateJob = _faunaJobFromSourceState(state); },
      log: (...args) => console.log('[fauna-update]', ...args),
    });
    return _sourceUpdater;
  }

  function _faunaGitSha() {
    // 1. Try live git (works in dev / git-clone installs)
    try {
      return execSync('git rev-parse HEAD', { cwd: appDir, encoding: 'utf8' }).trim();
    } catch (_) {}
    // 2. Fall back to build-time SHA embedded in build-info.json (packaged app)
    try {
      const info = JSON.parse(fs.readFileSync(path.join(appDir, 'build-info.json'), 'utf8'));
      if (info && info.sha) return info.sha;
    } catch (_) {}
    return null;
  }

  async function _faunaFetchRemoteSha() {
    // Use GitHub API — no auth needed for public repos
    const url = `https://api.github.com/repos/${FAUNA_REPO_OWNER}/${FAUNA_REPO_NAME}/commits/main`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Fauna-App/1.0', 'Accept': 'application/vnd.github.sha' } });
    const body = await response.text();
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body.slice(0, 120)}`);
    return body.trim();
  }

  app.get('/api/fauna/update-status', (_req, res) => {
    if (_faunaIsPackaged()) {
      try {
        const updater = _faunaSourceUpdater();
        if (updater) _faunaUpdateJob = _faunaJobFromSourceState(updater.getState());
      } catch (e) {
        _faunaUpdateJob = { phase: 'error', updateAvailable: false, error: e.message, logs: [{ message: e.message, ts: Date.now() }] };
      }
    }
    const channel = _faunaIsPackaged() ? (_faunaSourceUpdater()?.getChannel() || 'stable') : 'beta';
    res.json({ job: _faunaUpdateJob || { phase: 'idle', updateAvailable: false, channel }, version: _faunaAppVersion(), channel });
  });

  app.post('/api/fauna/update-channel', express.json(), (req, res) => {
    if (!_faunaIsPackaged()) return res.status(400).json({ error: 'Update channels apply to packaged Fauna builds' });
    try {
      const updater = _faunaSourceUpdater();
      const state = updater.setChannel(req.body?.channel);
      _faunaUpdateJob = _faunaJobFromSourceState(state);
      res.json({ job: _faunaUpdateJob, version: _faunaAppVersion(), channel: state.channel });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/fauna/check-update', async (_req, res) => {
    if (_faunaIsPackaged()) {
      try {
        const updater = _faunaSourceUpdater();
        if (!updater) throw new Error('Source updater unavailable');
        _faunaUpdateJob = _faunaJobFromSourceState(await updater.checkForUpdates(true));
      } catch (err) {
        _faunaUpdateJob = { phase: 'error', checking: false, running: false, updateAvailable: false, error: err.message, logs: [{ message: err.message, ts: Date.now() }] };
      }
      return res.json({ job: _faunaUpdateJob, version: _faunaAppVersion(), channel: _faunaUpdateJob.channel || 'stable' });
    }

    _faunaUpdateJob = { phase: 'checking', checking: true, running: false, logs: [] };
    _faunaLog('Reading local git SHA…');
    try {
      const currentSha = _faunaGitSha();
      if (!currentSha) throw new Error('Not a git repository — cannot check for updates');
      _faunaLog(`Local SHA: ${currentSha.slice(0, 12)}`);
      _faunaLog('Fetching latest SHA from GitHub…');
      const latestSha = await _faunaFetchRemoteSha();
      _faunaLog(`Remote SHA: ${latestSha.slice(0, 12)}`);
      const updateAvailable = latestSha !== currentSha;
      _faunaUpdateJob = {
        phase: updateAvailable ? 'available' : 'current',
        checking: false, running: false,
        updateAvailable,
        currentSha, latestSha,
        logs: _faunaUpdateJob.logs,
        message: updateAvailable ? `Update available (${latestSha.slice(0,7)})` : 'Already up to date',
      };
    } catch (err) {
      _faunaUpdateJob = {
        phase: 'error', checking: false, running: false, updateAvailable: false,
        error: err.message, logs: (_faunaUpdateJob && _faunaUpdateJob.logs) || [],
      };
      _faunaLog(`Error: ${err.message}`);
    }
    res.json({ job: _faunaUpdateJob });
  });

  app.post('/api/fauna/install-update', express.json(), async (req, res) => {
    if (_faunaUpdateJob && _faunaUpdateJob.running) {
      return res.status(409).json({ error: 'Update already in progress' });
    }

    console.log('[fauna-update] Install triggered. App dir:', appDir);
    console.log('[fauna-update] Is packaged:', _faunaIsPackaged());

    if (_faunaIsPackaged()) {
      try {
        const updater = _faunaSourceUpdater();
        if (!updater) throw new Error('Source updater unavailable');
        const installPromise = updater.installUpdate();
        _faunaUpdateJob = _faunaJobFromSourceState(updater.getState());
        res.json({ job: _faunaUpdateJob, version: _faunaAppVersion(), channel: _faunaUpdateJob.channel || 'stable' });
        installPromise.catch(err => {
          _faunaUpdateJob = { phase: 'error', running: false, updateAvailable: false, error: err.message, logs: [{ message: err.message, ts: Date.now() }] };
        });
        return;
      } catch (err) {
        _faunaUpdateJob = { phase: 'error', running: false, updateAvailable: false, error: err.message, logs: [{ message: err.message, ts: Date.now() }] };
        return res.status(400).json({ job: _faunaUpdateJob, error: err.message });
      }
    }

    // Check if we can do git-based updates (requires .git folder)
    const hasGitRepo = fs.existsSync(path.join(appDir, '.git'));
    console.log('[fauna-update] .git exists in app dir:', hasGitRepo);

    // If no git repo exists at all, we can't update
    if (!hasGitRepo) {
      console.log('[fauna-update] No git repo found, cannot update');
      return res.status(400).json({
        error: 'No git repository found. Clone the repository so Fauna can update from origin/main.'
      });
    }

    _faunaUpdateJob = { phase: 'starting', running: true, logs: [], updateAvailable: false };
    res.json({ job: _faunaUpdateJob });   // respond immediately; client polls /update-status

    const { promisify } = await import('util');
    const execP = promisify(_exec);

    async function phase(name, cmd) {
      _faunaUpdateJob.phase = name;
      _faunaLog(`[${name}] ${cmd}`);
      const { stdout, stderr } = await execP(cmd, { cwd: appDir, env: { ...process.env } });
      if (stdout) stdout.trim().split('\n').forEach(l => _faunaLog(l));
      if (stderr) stderr.trim().split('\n').forEach(l => _faunaLog(l));
    }

    (async () => {
      try {
        await phase('download',      'git fetch origin main');
        await phase('extract',       'git reset --hard origin/main');
        await phase('dependencies',  'npm install --prefer-offline');
        _faunaUpdateJob.phase    = 'complete';
        _faunaUpdateJob.running  = false;
        _faunaUpdateJob.message  = 'Update complete — restart Fauna to apply changes';
        _faunaLog('Done. Restart the app to use the new version.');
      } catch (err) {
        _faunaUpdateJob.phase   = 'error';
        _faunaUpdateJob.running = false;
        _faunaUpdateJob.error   = err.message;
        _faunaLog(`Install failed: ${err.message}`);
      }
    })();
  });
}

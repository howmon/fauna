// Fauna self-update routes.
//
// Three endpoints:
//   GET  /api/fauna/update-status  — returns the current update job state
//   POST /api/fauna/check-update   — compares local git SHA / build-info.sha
//                                    against the GitHub HEAD commit
//   POST /api/fauna/install-update — `git fetch && git reset --hard && npm i`
//                                    in dev/git checkout; opens GitHub
//                                    releases in browser for packaged builds.

import fs from 'fs';
import path from 'path';
import { execSync, exec as _exec } from 'child_process';

const FAUNA_REPO_OWNER = 'howmon';
const FAUNA_REPO_NAME  = 'fauna';

export function registerFaunaUpdateRoutes(app, {
  express,
  appDir,
  getElectronApp,
  getElectronShell,
}) {
  let _faunaUpdateJob = null;

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
    const https = await import('https');
    return new Promise((resolve, reject) => {
      const url = `https://api.github.com/repos/${FAUNA_REPO_OWNER}/${FAUNA_REPO_NAME}/commits/HEAD`;
      const opts = { headers: { 'User-Agent': 'Fauna-App/1.0', 'Accept': 'application/vnd.github.sha' } };
      https.get(url, opts, r => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => {
          if (r.statusCode === 200) resolve(body.trim());
          else reject(new Error(`GitHub API ${r.statusCode}: ${body.slice(0, 120)}`));
        });
      }).on('error', reject);
    });
  }

  app.get('/api/fauna/update-status', (_req, res) => {
    res.json({ job: _faunaUpdateJob || { phase: 'idle', updateAvailable: false }, version: _faunaAppVersion() });
  });

  app.post('/api/fauna/check-update', async (_req, res) => {
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

    // Check if we can do git-based updates (requires .git folder)
    const hasGitRepo = fs.existsSync(path.join(appDir, '.git'));
    console.log('[fauna-update] .git exists in app dir:', hasGitRepo);

    // In a packaged app without git repo, open the releases page instead
    if (_faunaIsPackaged() && !hasGitRepo) {
      const releasesUrl = `https://github.com/${FAUNA_REPO_OWNER}/${FAUNA_REPO_NAME}/releases`;
      console.log('[fauna-update] Opening releases page:', releasesUrl);
      const _electronShell = getElectronShell();
      console.log('[fauna-update] _electronShell available:', !!_electronShell);

      if (_electronShell) {
        _electronShell.openExternal(releasesUrl);
        console.log('[fauna-update] openExternal called');
      } else {
        console.log('[fauna-update] WARNING: _electronShell not available, cannot open browser');
      }

      _faunaUpdateJob = {
        phase: 'complete', running: false, updateAvailable: false,
        message: 'Opened GitHub releases page in browser — download and install the new version.',
        logs: [{ message: `Opened ${releasesUrl}` }],
      };
      return res.json({ job: _faunaUpdateJob });
    }

    // If no git repo exists at all, we can't update
    if (!hasGitRepo) {
      console.log('[fauna-update] No git repo found, cannot update');
      return res.status(400).json({
        error: 'No git repository found. Please install from GitHub releases or clone the repository.'
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
        await phase('download',      'git fetch origin');
        await phase('extract',       'git reset --hard origin/HEAD');
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

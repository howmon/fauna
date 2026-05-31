// soffice (LibreOffice) runtime locator — used by pptx-rasterize to convert
// PowerPoint decks into PDFs (which we then split into per-slide PNG
// backdrops for the lesson widget).
//
// Resolution order:
//   1. Env override:        process.env.FAUNA_SOFFICE_BIN
//   2. Userdata cache:      <userData>/runtime/libreoffice/Contents/MacOS/soffice
//                           <userData>/runtime/libreoffice/program/soffice
//   3. Standard system locations (macOS / Linux / Windows)
//   4. `which soffice` via PATH
//
// If nothing is found, callers receive a structured `notFound` result with
// the appropriate install command for the user's platform. We deliberately
// do NOT silently download a 500 MB .dmg — instead the UI surfaces a one-
// click "Install LibreOffice" action that runs `brew install --cask
// libreoffice` (or the platform equivalent).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

let _cached = null;

function _exists(p) {
  try { return p && fs.existsSync(p) && fs.statSync(p).isFile(); }
  catch (_) { return false; }
}

function _candidatePaths(userDataDir) {
  const out = [];
  if (process.env.FAUNA_SOFFICE_BIN) out.push(process.env.FAUNA_SOFFICE_BIN);
  if (userDataDir) {
    out.push(path.join(userDataDir, 'runtime', 'libreoffice', 'Contents', 'MacOS', 'soffice'));
    out.push(path.join(userDataDir, 'runtime', 'libreoffice', 'program', 'soffice'));
    out.push(path.join(userDataDir, 'runtime', 'libreoffice', 'program', 'soffice.exe'));
  }
  if (process.platform === 'darwin') {
    out.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
    out.push('/opt/homebrew/bin/soffice');
    out.push('/usr/local/bin/soffice');
  } else if (process.platform === 'linux') {
    out.push('/usr/bin/soffice');
    out.push('/usr/bin/libreoffice');
    out.push('/usr/local/bin/soffice');
    out.push('/snap/bin/libreoffice');
  } else if (process.platform === 'win32') {
    out.push('C:\\Program Files\\LibreOffice\\program\\soffice.exe');
    out.push('C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe');
  }
  return out;
}

async function _whichSoffice() {
  return new Promise(resolve => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const name = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
    const ch = spawn(cmd, [name], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ch.stdout.on('data', d => { out += d.toString(); });
    ch.on('close', () => {
      const first = out.split('\n').map(s => s.trim()).find(Boolean);
      resolve(_exists(first) ? first : null);
    });
    ch.on('error', () => resolve(null));
  });
}

export function installHint() {
  if (process.platform === 'darwin') {
    return {
      platform: 'macOS',
      cmd: 'brew install --cask libreoffice',
      url: 'https://www.libreoffice.org/download/download/',
      note: 'Installs LibreOffice (~500 MB) via Homebrew. Or download the .dmg from libreoffice.org.',
    };
  }
  if (process.platform === 'linux') {
    return {
      platform: 'Linux',
      cmd: 'sudo apt-get install -y libreoffice  # or: sudo dnf install libreoffice',
      url: 'https://www.libreoffice.org/download/download/',
      note: 'Installs LibreOffice via the system package manager.',
    };
  }
  if (process.platform === 'win32') {
    return {
      platform: 'Windows',
      cmd: 'winget install TheDocumentFoundation.LibreOffice',
      url: 'https://www.libreoffice.org/download/download/',
      note: 'Installs LibreOffice via winget. Or download the .msi from libreoffice.org.',
    };
  }
  return { platform: process.platform, cmd: '', url: 'https://www.libreoffice.org/', note: '' };
}

/**
 * Resolve the path to a usable `soffice` binary.
 * @param {object} opts
 * @param {string} [opts.userDataDir]  Electron app.getPath('userData'); used for cache lookup.
 * @returns {Promise<{ok:true, bin:string, source:string} | {ok:false, hint:object}>}
 */
export async function resolveSoffice({ userDataDir } = {}) {
  if (_cached && _exists(_cached.bin)) return _cached;
  for (const p of _candidatePaths(userDataDir)) {
    if (_exists(p)) {
      _cached = { ok: true, bin: p, source: 'fs' };
      return _cached;
    }
  }
  const w = await _whichSoffice();
  if (w) {
    _cached = { ok: true, bin: w, source: 'PATH' };
    return _cached;
  }
  return { ok: false, hint: installHint() };
}

/**
 * Attempt to install LibreOffice via the platform's package manager.
 * Returns a stream-like { exitCode, stdout, stderr } result. Caller is
 * responsible for surfacing progress to the user.
 *
 * NOTE: requires brew/winget/apt to be present and on PATH. For macOS this
 * runs `brew install --cask libreoffice` which prompts for sudo only if
 * brew itself needs elevated install (rare).
 */
export async function attemptInstall({ onLine } = {}) {
  let cmd, args;
  if (process.platform === 'darwin') {
    cmd = 'brew'; args = ['install', '--cask', 'libreoffice'];
  } else if (process.platform === 'linux') {
    // Best-effort: try apt-get first; user may need to swap for dnf/pacman/etc.
    cmd = 'sudo'; args = ['apt-get', 'install', '-y', 'libreoffice'];
  } else if (process.platform === 'win32') {
    cmd = 'winget'; args = ['install', '--silent', '--accept-package-agreements', '--accept-source-agreements', 'TheDocumentFoundation.LibreOffice'];
  } else {
    return { exitCode: 1, stderr: 'unsupported platform: ' + process.platform };
  }
  return new Promise(resolve => {
    const ch = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    ch.stdout.on('data', d => {
      const s = d.toString();
      stdout += s;
      if (typeof onLine === 'function') s.split('\n').forEach(line => { if (line.trim()) onLine(line); });
    });
    ch.stderr.on('data', d => {
      const s = d.toString();
      stderr += s;
      if (typeof onLine === 'function') s.split('\n').forEach(line => { if (line.trim()) onLine(line); });
    });
    ch.on('close', code => {
      _cached = null; // force re-detection on next call
      resolve({ exitCode: code, stdout, stderr });
    });
    ch.on('error', err => {
      resolve({ exitCode: 1, stdout, stderr: stderr + '\n' + (err.message || String(err)) });
    });
  });
}

/** Cheap synchronous probe — used by health checks. Returns true|false. */
export function hasSofficeSync({ userDataDir } = {}) {
  for (const p of _candidatePaths(userDataDir)) {
    if (_exists(p)) return true;
  }
  return false;
}

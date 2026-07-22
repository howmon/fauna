// Parakeet (sherpa-onnx) voice model + transcription routes.
//
// Cross-platform STT. A Parakeet model is four files downloaded from
// HuggingFace into ~/.config/fauna/parakeet/<alias>/. We use Node's https
// (with redirect following) rather than spawning curl, so the download works
// identically on macOS, Windows, and Linux.
//
// This module also owns the HTTP transcription surface used by the browser
// voice client: POST /api/transcribe accepts an arbitrary audio blob
// (webm/ogg/mp4/wav), decodes it to canonical PCM16 16 kHz mono with the
// bundled static ffmpeg, and runs it through the in-process Parakeet engine.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { createRequire } from 'module';

import {
  MODEL_DIR,
  MODEL_FILES,
  isParakeetAlias,
  modelDirFor,
  modelFilePath,
  downloadUrlFor,
  isInstalled,
  resolveActiveModel,
  listModels,
} from '../voice/parakeet-models.js';
import { getSettings } from '../voice/settings.js';
import { transcribePcm } from '../voice/transcribe-parakeet.js';

const _require = createRequire(import.meta.url);

// Download one URL to a destination path, following redirects, reporting
// byte progress. Resolves on success, rejects on error.
async function downloadFile(url, dest, onProgress, signal) {
  const response = await fetch(url, { headers: { 'User-Agent': 'fauna' }, redirect: 'follow', signal });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
  const total = parseInt(response.headers.get('content-length') || '0', 10);
  return new Promise((resolve, reject) => {
    let received = 0;
    const source = Readable.fromWeb(response.body);
    const out = fs.createWriteStream(dest);
    source.on('data', chunk => {
      received += chunk.length;
      if (onProgress) onProgress(received, total);
    });
    source.on('error', error => {
      out.destroy();
      reject(error);
    });
    source.pipe(out);
    out.on('finish', () => out.close(() => resolve()));
    out.on('error', reject);
  });
}

export function registerParakeetRoutes(app, { express, appDir, augmentedPath } = {}) {
  function _selectedAlias(reqAlias) {
    if (isParakeetAlias(reqAlias)) return reqAlias;
    const s = getSettings().parakeetModel;
    if (isParakeetAlias(s)) return s;
    return 'parakeet-tdt-0.6b-v2';
  }

  // Current install state + full catalogue for the settings picker.
  app.get('/api/parakeet-model-status', (req, res) => {
    const requested = typeof req.query?.model === 'string' ? req.query.model : null;
    const alias = _selectedAlias(requested);
    res.json({
      ready:   isInstalled(alias),
      model:   alias,
      dir:     modelDirFor(alias),
      models:  listModels(),
      active:  resolveActiveModel(alias),
    });
  });

  // SSE — download all four files of a model with combined progress.
  app.get('/api/parakeet-model-download', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    function send(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

    const requested = typeof req.query?.model === 'string' ? req.query.model : null;
    const alias = _selectedAlias(requested);
    if (!isParakeetAlias(alias)) {
      send({ error: 'Unknown model alias: ' + (requested || '(none)') });
      return res.end();
    }
    if (isInstalled(alias)) {
      send({ pct: 100, ready: true, model: alias });
      return res.end();
    }

    const dir = modelDirFor(alias);
    fs.mkdirSync(dir, { recursive: true });

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    // Approximate combined progress: files are roughly weighted by the
    // encoder dominating, but content-length gives us exact per-file bytes.
    // We treat all four as one virtual stream by summing received/total.
    (async () => {
      const totals = new Array(MODEL_FILES.length).fill(0);
      const recvd  = new Array(MODEL_FILES.length).fill(0);
      let lastPct = -1;
      try {
        for (let i = 0; i < MODEL_FILES.length; i++) {
          const file = MODEL_FILES[i];
          const url  = downloadUrlFor(alias, file);
          const dest = modelFilePath(alias, file);
          const tmp  = dest + '.tmp';
          await downloadFile(url, tmp, (received, total) => {
            recvd[i] = received;
            totals[i] = total || totals[i];
            const sumT = totals.reduce((a, b) => a + b, 0);
            const sumR = recvd.reduce((a, b) => a + b, 0);
            if (sumT > 0) {
              const pct = Math.min(99, Math.round((sumR / sumT) * 100));
              if (pct !== lastPct) { lastPct = pct; send({ pct, model: alias, file }); }
            }
          }, controller.signal);
          fs.renameSync(tmp, dest);
        }
        send({ pct: 100, ready: true, model: alias });
      } catch (e) {
        // Clean up partials so a retry starts fresh.
        for (const f of MODEL_FILES) {
          try { fs.unlinkSync(modelFilePath(alias, f) + '.tmp'); } catch (_) {}
        }
        send({ error: 'Download failed: ' + e.message, model: alias });
      } finally {
        res.end();
      }
    })();
  });

  // DELETE a downloaded Parakeet model (its whole folder). Returns catalogue.
  app.post('/api/parakeet-model-delete', express.json({ limit: '1kb' }), (req, res) => {
    const alias = String((req.body && req.body.model) || '');
    if (!isParakeetAlias(alias)) return res.status(400).json({ ok: false, error: 'unknown model' });
    const dir = modelDirFor(alias);
    try {
      // Guard: only ever remove folders under our own model dir.
      if (dir && dir.startsWith(MODEL_DIR) && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return res.json({ ok: true, models: listModels() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Transcription ──────────────────────────────────────────────────────
  // POST /api/transcribe — arbitrary audio blob body → { ok, text }.
  // Decodes the upload to canonical PCM16 16 kHz mono with the bundled static
  // ffmpeg (streamed through stdin/stdout, no temp files) and runs it through
  // the in-process Parakeet engine.
  app.post('/api/transcribe', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ ok: false, error: 'Empty audio body' });
    }
    if (!resolveActiveModel(getSettings().parakeetModel)) {
      return res.status(503).json({ ok: false, error: 'No Parakeet model installed', code: 'MODEL_MISSING' });
    }

    const ffmpegBin = _locateFfmpeg(appDir);

    try {
      const pcm = await _decodeToPcm16(ffmpegBin, req.body, augmentedPath);
      const out = await transcribePcm(pcm, { sampleRate: 16000 });
      if (!out.ok) {
        const body = { ok: false, error: out.error || 'Transcription failed' };
        if (out.code) body.code = out.code;
        return res.status(503).json(body);
      }
      return res.json({ ok: true, text: out.text || '' });
    } catch (e) {
      const body = { ok: false, error: e.message };
      if (e.code) body.code = e.code;
      return res.status(500).json(body);
    }
  });

  // SSE: repair broken system ffmpeg via brew reinstall (macOS).
  // GET /api/repair-ffmpeg → streams { line } then { done } or { error }.
  app.get('/api/repair-ffmpeg', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const brewBin = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((p) => fs.existsSync(p)) || 'brew';
    const proc = spawn(brewBin, ['reinstall', 'ffmpeg'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: augmentedPath || process.env.PATH, HOMEBREW_NO_AUTO_UPDATE: '1' },
    });
    proc.stdout.on('data', (chunk) => chunk.toString().split('\n').filter(Boolean).forEach((l) => send({ line: l })));
    proc.stderr.on('data', (chunk) => chunk.toString().split('\n').filter(Boolean).forEach((l) => send({ line: l })));
    proc.on('close', (code) => {
      if (code === 0) send({ done: true });
      else send({ error: `brew reinstall ffmpeg exited ${code}` });
      res.end();
    });
    proc.on('error', (err) => { send({ error: err.message }); res.end(); });
    req.on('close', () => { try { proc.kill(); } catch (_) {} });
  });
}

// Prefer the bundled static ffmpeg (no system lib deps); fall back to PATH.
function _locateFfmpeg(appDir) {
  let staticPath = null;
  // Strategy 1: process.resourcesPath (most reliable in packed Electron).
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(p)) staticPath = p;
  }
  // Strategy 2: require('ffmpeg-static') with asar path fix.
  if (!staticPath) {
    try {
      const pkg = _require('ffmpeg-static');
      if (pkg) {
        const fixed = pkg.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
        if (fs.existsSync(fixed)) staticPath = fixed;
      }
    } catch (_) {}
  }
  // Strategy 3: relative to appDir (dev mode).
  if (!staticPath && appDir) {
    const p = path.join(appDir, 'node_modules', 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(p)) staticPath = p;
  }
  return staticPath || 'ffmpeg';
}

// Decode an arbitrary audio buffer to raw PCM16 mono @ 16 kHz using ffmpeg,
// piping input via stdin and collecting output from stdout. Returns a Buffer
// of little-endian s16 samples suitable for the Parakeet engine.
function _decodeToPcm16(ffmpegBin, inputBuf, augmentedPath) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'];
    const chunks = [];
    let stderr = '';
    const ff = spawn(ffmpegBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: augmentedPath || process.env.PATH },
    });
    ff.stdin.on('error', () => {}); // suppress EPIPE if ffmpeg closes stdin early
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => { stderr += c.toString(); });
    ff.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(chunks));
      const detail = stderr.trim().split('\n').pop() || '';
      reject(new Error(`ffmpeg exit ${code}: ${detail}`));
    });
    ff.on('error', (err) => {
      const wrapped = new Error('ffmpeg spawn error: ' + err.message);
      if (err.code === 'ENOENT') wrapped.code = 'FFMPEG_BROKEN';
      reject(wrapped);
    });
    ff.stdin.write(inputBuf);
    ff.stdin.end();
  });
}

// Whisper voice transcription routes.
// Extracted from server.js. Uses bundled whisper.cpp binary + ffmpeg-static
// to transcribe audio uploads. Also exposes an SSE model-download endpoint
// and a brew-based ffmpeg repair endpoint.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

export function registerWhisperRoutes(app, {
  express,
  faunaConfigDir,
  augmentedPath,
  appDir,
}) {
  // Model lives at ~/.config/fauna/whisper/ggml-base.en.bin (downloaded on first use)
  const WHISPER_MODEL_DIR  = path.join(faunaConfigDir, 'whisper');
  const WHISPER_MODEL_FILE = path.join(WHISPER_MODEL_DIR, 'ggml-base.en.bin');
  const WHISPER_MODEL_URL  = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

  app.get('/api/whisper-model-status', (_req, res) => {
    const ready = fs.existsSync(WHISPER_MODEL_FILE);
    const size  = ready ? (() => { try { return fs.statSync(WHISPER_MODEL_FILE).size; } catch (_) { return 0; } })() : 0;
    res.json({ ready, modelPath: WHISPER_MODEL_FILE, size });
  });

  // SSE endpoint — download model and stream progress
  app.get('/api/whisper-model-download', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    function send(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

    if (fs.existsSync(WHISPER_MODEL_FILE)) {
      send({ pct: 100, ready: true });
      return res.end();
    }

    fs.mkdirSync(WHISPER_MODEL_DIR, { recursive: true });
    const tmpFile = WHISPER_MODEL_FILE + '.tmp';

    // Use curl for download — reliable progress on macOS
    const dl = spawn('curl', ['-L', '--progress-bar', '-o', tmpFile, WHISPER_MODEL_URL], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lastPct = 0;
    dl.stderr.on('data', chunk => {
      const str = chunk.toString();
      const m = str.match(/(\d+(?:\.\d+)?)%/);
      if (m) {
        const pct = Math.round(parseFloat(m[1]));
        if (pct !== lastPct) { lastPct = pct; send({ pct }); }
      }
    });

    dl.on('close', code => {
      if (code === 0 && fs.existsSync(tmpFile)) {
        fs.renameSync(tmpFile, WHISPER_MODEL_FILE);
        send({ pct: 100, ready: true });
      } else {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        send({ error: 'Download failed (exit ' + code + ')' });
      }
      res.end();
    });

    req.on('close', () => { try { dl.kill(); } catch (_) {} });
  });

  // POST /api/transcribe — audio blob body → { ok, text }
  // Uses nodejs-whisper (ships whisper.cpp binary in node_modules)
  app.post('/api/transcribe', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
    if (!fs.existsSync(WHISPER_MODEL_FILE)) {
      return res.status(503).json({ ok: false, error: 'Whisper model not downloaded yet' });
    }
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ ok: false, error: 'Empty audio body' });
    }
    const ts     = Date.now();
    const ctHeader = req.headers['content-type'] || '';
    const isWav  = ctHeader.includes('wav') || ctHeader.includes('wave') || (req.body.length >= 4 && req.body.slice(0,4).toString('ascii') === 'RIFF');
    const ext = isWav ? 'wav' : (ctHeader.includes('ogg') ? 'ogg' : ctHeader.includes('mp4') ? 'mp4' : 'webm');
    const tmpIn  = path.join(os.tmpdir(), `fauna_voice_${ts}.${ext}`);
    const tmpWav = path.join(os.tmpdir(), `fauna_voice_${ts}.wav`);
    try {
      fs.writeFileSync(tmpIn, req.body);
      console.log('[transcribe] wrote', req.body.length, 'bytes to', tmpIn, '(content-type:', ctHeader, ')');
      // Fast path: client already sent WAV — skip ffmpeg entirely.
      let ffOk = false;
      if (isWav) {
        fs.copyFileSync(tmpIn, tmpWav);
        ffOk = true;
      }
      // Verify webm magic bytes (first 4 bytes should be 0x1A45DFA3 for EBML)
      if (ext === 'webm' && req.body.length >= 4) {
        const magic = req.body.readUInt32BE(0);
        if (magic !== 0x1A45DFA3) {
          console.warn('[transcribe] WARNING: webm magic mismatch, got 0x' + magic.toString(16) + ' — may not be valid webm');
        }
      }
      // Prefer the bundled static ffmpeg (no system lib deps); fall back to PATH
      let ffmpegBin;
      {
        let staticPath = null;
        // Strategy 1: process.resourcesPath (most reliable in packed Electron)
        if (!staticPath && process.resourcesPath) {
          const p = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
          if (fs.existsSync(p)) staticPath = p;
        }
        // Strategy 2: require('ffmpeg-static') with asar path fix
        if (!staticPath) {
          try {
            const pkg = _require('ffmpeg-static');
            if (pkg) {
              const fixed = pkg.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
              if (fs.existsSync(fixed)) staticPath = fixed;
            }
          } catch (_) {}
        }
        // Strategy 3: relative to appDir (dev mode)
        if (!staticPath) {
          const p = path.join(appDir, 'node_modules', 'ffmpeg-static', 'ffmpeg');
          if (fs.existsSync(p)) staticPath = p;
        }
        ffmpegBin = staticPath || 'ffmpeg';
        if (!staticPath) console.error('[transcribe] WARNING: ffmpeg-static not found, falling back to system ffmpeg');
        else console.log('[transcribe] using ffmpeg:', staticPath);
      }
      // Determine input format from Content-Type header
      const ct = req.headers['content-type'] || '';
      const inputFmt = ct.includes('ogg') ? 'ogg' : ct.includes('mp4') ? 'mp4' : 'webm';

      // Try ffmpeg conversion with multiple strategies
      const tryFfmpeg = (args, useStdin) => new Promise((resolve, reject) => {
        let rejected = false;
        const fail = (err) => { if (!rejected) { rejected = true; reject(err); } };
        let ffStderr = '';
        const ff = spawn(ffmpegBin, args, {
          stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: augmentedPath },
        });
        if (useStdin) {
          ff.stdin.on('error', () => {}); // suppress EPIPE if ffmpeg closes stdin early
          ff.stdin.write(req.body);
          ff.stdin.end();
        }
        ff.stdout.on('data', () => {}); // drain stdout
        ff.stderr.on('data', chunk => { ffStderr += chunk.toString(); });
        ff.on('close', (code, signal) => {
          if (code === 0) return resolve();
          const detail = ffStderr.trim().split('\n').pop() || '';
          fail(new Error(`ffmpeg exit ${code ?? ('signal:' + signal)}: ${detail}`));
        });
        ff.on('error', err => {
          var msg = 'ffmpeg spawn error: ' + err.message;
          var wrapped = new Error(msg);
          if (err.code === 'ENOENT') wrapped.code = 'FFMPEG_BROKEN';
          fail(wrapped);
        });
      });

      let ffOk2 = ffOk;
      if (!ffOk2) {
      // Strategy 1: explicit input format from file
      try {
        await tryFfmpeg(['-y', '-loglevel', 'error', '-f', inputFmt, '-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', tmpWav], false);
        ffOk2 = true;
      } catch (e1) {
        console.warn('[transcribe] ffmpeg strategy 1 failed:', e1.message);
        // Strategy 2: let ffmpeg probe the file (no -f)
        try {
          await tryFfmpeg(['-y', '-loglevel', 'error', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', tmpWav], false);
          ffOk2 = true;
        } catch (e2) {
          console.warn('[transcribe] ffmpeg strategy 2 failed:', e2.message);
          // Strategy 3: pipe via stdin with explicit format
          try {
            await tryFfmpeg(['-y', '-loglevel', 'error', '-f', inputFmt, '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', tmpWav], true);
            ffOk2 = true;
          } catch (e3) {
            console.error('[transcribe] all ffmpeg strategies failed:', e3.message);
            const finalErr = new Error(`ffmpeg failed (exit 1). ${e3.message}`);
            if (e3.code) finalErr.code = e3.code;
            throw finalErr;
          }
        }
      }
      }
      void ffOk2;
      // Run whisper-cli directly (bypasses nodejs-whisper JS wrapper which breaks inside asar)
      let whisperBin = null;
      {
        const relBin = path.join('node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
        // Strategy 1: unpacked in Electron resources
        if (process.resourcesPath) {
          const p = path.join(process.resourcesPath, 'app.asar.unpacked', relBin);
          if (fs.existsSync(p)) whisperBin = p;
        }
        // Strategy 2: dev mode (appDir)
        if (!whisperBin) {
          const p = path.join(appDir, relBin);
          if (fs.existsSync(p)) whisperBin = p;
        }
        if (!whisperBin) throw new Error('whisper-cli binary not found');
      }
      const text = await new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const wp = spawn(whisperBin, [
          '-m', WHISPER_MODEL_FILE,
          '-f', tmpWav,
          '-l', 'en',
          '-otxt',
          '--no-prints',
        ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: augmentedPath } });
        wp.stdout.on('data', d => { stdout += d.toString(); });
        wp.stderr.on('data', d => { stderr += d.toString(); });
        wp.on('close', code => {
          if (code !== 0) return reject(new Error(`whisper-cli exited ${code}: ${stderr.trim()}`));
          // whisper-cli with -otxt writes to <input>.txt
          const txtFile = tmpWav + '.txt';
          if (fs.existsSync(txtFile)) {
            const t = fs.readFileSync(txtFile, 'utf8').trim();
            try { fs.unlinkSync(txtFile); } catch (_) {}
            resolve(t);
          } else {
            resolve(stdout.trim());
          }
        });
        wp.on('error', err => reject(new Error('whisper-cli spawn error: ' + err.message)));
      });
      res.json({ ok: true, text });
    } catch (e) {
      const body = { ok: false, error: e.message };
      if (e.code) body.code = e.code;
      res.status(500).json(body);
    } finally {
      try { fs.unlinkSync(tmpIn); } catch (_) {}
      try { fs.unlinkSync(tmpWav); } catch (_) {}
    }
  });

  // SSE: repair broken system ffmpeg via brew reinstall
  // GET /api/repair-ffmpeg → streams { line } then { done } or { error }
  app.get('/api/repair-ffmpeg', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    // Locate brew
    const brewBin = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(p => fs.existsSync(p)) || 'brew';
    const proc = spawn(brewBin, ['reinstall', 'ffmpeg'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: augmentedPath, HOMEBREW_NO_AUTO_UPDATE: '1' },
    });
    proc.stdout.on('data', chunk => chunk.toString().split('\n').filter(Boolean).forEach(l => send({ line: l })));
    proc.stderr.on('data', chunk => chunk.toString().split('\n').filter(Boolean).forEach(l => send({ line: l })));
    proc.on('close', code => {
      if (code === 0) send({ done: true });
      else send({ error: `brew reinstall ffmpeg exited ${code}` });
      res.end();
    });
    proc.on('error', err => { send({ error: err.message }); res.end(); });
    req.on('close', () => { try { proc.kill(); } catch (_) {} });
  });
}

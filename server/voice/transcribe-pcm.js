// ── PCM → Whisper transcription (no ffmpeg) ──────────────────────────────
//
// Used by the resident voice pipeline. Takes a raw PCM16 mono buffer (the
// format produced by public/js/audio-capture.js), wraps it in a WAV header,
// and runs the bundled whisper-cli binary directly.
//
// Keeps zero coupling with the REST /api/transcribe route in
// server/routes/whisper.js: both call into whisper-cli but they own their
// own input pipelines (the route handles arbitrary upload encodings via
// ffmpeg; this module assumes already-canonical PCM).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import { writePcmAsWav } from './wav.js';

const MODEL_DIR  = path.join(os.homedir(), '.config', 'fauna', 'whisper');
const MODEL_FILE = path.join(MODEL_DIR, 'ggml-base.en.bin');

let _whisperBinCache = null;

function locateWhisperBin(appDir) {
  if (_whisperBinCache && fs.existsSync(_whisperBinCache)) return _whisperBinCache;
  const rel = path.join('node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', rel));
  if (appDir) candidates.push(path.join(appDir, rel));
  for (const p of candidates) {
    if (fs.existsSync(p)) { _whisperBinCache = p; return p; }
  }
  return null;
}

export function isWhisperReady() {
  return fs.existsSync(MODEL_FILE);
}

export function getWhisperModelPath() {
  return MODEL_FILE;
}

/**
 * Transcribe a PCM16 mono buffer.
 *
 * @param {Buffer}  pcm                raw PCM16 mono, little-endian
 * @param {object}  opts
 * @param {number}  opts.sampleRate    sample rate of the PCM (typically 16000)
 * @param {string}  opts.appDir        absolute path to the Fauna install dir
 * @param {string}  [opts.augmentedPath]  PATH override for child process
 * @param {number}  [opts.timeoutMs]   hard kill timeout (default 30 s)
 * @returns {Promise<{ok:boolean, text?:string, error?:string, code?:string}>}
 */
export async function transcribePcm(pcm, opts) {
  const { sampleRate, appDir, augmentedPath, timeoutMs = 30000 } = opts || {};
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
    return { ok: false, error: 'Empty PCM buffer' };
  }
  if (!isWhisperReady()) {
    return { ok: false, error: 'Whisper model not downloaded yet', code: 'MODEL_MISSING' };
  }
  const whisperBin = locateWhisperBin(appDir);
  if (!whisperBin) {
    return { ok: false, error: 'whisper-cli binary not found', code: 'BIN_MISSING' };
  }

  const ts     = Date.now();
  const tmpWav = path.join(os.tmpdir(), `fauna_voice_${ts}_${process.pid}.wav`);

  try {
    writePcmAsWav(tmpWav, pcm, sampleRate || 16000);
  } catch (e) {
    return { ok: false, error: 'Failed to write WAV: ' + e.message };
  }

  try {
    const text = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const wp = spawn(whisperBin, [
        '-m', MODEL_FILE,
        '-f', tmpWav,
        '-l', 'en',
        '-otxt',
        '--no-prints',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env:   augmentedPath ? { ...process.env, PATH: augmentedPath } : process.env,
      });
      const killTimer = setTimeout(() => {
        try { wp.kill('SIGKILL'); } catch (_) {}
        reject(new Error('whisper-cli timeout after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      wp.stdout.on('data', d => { stdout += d.toString(); });
      wp.stderr.on('data', d => { stderr += d.toString(); });
      wp.on('close', code => {
        clearTimeout(killTimer);
        if (code !== 0) return reject(new Error(`whisper-cli exited ${code}: ${stderr.trim()}`));
        const txtFile = tmpWav + '.txt';
        if (fs.existsSync(txtFile)) {
          const t = fs.readFileSync(txtFile, 'utf8').trim();
          try { fs.unlinkSync(txtFile); } catch (_) {}
          resolve(t);
        } else {
          resolve(stdout.trim());
        }
      });
      wp.on('error', err => {
        clearTimeout(killTimer);
        reject(new Error('whisper-cli spawn error: ' + err.message));
      });
    });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmpWav); } catch (_) {}
  }
}

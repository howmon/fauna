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
import { getSettings } from './settings.js';
import { isInstalled, modelPathFor, resolveActiveModel } from './whisper-models.js';

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
  // Ready if *any* installed model exists — the caller can still ask for a
  // specific one via opts.model, but a fresh install with only 'tiny' should
  // still be considered "ready" by the dictation orchestrator.
  return !!resolveActiveModel();
}

export function getWhisperModelPath() {
  const sel = (getSettings().whisperModel || 'base.en');
  const active = resolveActiveModel(sel);
  return active ? modelPathFor(active) : modelPathFor('base.en');
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
  // Resolve the model to use: caller override > current setting > any installed.
  const settings = getSettings();
  const preferred = opts?.model || settings.whisperModel || 'base.en';
  const activeAlias = resolveActiveModel(preferred);
  if (!activeAlias) {
    return { ok: false, error: 'No Whisper model installed', code: 'MODEL_MISSING' };
  }
  const modelFile = modelPathFor(activeAlias);
  if (!isInstalled(activeAlias)) {
    return { ok: false, error: 'Whisper model "' + activeAlias + '" not installed', code: 'MODEL_MISSING' };
  }
  const language = (opts?.language || settings.whisperLanguage || 'auto').toLowerCase();
  // English-only models can't honour --language other than 'en' — force it.
  const lang = activeAlias.endsWith('.en') ? 'en' : language;

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
      const wpArgs = [
        '-m', modelFile,
        '-f', tmpWav,
        '-otxt',
        '--no-prints',
      ];
      // Whisper-cli auto-detects language when -l is omitted or set to 'auto'.
      if (lang && lang !== 'auto') {
        wpArgs.push('-l', lang);
      } else {
        wpArgs.push('-l', 'auto');
      }
      // Bias the decoder toward custom vocabulary (project names, jargon).
      // whisper-cli accepts --prompt "<text>"; we pass it as a single argv
      // entry so spaces don't fragment it.
      const hot = (opts?.hotWords ?? settings.whisperHotWords ?? '').trim();
      if (hot) wpArgs.push('--prompt', hot);
      const wp = spawn(whisperBin, wpArgs, {
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

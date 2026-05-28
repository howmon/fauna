// Narration — Text-to-Speech for the video pipeline.
//
// V1 strategy (zero new npm deps): use the OS-native TTS that's already
// available in server/voice/tts.js for the live voice assistant, but render
// to a file instead of streaming to speakers:
//
//   macOS  → /usr/bin/say  -o out.aiff   →  ffmpeg → out.mp3
//   linux  → espeak-ng     --stdout      →  ffmpeg → out.mp3
//   win    → PowerShell SAPI to .wav     →  ffmpeg → out.mp3
//
// Subtitle timing: MoneyPrinterTurbo's "character-proportional duration
// allocation" — split the script into sentences, then assign each sentence
// a slice of the total audio duration proportional to its character count.
// This matches the upstream fallback that ships when an engine doesn't
// expose word-boundary events, and produces solid SRT timing for short-form
// videos where each sentence is its own subtitle line.
//
// Future: plug edge-tts / azure / elevenlabs behind the same `synthesize()`
// signature without changing callers.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const FFMPEG = ffmpegStatic || 'ffmpeg';

function _run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    let stdout = ''; let stderr = '';
    p.stdout?.on('data', d => { stdout += d.toString(); });
    p.stderr?.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-400)}`)));
  });
}

/**
 * Probe an audio file with ffprobe-equivalent (ffmpeg -i prints metadata to stderr).
 * Returns duration in seconds.
 */
export async function probeDuration(audioFile) {
  try {
    await _run(FFMPEG, ['-i', audioFile, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // ffmpeg always exits non-zero for `-f null -` on inputs without filter chain;
    // parse stderr anyway.
    const m = String(e.message).match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return 0;
}

async function _ttsMac(text, voice, outAiff) {
  const args = [];
  if (voice) args.push('-v', voice);
  args.push('-o', outAiff, '--', text);
  await _run('/usr/bin/say', args);
}

async function _ttsLinux(text, voice, outWav) {
  const args = ['--stdout'];
  if (voice) args.push('-v', voice);
  args.push(text);
  return new Promise((resolve, reject) => {
    const p = spawn('espeak-ng', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(outWav);
    p.stdout.pipe(out);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error('espeak-ng failed')));
  });
}

async function _ttsWin(text, voice, outWav) {
  const escaped = text.replace(/"/g, '`"').replace(/\$/g, '`$');
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    voice ? `$s.SelectVoice("${voice}");` : '',
    `$s.SetOutputToWaveFile("${outWav}");`,
    `$s.Speak("${escaped}");`,
    '$s.Dispose();',
  ].join(' ');
  await _run('powershell.exe', ['-NoProfile', '-Command', ps]);
}

/**
 * Synthesize narration to MP3.
 * @param {object} args
 * @param {string} args.text       — full script
 * @param {string} args.outFile    — absolute path to write (must end .mp3)
 * @param {string} [args.voice]    — engine-specific voice name (e.g. 'Samantha' on Mac)
 * @returns {Promise<{audioFile:string, durationSec:number}>}
 */
export async function synthesize({ text, outFile, voice }) {
  if (!text || !text.trim()) throw new Error('text is required');
  if (!outFile) throw new Error('outFile is required');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // 1) Native TTS → intermediate audio file
  const tmpExt = IS_MAC ? '.aiff' : '.wav';
  const tmp = outFile.replace(/\.mp3$/i, '') + '.tmp' + tmpExt;
  try {
    if (IS_MAC) await _ttsMac(text, voice, tmp);
    else if (IS_WIN) await _ttsWin(text, voice, tmp);
    else await _ttsLinux(text, voice, tmp);
  } catch (e) {
    throw new Error(`TTS engine failed: ${e.message}`);
  }

  // 2) Transcode to MP3 (consistent codec for downstream ffmpeg mux)
  try {
    await _run(FFMPEG, ['-y', '-i', tmp, '-codec:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', outFile]);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }

  const durationSec = await probeDuration(outFile);
  return { audioFile: outFile, durationSec };
}

// ── Subtitle generation (character-proportional) ──────────────────────────

/**
 * Split a script into sentence-level subtitle units, preserving the original
 * line breaks the script generator emitted (we ask it for one sentence per line)
 * and falling back to splitting on punctuation if needed.
 */
export function splitIntoCues(script) {
  if (!script) return [];
  const lines = script.split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    // If a line is huge, split it on sentence-ending punctuation.
    if (line.length > 80) {
      const parts = line.split(/(?<=[.!?。！？])\s+/).map(s => s.trim()).filter(Boolean);
      out.push(...parts);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Allocate subtitle timings across the audio duration proportional to character count.
 * Returns SRT-shaped cues.
 */
export function buildCues(script, audioDurationSec) {
  const segments = splitIntoCues(script);
  if (!segments.length || !audioDurationSec) return [];
  const totalChars = segments.reduce((s, t) => s + t.length, 0) || 1;
  // Trim the last 200ms so subs don't extend past the audio.
  const usable = Math.max(0.1, audioDurationSec - 0.2);
  let cursor = 0;
  const cues = [];
  for (let i = 0; i < segments.length; i++) {
    const text = segments[i];
    const start = cursor;
    const dur = (text.length / totalChars) * usable;
    const end = i === segments.length - 1 ? usable : Math.min(usable, cursor + dur);
    cues.push({ index: i + 1, start, end, text });
    cursor = end;
  }
  return cues;
}

function _fmtTimestamp(sec) {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const whole = Math.floor(s);
  const ms = Math.round((s - whole) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(whole).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

/** Serialize cues to SRT format. */
export function cuesToSrt(cues) {
  return cues.map(c => `${c.index}\n${_fmtTimestamp(c.start)} --> ${_fmtTimestamp(c.end)}\n${c.text}\n`).join('\n');
}

/**
 * Generate subtitle file from script + audio duration.
 * Returns { subtitlePath, cues }.
 */
export function writeSubtitles({ script, audioDurationSec, outFile }) {
  const cues = buildCues(script, audioDurationSec);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, cuesToSrt(cues), 'utf8');
  return { subtitlePath: outFile, cues };
}

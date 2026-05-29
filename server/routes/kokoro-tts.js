// Kokoro TTS routes — ad-hoc "speak this" + multi-voice podcast generation.
//
// Unlike the video pipeline (which produces an MP4), these endpoints just
// synthesize Kokoro audio to an mp3 the renderer can embed via a gen-ui
// MediaPlayer. Content-hash cached under ~/.fauna/kokoro-cache so repeated
// prompts ("read me this article again") are instant.
//
//   POST /api/kokoro-tts          { text, voice? }      → { ok, id, url, durationSec, voice }
//   POST /api/kokoro-podcast      { segments:[{voice,text}], title? }
//                                                       → { ok, id, url, durationSec, segmentCount }
//   GET  /api/kokoro-audio/:id.mp3                       → audio/mpeg with Range support

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { synthesizeKokoroSegments, parseVoiceSpec, DEFAULT_KOKORO_VOICE } from '../video/kokoro.js';
import { FFMPEG_PATH } from '../video/ffmpeg-path.js';
import { splitIntoCues } from '../video/narration.js';

const CACHE_DIR = path.join(os.homedir(), '.fauna', 'kokoro-cache');

function _ensureCache() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}
}

function _run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr?.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exit ${code}: ${stderr.slice(-300)}`)));
  });
}

function _resolveVoice(v) {
  const spec = parseVoiceSpec(v);
  return spec.engine === 'kokoro' && spec.voiceId ? spec.voiceId : (v || DEFAULT_KOKORO_VOICE);
}

function _cacheKey(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function _cachePath(id) {
  return path.join(CACHE_DIR, `${id}.mp3`);
}

/**
 * Synthesize plain text with one Kokoro voice → mp3. Returns the cache id.
 * Splits long text into sentence-sized chunks so the streamed synthesis
 * stays under the model's natural utterance length.
 */
async function _synthSingle({ text, voice }) {
  _ensureCache();
  const voiceId = _resolveVoice(voice);
  const id = _cacheKey({ kind: 'single', voice: voiceId, text });
  const outMp3 = _cachePath(id);
  if (fs.existsSync(outMp3) && fs.statSync(outMp3).size > 0) {
    return { id, file: outMp3, voice: voiceId };
  }
  const segments = splitIntoCues(text);
  if (!segments.length) throw new Error('text has no spoken content');
  const segDir = outMp3 + '.segs';
  try {
    fs.mkdirSync(segDir, { recursive: true });
    const segs = await synthesizeKokoroSegments({ segments, outDir: segDir, voice: voiceId });
    const listFile = path.join(segDir, 'concat.txt');
    fs.writeFileSync(listFile, segs.map(s => `file '${s.wavFile.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    await _run(FFMPEG_PATH, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-codec:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', outMp3,
    ]);
    return { id, file: outMp3, voice: voiceId };
  } finally {
    try { fs.rmSync(segDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Synthesize a multi-voice podcast. `segments` is an ordered list of
 * { voice, text } turns; each is synthesized independently and concatenated
 * into a single mp3 with a small silence gap between speakers so the
 * resulting audio sounds like a real conversation.
 */
async function _synthPodcast({ segments, gapSec = 0.35 }) {
  _ensureCache();
  if (!Array.isArray(segments) || !segments.length) throw new Error('segments required');
  const norm = segments.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`segments[${i}] must be an object`);
    const text = String(s.text || '').trim();
    if (!text) throw new Error(`segments[${i}].text is empty`);
    return { voice: _resolveVoice(s.voice), text };
  });
  const id = _cacheKey({ kind: 'podcast', gapSec, segments: norm });
  const outMp3 = _cachePath(id);
  if (fs.existsSync(outMp3) && fs.statSync(outMp3).size > 0) {
    return { id, file: outMp3 };
  }
  const segDir = outMp3 + '.segs';
  try {
    fs.mkdirSync(segDir, { recursive: true });
    // Synthesize per-turn into a single wav per turn so we can interleave
    // silence in the concat list.
    const turnFiles = [];
    for (let i = 0; i < norm.length; i++) {
      const turn = norm[i];
      const turnDir = path.join(segDir, `turn-${String(i).padStart(3, '0')}`);
      fs.mkdirSync(turnDir, { recursive: true });
      const cues = splitIntoCues(turn.text);
      const segs = await synthesizeKokoroSegments({
        segments: cues.length ? cues : [turn.text],
        outDir: turnDir,
        voice: turn.voice,
      });
      // Concat the turn's sentences into one wav (so silence gaps only fall
      // between turns, not between sentences in the same turn).
      const turnWav = path.join(turnDir, 'turn.wav');
      const listFile = path.join(turnDir, 'concat.txt');
      fs.writeFileSync(listFile, segs.map(s => `file '${s.wavFile.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
      await _run(FFMPEG_PATH, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', turnWav]);
      turnFiles.push(turnWav);
    }
    // Generate one silence wav at the same sample rate (24000 Hz mono from Kokoro).
    let silenceWav = null;
    if (gapSec > 0 && turnFiles.length > 1) {
      silenceWav = path.join(segDir, 'silence.wav');
      await _run(FFMPEG_PATH, [
        '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=24000`,
        '-t', String(gapSec), silenceWav,
      ]);
    }
    // Build interleaved concat list.
    const concatList = path.join(segDir, 'all.txt');
    const lines = [];
    for (let i = 0; i < turnFiles.length; i++) {
      lines.push(`file '${turnFiles[i].replace(/'/g, "'\\''")}'`);
      if (silenceWav && i < turnFiles.length - 1) {
        lines.push(`file '${silenceWav.replace(/'/g, "'\\''")}'`);
      }
    }
    fs.writeFileSync(concatList, lines.join('\n'), 'utf8');
    await _run(FFMPEG_PATH, [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
      '-codec:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', outMp3,
    ]);
    return { id, file: outMp3 };
  } finally {
    try { fs.rmSync(segDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * ffmpeg-based duration probe.
 */
async function _probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG_PATH, ['-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr?.on('data', d => { stderr += d.toString(); });
    p.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (m) resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      else resolve(0);
    });
    p.on('error', () => resolve(0));
  });
}

export function registerKokoroTtsRoutes(app) {
  app.use(['/api/kokoro-tts', '/api/kokoro-podcast', '/api/kokoro-audio'], (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.post('/api/kokoro-tts', async (req, res) => {
    try {
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ ok: false, error: 'text required' });
      if (text.length > 20000) return res.status(400).json({ ok: false, error: 'text too long (>20000 chars)' });
      const voice = req.body?.voice;
      const { id, file, voice: usedVoice } = await _synthSingle({ text, voice });
      const durationSec = await _probeDuration(file);
      res.json({
        ok: true,
        id,
        url: `/api/kokoro-audio/${id}.mp3`,
        durationSec,
        voice: usedVoice,
        bytes: fs.statSync(file).size,
      });
    } catch (e) {
      console.error('[kokoro-tts] failed:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/kokoro-podcast', async (req, res) => {
    try {
      const segments = req.body?.segments;
      const gapSec = Number.isFinite(req.body?.gapSec) ? Number(req.body.gapSec) : 0.35;
      const { id, file } = await _synthPodcast({ segments, gapSec });
      const durationSec = await _probeDuration(file);
      res.json({
        ok: true,
        id,
        url: `/api/kokoro-audio/${id}.mp3`,
        durationSec,
        segmentCount: segments.length,
        bytes: fs.statSync(file).size,
      });
    } catch (e) {
      console.error('[kokoro-podcast] failed:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/kokoro-audio/:id.mp3', (req, res) => {
    const id = String(req.params.id || '');
    // sha256 hex slice → strictly [0-9a-f]; reject anything else for safety.
    if (!/^[0-9a-f]{8,64}$/.test(id)) return res.status(400).end();
    const file = _cachePath(id);
    if (!fs.existsSync(file)) return res.status(404).end();
    const stat = fs.statSync(file);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'audio/mpeg',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(file).pipe(res);
    }
  });
}

// Exported for self-tools.js so model tools can synthesize without an HTTP
// round-trip (they're already in-process).
export { _synthSingle as synthSingleKokoro, _synthPodcast as synthKokoroPodcast, _probeDuration as probeKokoroDuration };

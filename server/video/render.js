// Render — ffmpeg pipeline for combining clips, mixing audio, and burning subs.
//
// MoneyPrinterTurbo uses MoviePy for composition + ffmpeg concat-demuxer for
// the final merge. We collapse that into a single ffmpeg invocation per output:
//
//   1. Pre-normalise each downloaded clip to the target aspect (scale + pad)
//      and trim to maxClipDuration. Write each as an intermediate .mp4 with
//      identical codecs/dims so the concat demuxer doesn't need re-encoding.
//   2. Concat-demuxer them into combined.mp4 (still video-only — original
//      ambient audio dropped because narration replaces it).
//   3. Overlay narration audio + (optional) BGM, burn in subtitles via
//      ffmpeg's `subtitles=` filter, and emit final-N.mp4.
//
// Notes
//   - aspect handling = letterbox/pillarbox (never crop).
//   - subtitle styling tuned for vertical short-form: large font, white text,
//     thick black stroke, anchored near bottom.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

const FFMPEG = ffmpegStatic || 'ffmpeg';

function _run(cmd, args, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      if (onProgress) {
        const m = chunk.match(/time=(\d+):(\d+):([\d.]+)/);
        if (m) onProgress({ time: Number(m[1])*3600 + Number(m[2])*60 + Number(m[3]) });
      }
    });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-500)}`)));
  });
}

function _dimsFor(aspect) {
  if (aspect === '9:16') return { w: 1080, h: 1920 };
  if (aspect === '16:9') return { w: 1920, h: 1080 };
  if (aspect === '1:1')  return { w: 1080, h: 1080 };
  return { w: 1920, h: 1080 };
}

/**
 * Normalize a single input clip: scale to fit, pad to exact dims, trim, drop audio.
 * Produces a clean mp4 that's safe to concat without re-encoding.
 */
async function normaliseClip(inPath, outPath, { aspect, maxClipDuration, fps = 30 }) {
  const { w, h } = _dimsFor(aspect);
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `setsar=1`,
    `fps=${fps}`,
  ].join(',');
  const args = [
    '-y', '-i', inPath,
    '-t', String(maxClipDuration),
    '-vf', vf,
    '-an',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23',
    outPath,
  ];
  await _run(FFMPEG, args);
}

/**
 * Concat-demuxer-merge a list of pre-normalised mp4s into one continuous video.
 */
async function concatClips(clipPaths, outPath, { jobDir }) {
  const listFile = path.join(jobDir, 'concat-list.txt');
  // The concat demuxer requires single-quoted paths with internal quotes escaped.
  const body = clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listFile, body, 'utf8');
  const args = [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy',
    outPath,
  ];
  await _run(FFMPEG, args);
}

/**
 * Loop / repeat a clip list to cover the target duration, then concat.
 * Returns the path to combined.mp4.
 */
export async function buildCombined({ clips, jobDir, aspect, audioDurationSec, maxClipDuration = 5, fps = 30, onProgress }) {
  const normDir = path.join(jobDir, 'normalised');
  fs.mkdirSync(normDir, { recursive: true });

  // Normalise each unique clip once.
  onProgress?.('Normalising clips');
  const normalised = [];
  for (let i = 0; i < clips.length; i++) {
    const out = path.join(normDir, `n-${String(i+1).padStart(2,'0')}.mp4`);
    if (!fs.existsSync(out)) {
      await normaliseClip(clips[i].path, out, { aspect, maxClipDuration, fps });
    }
    normalised.push(out);
  }

  // Repeat (cycling) until we have enough clip-seconds for the audio.
  const seq = [];
  const perClip = maxClipDuration;
  const need = Math.ceil(audioDurationSec / perClip);
  for (let i = 0; i < need; i++) {
    seq.push(normalised[i % normalised.length]);
  }

  const combined = path.join(jobDir, 'combined.mp4');
  onProgress?.('Concatenating clips');
  await concatClips(seq, combined, { jobDir });
  return combined;
}

/**
 * Final render: combined video + narration audio + (optional) bgm + (optional) burned-in subs.
 */
export async function renderFinal({ combinedVideo, audioFile, subtitlePath, bgmFile, bgmVolume = 0.2, voiceVolume = 1.0, outFile, audioDurationSec, aspect, onProgress }) {
  const { w, h } = _dimsFor(aspect);
  const args = ['-y', '-i', combinedVideo, '-i', audioFile];
  if (bgmFile) args.push('-stream_loop', '-1', '-i', bgmFile);

  // Build filter graph
  const vFilters = [];
  if (subtitlePath && fs.existsSync(subtitlePath)) {
    // Subtitles filter requires escaping ':' on the path so ffmpeg doesn't
    // interpret it as an option separator. Also style for short-form video.
    const esc = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const fontSize = aspect === '9:16' ? 22 : 16;
    const style = [
      `FontName=Helvetica`,
      `FontSize=${fontSize}`,
      `PrimaryColour=&HFFFFFF&`,
      `OutlineColour=&H000000&`,
      `BorderStyle=1`,
      `Outline=2`,
      `Shadow=0`,
      `Alignment=2`, // bottom-center
      `MarginV=80`,
    ].join(',');
    vFilters.push(`subtitles='${esc}':force_style='${style}'`);
  }
  if (vFilters.length) args.push('-vf', vFilters.join(','));

  // Audio mix
  if (bgmFile) {
    const aFilter = `[1:a]volume=${voiceVolume}[v];[2:a]volume=${bgmVolume},apad[b];[v][b]amix=inputs=2:duration=first[a]`;
    args.push('-filter_complex', aFilter, '-map', '0:v', '-map', '[a]');
  } else {
    args.push('-map', '0:v', '-map', '1:a');
  }

  // Trim to audio duration so trailing video frames don't outlast narration.
  if (audioDurationSec) args.push('-t', String(audioDurationSec));

  // Output
  args.push(
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '21',
    '-s', `${w}x${h}`,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-movflags', '+faststart',
    outFile,
  );

  onProgress?.('Rendering final video');
  await _run(FFMPEG, args, {
    onProgress: ({ time }) => {
      if (audioDurationSec) {
        const pct = Math.min(100, Math.round((time / audioDurationSec) * 100));
        onProgress?.(`Rendering ${pct}%`);
      }
    },
  });
  return outFile;
}

/**
 * Convenience: full render path from gathered clips → final mp4.
 */
export async function render({ clips, jobDir, audioFile, audioDurationSec, subtitlePath, bgmFile, aspect = '9:16', maxClipDuration = 5, outFile, onProgress }) {
  const combined = await buildCombined({ clips, jobDir, aspect, audioDurationSec, maxClipDuration, onProgress });
  const final = await renderFinal({
    combinedVideo: combined,
    audioFile,
    subtitlePath,
    bgmFile,
    audioDurationSec,
    aspect,
    outFile,
    onProgress,
  });
  return { finalPath: final, combinedPath: combined };
}

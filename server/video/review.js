// Post-render self-review — a quality gate inspired by OpenMontage's mandatory
// post-render review (ffprobe + frame sampling + audio analysis + delivery
// promise verification). Re-implemented from scratch for fauna (OpenMontage is
// AGPL; this shares only the *idea*).
//
// Today the studio renders blind: if a clip download was corrupt, the narration
// track was silent, or the concat produced a mostly-black video, the user finds
// out by watching the result. This module inspects the finished mp4 and returns
// a structured verdict { ok, issues, warnings, stats } so the pipeline can warn
// (or the agent can auto-repair) before presenting the video.
//
// It uses ONLY the bundled ffmpeg-static binary — parsing `ffmpeg -i` stderr for
// container/stream info, the `blackdetect` filter for black-frame coverage, and
// the `volumedetect` filter for audio levels. No ffprobe/sharp dependency, so it
// works the same in dev and when packaged inside app.asar.unpacked.

import fs from 'fs';
import { spawn } from 'child_process';
import { FFMPEG_PATH } from './ffmpeg-path.js';

// ── Thresholds ────────────────────────────────────────────────────────────
const BLACK_ISSUE_FRACTION = 0.5;   // >50% black → broken render
const BLACK_WARN_FRACTION = 0.15;   // >15% black → suspicious
const SILENCE_MEAN_DB = -50;        // mean below this → effectively silent
const CLIP_MAX_DB = -0.1;           // max at/above this → clipping risk
const DURATION_TOL_FRAC = 0.15;     // allowed |actual-expected|/expected
const DURATION_TOL_MIN = 2;         // ...but always allow at least 2s slack

// ── Pure parsers (exported for unit tests) ─────────────────────────────────

// "Duration: 00:01:03.42, ..." → seconds (number) or null.
export function parseDurationLine(stderr) {
  const m = String(stderr).match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Parse `ffmpeg -i` stderr into normalized media facts.
export function parseProbeStderr(stderr) {
  const s = String(stderr);
  const durationSec = parseDurationLine(s);

  let width = null, height = null, fps = null, hasVideo = false;
  const v = s.match(/Stream #[^\n]*Video:[^\n]*/);
  if (v) {
    hasVideo = true;
    const dims = v[0].match(/(\d{2,5})x(\d{2,5})/);
    if (dims) { width = Number(dims[1]); height = Number(dims[2]); }
    const f = v[0].match(/([\d.]+)\s*fps/);
    if (f) fps = Number(f[1]);
  }
  const hasAudio = /Stream #[^\n]*Audio:/.test(s);
  return { durationSec, width, height, fps, hasVideo, hasAudio };
}

// Sum black-interval durations reported by the `blackdetect` filter.
// Lines look like: "[blackdetect @ 0x..] black_start:1.2 black_end:2.5 black_duration:1.3"
export function parseBlackDetect(stderr) {
  let total = 0;
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
  let m;
  while ((m = re.exec(String(stderr))) !== null) {
    const d = Number(m[2]) - Number(m[1]);
    if (d > 0) total += d;
  }
  return total; // seconds
}

// Parse `volumedetect` summary lines → { meanVolumeDb, maxVolumeDb } (or null).
export function parseVolumeDetect(stderr) {
  const s = String(stderr);
  const mean = s.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  const max = s.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  return {
    meanVolumeDb: mean ? Number(mean[1]) : null,
    maxVolumeDb: max ? Number(max[1]) : null,
  };
}

function _dimsFor(aspect) {
  if (aspect === '9:16') return { w: 1080, h: 1920 };
  if (aspect === '16:9') return { w: 1920, h: 1080 };
  if (aspect === '1:1') return { w: 1080, h: 1080 };
  return null;
}

// Assemble the verdict from already-gathered facts. Pure → unit-testable.
//   probe:  output of parseProbeStderr
//   blackSec: output of parseBlackDetect
//   volume: output of parseVolumeDetect
//   expected: { audioDurationSec, aspect, expectSubtitles, hasSubtitleFile }
export function buildVerdict({ probe, blackSec = 0, volume = {}, expected = {} }) {
  const issues = [];
  const warnings = [];
  const p = probe || {};
  const dur = p.durationSec;

  if (!p.hasVideo) issues.push('No video stream in the rendered file.');
  if (!p.hasAudio) issues.push('No audio stream — narration track is missing from the render.');

  if (dur == null) {
    issues.push('Could not read the rendered video duration.');
  } else if (expected.audioDurationSec) {
    const tol = Math.max(DURATION_TOL_MIN, expected.audioDurationSec * DURATION_TOL_FRAC);
    const diff = Math.abs(dur - expected.audioDurationSec);
    if (diff > tol) {
      issues.push(
        `Video duration ${dur.toFixed(1)}s does not match narration ${expected.audioDurationSec.toFixed(1)}s ` +
        `(off by ${diff.toFixed(1)}s).`
      );
    }
  }

  // Black-frame coverage (broken clips / failed overlays).
  if (dur && dur > 0) {
    const frac = blackSec / dur;
    if (frac > BLACK_ISSUE_FRACTION) {
      issues.push(`${Math.round(frac * 100)}% of the video is black — the footage likely failed to render.`);
    } else if (frac > BLACK_WARN_FRACTION) {
      warnings.push(`${Math.round(frac * 100)}% of the video is black frames.`);
    }
  }

  // Audio levels.
  if (p.hasAudio) {
    if (volume.meanVolumeDb == null) {
      warnings.push('Could not analyze audio levels.');
    } else if (volume.meanVolumeDb < SILENCE_MEAN_DB) {
      issues.push(`Audio is effectively silent (mean ${volume.meanVolumeDb} dB).`);
    }
    if (volume.maxVolumeDb != null && volume.maxVolumeDb >= CLIP_MAX_DB) {
      warnings.push(`Audio peaks at ${volume.maxVolumeDb} dB — possible clipping/distortion.`);
    }
  }

  // Subtitle presence (delivery-promise check).
  if (expected.expectSubtitles && !expected.hasSubtitleFile) {
    warnings.push('Subtitles were requested but no subtitle track was burned in.');
  }

  // Resolution sanity vs requested aspect.
  if (expected.aspect && p.width && p.height) {
    const d = _dimsFor(expected.aspect);
    if (d && (p.width !== d.w || p.height !== d.h)) {
      warnings.push(`Output is ${p.width}x${p.height}, expected ${d.w}x${d.h} for ${expected.aspect}.`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    stats: {
      durationSec: dur,
      width: p.width,
      height: p.height,
      fps: p.fps,
      hasAudio: !!p.hasAudio,
      blackSec: Number(blackSec.toFixed(2)),
      meanVolumeDb: volume.meanVolumeDb ?? null,
      maxVolumeDb: volume.maxVolumeDb ?? null,
    },
  };
}

// ── ffmpeg drivers (impure) ────────────────────────────────────────────────

// Run ffmpeg and capture stderr. ffmpeg exits non-zero for probe-only / null
// muxer invocations, which is expected — we resolve with whatever stderr we got.
function _ffmpegStderr(args) {
  return new Promise((resolve) => {
    let stderr = '';
    let p;
    try {
      p = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      resolve(''); return;
    }
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', () => resolve(stderr));
    p.on('close', () => resolve(stderr));
  });
}

/**
 * Inspect a finished render and return a structured quality verdict.
 * Never throws — on any failure it returns a verdict with a single warning so
 * the pipeline degrades gracefully instead of breaking the render step.
 *
 * @returns {Promise<{ok:boolean, issues:string[], warnings:string[], stats:object}>}
 */
export async function reviewRender({ videoFile, audioDurationSec, aspect, expectSubtitles = false, subtitlePath } = {}) {
  try {
    if (!videoFile || !fs.existsSync(videoFile) || fs.statSync(videoFile).size === 0) {
      return { ok: false, issues: ['Rendered file is missing or empty.'], warnings: [], stats: {} };
    }

    const probeOut = await _ffmpegStderr(['-hide_banner', '-i', videoFile]);
    const probe = parseProbeStderr(probeOut);

    const blackOut = await _ffmpegStderr([
      '-hide_banner', '-i', videoFile,
      '-vf', 'blackdetect=d=0.05:pic_th=0.98', '-an', '-f', 'null', '-',
    ]);
    const blackSec = parseBlackDetect(blackOut);

    let volume = { meanVolumeDb: null, maxVolumeDb: null };
    if (probe.hasAudio) {
      const volOut = await _ffmpegStderr([
        '-hide_banner', '-i', videoFile,
        '-af', 'volumedetect', '-vn', '-f', 'null', '-',
      ]);
      volume = parseVolumeDetect(volOut);
    }

    const hasSubtitleFile = !!(subtitlePath && fs.existsSync(subtitlePath) && fs.statSync(subtitlePath).size > 0);

    return buildVerdict({
      probe,
      blackSec,
      volume,
      expected: { audioDurationSec, aspect, expectSubtitles, hasSubtitleFile },
    });
  } catch (e) {
    return { ok: true, issues: [], warnings: ['Self-review could not run: ' + e.message], stats: {} };
  }
}

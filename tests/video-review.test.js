// Post-render self-review — unit tests for the pure parsers and verdict logic.
// These exercise the side-effect-free helpers with captured ffmpeg stderr
// fixtures; the ffmpeg drivers themselves are integration-only (not run in CI).

import { describe, it, expect } from 'vitest';
import {
  parseDurationLine,
  parseProbeStderr,
  parseBlackDetect,
  parseVolumeDetect,
  buildVerdict,
} from '../server/video/review.js';

const PROBE_FIXTURE = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'final.mp4':
  Duration: 00:00:32.40, start: 0.000000, bitrate: 2200 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1080x1920, 2000 kb/s, 30 fps, 30 tbr
  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo, fltp, 192 kb/s
`;

describe('parseDurationLine', () => {
  it('reads HH:MM:SS.ss into seconds', () => {
    expect(parseDurationLine('Duration: 00:01:03.42, start')).toBeCloseTo(63.42, 2);
  });
  it('returns null when absent', () => {
    expect(parseDurationLine('no duration here')).toBeNull();
  });
});

describe('parseProbeStderr', () => {
  it('extracts duration, dims, fps, and stream presence', () => {
    const p = parseProbeStderr(PROBE_FIXTURE);
    expect(p.durationSec).toBeCloseTo(32.4, 1);
    expect(p.width).toBe(1080);
    expect(p.height).toBe(1920);
    expect(p.fps).toBe(30);
    expect(p.hasVideo).toBe(true);
    expect(p.hasAudio).toBe(true);
  });
  it('detects a missing audio stream', () => {
    const p = parseProbeStderr(PROBE_FIXTURE.replace(/Stream #0:1.*Audio:.*/g, ''));
    expect(p.hasVideo).toBe(true);
    expect(p.hasAudio).toBe(false);
  });
});

describe('parseBlackDetect', () => {
  it('sums black interval durations', () => {
    const s = `
      [blackdetect @ 0x1] black_start:0 black_end:1.5 black_duration:1.5
      [blackdetect @ 0x1] black_start:10 black_end:12 black_duration:2
    `;
    expect(parseBlackDetect(s)).toBeCloseTo(3.5, 5);
  });
  it('returns 0 with no black intervals', () => {
    expect(parseBlackDetect('clean video')).toBe(0);
  });
});

describe('parseVolumeDetect', () => {
  it('reads mean and max volume in dB', () => {
    const s = `
      [Parsed_volumedetect_0 @ 0x1] mean_volume: -18.4 dB
      [Parsed_volumedetect_0 @ 0x1] max_volume: -1.2 dB
    `;
    expect(parseVolumeDetect(s)).toEqual({ meanVolumeDb: -18.4, maxVolumeDb: -1.2 });
  });
  it('returns nulls when missing', () => {
    expect(parseVolumeDetect('')).toEqual({ meanVolumeDb: null, maxVolumeDb: null });
  });
});

describe('buildVerdict', () => {
  const goodProbe = { durationSec: 32, width: 1080, height: 1920, fps: 30, hasVideo: true, hasAudio: true };

  it('passes a clean render', () => {
    const v = buildVerdict({
      probe: goodProbe,
      blackSec: 0.2,
      volume: { meanVolumeDb: -18, maxVolumeDb: -2 },
      expected: { audioDurationSec: 32, aspect: '9:16', expectSubtitles: true, hasSubtitleFile: true },
    });
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([]);
  });

  it('flags a missing audio stream as an issue', () => {
    const v = buildVerdict({ probe: { ...goodProbe, hasAudio: false }, expected: {} });
    expect(v.ok).toBe(false);
    expect(v.issues.join(' ')).toMatch(/audio stream/i);
  });

  it('flags a mostly-black render as an issue', () => {
    const v = buildVerdict({ probe: goodProbe, blackSec: 20, volume: { meanVolumeDb: -18 }, expected: { audioDurationSec: 32 } });
    expect(v.ok).toBe(false);
    expect(v.issues.join(' ')).toMatch(/black/i);
  });

  it('warns (not errors) on a moderately-black render', () => {
    const v = buildVerdict({ probe: goodProbe, blackSec: 7, volume: { meanVolumeDb: -18 }, expected: { audioDurationSec: 32 } });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/black/i);
  });

  it('flags silent audio as an issue', () => {
    const v = buildVerdict({ probe: goodProbe, blackSec: 0, volume: { meanVolumeDb: -80 }, expected: { audioDurationSec: 32 } });
    expect(v.ok).toBe(false);
    expect(v.issues.join(' ')).toMatch(/silent/i);
  });

  it('warns on clipping audio', () => {
    const v = buildVerdict({ probe: goodProbe, blackSec: 0, volume: { meanVolumeDb: -18, maxVolumeDb: 0 }, expected: { audioDurationSec: 32 } });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/clipping/i);
  });

  it('flags a large duration mismatch', () => {
    const v = buildVerdict({ probe: { ...goodProbe, durationSec: 50 }, blackSec: 0, volume: { meanVolumeDb: -18 }, expected: { audioDurationSec: 32 } });
    expect(v.ok).toBe(false);
    expect(v.issues.join(' ')).toMatch(/duration/i);
  });

  it('warns when subtitles were requested but absent', () => {
    const v = buildVerdict({ probe: goodProbe, blackSec: 0, volume: { meanVolumeDb: -18 }, expected: { audioDurationSec: 32, expectSubtitles: true, hasSubtitleFile: false } });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/subtitle/i);
  });

  it('warns on a resolution mismatch', () => {
    const v = buildVerdict({ probe: { ...goodProbe, width: 1920, height: 1080 }, blackSec: 0, volume: { meanVolumeDb: -18 }, expected: { audioDurationSec: 32, aspect: '9:16' } });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/expected 1080x1920/i);
  });
});

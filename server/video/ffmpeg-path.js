// Resolve the on-disk path to the bundled ffmpeg binary.
//
// `ffmpeg-static` returns a path that lives inside `app.asar` when packaged.
// `child_process.spawn` cannot execute files inside an asar archive — it
// raises ENOTDIR because asar appears as a file, not a directory.
// We mirror what the rest of the repo does for whisper (see
// server/routes/whisper.js): rewrite `app.asar` → `app.asar.unpacked` when
// running inside Electron, fall back to the raw path in dev.

import ffmpegStaticRaw from 'ffmpeg-static';

function _resolveFfmpegPath() {
  const raw = ffmpegStaticRaw;
  if (!raw) return 'ffmpeg';
  if (raw.includes('app.asar') && !raw.includes('app.asar.unpacked')) {
    return raw.replace('app.asar', 'app.asar.unpacked');
  }
  return raw;
}

export const FFMPEG_PATH = _resolveFfmpegPath();

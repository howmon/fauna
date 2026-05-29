// Lesson → MP4 video renderer.
//
// Renders an existing lesson (already synthesized to per-scene audio) into a
// single downloadable mp4. Approach:
//
//   1. Spin up an offscreen Electron BrowserWindow sized to the lesson canvas
//      (default 1280×720).
//   2. Load the regular lesson widget HTML+JS (same code path users see live)
//      via a data: URL.
//   3. For each scene: call window.__renderSceneStatic(idx) which resets the
//      canvas and runs every action immediately (no animation), then
//      capturePage() → PNG.
//   4. Per scene: ffmpeg `loop -i scene.png + scene.mp3 → scene.mp4` with the
//      audio duration controlling length.
//   5. Concat-demuxer-merge all scene mp4s → ~/.fauna/lessons/<id>/lesson.mp4.
//
// The result is a slideshow video (one still image per scene with narration)
// — not a frame-perfect capture of the pen-drawing animation. That tradeoff
// is intentional: still-image-per-scene renders in seconds with no live
// screen capture, no audio sync drift, and ships through the existing
// /api/lesson-video route as a simple download.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

import { FFMPEG_PATH } from '../video/ffmpeg-path.js';
import { loadLesson, lessonAudioPath } from './generator.js';
import { buildLessonWidget } from './widget-bundle.js';

const LESSONS_ROOT = path.join(os.homedir(), '.fauna', 'lessons');

function _run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} failed (${code}): ${stderr.slice(-500)}`)));
  });
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Build (or reuse) the mp4 for a lesson.
 *
 * @param {object} args
 * @param {string} args.lessonId
 * @param {() => any} args.getBrowserWindow  - returns Electron.BrowserWindow
 * @param {(evt:{phase:string,sceneIndex?:number,total?:number}) => void} [args.onProgress]
 * @param {boolean} [args.force=false]       - re-render even if mp4 exists
 * @returns {Promise<string>} absolute path to the rendered mp4
 */
export async function renderLessonVideo({ lessonId, getBrowserWindow, onProgress, force = false }) {
  const lesson = loadLesson(lessonId);
  if (!lesson) throw new Error('lesson not found: ' + lessonId);
  const dir = path.join(LESSONS_ROOT, lessonId);
  const outFile = path.join(dir, 'lesson.mp4');
  if (fs.existsSync(outFile) && !force && fs.statSync(outFile).size > 0) return outFile;

  const BW = getBrowserWindow && getBrowserWindow();
  if (!BW) throw new Error('Electron BrowserWindow not available (video render requires Electron)');

  const W = lesson.canvas?.width || 1280;
  const H = lesson.canvas?.height || 720;
  const workDir = path.join(dir, 'video-tmp');
  if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  // Build the widget HTML inline; embed the runtime JS as a <script> so the
  // data: URL is fully self-contained (no need for the loopback server).
  const { bundle } = buildLessonWidget({ lessonId, lesson });
  const fullHtml = bundle.html.replace(
    '</body>',
    `<script>${bundle.js.replace(/<\/script>/gi, '<\\/script>')}</script></body>`
  );

  let win;
  try {
    win = new BW({
      width: W, height: H,
      show: false,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: false },
    });
    // setFrameRate is helpful even though we use capturePage, not OSR streaming.
    try { win.webContents.setFrameRate(30); } catch (_) {}

    onProgress?.({ phase: 'loading' });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml));
    // Give KaTeX (CDN) + boot a moment to settle.
    await _sleep(1200);

    const sceneCount = await win.webContents.executeJavaScript('window.__sceneCount && window.__sceneCount()');
    if (!sceneCount || sceneCount < 1) throw new Error('widget did not expose scene count');

    const sceneClips = [];
    for (let i = 0; i < lesson.scenes.length; i++) {
      const scene = lesson.scenes[i];
      onProgress?.({ phase: 'frame', sceneIndex: i, total: lesson.scenes.length });

      const ok = await win.webContents.executeJavaScript(`window.__renderSceneStatic(${i})`);
      if (!ok) throw new Error('static render failed for scene ' + i);
      // Wait for KaTeX render + final layout pass.
      await _sleep(400);

      const img = await win.webContents.capturePage();
      const png = path.join(workDir, `scene${String(i).padStart(2, '0')}.png`);
      fs.writeFileSync(png, img.toPNG());

      const dur = Math.max(0.3, Number(scene.audioDurationSec) || 2);
      const mp3 = scene.audioUrl ? lessonAudioPath(lessonId, path.basename(scene.audioUrl)) : null;
      const clip = path.join(workDir, `scene${String(i).padStart(2, '0')}.mp4`);
      const args = ['-y', '-loop', '1', '-i', png];
      if (mp3 && fs.existsSync(mp3)) {
        args.push('-i', mp3);
      } else {
        // Silent track so every clip has matching streams for concat.
        args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      }
      args.push(
        '-t', String(dur),
        '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:white,setsar=1,fps=30`,
        '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '22',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
        '-shortest',
        clip,
      );
      await _run(FFMPEG_PATH, args);
      sceneClips.push(clip);
    }

    onProgress?.({ phase: 'concat' });
    const listFile = path.join(workDir, 'concat.txt');
    fs.writeFileSync(
      listFile,
      sceneClips.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8',
    );
    const tmpOut = path.join(workDir, 'lesson.mp4');
    await _run(FFMPEG_PATH, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', '-movflags', '+faststart',
      tmpOut,
    ]);
    fs.renameSync(tmpOut, outFile);
    onProgress?.({ phase: 'done' });
    return outFile;
  } finally {
    try { win && win.destroy(); } catch (_) {}
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/** Path on disk for a lesson's mp4 (may not exist yet). */
export function lessonVideoPath(lessonId) {
  if (!/^L_[a-z0-9]{8,32}$/i.test(lessonId)) return null;
  return path.join(LESSONS_ROOT, lessonId, 'lesson.mp4');
}

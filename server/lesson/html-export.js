// Lesson → portable HTML+audio bundle (zip).
//
// Produces a single self-contained zip suitable for uploading to any static
// host (S3, Netlify, GitHub Pages, a school LMS). Layout inside the zip:
//
//   lesson-<id>/
//     index.html        ← whole widget runtime inlined; audio URLs rewritten
//                          to relative ./audio/sceneNN-<hash>.mp3
//     audio/sceneNN-<hash>.mp3  (one per scene)
//     lesson.json       ← the synthesized DSL, for reference
//
// We use macOS's bundled /usr/bin/zip (no npm dep). The widget HTML is the
// same one users see live, just with two changes:
//   1. audio URLs rewritten from /api/lesson-audio/<id>/<file> to ./audio/<file>
//   2. the runtime JS inlined as a <script> tag so no loopback server is needed
//   3. the MP4 download link removed (the static bundle has no renderer)

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

import { loadLesson, lessonAudioPath } from './generator.js';
import { buildLessonWidget } from './widget-bundle.js';

const LESSONS_ROOT = path.join(os.homedir(), '.fauna', 'lessons');

function _run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} failed (${code}): ${stderr.slice(-500)}`)));
  });
}

/**
 * Build (or reuse) a portable HTML zip for a lesson.
 * @returns {Promise<string>} absolute path to the .zip
 */
export async function buildLessonHtmlBundle({ lessonId, force = false }) {
  if (!/^L_[a-z0-9]{8,32}$/i.test(lessonId)) throw new Error('bad lesson id');
  const lesson = loadLesson(lessonId);
  if (!lesson) throw new Error('lesson not found: ' + lessonId);
  const dir = path.join(LESSONS_ROOT, lessonId);
  const zipFile = path.join(dir, 'lesson-bundle.zip');
  if (fs.existsSync(zipFile) && !force && fs.statSync(zipFile).size > 0) return zipFile;

  // Rewrite audio URLs to relative paths inside the bundle.
  const portable = {
    ...lesson,
    scenes: lesson.scenes.map(s => ({
      ...s,
      audioUrl: s.audioUrl
        ? './audio/' + s.audioUrl.replace(/^.*\//, '')
        : null,
    })),
  };

  // Build widget HTML against the portable lesson + inline the runtime JS so
  // the file works offline / on any host.
  const { bundle } = buildLessonWidget({ lessonId, lesson: portable });
  let html = bundle.html;
  // Inline the runtime script.
  html = html.replace(
    '</body>',
    `<script>${bundle.js.replace(/<\/script>/gi, '<\\/script>')}</script></body>`,
  );
  // Strip the MP4 download button (no renderer in static hosting).
  html = html.replace(/<a id="download-mp4"[^>]*>[^<]*<\/a>/, '');

  // Stage everything into a temp directory we can zip atomically.
  const stageRoot = path.join(dir, 'html-tmp');
  if (fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true });
  const folderName = `lesson-${lessonId}`;
  const stageDir = path.join(stageRoot, folderName);
  fs.mkdirSync(path.join(stageDir, 'audio'), { recursive: true });

  fs.writeFileSync(path.join(stageDir, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(stageDir, 'lesson.json'), JSON.stringify(portable, null, 2), 'utf8');

  // Copy each scene's mp3 into the bundle.
  for (const scene of lesson.scenes) {
    if (!scene.audioUrl) continue;
    const filename = scene.audioUrl.replace(/^.*\//, '');
    const src = lessonAudioPath(lessonId, filename);
    if (!src || !fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(stageDir, 'audio', filename));
  }

  // Zip with macOS-bundled /usr/bin/zip: cd into stageRoot so the archive
  // contains lesson-<id>/... (not absolute paths).
  const tmpZip = path.join(stageRoot, 'bundle.zip');
  await _run('/usr/bin/zip', ['-rq', tmpZip, folderName], { cwd: stageRoot });
  fs.renameSync(tmpZip, zipFile);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  return zipFile;
}

export function lessonHtmlBundlePath(lessonId) {
  if (!/^L_[a-z0-9]{8,32}$/i.test(lessonId)) return null;
  return path.join(LESSONS_ROOT, lessonId, 'lesson-bundle.zip');
}

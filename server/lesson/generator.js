// Lesson generator — produces a structured "whiteboard lesson" DSL document
// + per-scene Kokoro audio, suitable for live in-chat playback (not video).
//
// The runtime widget (server/lesson/widget-bundle.js + public lesson runtime)
// uses the per-scene audio as a master clock and runs declarative animation
// actions against it. Sample-accurate Kokoro cues mean we can time every
// reveal/highlight/plot to the spoken word without any drift.
//
// Pipeline:
//   1. LLM call: topic + duration → JSON DSL (title, voice, canvas, props,
//      scenes[{id, narration, actions[]}]).
//   2. Validate DSL.
//   3. For each scene: Kokoro synth → mp3 written under
//      ~/.fauna/lessons/<id>/audio/sceneNN.mp3 (content-hash cached so
//      re-running the same lesson is instant).
//   4. Return a { lesson, audioBase } payload the widget consumes.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import {
  synthesizeKokoroSegments,
  parseVoiceSpec,
  DEFAULT_KOKORO_VOICE,
} from '../video/kokoro.js';
import { FFMPEG_PATH } from '../video/ffmpeg-path.js';
import { splitIntoCues } from '../video/narration.js';
import { extractSourceText } from './source-extract.js';

const LESSONS_ROOT = path.join(os.homedir(), '.fauna', 'lessons');

function _run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr?.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exit ${code}: ${stderr.slice(-300)}`)));
  });
}

// ── DSL prop kinds the runtime supports ─────────────────────────────────
// Adding a new pack = adding entries here + a handler in the runtime.
export const LESSON_KINDS = {
  // Universal
  text:    { props: ['content', 'fontSize', 'color', 'font', 'w', 'align', 'weight'], notes: 'Plain text label that wraps. content (string), fontSize (default 28), color (CSS), font ("sans"|"serif"|"hand"), w (max width in px BEFORE wrapping — REQUIRED for any text > ~40 chars), align ("left"|"center"|"right"), weight (e.g. 600).' },
  latex:   { props: ['tex', 'display'],                                notes: 'LaTeX expression. tex (string, e.g. "\\\\int 2x dx"), display (true=block,false=inline).' },
  shape:   { props: ['shape', 'w', 'h', 'fill', 'stroke', 'r'],        notes: 'shape: "rect"|"circle"|"ellipse"|"line"|"triangle". w/h or r in pixels; fill/stroke CSS.' },
  arrow:   { props: ['from', 'to', 'label', 'curve', 'color'],         notes: 'Arrow between two anchor points or two prop ids. from/to: {x,y} OR "<propId>" (uses prop center). label optional. curve (number, 0=straight). Triggered by {do:"draw"} or {do:"connect"}.' },
  image:   { props: ['src', 'w', 'h', 'alt'],                          notes: 'Static image (URL or data URI).' },
  svg:     { props: ['markup', 'w', 'h'],                              notes: 'Inline SVG markup (scripts stripped). markup must start with <svg>. Use for hand-drawn icons or pre-rendered diagrams.' },
  code:    { props: ['code', 'language'],                              notes: 'Monospace code block. Animated reveal via {do:"type"}.' },
  // Math pack
  plot:    { props: ['fn', 'xRange', 'yRange', 'color', 'gridStep'],   notes: '2D function plot. fn (JS expression of x, e.g. "Math.cos(x*x)*2*x"), xRange [min,max], yRange optional (auto-fit), color CSS, gridStep (auto if omitted). Use {do:"plot"} to reveal stroke-by-stroke.' },
  numberline:{ props: ['min', 'max', 'tick'],                          notes: 'Horizontal number line from min to max with tick spacing.' },
  // Chemistry pack (basic 2D; 3D defer)
  molecule:{ props: ['atoms', 'bonds'],                                notes: '2D structural formula. atoms: [{el,x,y}], bonds: [{a,b,order}]. (3D ball-stick variant deferred to next pack.)' },
  // Circuit pack — re-uses the existing renderCircuit() from lib/.
  circuit: { props: ['doc'],                                           notes: 'Circuit schematic. doc is the same DSL accepted by fauna_render_circuit.' },
};

// ── DSL validator ──────────────────────────────────────────────────────
export const ACTION_DOS = new Set([
  'write', 'draw', 'fade-in', 'fade-out', 'highlight',
  'connect', 'plot', 'type', 'move', 'rotate', 'scale',
  'circle', 'underline', 'arrow', 'erase', 'flash',
]);

export function validateLesson(doc) {
  const errors = [];
  const warnings = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['document is not an object'], warnings };
  if (!doc.title || typeof doc.title !== 'string') errors.push('title is required');
  if (!Array.isArray(doc.scenes) || !doc.scenes.length) errors.push('scenes[] must be a non-empty array');
  if (doc.scenes) {
    const sceneIds = new Set();
    for (let i = 0; i < doc.scenes.length; i++) {
      const s = doc.scenes[i];
      if (!s || typeof s !== 'object') { errors.push(`scenes[${i}] is not an object`); continue; }
      if (!s.id || typeof s.id !== 'string') errors.push(`scenes[${i}].id required`);
      if (s.id && sceneIds.has(s.id)) errors.push(`duplicate scene id "${s.id}"`);
      if (s.id) sceneIds.add(s.id);
      if (!s.narration || !String(s.narration).trim()) errors.push(`scenes[${i}].narration required`);
      if (s.actions && !Array.isArray(s.actions)) errors.push(`scenes[${i}].actions must be an array`);
      if (Array.isArray(s.actions)) {
        for (let j = 0; j < s.actions.length; j++) {
          const a = s.actions[j];
          if (!a || typeof a !== 'object') { errors.push(`scenes[${i}].actions[${j}] not an object`); continue; }
          if (!ACTION_DOS.has(a.do)) warnings.push(`unknown action.do "${a.do}" in scene[${i}].actions[${j}] — will be ignored at runtime`);
          if (a.prop && (!doc.props || !doc.props[a.prop])) errors.push(`action references unknown prop "${a.prop}" in scene[${i}]`);
        }
      }
    }
  }
  if (doc.props && typeof doc.props === 'object') {
    for (const [pid, p] of Object.entries(doc.props)) {
      if (!p || typeof p !== 'object') { errors.push(`prop "${pid}" is not an object`); continue; }
      if (!p.kind || !LESSON_KINDS[p.kind]) errors.push(`prop "${pid}" has unknown kind "${p.kind}"`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ── LLM prompt for DSL generation ───────────────────────────────────────
const SCRIPT_SYSTEM = `You are a master tutor designing an interactive whiteboard lesson. You output ONLY a single JSON object — the Lesson DSL — and nothing else. No prose, no markdown, no code fences around the JSON. The very first character must be "{" and the very last "}".`;

function _kindsCatalog() {
  const lines = [];
  for (const [k, v] of Object.entries(LESSON_KINDS)) {
    lines.push(`- "${k}": ${v.notes}`);
  }
  return lines.join('\n');
}

function _scriptUserPrompt({ topic, durationMin, voice, sourceText, sourceKind }) {
  const sceneCount = Math.max(3, Math.min(20, Math.round(durationMin * 2.5))); // ~24s avg per scene
  const sourceBlock = sourceText ? `

## Source material (${sourceKind || 'document'}) — GROUND THE LESSON IN THIS

The user supplied this source. Treat it as canonical: cover its main points in order, preserve key terminology and numbers, and do NOT invent facts that contradict it. Where the source has slides, you may map roughly one scene per slide (combine trivial slides, split dense ones).

<<<SOURCE_BEGIN>>>
${sourceText}
<<<SOURCE_END>>>
` : '';
  return `# Lesson DSL

Design a whiteboard lesson on this topic:

  ${topic}
${sourceBlock}
Target spoken duration: ~${durationMin} minute(s).
Aim for ~${sceneCount} scenes (each 15–40 seconds of narration). Each scene is a single conceptual beat with its own narration and a small set of animated actions.

## Output schema (return ONLY this JSON, nothing else)

{
  "title": "<short title, ≤ 60 chars>",
  "subject": "<one of: math|chemistry|physics|biology|cs|general>",
  "voice": "${voice || 'kokoro:af_bella'}",
  "canvas": { "width": 1280, "height": 720, "theme": "whiteboard" },
  "props": {
    "<propId>": { "kind": "<one of the kinds below>", ... kind-specific fields ... },
    ...
  },
  "scenes": [
    {
      "id": "<short slug, unique>",
      "narration": "<what the tutor SAYS in this scene — natural conversational sentences, one per line. NO stage directions, NO 'as you can see', NO 'here we have'. Speak directly to the learner. 30–120 words typical.>",
      "actions": [
        { "at": "start" | "<seconds float relative to scene audio start>" | "end",
          "do": "<one of: write, draw, fade-in, fade-out, highlight, connect, plot, type, move, rotate, scale, circle, underline, arrow, erase, flash>",
          "prop": "<propId>",
          "x": <number, optional, canvas px>, "y": <number, optional>,
          "w": <number, optional>, "h": <number, optional>,
          "color": "<CSS color, optional>",
          "durMs": <number, optional animation duration>,
          "range": [<startCharIdx>, <endCharIdx>]   // for highlight/underline on text/latex props
        },
        ...
      ]
    },
    ...
  ]
}

## Available prop kinds

${_kindsCatalog()}

## Action semantics

- "at" timestamps are seconds INTO the scene's audio. Use "start" to mean 0, "end" to mean (audioDuration). Floats like 1.5 are allowed. NEVER negative.
- "write" hand-draws the prop's strokes (good for text/latex/svg with paths).
- "draw" fades + slides the prop in (good for shapes, images).
- "fade-in"/"fade-out" simple opacity.
- "highlight" draws a translucent rect behind a text/latex prop (use "range" for char-range, otherwise whole prop).
- "underline"/"circle" annotation overlay.
- "connect" reveals an arrow whose endpoints reference other props.
- "plot" reveals a 2D function plot stroke-by-stroke.
- "type" types a code prop char-by-char.
- "move"/"rotate"/"scale" tween the prop (durMs default 600).
- "erase" removes a prop from the canvas.
- "flash" pulses a prop for emphasis.

## Hard rules

1. JSON must be valid. NO trailing commas. NO comments. Property names quoted.
2. Every action.prop MUST be defined in the top-level "props" object.
3. Narration is the actual spoken transcript. The tutor does not say "let's draw X" — they just teach, and the actions illustrate.
4. Keep prop ids short and snake_case (e.g. "eq_main", "graph1", "u_label").
5. LaTeX in "latex" props must use double-backslashes inside JSON strings: "\\\\int", "\\\\frac{a}{b}". Use $-free TeX (no $ delimiters).
6. Coordinates are in the 1280×720 canvas. Leave a 60px margin. Plan layout per-scene: pick distinct (x,y) for every prop so NOTHING overlaps. Title at top (y≈60). Diagrams in the middle band (y 180–520). Labels/captions below their referent. For "text" props longer than ~40 chars, ALWAYS set a "w" (width in px) so it wraps — e.g. {kind:"text", content:"...", w: 1100}. Default font size for body text is 24–28px; titles 36–48px. Never let text run past x+w > 1220.
7. **Each scene starts on a FRESH, EMPTY canvas by default.** Re-introduce the title/header as its own prop on each scene if you want it visible. If a scene needs to build on the previous scene's drawing (cumulative), add \`"keep": true\` at the scene level — but use this sparingly. Default behavior (fresh canvas) is almost always what you want.
8. Aim for 3–7 actions per scene. More than 10 is too busy.

Generate the lesson now.`;
}

export async function generateLessonDSL({ topic, durationMin = 5, voice, client, model = 'claude-sonnet-4.6', sourceText, sourceKind }) {
  if (!topic || !String(topic).trim()) throw new Error('topic is required');
  if (!client) throw new Error('client is required');
  const user = _scriptUserPrompt({ topic, durationMin, voice, sourceText, sourceKind });
  const r = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SCRIPT_SYSTEM },
      { role: 'user',   content: user },
    ],
    temperature: 0.7,
    max_tokens: 8192,
  });
  const raw = (r?.choices?.[0]?.message?.content || '').trim();
  // Strip ``` fences if the model defied instructions.
  let body = raw;
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  // Extract first {...} block defensively.
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('LLM returned no JSON object');
  body = body.slice(first, last + 1);
  let dsl;
  try {
    dsl = JSON.parse(body);
  } catch (e) {
    throw new Error('LLM returned invalid JSON: ' + e.message);
  }
  // Ensure voice is set.
  if (!dsl.voice) dsl.voice = voice || 'kokoro:af_bella';
  if (!dsl.canvas) dsl.canvas = { width: 1280, height: 720, theme: 'whiteboard' };
  return dsl;
}

// ── Audio synthesis per scene ───────────────────────────────────────────

function _lessonDir(lessonId) {
  return path.join(LESSONS_ROOT, lessonId);
}

function _hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * Synthesize per-scene audio. Returns the lesson with each scene augmented
 * with `audioUrl`, `audioDurationSec`, and `cues` (per-sentence timings).
 *
 * Audio files live at:
 *   ~/.fauna/lessons/<lessonId>/audio/sceneNN-<hash>.mp3
 *
 * Cached by content-hash on (voice, text) so re-runs are instant.
 */
export async function synthesizeLessonAudio({ lesson, lessonId, onProgress }) {
  if (!lesson?.scenes?.length) throw new Error('lesson has no scenes');
  const dir = path.join(_lessonDir(lessonId), 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const spec = parseVoiceSpec(lesson.voice);
  const voiceId = spec.engine === 'kokoro' && spec.voiceId ? spec.voiceId : DEFAULT_KOKORO_VOICE;

  const out = { ...lesson, scenes: [] };
  for (let i = 0; i < lesson.scenes.length; i++) {
    const scene = lesson.scenes[i];
    const text = String(scene.narration || '').trim();
    if (!text) { out.scenes.push({ ...scene, audioUrl: null, audioDurationSec: 0, cues: [] }); continue; }
    const key = _hash(voiceId + '|' + text);
    const mp3 = path.join(dir, `scene${String(i).padStart(2, '0')}-${key}.mp3`);
    const cuesFile = mp3 + '.cues.json';

    let cues, durationSec;
    if (fs.existsSync(mp3) && fs.existsSync(cuesFile) && fs.statSync(mp3).size > 0) {
      const j = JSON.parse(fs.readFileSync(cuesFile, 'utf8'));
      cues = j.cues; durationSec = j.durationSec;
    } else {
      if (onProgress) onProgress({ phase: 'audio', sceneIndex: i, total: lesson.scenes.length });
      const segDir = mp3 + '.segs';
      fs.mkdirSync(segDir, { recursive: true });
      try {
        const segments = splitIntoCues(text);
        const segs = await synthesizeKokoroSegments({
          segments: segments.length ? segments : [text],
          outDir: segDir, voice: voiceId,
        });
        const listFile = path.join(segDir, 'concat.txt');
        fs.writeFileSync(listFile, segs.map(s => `file '${s.wavFile.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
        await _run(FFMPEG_PATH, [
          '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
          '-codec:a', 'libmp3lame', '-b:a', '160k', '-ar', '24000', mp3,
        ]);
        // Build cue timeline from real per-segment durations.
        cues = [];
        let cursor = 0;
        for (let k = 0; k < segs.length; k++) {
          cues.push({ index: k, start: cursor, end: cursor + segs[k].durationSec, text: segs[k].text });
          cursor += segs[k].durationSec;
        }
        durationSec = cursor;
        fs.writeFileSync(cuesFile, JSON.stringify({ durationSec, cues }), 'utf8');
      } finally {
        try { fs.rmSync(segDir, { recursive: true, force: true }); } catch (_) {}
      }
    }
    out.scenes.push({
      ...scene,
      audioUrl: `/api/lesson-audio/${lessonId}/${path.basename(mp3)}`,
      audioDurationSec: durationSec,
      cues,
    });
  }
  return out;
}

/**
 * Full pipeline: LLM → DSL → validate → audio. Returns the synthesized
 * lesson and the id used for filesystem storage.
 */
export async function createLesson({ topic, durationMin = 5, voice, client, model, onProgress, source }) {
  const id = 'L_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  let sourceText, sourceKind;
  if (source) {
    if (onProgress) onProgress({ phase: 'source', source });
    const ext = await extractSourceText(source);
    if (ext?.ok) {
      sourceText = ext.text;
      sourceKind = ext.kind;
      if (!topic || !String(topic).trim()) topic = `Teach the contents of this ${ext.kind} source`;
    }
  }
  if (onProgress) onProgress({ phase: 'script' });
  const dsl = await generateLessonDSL({ topic, durationMin, voice, client, model, sourceText, sourceKind });
  const v = validateLesson(dsl);
  if (!v.ok) throw new Error('lesson DSL invalid: ' + v.errors.join('; '));
  if (onProgress) onProgress({ phase: 'audio-start', sceneCount: dsl.scenes.length });
  fs.mkdirSync(_lessonDir(id), { recursive: true });
  fs.writeFileSync(path.join(_lessonDir(id), 'lesson.draft.json'), JSON.stringify(dsl, null, 2), 'utf8');
  const lesson = await synthesizeLessonAudio({ lesson: dsl, lessonId: id, onProgress });
  fs.writeFileSync(path.join(_lessonDir(id), 'lesson.json'), JSON.stringify(lesson, null, 2), 'utf8');
  return { id, lesson, warnings: v.warnings };
}

export function loadLesson(lessonId) {
  const f = path.join(_lessonDir(lessonId), 'lesson.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

export function lessonAudioPath(lessonId, fileName) {
  // Only allow our own filename pattern to prevent traversal.
  if (!/^scene\d{2}-[0-9a-f]{8,32}\.mp3$/.test(fileName)) return null;
  return path.join(_lessonDir(lessonId), 'audio', fileName);
}

// Exposed for tests + tool catalog.
export const _internals = { _scriptUserPrompt, ACTION_DOS, LESSONS_ROOT };

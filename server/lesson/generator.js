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
import { withTimeout } from '../lib/async-utils.js';

const LESSONS_ROOT = path.join(os.homedir(), '.fauna', 'lessons');

// Hard cap on a single lesson-script LLM call so a stalled completion fails
// fast instead of hanging the tool call for minutes. The DSL is small enough
// that a healthy generation finishes well inside this window.
const LESSON_SCRIPT_TIMEOUT_MS = 120_000;

// Some Copilot-served models (observed with Claude Sonnet on certain prompts)
// return an empty `choices: []` while still consuming the entire output-token
// budget — they produce no visible content at all. Retrying the SAME model
// just burns ~2 min and then the agent retries the whole tool, so on an empty
// completion we fall through to a known-reliable fallback. gpt-4.1 produces
// this kind of structured JSON dependably.
const LESSON_FALLBACK_MODEL = 'gpt-4.1';

// Ordered list of models to try: the requested model first, then the fallback
// (de-duped so we never call the same model twice).
function _modelChain(primary) {
  const chain = [];
  if (primary) chain.push(primary);
  if (LESSON_FALLBACK_MODEL && LESSON_FALLBACK_MODEL !== primary) chain.push(LESSON_FALLBACK_MODEL);
  return chain.length ? chain : [LESSON_FALLBACK_MODEL];
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

// ── DSL prop kinds the runtime supports ─────────────────────────────────
// Adding a new pack = adding entries here + a handler in the runtime.
export const LESSON_KINDS = {
  // Universal
  text:    { props: ['content', 'fontSize', 'color', 'font', 'w', 'align', 'weight', 'slot'], notes: 'Plain text label that wraps. content (string), fontSize (default 28), color (CSS), font ("sans"|"serif"|"hand"), w (max width in px BEFORE wrapping — REQUIRED for any text > ~40 chars), align ("left"|"center"|"right"), weight (e.g. 600). PREFERRED: set `slot` to one of "title" | "body-top" | "body-center" | "body-bottom" | "caption" and OMIT (x,y,w) — the runtime auto-positions the text in the named lane and your scene cannot end up with overlapping captions.' },
  latex:   { props: ['tex', 'display', 'slot'],                        notes: 'LaTeX expression. tex (string, e.g. "\\\\int 2x dx"), display (true=block,false=inline). Supports the same `slot` field as text — use it for centred equations.' },
  shape:   { props: ['shape', 'w', 'h', 'fill', 'stroke', 'r'],        notes: 'shape: "rect"|"circle"|"ellipse"|"line"|"triangle". w/h or r in pixels; fill/stroke CSS.' },
  arrow:   { props: ['from', 'to', 'label', 'curve', 'color'],         notes: 'Arrow between two anchor points or two prop ids. from/to: {x,y} OR "<propId>" (uses prop center). label optional. curve (number, 0=straight). Triggered by {do:"draw"} or {do:"connect"}.' },
  image:   { props: ['src', 'w', 'h', 'alt'],                          notes: 'Static image (URL or data URI).' },
  slide:   { props: ['src', 'w', 'h'],                                 notes: 'Full-canvas slide backdrop (PNG of a source PowerPoint/Keynote slide). USE ONLY when the source material is a deck and the generator has been given pre-rendered slide images. Place at (0,0) sized to the full canvas (w=1280,h=720). One per scene, drawn first so it sits behind any other props. Do NOT add other content props on top in v1 strict-slide mode — narration alone walks through the slide.' },
  svg:     { props: ['markup', 'w', 'h'],                              notes: 'Inline SVG markup (scripts stripped). markup must start with <svg>. Use for hand-drawn icons or pre-rendered diagrams.' },
  code:    { props: ['code', 'language'],                              notes: 'Monospace code block. Animated reveal via {do:"type"}.' },
  // Math pack
  plot:    { props: ['fn', 'xRange', 'yRange', 'color', 'gridStep'],   notes: '2D function plot. fn (JS expression of x, e.g. "Math.cos(x*x)*2*x"), xRange [min,max], yRange optional (auto-fit), color CSS, gridStep (auto if omitted). Use {do:"plot"} to reveal stroke-by-stroke.' },
  numberline:{ props: ['min', 'max', 'tick'],                          notes: 'Horizontal number line from min to max with tick spacing.' },
  // Chemistry pack (basic 2D; 3D defer)
  molecule:{ props: ['atoms', 'bonds'],                                notes: '2D structural formula. atoms: [{el,x,y}], bonds: [{a,b,order}]. (3D ball-stick variant deferred to next pack.)' },
  // Circuit pack — re-uses the existing renderCircuit() from lib/.
  circuit: { props: ['doc'],                                           notes: 'Circuit schematic. doc is the same DSL accepted by fauna_render_circuit.' },
  // Composite — high-level so the LLM doesn't have to place every node by hand.
  flow:    { props: ['nodes', 'direction', 'shape', 'color', 'labelPos', 'showArrows'], notes: 'Sequence / pipeline / lifecycle diagram. nodes: [{label, color?, fill?}]. direction: "horizontal"(default)|"vertical". shape: "circle"(default)|"rect". labelPos: "below"(default)|"inside"|"above". showArrows: true(default) — draws arrows between consecutive nodes. The runtime auto-spaces nodes evenly across the available canvas width/height starting from the prop\'s (x,y) — USE THIS for any "step 1 → step 2 → step 3" / "phase 1 → phase 2" / "process flow" / "lifecycle" diagram instead of placing individual shape+text+arrow props.' },
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
      if (p.slot && !VALID_SLOTS.has(p.slot)) errors.push(`prop "${pid}" has unknown slot "${p.slot}" (valid: ${[...VALID_SLOTS].join(', ')})`);
    }
  }
  // Per-scene overlap check: for every scene, estimate each prop's bounding
  // box from its action coords + kind-specific size hints. Any two props
  // whose axis-aligned bboxes overlap by >50% of the smaller area get
  // flagged as a layout error (the repair pass then re-asks the LLM with
  // the specific collision). Catches the "two captions at the same y"
  // failure mode that the runtime can't recover from at render time.
  if (Array.isArray(doc.scenes)) {
    for (let si = 0; si < doc.scenes.length; si++) {
      const scene = doc.scenes[si];
      if (!Array.isArray(scene.actions)) continue;
      const boxes = [];
      for (const a of scene.actions) {
        if (!a || !a.prop) continue;
        const prop = doc.props?.[a.prop];
        if (!prop) continue;
        // Slotted props won't collide with each other in the same lane
        // unless the SAME lane is used twice — handled below.
        const box = _estimatePropBox(prop, a, doc.canvas);
        if (!box) continue;
        boxes.push({ id: a.prop, slot: prop.slot || null, box });
      }
      // (a) two props slotted into the same lane in the same scene
      const slotted = boxes.filter(b => b.slot);
      const slotsUsed = new Map();
      for (const b of slotted) {
        if (slotsUsed.has(b.slot) && slotsUsed.get(b.slot) !== b.id) {
          errors.push(`scene[${si}]: props "${slotsUsed.get(b.slot)}" and "${b.id}" both use slot "${b.slot}" — give one a different slot or move one to a free coordinate`);
        }
        slotsUsed.set(b.slot, b.id);
      }
      // (b) bbox overlap >50% of smaller
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          if (boxes[i].id === boxes[j].id) continue;
          const ov = _bboxOverlapRatio(boxes[i].box, boxes[j].box);
          if (ov > 0.5) {
            errors.push(`scene[${si}]: props "${boxes[i].id}" and "${boxes[j].id}" overlap (~${Math.round(ov * 100)}% of smaller bbox) — give them distinct (x,y) or use a "slot"`);
          }
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Valid slot names mirrored from server/lesson/widget-bundle.js SLOTS map.
// Keep in sync — the runtime treats any unknown slot as free placement.
const VALID_SLOTS = new Set(['title', 'body-top', 'body-center', 'body-bottom', 'caption']);

// Standardized slot lanes used by validateLesson for bbox estimation. Match
// the runtime SLOTS exactly (canvas-relative; CANVAS_W=1280, CANVAS_H=720).
const SLOT_LANES = {
  'title':       { y: 60,  h: 80 },
  'body-top':    { y: 180, h: 120 },
  'body-center': { y: 320, h: 120 },
  'body-bottom': { y: 500, h: 120 },
  'caption':     { y: 600, h: 80 },
};

function _estimatePropBox(prop, action, canvas) {
  const W = canvas?.width || 1280;
  const H = canvas?.height || 720;
  // Slotted: lane defines y/h, centred horizontally with default w.
  if (prop.slot && SLOT_LANES[prop.slot]) {
    const lane = SLOT_LANES[prop.slot];
    const w = Math.min(prop.w || (W - 120), W - 120);
    return { x: Math.round((W - w) / 2), y: lane.y, w, h: lane.h };
  }
  const x = Number.isFinite(action.x) ? action.x : (Number.isFinite(prop.x) ? prop.x : 60);
  const y = Number.isFinite(action.y) ? action.y : (Number.isFinite(prop.y) ? prop.y : 100);
  let w, h;
  switch (prop.kind) {
    case 'text':       w = prop.w || Math.min(800, W - x - 60); h = Math.max(40, Math.min(400, Math.ceil(String(prop.content || '').length / Math.max(20, (w / ((prop.fontSize || 28) * 0.55)))) * (prop.fontSize || 28) * 1.3)); break;
    case 'latex':      w = prop.w || 400; h = prop.h || 80;  break;
    case 'shape':      w = prop.w || (prop.r ? prop.r * 2 : 80); h = prop.h || (prop.r ? prop.r * 2 : 80); break;
    case 'image':
    case 'slide':      w = prop.w || (prop.kind === 'slide' ? W : 240); h = prop.h || (prop.kind === 'slide' ? H : 180); break;
    case 'code':       w = 700; h = 300; break;
    case 'plot':       w = action.w || 480; h = action.h || 280; break;
    case 'numberline': w = action.w || 600; h = 80; break;
    case 'flow':       w = action.w || prop.w || (W - x - 60); h = action.h || prop.h || 240; break;
    case 'molecule':   w = 320; h = 320; break;
    case 'arrow':      return null;   // arrows don't claim layout space
    case 'svg':        w = prop.w || 200; h = prop.h || 200; break;
    case 'circuit':    w = 480; h = 320; break;
    default:           w = 100; h = 40;
  }
  return { x, y, w, h };
}

function _bboxOverlapRatio(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const smaller = Math.min(a.w * a.h, b.w * b.h) || 1;
  return inter / smaller;
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
  // When source material is a structured deck/document (pptx, docx, pdf, slide-formatted markdown)
  // we force STRICT mode: one scene per slide, narration explains THAT slide's content,
  // no innovation, no reordering, no inventing parallel examples.
  const isSlideSource = !!sourceText && /\b(pptx|powerpoint|slides?|docx|word|pdf)\b/i.test(sourceKind || '');
  const slideCount = isSlideSource ? (sourceText.match(/^#\s*Slide\s+\d+/gmi) || []).length : 0;
  const sourceBlock = sourceText ? (isSlideSource ? `

## Source material (${sourceKind}) — STRICT SLIDE-FOLLOWING MODE

The user uploaded a ${sourceKind}. Your job is to **explain THIS deck**, not invent a new lesson on the same topic. Follow these rules WITHOUT exception:

1. **One scene per slide, in the exact order they appear.** Do NOT merge, split, reorder, skip, or add slides. ${slideCount > 0 ? `The source has ${slideCount} slide(s) → produce exactly ${slideCount} scene(s).` : ''}
2. **Use the slide's own words.** Every heading, bullet, number, label, and term on a slide must appear (verbatim or near-verbatim) as a prop in that scene. If a slide says "Days of Supply = Avg Inventory / Daily COGS", the scene shows that exact equation — not a "better" rewording.
3. **Narration EXPLAINS what is on the slide.** Read/elaborate the bullets in order, define terms the slide introduces, walk through any formula/diagram the slide shows. Do NOT add tangential examples, analogies, or content not implied by the slide.
4. **Layout mirrors the slide.** Title at top, bullets below in slide order, diagrams/equations where the slide places them. Use \`flow\` props for slide-native step diagrams.
5. **Do NOT be "innovative."** No surprise twists, no extra scenes, no recap scene unless the deck itself has one, no quiz unless the deck has one. The lesson is a faithful narrated walkthrough of the provided deck.
6. Override the auto scene count — use the slide count instead. Each scene's narration should be ~20-60s of speech proportional to that slide's density.

<<<SOURCE_BEGIN>>>
${sourceText}
<<<SOURCE_END>>>
` : `

## Source material (${sourceKind || 'document'}) — GROUND THE LESSON IN THIS

The user supplied this source. Treat it as canonical: cover its main points in order, preserve key terminology and numbers, and do NOT invent facts that contradict it. Where the source has slides, you may map roughly one scene per slide (combine trivial slides, split dense ones).

<<<SOURCE_BEGIN>>>
${sourceText}
<<<SOURCE_END>>>
`) : '';
  const sceneTarget = isSlideSource && slideCount > 0
    ? `Produce EXACTLY ${slideCount} scenes — one per slide, in order.`
    : `Aim for ~${sceneCount} scenes (each 15–40 seconds of narration). Each scene is a single conceptual beat with its own narration and a small set of animated actions.`;
  return `# Lesson DSL

Design a whiteboard lesson on this topic:

  ${topic}
${sourceBlock}
Target spoken duration: ~${durationMin} minute(s).
${sceneTarget}

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
6. Coordinates are in the 1280×720 canvas. **Prefer the "slot" field over manual (x,y)** for every text or latex prop — it's the single biggest source of layout bugs. Pick from "title" (top, y≈60), "body-top" (y≈180), "body-center" (~middle), "body-bottom" (y≈500), or "caption" (y≈600). Slotted props are auto-centered and auto-wrapped; you do NOT specify x, y, or w. Reach for explicit (x,y) ONLY for diagrams, plots, shapes, arrows, and flows where you genuinely need a specific position. When you DO use explicit coords: leave a 60px margin, never put two props at the same (x,y), Title at top (y≈60), Diagrams in the middle band (y 180–520), Labels below their referent. For "text" props longer than ~40 chars without a slot, set "w" so it wraps. Default font size for body text is 24–28px; titles 36–48px. Never let text run past x+w > 1220.
7. **Each scene starts on a FRESH, EMPTY canvas by default.** Re-introduce the title/header as its own prop on each scene if you want it visible. If a scene needs to build on the previous scene's drawing (cumulative), add \`"keep": true\` at the scene level — but use this sparingly. Default behavior (fresh canvas) is almost always what you want.
8. Aim for 3–7 actions per scene. More than 10 is too busy.
9. **For ANY sequence / pipeline / lifecycle / process / "step 1 → step 2" diagram, use ONE \`flow\` prop — never hand-place shape+text+arrow props for these.** A flow prop renders all nodes evenly spaced, auto-connects them with arrows, and positions labels correctly. Example:
   \`\`\`
   "props": {
     "lifecycle": { "kind": "flow", "nodes": [
       {"label":"Alpha","color":"#f59e0b"},
       {"label":"Beta","color":"#3b82f6"},
       {"label":"Stable","color":"#22c55e"},
       {"label":"Deprecated","color":"#ef4444"}
     ], "direction":"horizontal", "shape":"circle", "labelPos":"below" }
   },
   "scenes":[{ "id":"lc", "actions":[ {"at":"start","do":"draw","prop":"lifecycle","x":80,"y":260} ] }]
   \`\`\`
   The \`x,y\` is the top-left of the flow's bounding box; you can also pass \`w\` (defaults to canvas width minus margin) and \`h\` (defaults to 240).

Generate the lesson now.`;
}

export async function generateLessonDSL({ topic, durationMin = 5, voice, client, model = 'claude-sonnet-4.6', sourceText, sourceKind, repair }) {
  if (!topic || !String(topic).trim()) throw new Error('topic is required');
  if (!client) throw new Error('client is required');
  let user = _scriptUserPrompt({ topic, durationMin, voice, sourceText, sourceKind });
  // Repair pass: feed the previous attempt's problems back so the model fixes
  // them in place rather than regenerating blind.
  if (repair?.errors?.length) {
    user += '\n\n## Your previous attempt was rejected\nFix every problem below and return a corrected JSON object. Output ONLY the JSON — no prose, no code fences.\n'
      + repair.errors.map(e => '- ' + e).join('\n');
  }
  // Try the requested model, then a reliable fallback. The most common
  // real-world failure is the primary model returning empty `choices`, so the
  // fallback model is what actually rescues the call. Each attempt is bounded
  // by the same timeout so the worst case stays predictable.
  const models = _modelChain(model);
  let raw = '';
  let lastErr;
  for (const m of models) {
    try {
      const r = await withTimeout(client.chat.completions.create({
        model: m,
        messages: [
          { role: 'system', content: SCRIPT_SYSTEM },
          { role: 'user',   content: user },
        ],
        temperature: 0.7,
        max_tokens: 8192,
      }), LESSON_SCRIPT_TIMEOUT_MS, 'lesson script generation');
      raw = (r?.choices?.[0]?.message?.content || '').trim();
      if (raw) break;
      const noChoices = !(r?.choices?.length);
      console.warn('[lesson] empty DSL from model=' + m + (noChoices ? ' (no choices returned)' : '') + '; trying next model if any');
      lastErr = new Error('LLM returned empty response (model=' + m + ')');
    } catch (e) {
      lastErr = e;
      console.warn('[lesson] DSL generation error from model=' + m + ': ' + (e?.message || e) + '; trying next model if any');
    }
  }
  if (!raw) throw new Error('Lesson script generation failed (tried ' + models.join(', ') + '): ' + (lastErr?.message || lastErr));
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

// ── Slide-deck strict mode: deterministic DSL assembly ─────────────────
// When the source is a PowerPoint/Keynote/PDF deck and we've successfully
// rasterized the slides to PNGs, we DON'T ask the LLM to invent a layout.
// Instead we generate narration-only and mechanically build a DSL where
// each scene shows the original slide image as a full-canvas backdrop.
// This guarantees pixel-perfect deck fidelity — no overlays, no re-rendered
// shapes, no hallucinated URLs.

const SLIDE_NARRATION_SYSTEM = `You are a master tutor narrating a slide deck. The user uploaded a deck and wants you to walk through it slide by slide. For EACH slide, produce a natural spoken explanation of what is on that slide — read/elaborate the bullets in order, define terms, walk through any formula or diagram. Do NOT add tangential examples. Do NOT invent content not on the slide. You output ONLY JSON.`;

function _slideNarrationPrompt({ topic, slideTexts, voice }) {
  const slides = slideTexts.map((t, i) => `--- SLIDE ${i + 1} ---\n${t || '(empty / image-only slide)'}`).join('\n\n');
  return `Topic / intent the user provided:\n  ${topic || '(none — just walk through the deck)'}\n\nThere are ${slideTexts.length} slides. Produce a narration for each one.\n\nRules:\n- Output ONLY a single JSON object — no prose, no markdown, no code fences.\n- Each narration is the actual spoken transcript: 30–120 words, conversational, second-person ("you can see..." is fine here because the learner is literally looking at the slide).\n- Stick to the slide's own content. If a slide is sparse, keep the narration short.\n- Do NOT say "next slide" or "as shown above" — the visual transition is handled.\n- First slide: brief intro / orient the learner. Last slide: brief wrap-up only if the slide itself is a summary.\n\nSchema:\n\n{\n  "title": "<short title for the lesson, ≤ 60 chars>",\n  "subject": "<one of: math|chemistry|physics|biology|cs|general>",\n  "voice": "${voice || 'kokoro:af_bella'}",\n  "narrations": [\n    "<narration for slide 1>",\n    "<narration for slide 2>",\n    ...\n  ]\n}\n\nThe narrations array MUST have exactly ${slideTexts.length} entries.\n\n## Slides\n\n${slides}\n\nReturn the JSON now.`;
}

/** LLM call: generate one narration per slide (narration-only, no layout). */
export async function generateSlideNarrations({ topic, slideTexts, voice, client, model = 'claude-sonnet-4.6' }) {
  if (!client) throw new Error('client is required');
  if (!Array.isArray(slideTexts) || !slideTexts.length) throw new Error('slideTexts required');
  const user = _slideNarrationPrompt({ topic, slideTexts, voice });
  // Same fallback strategy as generateLessonDSL: if the primary model returns
  // an empty body, try the reliable fallback before giving up.
  const models = _modelChain(model);
  let raw = '';
  let lastErr;
  for (const m of models) {
    try {
      const r = await withTimeout(client.chat.completions.create({
        model: m,
        messages: [
          { role: 'system', content: SLIDE_NARRATION_SYSTEM },
          { role: 'user',   content: user },
        ],
        temperature: 0.5,
        max_tokens: 8192,
      }), LESSON_SCRIPT_TIMEOUT_MS, 'lesson slide narrations');
      raw = (r?.choices?.[0]?.message?.content || '').trim();
      if (raw) break;
      const noChoices = !(r?.choices?.length);
      console.warn('[lesson] empty slide narrations from model=' + m + (noChoices ? ' (no choices returned)' : '') + '; trying next model if any');
      lastErr = new Error('LLM returned empty response (model=' + m + ')');
    } catch (e) {
      lastErr = e;
      console.warn('[lesson] slide narrations error from model=' + m + ': ' + (e?.message || e) + '; trying next model if any');
    }
  }
  if (!raw) throw new Error('Slide narration generation failed (tried ' + models.join(', ') + '): ' + (lastErr?.message || lastErr));
  if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('LLM returned no JSON for slide narrations');
  let parsed;
  try { parsed = JSON.parse(raw.slice(first, last + 1)); }
  catch (e) { throw new Error('slide narrations JSON parse failed: ' + e.message); }
  if (!Array.isArray(parsed.narrations)) throw new Error('narrations must be an array');
  // Pad or trim to match slide count.
  while (parsed.narrations.length < slideTexts.length) parsed.narrations.push('');
  if (parsed.narrations.length > slideTexts.length) parsed.narrations = parsed.narrations.slice(0, slideTexts.length);
  return {
    title: parsed.title || 'Slide deck walkthrough',
    subject: parsed.subject || 'general',
    voice: parsed.voice || voice || 'kokoro:af_bella',
    narrations: parsed.narrations.map(n => String(n || '').trim()),
  };
}

/**
 * Mechanically assemble a Lesson DSL from slide images + narrations.
 * One scene per slide. Each scene has exactly one `slide` prop drawn
 * full-canvas at scene start. No overlays in v1.
 *
 * @param {object} opts
 * @param {string} opts.lessonId
 * @param {Array<{index:number, slideUrl:string}>} opts.slides   Per-slide image URLs as served by /api/lesson-slide.
 * @param {string[]} opts.narrations                            Per-slide narration text.
 * @param {string} opts.title
 * @param {string} opts.subject
 * @param {string} opts.voice
 */
export function assembleSlideLessonDSL({ slides, narrations, title, subject, voice }) {
  if (!Array.isArray(slides) || !slides.length) throw new Error('slides required');
  const props = {};
  const scenes = [];
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const propId = 'slide_' + String(i + 1).padStart(3, '0');
    props[propId] = { kind: 'slide', src: s.slideUrl, w: 1280, h: 720 };
    scenes.push({
      id: 'scene_' + String(i + 1).padStart(3, '0'),
      narration: narrations[i] || `Slide ${i + 1}.`,
      actions: [
        { at: 'start', do: 'draw', prop: propId, x: 0, y: 0 },
      ],
    });
  }
  return {
    title: title || 'Slide deck walkthrough',
    subject: subject || 'general',
    voice: voice || 'kokoro:af_bella',
    canvas: { width: 1280, height: 720, theme: 'whiteboard' },
    props,
    scenes,
  };
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
export async function createLesson({ topic, durationMin = 5, voice, client, model, onProgress, source, userDataDir }) {
  const id = 'L_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  let sourceText, sourceKind, slideImages, rasterError;
  if (source) {
    if (onProgress) onProgress({ phase: 'source', source });
    const ext = await extractSourceText(source, {
      autoInstall: true,
      userDataDir,
      onProgress,
    });
    if (ext?.ok) {
      sourceText = ext.text;
      sourceKind = ext.kind;
      slideImages = ext.slideImages || null;
      rasterError = ext.rasterError || null;
      if (!topic || !String(topic).trim()) topic = `Teach the contents of this ${ext.kind} source`;
    }
  }

  // If the user gave us a deck but rasterization failed (typically because
  // LibreOffice / soffice isn't installed), fail loudly instead of silently
  // falling back to a generic invented whiteboard. The model can then ask the
  // user to install LibreOffice and retry, or proceed without `source` for a
  // generic whiteboard lesson.
  if (source && sourceKind && ['pptx','ppt','key','odp'].includes(String(sourceKind).toLowerCase()) && !slideImages?.length) {
    throw new Error(
      'Slide-fidelity mode unavailable for this deck: ' +
      (rasterError || 'rasterization produced no images') +
      '. Tell the user to install LibreOffice (`brew install --cask libreoffice`) and retry. Do NOT silently fall back to a generic whiteboard — the user explicitly shared this deck and expects it to be used verbatim.'
    );
  }

  let dsl;
  // ── STRICT SLIDE MODE ──
  // If the source produced rasterized slide images, build a deterministic
  // one-scene-per-slide DSL with the original slide as backdrop. This
  // guarantees pixel-perfect deck fidelity.
  if (slideImages && slideImages.length) {
    if (onProgress) onProgress({ phase: 'slides-copy', slideCount: slideImages.length });
    fs.mkdirSync(path.join(_lessonDir(id), 'slides'), { recursive: true });
    const slidesForDsl = [];
    for (let i = 0; i < slideImages.length; i++) {
      const src = slideImages[i];
      const filename = 'slide-' + String(i + 1).padStart(3, '0') + '.png';
      const dest = path.join(_lessonDir(id), 'slides', filename);
      try { fs.copyFileSync(src, dest); }
      catch (e) { throw new Error('failed to copy slide ' + (i + 1) + ': ' + e.message); }
      slidesForDsl.push({ index: i + 1, slideUrl: '/api/lesson-slide/' + id + '/' + filename });
    }
    // Split extracted text back into per-slide chunks for the narrator.
    // Source-extract emits "# Slide N\n<text>" blocks; split on that.
    const perSlide = _splitSourceBySlide(sourceText, slideImages.length);
    if (onProgress) onProgress({ phase: 'script', mode: 'slide-narration' });
    const narr = await generateSlideNarrations({ topic, slideTexts: perSlide, voice, client, model });
    dsl = assembleSlideLessonDSL({
      slides: slidesForDsl, narrations: narr.narrations,
      title: narr.title, subject: narr.subject, voice: narr.voice,
    });
  } else {
    // Default whiteboard-lesson mode (LLM-generated layout). Generate, then
    // validate. If the model returned un-parseable or invalid DSL, do ONE
    // internal repair pass (feeding the problems back) before giving up. This
    // keeps a transient formatting failure contained inside a single tool
    // call instead of forcing the agent to blindly re-invoke the whole
    // expensive pipeline — the multi-minute retry loop we want to avoid.
    if (onProgress) onProgress({ phase: 'script' });
    let problems = null;
    try {
      dsl = await generateLessonDSL({ topic, durationMin, voice, client, model, sourceText, sourceKind });
      const v0 = validateLesson(dsl);
      if (!v0.ok) problems = v0.errors;
    } catch (e) {
      problems = [e.message];
    }
    if (problems) {
      if (onProgress) onProgress({ phase: 'script-repair', errors: problems });
      try {
        dsl = await generateLessonDSL({
          topic, durationMin, voice, client, model, sourceText, sourceKind,
          repair: { errors: problems },
        });
      } catch (e) {
        const err = new Error('Lesson script generation failed twice (' + e.message + '). Do NOT retry fauna_lesson_create for the same topic — fall back to fauna_video_create or deliver the lesson as written notes.');
        err.code = 'LESSON_GEN_FAILED';
        throw err;
      }
      const vr = validateLesson(dsl);
      if (!vr.ok) {
        const err = new Error('Lesson layout still invalid after a repair pass (' + vr.errors.join('; ') + '). Do NOT retry fauna_lesson_create for the same topic — fall back to fauna_video_create or deliver the lesson as written notes.');
        err.code = 'LESSON_DSL_INVALID';
        throw err;
      }
    }
  }

  const v = validateLesson(dsl);
  if (!v.ok) throw new Error('lesson DSL invalid: ' + v.errors.join('; '));
  if (onProgress) onProgress({ phase: 'audio-start', sceneCount: dsl.scenes.length });
  fs.mkdirSync(_lessonDir(id), { recursive: true });
  fs.writeFileSync(path.join(_lessonDir(id), 'lesson.draft.json'), JSON.stringify(dsl, null, 2), 'utf8');
  const lesson = await synthesizeLessonAudio({ lesson: dsl, lessonId: id, onProgress });
  fs.writeFileSync(path.join(_lessonDir(id), 'lesson.json'), JSON.stringify(lesson, null, 2), 'utf8');
  return { id, lesson, warnings: v.warnings, slideCount: slideImages ? slideImages.length : 0 };
}

/** Split source text emitted by source-extract into one chunk per slide.
 *  Falls back to even chunking if the "# Slide N" markers aren't present
 *  (e.g. PDF source with no slide headers). */
function _splitSourceBySlide(text, expectedCount) {
  const result = [];
  if (!text) {
    for (let i = 0; i < expectedCount; i++) result.push('');
    return result;
  }
  // Split on "# Slide N" headers. Each piece begins with the slide number's
  // content (preceded by the captured number).
  const parts = text.split(/^#\s*Slide\s+(\d+)[\t ]*\r?\n/mi);
  // parts[0] = preamble (usually empty), then alternating [number, body, number, body, ...]
  const byIdx = new Map();
  for (let i = 1; i < parts.length; i += 2) {
    const n = parseInt(parts[i], 10);
    const body = parts[i + 1] || '';
    // Strip any trailing "## Slide N notes" section — keep just the slide body.
    const cleaned = body.split(/^##\s*Slide\s+\d+\s+notes/mi)[0].trim();
    if (!isNaN(n)) byIdx.set(n, cleaned);
  }
  if (byIdx.size > 0) {
    for (let i = 1; i <= expectedCount; i++) result.push(byIdx.get(i) || '');
    return result;
  }
  // Fallback: distribute text as evenly as possible
  const chunkSize = Math.ceil(text.length / Math.max(1, expectedCount));
  for (let i = 0; i < expectedCount; i++) {
    result.push(text.slice(i * chunkSize, (i + 1) * chunkSize).trim());
  }
  return result;
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

export function lessonSlidePath(lessonId, fileName) {
  // Only allow slide-NNN.png to prevent traversal.
  if (!/^slide-\d{3}\.png$/.test(fileName)) return null;
  return path.join(_lessonDir(lessonId), 'slides', fileName);
}

// Exposed for tests + tool catalog.
export const _internals = { _scriptUserPrompt, ACTION_DOS, LESSONS_ROOT };

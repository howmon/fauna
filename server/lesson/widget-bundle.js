// Lesson runtime widget bundle.
//
// Returns { bundle:{html,js}, title, tools } for the dynamic-widget pipeline.
// The HTML is a self-contained whiteboard player:
//   * one <audio> element drives the master clock
//   * an SVG canvas holds drawn / faded-in props
//   * KaTeX (CDN) renders LaTeX props into SVG-fronted nodes
//   * a scrubber + scene list + cue overlay let the user navigate
//
// The widget receives the synthesized lesson document inline (no fetch
// roundtrip): we serialize it into a <script type="application/json">
// tag at mount time. Audio URLs are absolute /api/lesson-audio/<id>/<file>
// so the iframe (loopback-only) can stream them with Range support.

export function buildLessonWidget({ lessonId, lesson, port = 3737 }) {
  const lessonJson = JSON.stringify(lesson).replace(/</g, '\\u003c');
  const title = `Lesson · ${lesson.title || 'untitled'}`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${_escape(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>${CSS}</style>
</head><body>
<div id="root">
  <div id="canvas-wrap">
    <svg id="board" viewBox="0 0 ${lesson.canvas?.width || 1280} ${lesson.canvas?.height || 720}" preserveAspectRatio="xMidYMid meet"></svg>
    <div id="overlay"></div>
  </div>
  <div id="cue-strip"></div>
  <div id="controls">
    <button id="play" title="Play / Pause">▶</button>
    <button id="prev" title="Previous scene">⏮</button>
    <button id="next" title="Next scene">⏭</button>
    <input type="range" id="scrub" min="0" max="1000" value="0" step="1">
    <span id="time">0:00 / 0:00</span>
    <select id="speed">
      <option value="0.75">0.75×</option>
      <option value="1" selected>1×</option>
      <option value="1.25">1.25×</option>
      <option value="1.5">1.5×</option>
      <option value="2">2×</option>
    </select>
    <span id="scene-label"></span>
    <a id="download-mp4" href="/api/lesson-video/${lessonId}?download=1" download="lesson.mp4" title="Download MP4 video (renders on first click — may take a minute)">⬇ MP4</a>
    <a id="download-html" href="/api/lesson-html/${lessonId}?download=1" download="lesson-bundle.zip" title="Download self-contained HTML + audio zip — upload to any website">⬇ HTML</a>
  </div>
  <div id="scene-list"></div>
</div>
<audio id="audio" preload="auto"></audio>
<script type="application/json" id="lesson-data">${lessonJson}</script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
</body></html>`;

  return {
    bundle: {
      html,
      js: RUNTIME_JS,
    },
    title,
    tools: [
      { name: 'play',     description: 'Resume playback.',           parameters: { type: 'object', properties: {} } },
      { name: 'pause',    description: 'Pause playback.',            parameters: { type: 'object', properties: {} } },
      { name: 'goto_scene', description: 'Jump to a scene by id or index.', parameters: { type: 'object', properties: { scene: { type: ['string','number'] } }, required: ['scene'] } },
      { name: 'set_speed',description: 'Set playback rate (0.5–2).', parameters: { type: 'object', properties: { rate: { type: 'number' } }, required: ['rate'] } },
      { name: 'get_state',description: 'Return current scene index and time.', parameters: { type: 'object', properties: {} } },
    ],
  };
}

function _escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ─────────────────────────────────────────────────────────────────────────
// CSS — kept tight; whiteboard look with dark text on cream.
// ─────────────────────────────────────────────────────────────────────────
const CSS = `
:root {
  --bg: #fdfaf2;
  --ink: #1a1a1a;
  --accent: #2563eb;
  --warn: #d97706;
  --highlight: rgba(255, 209, 102, 0.55);
  --ui-bg: #1f1f23;
  --ui-fg: #f4f4f5;
  --ui-muted: #a1a1aa;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--ui-bg); color: var(--ui-fg); font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; height: 100%; overflow: hidden; }
/* 4 rows: canvas (flex) · caption strip · controls · scene chips. The caption
   strip is OUT of the canvas — it cannot overlap any prop, regardless of
   what y coord the model picks. Previously it was a position:absolute child
   of #canvas-wrap and any text prop in the bottom band collided with it. */
#root { display: grid; grid-template-rows: 1fr auto auto auto; height: 100vh; gap: 0; }
#canvas-wrap { position: relative; background: var(--bg); overflow: hidden; display: flex; align-items: center; justify-content: center; }
#board { width: 100%; height: 100%; display: block; overflow: hidden; background: var(--bg); }
#overlay { position: absolute; inset: 0; pointer-events: none; }
#cue-strip {
  padding: 10px 20px; background: var(--bg);
  color: var(--ink); font-size: 16px; min-height: 44px;
  text-align: center; font-weight: 500;
  border-top: 1px solid #e5e2d8;
}
#cue-strip:empty { min-height: 0; padding: 0; border-top: 0; }
#controls {
  display: flex; align-items: center; gap: 10px; padding: 8px 14px;
  background: var(--ui-bg); border-top: 1px solid #303035;
}
#controls button {
  background: #303035; color: var(--ui-fg); border: none; border-radius: 6px;
  padding: 6px 12px; cursor: pointer; font-size: 14px; min-width: 36px;
}
#controls button:hover { background: #404048; }
#controls button:disabled { opacity: 0.5; cursor: not-allowed; }
#scrub { flex: 1; cursor: pointer; }
#time { color: var(--ui-muted); font-variant-numeric: tabular-nums; min-width: 96px; text-align: right; }
#speed {
  background: #303035; color: var(--ui-fg); border: 1px solid #404048;
  border-radius: 4px; padding: 4px; font-size: 13px;
}
#scene-label { color: var(--ui-muted); margin-left: 8px; white-space: nowrap; }
#download-mp4 {
  background: #303035; color: var(--ui-fg); text-decoration: none;
  border-radius: 6px; padding: 6px 12px; font-size: 13px; margin-left: auto;
}
#download-mp4:hover { background: #404048; }
#download-html {
  background: #303035; color: var(--ui-fg); text-decoration: none;
  border-radius: 6px; padding: 6px 12px; font-size: 13px;
}
#download-html:hover { background: #404048; }
#scene-list {
  display: flex; gap: 4px; padding: 6px 14px; overflow-x: auto;
  background: #18181b; border-top: 1px solid #303035; max-height: 60px;
}
.scene-chip {
  background: #303035; color: var(--ui-fg); border: 1px solid transparent;
  border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 12px;
  white-space: nowrap; flex-shrink: 0;
}
.scene-chip:hover { background: #404048; }
.scene-chip.active { background: var(--accent); border-color: var(--accent); }
.prop-node { transform-box: fill-box; transform-origin: center; }
.prop-text-fo { overflow: visible; }
.prop-text-box {
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  line-height: 1.35;
  word-wrap: break-word;
  overflow-wrap: break-word;
  white-space: normal;
}
.prop-text-box.font-serif { font-family: Georgia, "Times New Roman", serif; }
.prop-text-box.font-hand { font-family: "Caveat", "Bradley Hand", cursive; }
.prop-text { fill: var(--ink); font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
.prop-text.font-serif { font-family: Georgia, "Times New Roman", serif; }
.prop-text.font-hand { font-family: "Caveat", "Bradley Hand", cursive; }
.katex { color: var(--ink); }
.katex-display { margin: 0; }
foreignObject.prop-latex { overflow: visible; }
.highlight-band { fill: var(--highlight); opacity: 0; transition: opacity 0.4s ease; }
.highlight-band.on { opacity: 1; }
.write-path { fill: none; stroke: var(--ink); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.plot-path { fill: none; stroke: var(--accent); stroke-width: 2.5; }
.plot-grid { fill: none; stroke: #cbc8bf; stroke-width: 0.5; }
.plot-axis { fill: none; stroke: #888; stroke-width: 1; }
.shape-rect, .shape-circle, .shape-ellipse, .shape-triangle { transition: opacity 0.4s ease; }
.arrow-line { fill: none; stroke: var(--ink); stroke-width: 2.5; marker-end: url(#arrowhead); }
.fade-in { animation: fadeIn 0.5s ease forwards; }
.fade-out { animation: fadeOut 0.4s ease forwards; }
.flash { animation: flashPulse 0.8s ease 2; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }
@keyframes flashPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); filter: brightness(1.3); } }
`;

// ─────────────────────────────────────────────────────────────────────────
// Runtime JS — runs inside the widget iframe sandbox.
//
// IMPORTANT: This entire script is delivered as the widget's `bundle.js`
// (separate from the HTML). The dynamic-widget host mounts the HTML inside
// an iframe, then injects this script. We rely on:
//   - window.KaTeX (loaded from CDN tag in HTML head)
//   - the inline <script type="application/json" id="lesson-data"> blob
// ─────────────────────────────────────────────────────────────────────────
const RUNTIME_JS = `
(() => {
  'use strict';

  // ── Load lesson document ────────────────────────────────────────────
  const dataTag = document.getElementById('lesson-data');
  if (!dataTag) { console.error('[lesson] no lesson-data tag'); return; }
  let LESSON;
  try { LESSON = JSON.parse(dataTag.textContent); }
  catch (e) { console.error('[lesson] parse failed', e); return; }

  const CANVAS_W = (LESSON.canvas && LESSON.canvas.width)  || 1280;
  const CANVAS_H = (LESSON.canvas && LESSON.canvas.height) || 720;
  const SVG_NS   = 'http://www.w3.org/2000/svg';

  const board    = document.getElementById('board');
  const overlay  = document.getElementById('overlay');
  const audio    = document.getElementById('audio');
  const cueStrip = document.getElementById('cue-strip');
  const playBtn  = document.getElementById('play');
  const prevBtn  = document.getElementById('prev');
  const nextBtn  = document.getElementById('next');
  const scrub    = document.getElementById('scrub');
  const timeEl   = document.getElementById('time');
  const speedSel = document.getElementById('speed');
  const sceneLbl = document.getElementById('scene-label');
  const sceneList= document.getElementById('scene-list');

  // ── Shared arrowhead marker (defined once on board) ─────────────────
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.innerHTML = '<marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>';
  board.appendChild(defs);

  // ── State ───────────────────────────────────────────────────────────
  let sceneIndex = 0;
  const sceneStarts = [];      // cumulative audio start time per scene (when stitched conceptually)
  let totalDuration = 0;
  for (const s of LESSON.scenes) {
    sceneStarts.push(totalDuration);
    totalDuration += (s.audioDurationSec || 0);
  }

  const propNodes = new Map(); // propId → { node, opts }
  const sceneState = LESSON.scenes.map(() => ({ ranActions: new Set() }));

  // ── Action handlers ─────────────────────────────────────────────────
  function ensureGroup(propId) {
    let entry = propNodes.get(propId);
    if (entry) return entry;
    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('prop-node');
    g.dataset.propId = propId;
    g.style.opacity = '0';
    board.appendChild(g);
    entry = { node: g, kind: null, opts: {} };
    propNodes.set(propId, entry);
    return entry;
  }

  function placeRoot(g, x, y) {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      g.setAttribute('transform', 'translate(' + x + ',' + y + ')');
    }
  }

  function renderProp(propId, action) {
    const prop = (LESSON.props && LESSON.props[propId]) || null;
    if (!prop) return null;
    const entry = ensureGroup(propId);
    if (entry.kind && entry.kind !== prop.kind) entry.node.innerHTML = '';
    entry.kind = prop.kind;
    const g = entry.node;
    // ── Slot system ─────────────────────────────────────────────────
    // If the prop declares a layout slot ('title' | 'caption' | 'body-top'
    // | 'body-center' | 'body-bottom' | 'free'), the runtime snaps the
    // prop into a managed lane and IGNORES any (x,y) the model supplied.
    // This frees the LLM from doing canvas arithmetic — which is where
    // every misrender bug originates — for the 80% of props that just
    // want to sit in a standard slot.
    const slot = (prop.slot && SLOTS[prop.slot]) ? prop.slot : null;
    if (slot) {
      const lane = SLOTS[slot];
      const w = (prop.kind === 'text' || prop.kind === 'latex')
        ? Math.min(prop.w || lane.w, lane.w)
        : (prop.w || lane.w);
      const x = Math.round((CANVAS_W - w) / 2);   // centred horizontally
      const y = lane.y;
      entry.opts.x = x; entry.opts.y = y;
      entry.opts.xExplicit = x; entry.opts.yExplicit = y;
      placeRoot(g, x, y);
      _renderPropBody(g, prop, action, x, w);
      return entry;
    }
    // Did the caller (or any earlier action on this prop) actually supply
    // coordinates? If not, we'll auto-place to avoid collisions.
    const hasExplicit = Number.isFinite(action.x) || Number.isFinite(action.y)
      || Number.isFinite(entry.opts.xExplicit) || Number.isFinite(entry.opts.yExplicit);
    let x = Number.isFinite(action.x) ? action.x : (entry.opts.x || 60);
    let y = Number.isFinite(action.y) ? action.y : (entry.opts.y || 100);
    if (Number.isFinite(action.x)) entry.opts.xExplicit = action.x;
    if (Number.isFinite(action.y)) entry.opts.yExplicit = action.y;
    // Auto-layout: when the model omits (x,y) on multiple props, every
    // one of them defaults to (60,100) and they pile on top of each
    // other (very visible with text/latex blocks — see screenshot bug).
    // Walk the already-placed props in this scene and shift the new
    // prop downward past the lowest existing bottom edge.
    if (!hasExplicit) {
      let pushTo = y;
      propNodes.forEach((other, otherId) => {
        if (otherId === propId) return;
        if (other.node === g) return;
        // Only consider props that are actually in the DOM AND visible.
        // Don't trust inline opacity alone — a prop coming out of a
        // fade-out still has computed opacity, and a freshly-created
        // group sits at opacity:0 until its action's runAction sets 1.
        if (!other.node.isConnected) return;
        const cs = (window.getComputedStyle ? window.getComputedStyle(other.node) : null);
        if (cs && (cs.opacity === '0' || cs.display === 'none' || cs.visibility === 'hidden')) return;
        try {
          const bb = other.node.getBBox();
          if (!bb || !Number.isFinite(bb.height) || bb.height < 1) return;
          // Translate by the group's own transform to get absolute y
          const tx = other.opts && Number.isFinite(other.opts.y) ? other.opts.y : 0;
          const bottom = tx + bb.y + bb.height;
          // If our default y lands inside or above this prop's row,
          // bump below it (with a small gap).
          if (pushTo <= bottom + 16) {
            pushTo = Math.max(pushTo, bottom + 16);
          }
        } catch (_) {}
      });
      // Don't run off the canvas — clamp so something is always visible.
      // We reserve the bottom 40px as a safety margin (caption strip lives
      // outside the canvas now, so this is purely overflow protection).
      if (pushTo + 40 > CANVAS_H) pushTo = Math.max(100, CANVAS_H - 80);
      y = pushTo;
    }
    entry.opts.x = x; entry.opts.y = y;
    placeRoot(g, x, y);
    _renderPropBody(g, prop, action, x);
    return entry;
  }

  // ── Slot definitions ────────────────────────────────────────────────
  // Standardized lanes so the LLM doesn't have to invent coordinates.
  // The 60px margins match the rules in the prompt. The bottom band
  // ('body-bottom') stays well clear of the new external cue strip and
  // leaves room for action overlays (highlight rects, underlines).
  const MARGIN = 60;
  const SLOTS = {
    'title':       { y: 60,                      w: CANVAS_W - MARGIN * 2 },
    'body-top':    { y: 180,                     w: CANVAS_W - MARGIN * 2 },
    'body-center': { y: Math.round(CANVAS_H/2) - 40, w: CANVAS_W - MARGIN * 2 },
    'body-bottom': { y: CANVAS_H - 220,          w: CANVAS_W - MARGIN * 2 },
    'caption':     { y: CANVAS_H - 120,          w: CANVAS_W - MARGIN * 2 },
  };

  function _renderPropBody(g, prop, action, x, slotW) {
    // slotW is the lane width when the prop is slotted; used to override the
    // free-form maxW calc so slotted text wraps inside its lane, not all the
    // way to the canvas right edge.
    switch (prop.kind) {
      case 'text': {
        if (!g.querySelector('foreignObject')) {
          const maxW = Number.isFinite(slotW)
            ? slotW
            : Math.max(200, Math.min(CANVAS_W - x - 40, prop.w || (CANVAS_W - x - 60)));
          const fo = document.createElementNS(SVG_NS, 'foreignObject');
          fo.setAttribute('width', String(maxW));
          fo.setAttribute('height', String(prop.h || 400));
          fo.classList.add('prop-text-fo');
          const div = document.createElement('div');
          const fontClass = prop.font ? (' font-' + prop.font) : '';
          div.className = 'prop-text-box' + fontClass;
          div.style.fontSize = (prop.fontSize || 28) + 'px';
          if (prop.color) div.style.color = prop.color;
          if (prop.align) div.style.textAlign = prop.align;
          if (prop.weight) div.style.fontWeight = String(prop.weight);
          div.textContent = String(prop.content || '');
          fo.appendChild(div);
          g.appendChild(fo);
        }
        break;
      }
      case 'latex': {
        if (!g.querySelector('foreignObject')) {
          const maxW = Number.isFinite(slotW)
            ? slotW
            : Math.max(200, Math.min(CANVAS_W - x - 40, prop.w || 800));
          const fo = document.createElementNS(SVG_NS, 'foreignObject');
          fo.setAttribute('width', String(maxW)); fo.setAttribute('height', String(prop.h || 200));
          fo.classList.add('prop-latex');
          const div = document.createElement('div');
          div.style.cssText = 'display:inline-block;color:#1a1a1a;max-width:100%;overflow-x:auto;';
          try {
            if (window.katex) window.katex.render(String(prop.tex || ''), div, { displayMode: !!prop.display, throwOnError: false });
            else div.textContent = prop.tex;
          } catch (e) { div.textContent = prop.tex; }
          fo.appendChild(div);
          g.appendChild(fo);
        }
        break;
      }
      case 'shape': {
        if (!g.querySelector('.shape-el')) {
          const w = prop.w || 80, h = prop.h || 80, r = prop.r || 40;
          let el;
          if (prop.shape === 'circle') {
            el = document.createElementNS(SVG_NS, 'circle');
            el.setAttribute('cx', String(r)); el.setAttribute('cy', String(r)); el.setAttribute('r', String(r));
          } else if (prop.shape === 'ellipse') {
            el = document.createElementNS(SVG_NS, 'ellipse');
            el.setAttribute('cx', String(w/2)); el.setAttribute('cy', String(h/2));
            el.setAttribute('rx', String(w/2)); el.setAttribute('ry', String(h/2));
          } else if (prop.shape === 'line') {
            el = document.createElementNS(SVG_NS, 'line');
            el.setAttribute('x1','0'); el.setAttribute('y1','0');
            el.setAttribute('x2', String(w)); el.setAttribute('y2', String(h));
          } else if (prop.shape === 'triangle') {
            el = document.createElementNS(SVG_NS, 'polygon');
            el.setAttribute('points', '0,'+h + ' ' + (w/2)+',0 ' + w+','+h);
          } else {
            el = document.createElementNS(SVG_NS, 'rect');
            el.setAttribute('width', String(w)); el.setAttribute('height', String(h));
          }
          el.classList.add('shape-el');
          el.setAttribute('fill', prop.fill || 'none');
          el.setAttribute('stroke', prop.stroke || '#1a1a1a');
          el.setAttribute('stroke-width', '2');
          g.appendChild(el);
        }
        break;
      }
      case 'image': {
        if (!g.querySelector('image')) {
          const im = document.createElementNS(SVG_NS, 'image');
          im.setAttributeNS('http://www.w3.org/1999/xlink', 'href', prop.src || '');
          im.setAttribute('href', prop.src || '');
          im.setAttribute('width', String(prop.w || 240));
          im.setAttribute('height', String(prop.h || 180));
          if (prop.alt) im.setAttribute('aria-label', prop.alt);
          g.appendChild(im);
        }
        break;
      }
      case 'slide': {
        // Full-canvas slide backdrop. Identical to 'image' but with default
        // dimensions matching the lesson canvas (1280x720) and aspect-fit
        // preservation so the original deck visual is never distorted.
        if (!g.querySelector('image')) {
          const im = document.createElementNS(SVG_NS, 'image');
          im.setAttributeNS('http://www.w3.org/1999/xlink', 'href', prop.src || '');
          im.setAttribute('href', prop.src || '');
          im.setAttribute('width', String(prop.w || 1280));
          im.setAttribute('height', String(prop.h || 720));
          im.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          im.setAttribute('aria-label', prop.alt || 'slide');
          g.appendChild(im);
        }
        break;
      }
      case 'svg': {
        if (!g.querySelector('g.svg-inline')) {
          const inner = document.createElementNS(SVG_NS, 'g');
          inner.classList.add('svg-inline');
          // Sanitize: strip <script> tags from the markup.
          const safe = String(prop.markup || '').replace(/<script[\\s\\S]*?<\\/script>/gi, '');
          // Wrap in a foreignObject only if it's already a full <svg> — otherwise inject.
          inner.innerHTML = safe.replace(/^<svg[^>]*>|<\\/svg>$/gi, '');
          g.appendChild(inner);
        }
        break;
      }
      case 'code': {
        if (!g.querySelector('foreignObject')) {
          const fo = document.createElementNS(SVG_NS, 'foreignObject');
          fo.setAttribute('width', '700'); fo.setAttribute('height', '300');
          const pre = document.createElement('pre');
          pre.style.cssText = 'margin:0;padding:10px 14px;background:#1f1f23;color:#f4f4f5;border-radius:8px;font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;';
          pre.textContent = String(prop.code || '');
          pre.dataset.full = String(prop.code || '');
          if (action.do === 'type') pre.textContent = '';
          fo.appendChild(pre);
          g.appendChild(fo);
        }
        break;
      }
      case 'plot': {
        if (!g.querySelector('g.plot-root')) {
          const root = document.createElementNS(SVG_NS, 'g');
          root.classList.add('plot-root');
          const w = action.w || 480, h = action.h || 280;
          const xR = prop.xRange || [-5, 5];
          const yR = prop.yRange || _autoFitY(prop.fn, xR);
          const xs = (v) => ((v - xR[0]) / (xR[1] - xR[0])) * w;
          const ys = (v) => h - ((v - yR[0]) / (yR[1] - yR[0])) * h;
          // axes
          const axisX = document.createElementNS(SVG_NS, 'line');
          axisX.setAttribute('class','plot-axis');
          const y0 = ys(0); axisX.setAttribute('x1','0'); axisX.setAttribute('y1', String(y0)); axisX.setAttribute('x2', String(w)); axisX.setAttribute('y2', String(y0));
          const axisY = document.createElementNS(SVG_NS, 'line');
          axisY.setAttribute('class','plot-axis');
          const x0 = xs(0); axisY.setAttribute('x1', String(x0)); axisY.setAttribute('y1','0'); axisY.setAttribute('x2', String(x0)); axisY.setAttribute('y2', String(h));
          root.appendChild(axisX); root.appendChild(axisY);
          // path
          const path = document.createElementNS(SVG_NS, 'path');
          path.classList.add('plot-path');
          let d = '';
          const N = 200;
          for (let i = 0; i <= N; i++) {
            const xv = xR[0] + (i/N) * (xR[1]-xR[0]);
            let yv; try { yv = _evalFn(prop.fn, xv); } catch (_) { yv = NaN; }
            if (!Number.isFinite(yv)) continue;
            d += (d ? ' L ' : 'M ') + xs(xv).toFixed(2) + ' ' + ys(yv).toFixed(2);
          }
          path.setAttribute('d', d);
          if (prop.color) path.setAttribute('stroke', prop.color);
          // animated reveal via dashoffset
          const len = path.getTotalLength ? 0 : 0; // measured after attach
          root.appendChild(path);
          g.appendChild(root);
          // measure after attach
          requestAnimationFrame(() => {
            try {
              const L = path.getTotalLength();
              path.style.strokeDasharray = String(L);
              path.style.strokeDashoffset = String(L);
              path.dataset.length = String(L);
            } catch (_) {}
          });
        }
        break;
      }
      case 'numberline': {
        if (!g.querySelector('g.nl-root')) {
          const root = document.createElementNS(SVG_NS, 'g');
          root.classList.add('nl-root');
          const w = action.w || 600;
          const mn = prop.min, mx = prop.max, tick = prop.tick || 1;
          const main = document.createElementNS(SVG_NS, 'line');
          main.setAttribute('x1','0'); main.setAttribute('y1','30'); main.setAttribute('x2', String(w)); main.setAttribute('y2','30');
          main.setAttribute('stroke','#1a1a1a'); main.setAttribute('stroke-width','2');
          main.setAttribute('marker-end', 'url(#arrowhead)');
          root.appendChild(main);
          for (let v = mn; v <= mx + 1e-9; v += tick) {
            const px = ((v - mn) / (mx - mn)) * w;
            const t = document.createElementNS(SVG_NS, 'line');
            t.setAttribute('x1', String(px)); t.setAttribute('x2', String(px));
            t.setAttribute('y1','24'); t.setAttribute('y2','36');
            t.setAttribute('stroke','#1a1a1a'); t.setAttribute('stroke-width','1.5');
            root.appendChild(t);
            const lbl = document.createElementNS(SVG_NS, 'text');
            lbl.setAttribute('x', String(px)); lbl.setAttribute('y','55');
            lbl.setAttribute('text-anchor','middle'); lbl.setAttribute('font-size','13');
            lbl.setAttribute('fill','#1a1a1a');
            lbl.textContent = String(Number.isInteger(tick) ? v : v.toFixed(2));
            root.appendChild(lbl);
          }
          g.appendChild(root);
        }
        break;
      }
      case 'arrow': {
        if (!g.querySelector('path.arrow-line')) {
          const p = document.createElementNS(SVG_NS, 'path');
          p.classList.add('arrow-line');
          const from = _resolveAnchor(prop.from, action) || {x:0,y:0};
          const to   = _resolveAnchor(prop.to, action)   || {x:100,y:0};
          // Group transform places at (0,0); we draw arrow in absolute board coords,
          // so move the group to (0,0) and bake coords into d.
          g.removeAttribute('transform');
          let d;
          if (prop.curve) {
            const mx = (from.x + to.x) / 2;
            const my = (from.y + to.y) / 2 - (prop.curve);
            d = 'M ' + from.x + ' ' + from.y + ' Q ' + mx + ' ' + my + ' ' + to.x + ' ' + to.y;
          } else {
            d = 'M ' + from.x + ' ' + from.y + ' L ' + to.x + ' ' + to.y;
          }
          p.setAttribute('d', d);
          if (prop.color) p.setAttribute('stroke', prop.color);
          g.appendChild(p);
          if (prop.label) {
            const tx = (from.x + to.x) / 2;
            const ty = (from.y + to.y) / 2 - 8;
            const t = document.createElementNS(SVG_NS, 'text');
            t.setAttribute('x', String(tx)); t.setAttribute('y', String(ty));
            t.setAttribute('text-anchor','middle'); t.setAttribute('font-size','14');
            t.setAttribute('fill','#1a1a1a');
            t.textContent = prop.label;
            g.appendChild(t);
          }
        }
        break;
      }
      case 'circuit': {
        if (!g.querySelector('g.circuit-inline') && prop.doc) {
          // Defer to fauna_render_circuit via /api — kept simple: we accept
          // a pre-rendered svg.markup if the generator put one in prop.svg.
          const inner = document.createElementNS(SVG_NS, 'g');
          inner.classList.add('circuit-inline');
          inner.innerHTML = String(prop.svg || '<text fill="#888">circuit prop missing svg</text>');
          g.appendChild(inner);
        }
        break;
      }
      case 'molecule': {
        if (!g.querySelector('g.mol-root')) {
          const root = document.createElementNS(SVG_NS, 'g');
          root.classList.add('mol-root');
          const atoms = Array.isArray(prop.atoms) ? prop.atoms : [];
          const bonds = Array.isArray(prop.bonds) ? prop.bonds : [];
          const SCALE = 40;
          for (const b of bonds) {
            const a1 = atoms[b.a], a2 = atoms[b.b]; if (!a1 || !a2) continue;
            const x1 = a1.x*SCALE, y1 = a1.y*SCALE, x2 = a2.x*SCALE, y2 = a2.y*SCALE;
            const draw = (off) => {
              const ln = document.createElementNS(SVG_NS, 'line');
              const dx = -(y2 - y1), dy = (x2 - x1);
              const L = Math.hypot(dx, dy) || 1;
              const ox = (dx/L) * off, oy = (dy/L) * off;
              ln.setAttribute('x1', String(x1+ox)); ln.setAttribute('y1', String(y1+oy));
              ln.setAttribute('x2', String(x2+ox)); ln.setAttribute('y2', String(y2+oy));
              ln.setAttribute('stroke', '#1a1a1a'); ln.setAttribute('stroke-width','2');
              root.appendChild(ln);
            };
            const order = b.order || 1;
            if (order === 1) draw(0);
            else if (order === 2) { draw(-3); draw(3); }
            else if (order === 3) { draw(-5); draw(0); draw(5); }
          }
          for (const a of atoms) {
            const c = document.createElementNS(SVG_NS, 'circle');
            c.setAttribute('cx', String(a.x*SCALE)); c.setAttribute('cy', String(a.y*SCALE));
            c.setAttribute('r','14'); c.setAttribute('fill', _atomColor(a.el)); c.setAttribute('stroke','#1a1a1a'); c.setAttribute('stroke-width','1.5');
            root.appendChild(c);
            const lbl = document.createElementNS(SVG_NS, 'text');
            lbl.setAttribute('x', String(a.x*SCALE)); lbl.setAttribute('y', String(a.y*SCALE+5));
            lbl.setAttribute('text-anchor','middle'); lbl.setAttribute('font-size','14'); lbl.setAttribute('font-weight','600');
            lbl.setAttribute('fill', _atomTextColor(a.el));
            lbl.textContent = String(a.el || '?');
            root.appendChild(lbl);
          }
          g.appendChild(root);
        }
        break;
      }
      case 'flow': {
        if (!g.querySelector('g.flow-root')) {
          const root = document.createElementNS(SVG_NS, 'g');
          root.classList.add('flow-root');
          const nodes = Array.isArray(prop.nodes) ? prop.nodes : [];
          const direction = prop.direction === 'vertical' ? 'vertical' : 'horizontal';
          const shape = prop.shape === 'rect' ? 'rect' : 'circle';
          const labelPos = (prop.labelPos === 'inside' || prop.labelPos === 'above') ? prop.labelPos : 'below';
          const showArrows = prop.showArrows !== false;
          // Available size — bounded so we never overflow the canvas.
          const availW = Math.max(200, Math.min(CANVAS_W - x - 40, action.w || prop.w || (CANVAS_W - x - 60)));
          const availH = Math.max(120, Math.min(CANVAS_H - y - 40, action.h || prop.h || 240));
          const n = nodes.length || 1;
          const NODE_R = shape === 'circle' ? Math.max(28, Math.min(60, ((direction === 'horizontal' ? availW : availH) / n) * 0.22)) : 0;
          const NODE_W = shape === 'rect' ? Math.max(80, Math.min(180, ((direction === 'horizontal' ? availW : availH) / n) * 0.55)) : NODE_R * 2;
          const NODE_H = shape === 'rect' ? 56 : NODE_R * 2;
          // Step from CENTER to CENTER along the layout axis.
          const stepAxis = direction === 'horizontal' ? availW : availH;
          const step = n > 1 ? (stepAxis - NODE_W) / (n - 1) : 0;
          const positions = [];
          for (let i = 0; i < n; i++) {
            let cx, cy;
            if (direction === 'horizontal') {
              cx = (NODE_W / 2) + i * step;
              cy = availH / 2;
            } else {
              cx = availW / 2;
              cy = (NODE_H / 2) + i * step;
            }
            positions.push({ cx, cy });
          }
          // Arrows first so they sit under the nodes.
          if (showArrows && n > 1) {
            for (let i = 0; i < n - 1; i++) {
              const a = positions[i], b = positions[i + 1];
              const dx = b.cx - a.cx, dy = b.cy - a.cy;
              const L = Math.hypot(dx, dy) || 1;
              const padA = (shape === 'circle' ? NODE_R : NODE_W / 2) + 6;
              const padB = (shape === 'circle' ? NODE_R : NODE_W / 2) + 10;
              const sx = a.cx + (dx / L) * padA, sy = a.cy + (dy / L) * padA;
              const ex = b.cx - (dx / L) * padB, ey = b.cy - (dy / L) * padB;
              const ln = document.createElementNS(SVG_NS, 'line');
              ln.setAttribute('x1', String(sx)); ln.setAttribute('y1', String(sy));
              ln.setAttribute('x2', String(ex)); ln.setAttribute('y2', String(ey));
              ln.setAttribute('stroke', prop.color || '#1a1a1a');
              ln.setAttribute('stroke-width', '2');
              ln.setAttribute('marker-end', 'url(#arrowhead)');
              root.appendChild(ln);
            }
          }
          // Nodes + labels.
          for (let i = 0; i < n; i++) {
            const node = nodes[i] || {};
            const { cx, cy } = positions[i];
            const fill = node.fill || _flowFill(node.color);
            const stroke = node.color || _flowStroke(i);
            if (shape === 'circle') {
              const c = document.createElementNS(SVG_NS, 'circle');
              c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy));
              c.setAttribute('r', String(NODE_R));
              c.setAttribute('fill', fill); c.setAttribute('stroke', stroke); c.setAttribute('stroke-width', '2');
              root.appendChild(c);
            } else {
              const r = document.createElementNS(SVG_NS, 'rect');
              r.setAttribute('x', String(cx - NODE_W / 2)); r.setAttribute('y', String(cy - NODE_H / 2));
              r.setAttribute('width', String(NODE_W)); r.setAttribute('height', String(NODE_H));
              r.setAttribute('rx', '8'); r.setAttribute('ry', '8');
              r.setAttribute('fill', fill); r.setAttribute('stroke', stroke); r.setAttribute('stroke-width', '2');
              root.appendChild(r);
            }
            const label = String(node.label || '');
            if (label) {
              const t = document.createElementNS(SVG_NS, 'text');
              let ly;
              if (labelPos === 'inside') {
                ly = cy + 5; t.setAttribute('fill', stroke);
              } else if (labelPos === 'above') {
                ly = cy - (shape === 'circle' ? NODE_R : NODE_H / 2) - 10; t.setAttribute('fill', '#1a1a1a');
              } else {
                ly = cy + (shape === 'circle' ? NODE_R : NODE_H / 2) + 22; t.setAttribute('fill', '#1a1a1a');
              }
              t.setAttribute('x', String(cx)); t.setAttribute('y', String(ly));
              t.setAttribute('text-anchor', 'middle');
              t.setAttribute('font-size', '16'); t.setAttribute('font-weight', '600');
              t.textContent = label;
              root.appendChild(t);
            }
          }
          g.appendChild(root);
        }
        break;
      }
      default:
        // Unknown kind: render a debug stub.
        if (!g.querySelector('text')) {
          const t = document.createElementNS(SVG_NS, 'text');
          t.setAttribute('fill','#d97706'); t.setAttribute('font-size','14');
          t.textContent = '[unknown prop kind: ' + prop.kind + ']';
          g.appendChild(t);
        }
    }
  }

  function _atomColor(el) {
    const map = { H: '#fff', C: '#222', N: '#3b82f6', O: '#ef4444', S: '#facc15', Cl: '#22c55e', Br: '#a3411a', F: '#22d3ee', P: '#f97316' };
    return map[el] || '#cbd5e1';
  }
  function _atomTextColor(el) {
    return (el === 'C' || el === 'Br') ? '#fff' : '#000';
  }

  // Flow palette — translucent fills paired with the stroke color so the
  // diagram reads well on the cream whiteboard background.
  const _FLOW_PALETTE = ['#f59e0b', '#3b82f6', '#22c55e', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];
  function _flowStroke(i) { return _FLOW_PALETTE[i % _FLOW_PALETTE.length]; }
  function _flowFill(color) {
    if (!color) return 'rgba(0,0,0,0.04)';
    // Convert hex to rgba with low alpha so node interiors don't compete with labels.
    const hex = String(color).trim();
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (m) {
      const n = parseInt(m[1], 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return 'rgba(' + r + ',' + g + ',' + b + ',0.18)';
    }
    return color;
  }

  function _resolveAnchor(ref, action) {
    if (!ref) return null;
    if (typeof ref === 'object' && Number.isFinite(ref.x) && Number.isFinite(ref.y)) return ref;
    if (typeof ref === 'string') {
      const entry = propNodes.get(ref);
      if (!entry) return null;
      try {
        const bb = entry.node.getBBox();
        const t = entry.node.getCTM();
        const x = (t ? t.e : 0) + bb.x + bb.width/2;
        const y = (t ? t.f : 0) + bb.y + bb.height/2;
        return { x, y };
      } catch (_) { return { x: entry.opts.x || 0, y: entry.opts.y || 0 }; }
    }
    return null;
  }

  function _evalFn(expr, x) {
    // Allow Math.* and basic operators. Sandboxed enough for lesson DSLs we
    // generate ourselves; reject any property access that isn't Math.<name>.
    if (typeof expr !== 'string') return NaN;
    if (/[^\\w\\s+\\-*/().,Math]/.test(expr.replace(/Math\\.[a-zA-Z0-9_]+/g, ''))) return NaN;
    // eslint-disable-next-line no-new-func
    return Function('x', 'with(Math){return (' + expr + ');}')(x);
  }

  function _autoFitY(expr, xR) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const xv = xR[0] + (i/100) * (xR[1]-xR[0]);
      try {
        const yv = _evalFn(expr, xv);
        if (Number.isFinite(yv)) { lo = Math.min(lo, yv); hi = Math.max(hi, yv); }
      } catch (_) {}
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [-1, 1];
    const pad = (hi - lo) * 0.1;
    return [lo - pad, hi + pad];
  }

  function runAction(action) {
    const entry = action.prop ? renderProp(action.prop, action) : null;
    const g = entry?.node;
    if (g) g.style.opacity = '1';
    const dur = action.durMs || 600;

    switch (action.do) {
      case 'fade-in':
      case 'draw': {
        if (g) { g.classList.add('fade-in'); g.style.opacity = '1'; }
        break;
      }
      case 'fade-out': {
        if (g) { g.classList.add('fade-out'); }
        break;
      }
      case 'write': {
        if (!g) break;
        // Stroke-animate any path/text inside the group.
        g.style.opacity = '1';
        const paths = g.querySelectorAll('path, line, polyline, circle, rect, ellipse, polygon');
        paths.forEach((p, idx) => {
          try {
            const len = (p.getTotalLength && p.getTotalLength()) || 200;
            p.style.transition = 'none';
            p.style.strokeDasharray = String(len);
            p.style.strokeDashoffset = String(len);
            // force reflow
            void p.getBoundingClientRect();
            p.style.transition = 'stroke-dashoffset ' + dur + 'ms ease ' + (idx * 60) + 'ms';
            p.style.strokeDashoffset = '0';
          } catch (_) {}
        });
        break;
      }
      case 'plot': {
        if (!g) break;
        g.style.opacity = '1';
        const p = g.querySelector('path.plot-path');
        if (p) {
          try {
            const L = parseFloat(p.dataset.length || '0') || p.getTotalLength();
            p.style.transition = 'none';
            p.style.strokeDasharray = String(L);
            p.style.strokeDashoffset = String(L);
            void p.getBoundingClientRect();
            p.style.transition = 'stroke-dashoffset ' + (action.durMs || 1500) + 'ms ease';
            p.style.strokeDashoffset = '0';
          } catch (_) {}
        }
        break;
      }
      case 'connect':
      case 'arrow': {
        if (!g) break;
        g.style.opacity = '1';
        const p = g.querySelector('path.arrow-line');
        if (p) {
          try {
            const L = p.getTotalLength();
            p.style.transition = 'none';
            p.style.strokeDasharray = String(L);
            p.style.strokeDashoffset = String(L);
            void p.getBoundingClientRect();
            p.style.transition = 'stroke-dashoffset ' + dur + 'ms ease';
            p.style.strokeDashoffset = '0';
          } catch (_) {}
        }
        break;
      }
      case 'highlight': {
        if (!g) break;
        g.style.opacity = '1';
        const bb = (() => { try { return g.getBBox(); } catch (_) { return { x:0,y:0,width:120,height:40 }; }})();
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.classList.add('highlight-band');
        rect.setAttribute('x', String(bb.x - 6));
        rect.setAttribute('y', String(bb.y - 4));
        rect.setAttribute('width', String(bb.width + 12));
        rect.setAttribute('height', String(bb.height + 8));
        rect.setAttribute('rx', '4');
        if (action.color) rect.setAttribute('fill', action.color);
        g.insertBefore(rect, g.firstChild);
        requestAnimationFrame(() => rect.classList.add('on'));
        break;
      }
      case 'underline': {
        if (!g) break;
        g.style.opacity = '1';
        const bb = (() => { try { return g.getBBox(); } catch (_) { return { x:0,y:0,width:100,height:30 }; }})();
        const ln = document.createElementNS(SVG_NS, 'line');
        ln.setAttribute('x1', String(bb.x)); ln.setAttribute('x2', String(bb.x + bb.width));
        ln.setAttribute('y1', String(bb.y + bb.height + 4)); ln.setAttribute('y2', String(bb.y + bb.height + 4));
        ln.setAttribute('stroke', action.color || '#d97706'); ln.setAttribute('stroke-width','2.5');
        try {
          const L = bb.width;
          ln.style.strokeDasharray = String(L);
          ln.style.strokeDashoffset = String(L);
          ln.style.transition = 'stroke-dashoffset ' + dur + 'ms ease';
          g.appendChild(ln);
          requestAnimationFrame(() => { ln.style.strokeDashoffset = '0'; });
        } catch (_) { g.appendChild(ln); }
        break;
      }
      case 'circle': {
        if (!g) break;
        g.style.opacity = '1';
        const bb = (() => { try { return g.getBBox(); } catch (_) { return { x:0,y:0,width:100,height:30 }; }})();
        const c = document.createElementNS(SVG_NS, 'ellipse');
        c.setAttribute('cx', String(bb.x + bb.width/2));
        c.setAttribute('cy', String(bb.y + bb.height/2));
        c.setAttribute('rx', String(bb.width/2 + 12));
        c.setAttribute('ry', String(bb.height/2 + 8));
        c.setAttribute('fill','none'); c.setAttribute('stroke', action.color || '#d97706'); c.setAttribute('stroke-width','2.5');
        try {
          const L = 2 * Math.PI * Math.max(bb.width, bb.height) / 2;
          c.style.strokeDasharray = String(L);
          c.style.strokeDashoffset = String(L);
          c.style.transition = 'stroke-dashoffset ' + dur + 'ms ease';
          g.appendChild(c);
          requestAnimationFrame(() => { c.style.strokeDashoffset = '0'; });
        } catch (_) { g.appendChild(c); }
        break;
      }
      case 'flash': {
        if (g) { g.classList.remove('flash'); void g.getBoundingClientRect(); g.classList.add('flash'); g.style.opacity = '1'; }
        break;
      }
      case 'move': {
        if (g && Number.isFinite(action.x) && Number.isFinite(action.y)) {
          g.style.transition = 'transform ' + dur + 'ms ease';
          g.setAttribute('transform', 'translate(' + action.x + ',' + action.y + ')');
          entry.opts.x = action.x; entry.opts.y = action.y;
        }
        break;
      }
      case 'rotate': {
        if (g) {
          const deg = Number.isFinite(action.deg) ? action.deg : 45;
          g.style.transition = 'transform ' + dur + 'ms ease';
          const x = entry.opts.x || 0, y = entry.opts.y || 0;
          g.setAttribute('transform', 'translate(' + x + ',' + y + ') rotate(' + deg + ')');
        }
        break;
      }
      case 'scale': {
        if (g) {
          const s = Number.isFinite(action.factor) ? action.factor : 1.2;
          g.style.transition = 'transform ' + dur + 'ms ease';
          const x = entry.opts.x || 0, y = entry.opts.y || 0;
          g.setAttribute('transform', 'translate(' + x + ',' + y + ') scale(' + s + ')');
        }
        break;
      }
      case 'type': {
        if (!g) break;
        g.style.opacity = '1';
        const pre = g.querySelector('pre');
        if (pre && pre.dataset.full) {
          const full = pre.dataset.full;
          const speed = action.durMs ? Math.max(8, action.durMs / full.length) : 22;
          let i = 0;
          pre.textContent = '';
          const tick = () => {
            i++;
            pre.textContent = full.slice(0, i);
            if (i < full.length) setTimeout(tick, speed);
          };
          tick();
        }
        break;
      }
      case 'erase': {
        if (g) { g.classList.add('fade-out'); setTimeout(() => g.remove(), 450); propNodes.delete(action.prop); }
        break;
      }
      default: {
        // unknown — do nothing (validator already warned)
      }
    }
  }

  function resolveAt(at, sceneDur) {
    if (at === 'start' || at == null) return 0;
    if (at === 'end') return Math.max(0, sceneDur - 0.2);
    const n = Number(at);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }

  // ── Scene playback ──────────────────────────────────────────────────
  function loadScene(idx, opts = {}) {
    if (idx < 0 || idx >= LESSON.scenes.length) return;
    const scene = LESSON.scenes[idx];
    // Clear previous scene's props unless the new scene opts in to a
    // cumulative canvas via {keep:true}. This prevents titles/diagrams
    // from stacking on top of each other across scenes.
    if (opts.preserveCanvas !== true && scene.keep !== true) {
      resetCanvas();
    }
    sceneIndex = idx;
    sceneState[idx].ranActions = new Set();
    audio.src = scene.audioUrl || '';
    audio.load();
    sceneLbl.textContent = (idx + 1) + ' / ' + LESSON.scenes.length + ' · ' + (scene.id || '');
    Array.from(sceneList.children).forEach((c, i) => c.classList.toggle('active', i === idx));
    if (opts.autoplay !== false) {
      audio.play().catch(()=>{});
    }
  }

  function checkActions() {
    const scene = LESSON.scenes[sceneIndex];
    if (!scene || !Array.isArray(scene.actions)) return;
    const t = audio.currentTime;
    const dur = scene.audioDurationSec || audio.duration || 0;
    for (let i = 0; i < scene.actions.length; i++) {
      if (sceneState[sceneIndex].ranActions.has(i)) continue;
      const a = scene.actions[i];
      const at = resolveAt(a.at, dur);
      if (t >= at) {
        sceneState[sceneIndex].ranActions.add(i);
        try { runAction(a); } catch (e) { console.warn('[lesson] action failed', a, e); }
      }
    }
    // Update cue strip from per-sentence cues if present.
    if (Array.isArray(scene.cues) && scene.cues.length) {
      const cue = scene.cues.find(c => t >= c.start && t < c.end) || scene.cues[scene.cues.length-1];
      if (cue) cueStrip.textContent = cue.text;
    } else {
      cueStrip.textContent = '';
    }
  }

  function fmtTime(s) {
    if (!Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  function updateTime() {
    const cur = sceneStarts[sceneIndex] + (audio.currentTime || 0);
    timeEl.textContent = fmtTime(cur) + ' / ' + fmtTime(totalDuration);
    if (audio.duration && Number.isFinite(audio.duration)) {
      const sceneFrac = audio.currentTime / audio.duration;
      const total = sceneStarts[sceneIndex] + (sceneFrac * audio.duration);
      scrub.value = String(Math.round((total / totalDuration) * 1000));
    }
  }

  // ── Scene list + controls wiring ────────────────────────────────────
  LESSON.scenes.forEach((s, i) => {
    const chip = document.createElement('div');
    chip.className = 'scene-chip';
    chip.textContent = (i+1) + '. ' + (s.id || ('scene ' + (i+1)));
    chip.addEventListener('click', () => { loadScene(i, { autoplay: true }); });
    sceneList.appendChild(chip);
  });

  function resetCanvas() {
    // Wipe EVERY trace of the previous scene so nothing leaks across the
    // transition. The original implementation removed prop nodes from the
    // SVG board but left the #overlay div, in-flight CSS transitions, and
    // any stale cue text — all visible as ghosts/overlays in the next
    // scene's first frame.
    Array.from(board.querySelectorAll('g.prop-node')).forEach(n => n.remove());
    propNodes.clear();
    if (overlay) overlay.innerHTML = '';
    cueStrip.textContent = '';
  }

  playBtn.addEventListener('click', () => {
    if (audio.paused) audio.play().catch(()=>{}); else audio.pause();
  });
  prevBtn.addEventListener('click', () => {
    if (sceneIndex > 0) { loadScene(sceneIndex - 1); }
  });
  nextBtn.addEventListener('click', () => {
    if (sceneIndex < LESSON.scenes.length - 1) { loadScene(sceneIndex + 1); }
  });
  scrub.addEventListener('input', () => {
    const total = (Number(scrub.value) / 1000) * totalDuration;
    // find scene
    let idx = 0;
    for (let i = 0; i < LESSON.scenes.length; i++) {
      const start = sceneStarts[i], end = start + (LESSON.scenes[i].audioDurationSec || 0);
      if (total >= start && total < end) { idx = i; break; }
      if (i === LESSON.scenes.length - 1) idx = i;
    }
    if (idx !== sceneIndex) {
      loadScene(idx, { autoplay: false });
    }
    const local = total - sceneStarts[idx];
    try { audio.currentTime = Math.max(0, local); } catch (_) {}
  });
  speedSel.addEventListener('change', () => { audio.playbackRate = Number(speedSel.value) || 1; });

  // ── Download buttons — sandboxed iframe (allow-scripts only) blocks the
  // \`download\` attribute and direct navigation. Relay the request to the
  // parent via widget.emit, where the parent has same-origin access and can
  // trigger the download cleanly.
  function _relayDownload(ev) {
    const a = ev.currentTarget;
    if (!a) return;
    ev.preventDefault();
    const href = a.getAttribute('href') || '';
    const filename = a.getAttribute('download') || '';
    try {
      if (window.widget && typeof window.widget.emit === 'function') {
        window.widget.emit('download', { url: href, filename: filename });
      }
    } catch (_) {}
  }
  const dlMp4 = document.getElementById('download-mp4');
  if (dlMp4) dlMp4.addEventListener('click', _relayDownload);
  const dlHtml = document.getElementById('download-html');
  if (dlHtml) dlHtml.addEventListener('click', _relayDownload);

  audio.addEventListener('timeupdate', () => { checkActions(); updateTime(); });
  audio.addEventListener('play',  () => { playBtn.textContent = '⏸'; });
  audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });
  audio.addEventListener('ended', () => {
    if (sceneIndex < LESSON.scenes.length - 1) loadScene(sceneIndex + 1);
    else playBtn.textContent = '▶';
  });

  function replayUpTo(uptoIdx) {
    // Re-run all actions for scenes 0..uptoIdx immediately (no delay) so the
    // canvas reflects the cumulative state when scrubbing backwards.
    for (let i = 0; i <= uptoIdx; i++) {
      const scene = LESSON.scenes[i];
      if (!scene || !Array.isArray(scene.actions)) continue;
      for (const a of scene.actions) {
        try { runAction(a); } catch (_) {}
      }
    }
  }

  // ── RPC handlers (chat-side tool calls) ─────────────────────────────
  // The dynamic-widget host forwards messages with type "rpc".
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type !== 'rpc' || !m.tool) return;
    try {
      switch (m.tool) {
        case 'play':       audio.play().catch(()=>{}); break;
        case 'pause':      audio.pause(); break;
        case 'goto_scene': {
          let idx = -1;
          if (typeof m.args?.scene === 'number') idx = m.args.scene;
          else if (typeof m.args?.scene === 'string') idx = LESSON.scenes.findIndex(s => s.id === m.args.scene);
          if (idx >= 0) { loadScene(idx); }
          break;
        }
        case 'set_speed':  audio.playbackRate = Math.max(0.5, Math.min(2, Number(m.args?.rate) || 1)); speedSel.value = String(audio.playbackRate); break;
        case 'get_state': {
          parent.postMessage({ type:'rpc-reply', id: m.id, ok:true, sceneIndex, time: audio.currentTime, total: totalDuration }, '*');
          return;
        }
      }
      parent.postMessage({ type:'rpc-reply', id: m.id, ok:true }, '*');
    } catch (e) {
      parent.postMessage({ type:'rpc-reply', id: m.id, ok:false, error: e.message }, '*');
    }
  });

  // ── Static render hook (used by offscreen video renderer) ───────────
  // Renders the END-STATE of a scene immediately with no animation, so an
  // offscreen Electron BrowserWindow can capturePage() each scene to a PNG
  // and ffmpeg can stitch them with the per-scene mp3s into a downloadable
  // mp4. Animations (stroke-dashoffset transitions, fade-ins, type_text
  // setTimeouts) are short-circuited to their final values after runAction.
  window.__renderSceneStatic = function(idx) {
    if (idx < 0 || idx >= LESSON.scenes.length) return false;
    const scene = LESSON.scenes[idx];
    if (scene.keep !== true) resetCanvas();
    sceneIndex = idx;
    if (Array.isArray(scene.actions)) {
      for (const a of scene.actions) {
        try { runAction(a); } catch (e) { console.warn('[lesson static] action failed', a, e); }
      }
    }
    // Force every pen-drawn path to its final drawn state (no transition).
    board.querySelectorAll('path,line,circle').forEach(el => {
      if (!el.style) return;
      if (el.style.strokeDashoffset || el.style.transition && /stroke-dashoffset/.test(el.style.transition)) {
        el.style.transition = 'none';
        el.style.strokeDashoffset = '0';
      }
    });
    // Force any fading-in groups to fully visible.
    board.querySelectorAll('g.prop-node').forEach(g => {
      g.style.transition = 'none';
      g.style.opacity = '1';
      g.classList.remove('fade-in');
      g.classList.remove('fade-out');
    });
    return true;
  };
  window.__sceneCount = function() { return LESSON.scenes.length; };

  // ── Boot ────────────────────────────────────────────────────────────
  loadScene(0, { autoplay: false });
  // Wait for user to click play to comply with autoplay policies; flash hint.
  cueStrip.textContent = 'Press ▶ to start the lesson';
})();
`;

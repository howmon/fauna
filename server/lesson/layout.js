// Lesson layout resolver.
//
// Runs after the LLM generates the DSL and AFTER validation. Two jobs:
//
//   1. Relative positioning. A prop may declare `relTo: "<otherPropId>"`,
//      `align: "below"|"above"|"leftOf"|"rightOf"|"belowLeft"|...`, and
//      `gap: <px>` instead of guessing (x,y). The resolver computes a
//      concrete (x,y) from the anchor's bbox and stamps it onto the
//      scene's action so the widget renders it deterministically.
//
//   2. Group flattening. A prop with `kind:"group"` is a flex container
//      with `direction:"row"|"column"`, `gap`, `align`, and `children: []`.
//      The resolver expands children into concrete top-level props at
//      concrete coords and rewrites the scene's actions to reveal each
//      child individually. The widget runtime never sees `group` —
//      backward compatible, no widget changes.
//
// Pure / deterministic / canvas-relative. Mirrors widget-bundle.js
// `_propDims` so dimensions agree.

const DEFAULT_CANVAS = { width: 1280, height: 720 };

// ── Dimension estimation (mirror of widget-bundle.js `_propDims`) ────
export function estimatePropDims(prop, action = {}, canvas = DEFAULT_CANVAS) {
  const W = canvas.width || DEFAULT_CANVAS.width;
  const H = canvas.height || DEFAULT_CANVAS.height;
  const x = Number.isFinite(action.x) ? action.x : (Number.isFinite(prop.x) ? prop.x : 60);
  const kind = prop && prop.kind;
  if (kind === 'text') {
    const fontSize = prop.fontSize || 28;
    // When the caller supplied an explicit width, honor it. Otherwise estimate
    // from content length: short captions should NOT default to 800px wide
    // (that breaks `relTo:belowCenter` because the caption ends up much wider
    // than its anchor). Estimate = (chars × glyph) + small padding, capped to
    // the available canvas width.
    const text = String(prop.content || '');
    let w;
    if (Number.isFinite(prop.w)) {
      w = prop.w;
    } else {
      const naturalW = Math.ceil(text.length * fontSize * 0.55) + 20;
      w = Math.max(40, Math.min(800, W - x - 60, naturalW));
    }
    const charsPerLine = Math.max(10, Math.floor(w / (fontSize * 0.55)));
    const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
    const h = prop.h || Math.max(40, Math.min(400, Math.round(lines * fontSize * 1.3)));
    return { w, h };
  }
  if (kind === 'latex') {
    const w = prop.w || 400;
    return { w, h: prop.h || 80 };
  }
  if (kind === 'shape') {
    const w = prop.w || (prop.r ? prop.r * 2 : 80);
    const h = prop.h || (prop.r ? prop.r * 2 : 80);
    return { w, h };
  }
  if (kind === 'image') return { w: prop.w || 240, h: prop.h || 180 };
  if (kind === 'slide') return { w: prop.w || W, h: prop.h || H };
  if (kind === 'code') return { w: prop.w || 700, h: prop.h || 300 };
  if (kind === 'plot') return { w: action.w || prop.w || 480, h: action.h || prop.h || 280 };
  if (kind === 'numberline') return { w: action.w || prop.w || 600, h: 80 };
  if (kind === 'flow') return { w: action.w || prop.w || Math.max(240, W - x - 60), h: action.h || prop.h || 240 };
  if (kind === 'molecule') return { w: 320, h: 320 };
  if (kind === 'svg') return { w: prop.w || 200, h: prop.h || 200 };
  if (kind === 'circuit') return { w: 480, h: 320 };
  if (kind === 'group') {
    // Group dims = computed bbox of children laid out. Recompute lazily.
    return groupDims(prop, canvas);
  }
  return { w: prop.w || 140, h: prop.h || 80 };
}

// ── Group bbox (without committing children to coords) ─────────────────
function groupDims(group, canvas) {
  const direction = group.direction === 'column' ? 'column' : 'row';
  const gap = Number.isFinite(group.gap) ? group.gap : 24;
  const padX = group.padding?.x ?? group.padding ?? 0;
  const padY = group.padding?.y ?? group.padding ?? 0;
  const children = Array.isArray(group.children) ? group.children : [];
  if (!children.length) return { w: 0, h: 0 };
  let main = 0;
  let cross = 0;
  for (const c of children) {
    const d = estimatePropDims(c, {}, canvas);
    if (direction === 'row') {
      main += d.w;
      cross = Math.max(cross, d.h);
    } else {
      main += d.h;
      cross = Math.max(cross, d.w);
    }
  }
  main += gap * (children.length - 1);
  if (direction === 'row') return { w: main + padX * 2, h: cross + padY * 2 };
  return { w: cross + padX * 2, h: main + padY * 2 };
}

// ── Slot lanes (mirror widget) ─────────────────────────────────────────
const SLOT_LANES = {
  'title':       { y: 60,  h: 80 },
  'body-top':    { y: 180, h: 120 },
  'body-center': { y: 320, h: 120 },
  'body-bottom': { y: 500, h: 120 },
  'caption':     { y: 600, h: 80 },
};

function slotBbox(slotName, propW, canvas) {
  const lane = SLOT_LANES[slotName];
  if (!lane) return null;
  const W = canvas.width || DEFAULT_CANVAS.width;
  const w = Math.min(propW || (W - 120), W - 120);
  return { x: Math.round((W - w) / 2), y: lane.y, w, h: lane.h };
}

// ── Relative-position resolver ─────────────────────────────────────────
const ALIGN_RULES = {
  // [dxFn(a,c), dyFn(a,c)] computing target (x,y) of the child given
  // anchor bbox `a` and child dims `c`, plus a gap.
  'below':       (a, c, g) => ({ x: a.x + (a.w - c.w) / 2,           y: a.y + a.h + g }),
  'belowLeft':   (a, c, g) => ({ x: a.x,                              y: a.y + a.h + g }),
  'belowCenter': (a, c, g) => ({ x: a.x + (a.w - c.w) / 2,           y: a.y + a.h + g }),
  'belowRight':  (a, c, g) => ({ x: a.x + a.w - c.w,                  y: a.y + a.h + g }),
  'above':       (a, c, g) => ({ x: a.x + (a.w - c.w) / 2,           y: a.y - c.h - g }),
  'aboveLeft':   (a, c, g) => ({ x: a.x,                              y: a.y - c.h - g }),
  'aboveCenter': (a, c, g) => ({ x: a.x + (a.w - c.w) / 2,           y: a.y - c.h - g }),
  'aboveRight':  (a, c, g) => ({ x: a.x + a.w - c.w,                  y: a.y - c.h - g }),
  'leftOf':      (a, c, g) => ({ x: a.x - c.w - g,                    y: a.y + (a.h - c.h) / 2 }),
  'rightOf':     (a, c, g) => ({ x: a.x + a.w + g,                    y: a.y + (a.h - c.h) / 2 }),
  'center':      (a, c)    => ({ x: a.x + (a.w - c.w) / 2,           y: a.y + (a.h - c.h) / 2 }),
};

export const VALID_ALIGNS = new Set(Object.keys(ALIGN_RULES));

// Given a propId, return its anchor bbox in the current scene. Resolution
// order: explicit (x,y) on action > explicit (x,y) on prop > slot lane.
// Returns null if the anchor isn't placeable (e.g. it's a group still
// awaiting expansion — caller must expand groups first).
function anchorBbox(propId, scene, propsMap, canvas) {
  const prop = propsMap[propId];
  if (!prop) return null;
  const action = (scene.actions || []).find(a => a && a.prop === propId);
  if (prop.slot && SLOT_LANES[prop.slot]) {
    return slotBbox(prop.slot, prop.w, canvas);
  }
  const dims = estimatePropDims(prop, action || {}, canvas);
  const x = Number.isFinite(action?.x) ? action.x
    : (Number.isFinite(prop.x) ? prop.x : null);
  const y = Number.isFinite(action?.y) ? action.y
    : (Number.isFinite(prop.y) ? prop.y : null);
  if (x == null || y == null) return null;
  return { x, y, w: dims.w, h: dims.h };
}

// ── Group expansion ────────────────────────────────────────────────────
// Replace `prop` (kind:'group') with concrete child props at concrete
// coords, and rewrite the scene's action(s) targeting the group into one
// action per child (preserving the original `do`, `at`, etc).
function expandGroupInScene(groupId, scene, propsMap, canvas, idCounter) {
  const group = propsMap[groupId];
  if (!group || group.kind !== 'group') return;
  const direction = group.direction === 'column' ? 'column' : 'row';
  const gap = Number.isFinite(group.gap) ? group.gap : 24;
  const padX = group.padding?.x ?? group.padding ?? 0;
  const padY = group.padding?.y ?? group.padding ?? 0;
  const crossAlign = group.align || 'center';   // 'start'|'center'|'end'
  const children = Array.isArray(group.children) ? group.children : [];
  if (!children.length) return;

  // Determine the group's origin (x,y). Same resolution order as anchorBbox.
  const groupAction = (scene.actions || []).find(a => a && a.prop === groupId);
  let originX, originY;
  if (group.slot && SLOT_LANES[group.slot]) {
    const dims = groupDims(group, canvas);
    const bbox = slotBbox(group.slot, dims.w, canvas);
    originX = bbox.x;
    originY = bbox.y;
  } else {
    originX = Number.isFinite(groupAction?.x) ? groupAction.x
      : (Number.isFinite(group.x) ? group.x : 60);
    originY = Number.isFinite(groupAction?.y) ? groupAction.y
      : (Number.isFinite(group.y) ? group.y : 100);
  }
  const dims = groupDims(group, canvas);
  const totalCross = direction === 'row' ? dims.h - padY * 2 : dims.w - padX * 2;

  // Lay out children along main axis with `gap`, cross-aligned per align.
  let cursor = direction === 'row' ? originX + padX : originY + padY;
  const childPlacements = [];
  for (const child of children) {
    const cd = estimatePropDims(child, {}, canvas);
    let cx, cy;
    if (direction === 'row') {
      cx = cursor;
      const crossSpan = cd.h;
      if (crossAlign === 'start')      cy = originY + padY;
      else if (crossAlign === 'end')   cy = originY + padY + (totalCross - crossSpan);
      else                              cy = originY + padY + (totalCross - crossSpan) / 2;
      cursor += cd.w + gap;
    } else {
      cy = cursor;
      const crossSpan = cd.w;
      if (crossAlign === 'start')      cx = originX + padX;
      else if (crossAlign === 'end')   cx = originX + padX + (totalCross - crossSpan);
      else                              cx = originX + padX + (totalCross - crossSpan) / 2;
      cursor += cd.h + gap;
    }
    childPlacements.push({ child, x: Math.round(cx), y: Math.round(cy) });
  }

  // Register child props in the global propsMap with synthetic ids.
  const newActions = [];
  for (let i = 0; i < childPlacements.length; i++) {
    const { child, x, y } = childPlacements[i];
    const childId = child.id || `${groupId}__${i}`;
    // Strip any layout-only fields the widget doesn't care about.
    const concrete = { ...child };
    delete concrete.id;
    delete concrete.relTo;
    delete concrete.align;
    delete concrete.gap;
    propsMap[childId] = concrete;
    // Mirror every action on the group onto each child, replacing the
    // prop id and stamping concrete (x,y). The widget reveals each child
    // independently — visually identical to revealing the group as a unit
    // because they all fire at the same `at` timestamp.
    const acts = (scene.actions || []).filter(a => a && a.prop === groupId);
    for (const a of acts) {
      newActions.push({ ...a, prop: childId, x, y });
    }
  }

  // Replace group actions with child actions, preserving order.
  if (newActions.length) {
    const out = [];
    let injected = false;
    for (const a of scene.actions || []) {
      if (a && a.prop === groupId) {
        if (!injected) {
          for (const na of newActions) out.push(na);
          injected = true;
        }
        // Skip the original group action.
      } else {
        out.push(a);
      }
    }
    scene.actions = out;
  }

  // Delete the group prop itself — the widget never needs to see it.
  delete propsMap[groupId];
}

// ── Public: resolve every scene in a doc ───────────────────────────────
export function resolveLayouts(doc) {
  if (!doc || !Array.isArray(doc.scenes)) return doc;
  const canvas = doc.canvas || DEFAULT_CANVAS;
  const propsMap = doc.props || (doc.props = {});

  // Pass 0: expand `bullets` sugar into a column group of text props.
  // bullets is purely syntactic sugar for "give me a stacked bullet list".
  // Fields: items: string[], fontSize?, marker? ("•"|"–"|"1.") , gap?, slot?
  for (const [pid, p] of Object.entries(propsMap)) {
    if (!p || p.kind !== 'bullets') continue;
    if (!Array.isArray(p.items) || !p.items.length) continue;
    const fontSize = p.fontSize || 26;
    const marker = p.marker || '•';
    const isNumbered = /^\s*(1\.|#)/.test(marker);
    const children = p.items.map((item, i) => {
      const bullet = isNumbered ? `${i + 1}.` : marker;
      return {
        kind: 'text',
        content: `${bullet}  ${String(item).trim()}`,
        fontSize,
        // Wrap inside the lane by default; LLM may override via per-item width.
      };
    });
    propsMap[pid] = {
      kind: 'group',
      direction: 'column',
      gap: Number.isFinite(p.gap) ? p.gap : 10,
      align: p.align || 'start',
      slot: p.slot,
      x: p.x,
      y: p.y,
      children,
    };
  }

  // Pass 1: expand groups in every scene. Mutates propsMap.
  let counter = 0;
  for (const scene of doc.scenes) {
    // Iterate over a snapshot of group ids in case new ones appear.
    const groupIds = Object.entries(propsMap)
      .filter(([_, p]) => p && p.kind === 'group')
      .map(([id]) => id);
    for (const gid of groupIds) {
      // Only expand groups this scene actually references.
      const referenced = (scene.actions || []).some(a => a && a.prop === gid);
      if (!referenced) continue;
      expandGroupInScene(gid, scene, propsMap, canvas, () => ++counter);
    }
  }

  // Pass 2: resolve relative positions per scene. Multiple passes in case
  // of chained anchors (A relTo B, B relTo C). Cap at 8 iterations to
  // avoid infinite loops on cycles.
  for (const scene of doc.scenes) {
    const actions = scene.actions || [];
    let progress = true;
    let iter = 0;
    while (progress && iter++ < 8) {
      progress = false;
      for (const action of actions) {
        if (!action || !action.prop) continue;
        const prop = propsMap[action.prop];
        if (!prop || !prop.relTo) continue;
        // Already stamped?
        if (Number.isFinite(action.x) && Number.isFinite(action.y)) continue;
        const rule = ALIGN_RULES[prop.align || 'below'];
        if (!rule) continue;
        const anchor = anchorBbox(prop.relTo, scene, propsMap, canvas);
        if (!anchor) continue;
        const childDims = estimatePropDims(prop, action, canvas);
        const gap = Number.isFinite(prop.gap) ? prop.gap : 16;
        const pos = rule(anchor, childDims, gap);
        action.x = Math.round(pos.x);
        action.y = Math.round(pos.y);
        progress = true;
      }
    }
  }

  // Pass 3: strip rel-pos fields from props (they've been consumed).
  for (const p of Object.values(propsMap)) {
    if (!p) continue;
    delete p.relTo;
    delete p.align;
    delete p.gap;
    // Note: do NOT delete prop.children; only group props had it and
    // those are already removed.
  }

  // Pass 4: auto-place unpositioned props per scene. Any prop the scene
  // references that has NO slot, NO relTo (already stripped), and NO
  // (x,y) on its action gets packed into the body region (y: 180→520)
  // top-to-bottom with the layout-estimated heights and a 24px gap.
  // This kills the most common LLM mistake: "I wrote a prop but forgot
  // to give it coordinates" → silently lands at (60,100) on top of the
  // title. Excluded kinds (flow, circuit, plot, slide) want their own
  // framing — if they have no coords, leave them alone for the runtime.
  const PACKABLE_KINDS = new Set(['text', 'latex', 'shape', 'image', 'svg', 'code', 'numberline', 'molecule']);
  const BODY_TOP_Y = 180;
  const BODY_BOTTOM_Y = 540;
  for (const scene of doc.scenes) {
    const actions = scene.actions || [];
    // Bucket: actions whose prop is unpositioned + packable.
    const toPack = [];
    for (const a of actions) {
      if (!a || !a.prop) continue;
      const prop = propsMap[a.prop];
      if (!prop) continue;
      if (prop.slot) continue;
      if (Number.isFinite(a.x) && Number.isFinite(a.y)) continue;
      if (Number.isFinite(prop.x) && Number.isFinite(prop.y)) continue;
      if (!PACKABLE_KINDS.has(prop.kind)) continue;
      toPack.push({ action: a, prop });
    }
    if (!toPack.length) continue;
    // Stack vertically inside the body band, horizontally centred.
    let cursorY = BODY_TOP_Y;
    const gap = 24;
    for (const { action, prop } of toPack) {
      const dims = estimatePropDims(prop, action, canvas);
      const x = Math.round((canvas.width - dims.w) / 2);
      if (cursorY + dims.h > BODY_BOTTOM_Y) {
        // Out of body space — let the widget's clamp handle it; stop packing.
        break;
      }
      action.x = Math.max(20, x);
      action.y = cursorY;
      cursorY += dims.h + gap;
    }
  }

  // Pass 5: nudge any remaining overlaps. The LLM may have hand-placed
  // two props at nearly-identical (x,y); the resolver shifts the lower
  // one down past the upper one with a 16px gap so the bbox validator
  // doesn't trip on it. Bounded to 4 sweeps to avoid pathological loops.
  for (const scene of doc.scenes) {
    const actions = scene.actions || [];
    let sweeps = 0;
    let moved = true;
    while (moved && sweeps++ < 4) {
      moved = false;
      const placed = [];
      for (const a of actions) {
        if (!a || !a.prop) continue;
        const prop = propsMap[a.prop];
        if (!prop) continue;
        const bbox = _placedBbox(prop, a, canvas);
        if (!bbox) continue;
        placed.push({ action: a, prop, bbox });
      }
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const A = placed[i], B = placed[j];
          if (A.action.prop === B.action.prop) continue;
          const overlap = _overlap(A.bbox, B.bbox);
          if (!overlap || overlap.ratio < 0.25) continue;
          // Bump whichever is lower-y (or, if tied, the later one) down
          // past the other with a 16px gap.
          const lower = (A.bbox.y <= B.bbox.y) ? B : A;
          const upper = (lower === A) ? B : A;
          const newY = upper.bbox.y + upper.bbox.h + 16;
          // Don't push off-canvas — if we can't fit, give up on this pair.
          if (newY + lower.bbox.h > canvas.height - 20) continue;
          lower.action.y = newY;
          lower.bbox.y = newY;
          moved = true;
        }
      }
    }
  }

  return doc;
}

// Compute the final bbox of a prop GIVEN its (possibly resolver-stamped)
// action. Used by the overlap-nudge pass. Returns null if the prop can't
// be located (e.g. arrow with no anchors).
function _placedBbox(prop, action, canvas) {
  if (prop.kind === 'arrow') return null;
  if (prop.slot && SLOT_LANES[prop.slot]) {
    return slotBbox(prop.slot, prop.w, canvas);
  }
  const x = Number.isFinite(action?.x) ? action.x
    : (Number.isFinite(prop.x) ? prop.x : null);
  const y = Number.isFinite(action?.y) ? action.y
    : (Number.isFinite(prop.y) ? prop.y : null);
  if (x == null || y == null) return null;
  const d = estimatePropDims(prop, action || {}, canvas);
  return { x, y, w: d.w, h: d.h };
}

function _overlap(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return null;
  const inter = (x2 - x1) * (y2 - y1);
  const smaller = Math.min(a.w * a.h, b.w * b.h) || 1;
  return { ratio: inter / smaller };
}

// Exported helpers for tests / validator.
export const _internals = {
  groupDims,
  slotBbox,
  ALIGN_RULES,
  SLOT_LANES,
};

import { describe, it, expect } from 'vitest';
import { resolveLayouts, estimatePropDims, VALID_ALIGNS } from '../server/lesson/layout.js';
import { validateLesson } from '../server/lesson/generator.js';

function baseDoc(extra = {}) {
  return {
    title: 't', subject: 'general', voice: 'kokoro:af_bella',
    canvas: { width: 1280, height: 720 },
    props: {}, scenes: [],
    ...extra,
  };
}

describe('layout.estimatePropDims', () => {
  it('shape size from w/h', () => {
    expect(estimatePropDims({ kind: 'shape', w: 100, h: 50 })).toEqual({ w: 100, h: 50 });
  });
  it('text wraps into multi-line based on content length', () => {
    const dims = estimatePropDims({ kind: 'text', content: 'x'.repeat(200), fontSize: 28, w: 400 });
    expect(dims.w).toBe(400);
    expect(dims.h).toBeGreaterThan(28);   // multi-line
  });
  it('group bbox is sum-of-children + gaps along main axis', () => {
    const dims = estimatePropDims({
      kind: 'group', direction: 'row', gap: 20,
      children: [
        { kind: 'shape', w: 100, h: 60 },
        { kind: 'shape', w: 100, h: 60 },
        { kind: 'shape', w: 100, h: 60 },
      ],
    });
    expect(dims).toEqual({ w: 100 * 3 + 20 * 2, h: 60 });
  });
});

describe('layout.resolveLayouts — relTo', () => {
  it('places child below anchor with default gap', () => {
    const doc = baseDoc({
      props: {
        a: { kind: 'shape', shape: 'rect', w: 200, h: 100 },
        b: { kind: 'text', content: 'caption', fontSize: 20, relTo: 'a', align: 'belowCenter' },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [
          { at: 'start', do: 'fade-in', prop: 'a', x: 100, y: 100 },
          { at: 0.5,     do: 'fade-in', prop: 'b' },
        ],
      }],
    });
    resolveLayouts(doc);
    const bAction = doc.scenes[0].actions.find(a => a.prop === 'b');
    expect(bAction.x).toBeGreaterThanOrEqual(0);
    expect(bAction.y).toBe(100 + 100 + 16);   // anchor.y + anchor.h + gap
    // relTo fields stripped post-resolve.
    expect(doc.props.b.relTo).toBeUndefined();
    expect(doc.props.b.align).toBeUndefined();
  });

  it('chains rel positions (B relTo A, C relTo B)', () => {
    const doc = baseDoc({
      props: {
        a: { kind: 'shape', shape: 'rect', w: 100, h: 50 },
        b: { kind: 'shape', shape: 'rect', w: 100, h: 50, relTo: 'a', align: 'below', gap: 10 },
        c: { kind: 'shape', shape: 'rect', w: 100, h: 50, relTo: 'b', align: 'below', gap: 10 },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [
          { at: 'start', do: 'fade-in', prop: 'a', x: 200, y: 100 },
          { at: 0.5,     do: 'fade-in', prop: 'b' },
          { at: 1.0,     do: 'fade-in', prop: 'c' },
        ],
      }],
    });
    resolveLayouts(doc);
    const acts = Object.fromEntries(doc.scenes[0].actions.map(a => [a.prop, a]));
    expect(acts.b.y).toBe(100 + 50 + 10);
    expect(acts.c.y).toBe(acts.b.y + 50 + 10);
  });

  it('respects custom gap', () => {
    const doc = baseDoc({
      props: {
        a: { kind: 'shape', shape: 'rect', w: 100, h: 50 },
        b: { kind: 'shape', shape: 'rect', w: 100, h: 50, relTo: 'a', align: 'rightOf', gap: 40 },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [
          { at: 'start', do: 'fade-in', prop: 'a', x: 100, y: 100 },
          { at: 0.5,     do: 'fade-in', prop: 'b' },
        ],
      }],
    });
    resolveLayouts(doc);
    const bAction = doc.scenes[0].actions.find(a => a.prop === 'b');
    expect(bAction.x).toBe(100 + 100 + 40);
  });

  it('VALID_ALIGNS covers all documented align values', () => {
    const expected = ['below', 'belowLeft', 'belowCenter', 'belowRight',
      'above', 'aboveLeft', 'aboveCenter', 'aboveRight',
      'leftOf', 'rightOf', 'center'];
    for (const a of expected) expect(VALID_ALIGNS.has(a)).toBe(true);
  });
});

describe('layout.resolveLayouts — group expansion', () => {
  it('flattens row group into 3 child actions side-by-side', () => {
    const doc = baseDoc({
      props: {
        kpis: {
          kind: 'group', direction: 'row', gap: 20,
          children: [
            { kind: 'shape', shape: 'rect', w: 100, h: 60, fill: '#fff' },
            { kind: 'shape', shape: 'rect', w: 100, h: 60, fill: '#000' },
            { kind: 'shape', shape: 'rect', w: 100, h: 60, fill: '#f00' },
          ],
        },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [{ at: 'start', do: 'fade-in', prop: 'kpis', x: 100, y: 200 }],
      }],
    });
    resolveLayouts(doc);
    // Group is gone; three child props were minted.
    expect(doc.props.kpis).toBeUndefined();
    const childIds = Object.keys(doc.props).filter(id => id.startsWith('kpis__'));
    expect(childIds).toHaveLength(3);
    // Each child action carries concrete (x,y), with x stepping by 100+20=120.
    const acts = doc.scenes[0].actions;
    expect(acts).toHaveLength(3);
    expect(acts[0].x).toBe(100);
    expect(acts[1].x).toBe(100 + 100 + 20);
    expect(acts[2].x).toBe(100 + (100 + 20) * 2);
    for (const a of acts) expect(a.do).toBe('fade-in');
  });

  it('column group stacks children vertically', () => {
    const doc = baseDoc({
      props: {
        list: {
          kind: 'group', direction: 'column', gap: 10,
          children: [
            { kind: 'shape', shape: 'rect', w: 80, h: 40 },
            { kind: 'shape', shape: 'rect', w: 80, h: 40 },
          ],
        },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [{ at: 'start', do: 'fade-in', prop: 'list', x: 50, y: 50 }],
      }],
    });
    resolveLayouts(doc);
    const acts = doc.scenes[0].actions;
    expect(acts[0].y).toBe(50);
    expect(acts[1].y).toBe(50 + 40 + 10);
  });

  it('group with slot derives its origin from the lane', () => {
    const doc = baseDoc({
      props: {
        row: {
          kind: 'group', direction: 'row', gap: 20, slot: 'body-center',
          children: [
            { kind: 'shape', shape: 'rect', w: 100, h: 60 },
            { kind: 'shape', shape: 'rect', w: 100, h: 60 },
          ],
        },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [{ at: 'start', do: 'fade-in', prop: 'row' }],
      }],
    });
    resolveLayouts(doc);
    // body-center lane y=320; children placed with cross-align center inside the lane.
    const acts = doc.scenes[0].actions;
    // Group total w = 100+100+20 = 220 → centred on canvas (1280-220)/2 = 530.
    expect(acts[0].x).toBe(530);
    expect(acts[1].x).toBe(530 + 100 + 20);
  });

  it('preserves the action.do/at when expanding (e.g. write/draw)', () => {
    const doc = baseDoc({
      props: {
        g: { kind: 'group', direction: 'row', children: [
          { kind: 'shape', shape: 'rect', w: 50, h: 50 },
          { kind: 'shape', shape: 'rect', w: 50, h: 50 },
        ]},
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [{ at: 1.5, do: 'draw', prop: 'g', x: 0, y: 0, durMs: 900 }],
      }],
    });
    resolveLayouts(doc);
    for (const a of doc.scenes[0].actions) {
      expect(a.do).toBe('draw');
      expect(a.at).toBe(1.5);
      expect(a.durMs).toBe(900);
    }
  });
});

describe('layout integration — validateLesson runs resolver before bbox check', () => {
  it('accepts a doc whose props would collide WITHOUT the group layout but pass WITH it', () => {
    // Three shapes overlapping at (100,100) — would collide if hand-placed.
    // Wrapped in a row group, the resolver spreads them out; bbox check passes.
    const doc = baseDoc({
      props: {
        row: {
          kind: 'group', direction: 'row', gap: 20,
          children: [
            { kind: 'shape', shape: 'rect', w: 100, h: 50 },
            { kind: 'shape', shape: 'rect', w: 100, h: 50 },
            { kind: 'shape', shape: 'rect', w: 100, h: 50 },
          ],
        },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [{ at: 'start', do: 'fade-in', prop: 'row', x: 100, y: 100 }],
      }],
    });
    const v = validateLesson(doc);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('rejects an empty group', () => {
    const doc = baseDoc({
      props: { g: { kind: 'group', children: [] } },
      scenes: [{ id: 's1', narration: 'n', actions: [] }],
    });
    const v = validateLesson(doc);
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /requires non-empty children/.test(e))).toBe(true);
  });

  it('rejects nested groups', () => {
    const doc = baseDoc({
      props: {
        g: { kind: 'group', children: [
          { kind: 'group', children: [{ kind: 'shape', w: 10, h: 10 }] },
        ]},
      },
      scenes: [{ id: 's1', narration: 'n', actions: [] }],
    });
    const v = validateLesson(doc);
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /cannot itself be a "group"/.test(e))).toBe(true);
  });

  it('rejects relTo pointing to an unknown prop', () => {
    const doc = baseDoc({
      props: { a: { kind: 'text', content: 'x', relTo: 'nope', align: 'below' } },
      scenes: [{ id: 's1', narration: 'n', actions: [] }],
    });
    const v = validateLesson(doc);
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /references unknown prop "nope"/.test(e))).toBe(true);
  });

  it('rejects unknown align value', () => {
    const doc = baseDoc({
      props: {
        a: { kind: 'shape', shape: 'rect', w: 50, h: 50 },
        b: { kind: 'text', content: 'x', relTo: 'a', align: 'sideways' },
      },
      scenes: [{ id: 's1', narration: 'n', actions: [] }],
    });
    const v = validateLesson(doc);
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /align "sideways" not in/.test(e))).toBe(true);
  });
});

describe('layout.resolveLayouts — bullets sugar', () => {
  it('expands bullets into a column group with markers', () => {
    const doc = baseDoc({
      props: {
        pts: { kind: 'bullets', slot: 'body-center',
          items: ['First', 'Second', 'Third'] },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [{ at: 'start', do: 'fade-in', prop: 'pts' }],
      }],
    });
    resolveLayouts(doc);
    // bullets prop is gone; 3 child text props minted.
    expect(doc.props.pts).toBeUndefined();
    const ids = Object.keys(doc.props).filter(id => id.startsWith('pts__'));
    expect(ids).toHaveLength(3);
    const contents = ids.map(id => doc.props[id].content);
    expect(contents[0]).toContain('First');
    expect(contents[0]).toMatch(/^•/);
  });

  it('supports numbered marker "1."', () => {
    const doc = baseDoc({
      props: { p: { kind: 'bullets', marker: '1.', slot: 'body-top',
        items: ['Alpha', 'Beta'] } },
      scenes: [{ id: 's1', narration: 'n',
        actions: [{ at: 'start', do: 'fade-in', prop: 'p' }] }],
    });
    resolveLayouts(doc);
    const ids = Object.keys(doc.props).filter(id => id.startsWith('p__'));
    expect(doc.props[ids[0]].content).toMatch(/^1\./);
    expect(doc.props[ids[1]].content).toMatch(/^2\./);
  });

  it('rejects bullets with empty items', () => {
    const doc = baseDoc({
      props: { p: { kind: 'bullets', items: [] } },
      scenes: [{ id: 's1', narration: 'n', actions: [] }],
    });
    const v = validateLesson(doc);
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /requires non-empty items/.test(e))).toBe(true);
  });
});

describe('layout.resolveLayouts — auto-place unpositioned props', () => {
  it('packs two coord-less text props vertically in the body region', () => {
    const doc = baseDoc({
      props: {
        a: { kind: 'text', content: 'Line A', fontSize: 28 },
        b: { kind: 'text', content: 'Line B', fontSize: 28 },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [
          { at: 'start', do: 'fade-in', prop: 'a' },
          { at: 0.5,     do: 'fade-in', prop: 'b' },
        ],
      }],
    });
    resolveLayouts(doc);
    const acts = doc.scenes[0].actions;
    // Both got y stamped.
    expect(acts[0].y).toBeGreaterThanOrEqual(180);
    expect(acts[1].y).toBeGreaterThan(acts[0].y);   // packed below
    // No overlap.
    expect(acts[1].y - acts[0].y).toBeGreaterThanOrEqual(40);
  });

  it('leaves slotted props alone (does not auto-place over them)', () => {
    const doc = baseDoc({
      props: {
        title: { kind: 'text', content: 'Hi', slot: 'title' },
        body:  { kind: 'text', content: 'Body' },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [
          { at: 'start', do: 'fade-in', prop: 'title' },
          { at: 0.5,     do: 'fade-in', prop: 'body' },
        ],
      }],
    });
    resolveLayouts(doc);
    const acts = doc.scenes[0].actions;
    const titleAct = acts.find(a => a.prop === 'title');
    const bodyAct  = acts.find(a => a.prop === 'body');
    // Title action gets no auto-place (slot handles it at render time).
    expect(titleAct.x).toBeUndefined();
    // Body got auto-placed in body region.
    expect(bodyAct.y).toBeGreaterThanOrEqual(180);
  });

  it('does not auto-place flow/circuit/plot (need explicit framing)', () => {
    const doc = baseDoc({
      props: {
        f: { kind: 'flow', nodes: [{ label: 'A' }, { label: 'B' }] },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [{ at: 'start', do: 'draw', prop: 'f' }],
      }],
    });
    resolveLayouts(doc);
    const act = doc.scenes[0].actions[0];
    expect(act.x).toBeUndefined();
    expect(act.y).toBeUndefined();
  });
});

describe('layout.resolveLayouts — auto-nudge overlapping props', () => {
  it('shifts the lower of two overlapping props down', () => {
    const doc = baseDoc({
      props: {
        a: { kind: 'shape', shape: 'rect', w: 200, h: 100 },
        b: { kind: 'shape', shape: 'rect', w: 200, h: 100 },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [
          { at: 'start', do: 'fade-in', prop: 'a', x: 100, y: 200 },
          { at: 0.5,     do: 'fade-in', prop: 'b', x: 110, y: 220 },   // overlaps a
        ],
      }],
    });
    resolveLayouts(doc);
    const acts = doc.scenes[0].actions;
    const A = acts.find(x => x.prop === 'a');
    const B = acts.find(x => x.prop === 'b');
    // b moves below a with 16px gap (a.y=200, a.h=100 → b.y=316).
    expect(B.y).toBeGreaterThanOrEqual(A.y + 100);
  });

  it('does not nudge non-overlapping props', () => {
    const doc = baseDoc({
      props: {
        a: { kind: 'shape', shape: 'rect', w: 100, h: 50 },
        b: { kind: 'shape', shape: 'rect', w: 100, h: 50 },
      },
      scenes: [{
        id: 's1', narration: 'n',
        actions: [
          { at: 'start', do: 'fade-in', prop: 'a', x: 100, y: 100 },
          { at: 0.5,     do: 'fade-in', prop: 'b', x: 100, y: 300 },
        ],
      }],
    });
    resolveLayouts(doc);
    const acts = doc.scenes[0].actions;
    expect(acts.find(x => x.prop === 'b').y).toBe(300);
  });
});

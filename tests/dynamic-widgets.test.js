// Unit tests for lib/dynamic-widgets.js — pure helpers (no IO).

import { describe, it, expect } from 'vitest';
import {
  packWidgetResult, unpackWidgetResult,
  extractWidgetRegistrations, buildEphemeralToolDefs,
  isWidgetTool, parseWidgetToolName, buildWidgetSrcdoc,
} from '../lib/dynamic-widgets.js';

describe('dynamic-widgets / pack-unpack', () => {
  it('round-trips a widget registration', () => {
    const reg = { widgetId: 'wabc', tools: [{ name: 'go', description: 'd' }] };
    const packed = packWidgetResult({ ok: true, widgetId: 'wabc' }, reg);
    const out = unpackWidgetResult(packed);
    expect(out).toEqual(reg);
  });

  it('returns null for unrelated tool_result strings', () => {
    expect(unpackWidgetResult('{"ok":true}')).toBeNull();
    expect(unpackWidgetResult('not json')).toBeNull();
    expect(unpackWidgetResult(null)).toBeNull();
  });

  it('also exposes the public payload alongside the marker', () => {
    const packed = packWidgetResult({ ok: true, widgetId: 'w1', custom: 42 }, { widgetId: 'w1', tools: [] });
    const parsed = JSON.parse(packed);
    expect(parsed.ok).toBe(true);
    expect(parsed.custom).toBe(42);
    expect(parsed.widgetId).toBe('w1');
  });
});

describe('dynamic-widgets / extractWidgetRegistrations', () => {
  it('finds widget registrations in a message history', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      { role: 'tool', tool_call_id: '1', content: packWidgetResult(
        { ok: true, widgetId: 'wA' },
        { widgetId: 'wA', tools: [{ name: 'rotate' }] },
      )},
      { role: 'tool', tool_call_id: '2', content: 'plain result' },
    ];
    const regs = extractWidgetRegistrations(messages);
    expect(regs).toHaveLength(1);
    expect(regs[0].widgetId).toBe('wA');
  });

  it('returns the latest registration when the same widgetId is re-emitted', () => {
    const messages = [
      { role: 'tool', content: packWidgetResult({}, { widgetId: 'w1', tools: [{ name: 'a' }] }) },
      { role: 'tool', content: packWidgetResult({}, { widgetId: 'w1', tools: [{ name: 'b' }] }) },
    ];
    const regs = extractWidgetRegistrations(messages);
    expect(regs).toHaveLength(1);
    expect(regs[0].tools[0].name).toBe('b');
  });

  it('handles empty / malformed inputs safely', () => {
    expect(extractWidgetRegistrations(null)).toEqual([]);
    expect(extractWidgetRegistrations([])).toEqual([]);
    expect(extractWidgetRegistrations([{ role: 'tool', content: 'x' }])).toEqual([]);
  });
});

describe('dynamic-widgets / buildEphemeralToolDefs', () => {
  it('namespaces tools as w_<slug>__<name>', () => {
    const defs = buildEphemeralToolDefs([{
      widgetId: 'w-abc-123',
      tools: [
        { name: 'rotate', description: 'rot', parameters: { type: 'object', properties: { deg: { type: 'number' } } } },
        { name: 'export' },
      ],
    }]);
    expect(defs).toHaveLength(2);
    expect(defs[0].function.name).toBe('w_wabc123__rotate');
    expect(defs[1].function.name).toBe('w_wabc123__export');
    expect(defs[0].function.parameters.properties.deg.type).toBe('number');
  });

  it('skips invalid tool names and dedups per-widget', () => {
    const defs = buildEphemeralToolDefs([{
      widgetId: 'w1',
      tools: [
        { name: 'ok' },
        { name: '9bad' },         // starts with digit
        { name: 'ok' },           // dup
        { name: 'has space' },    // invalid
      ],
    }]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name.endsWith('__ok')).toBe(true);
  });

  it('caps total ephemeral tools across all widgets', () => {
    const widgets = [];
    for (let i = 0; i < 5; i++) {
      const tools = [];
      for (let j = 0; j < 8; j++) tools.push({ name: 't' + i + j });
      widgets.push({ widgetId: 'w' + i, tools });
    }
    const defs = buildEphemeralToolDefs(widgets);
    expect(defs.length).toBeLessThanOrEqual(24);
  });
});

describe('dynamic-widgets / parseWidgetToolName', () => {
  it('identifies widget tools and extracts parts', () => {
    expect(isWidgetTool('w_abc123__rotate')).toBe(true);
    expect(isWidgetTool('fauna_remember')).toBe(false);
    expect(parseWidgetToolName('w_abc123__rotate')).toEqual({
      widgetIdSlug: 'abc123',
      toolName: 'rotate',
    });
    expect(parseWidgetToolName('not_a_widget')).toBeNull();
  });
});

describe('dynamic-widgets / buildWidgetSrcdoc', () => {
  it('includes the widget id, CSP, and user js', () => {
    const html = buildWidgetSrcdoc({ widgetId: 'w42', html: '<p>hi</p>', js: 'widget.on("a",()=>1);' });
    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toContain('connect-src \'none\'');
    expect(html).toContain('"w42"');
    expect(html).toContain('widget.on("a"');
    expect(html).toContain('<p>hi</p>');
  });
});

// Tests for the pipeline expression engine (server/lib/expr-engine.js).

import { describe, it, expect } from 'vitest';
import { buildContext, evaluateExpression, interpolate, hasExpression } from '../server/lib/expr-engine.js';

function ctx(opts) { return buildContext(opts); }

describe('expr-engine: $json / $input', () => {
  it('parses a JSON-string input into $json fields', () => {
    const c = ctx({ input: '{"name":"Ada","age":36}' });
    expect(interpolate('{{ $json.name }}', c)).toBe('Ada');
    expect(interpolate('Age: {{ $json.age }}', c)).toBe('Age: 36');
  });

  it('leaves a non-JSON input as a plain string in $json', () => {
    const c = ctx({ input: 'hello world' });
    expect(interpolate('{{ $json }}', c)).toBe('hello world');
    expect(interpolate('{{ $input }}', c)).toBe('hello world');
  });

  it('single-expression template returns the typed value (object passthrough)', () => {
    const c = ctx({ input: '{"a":1}' });
    const out = interpolate('{{ $json }}', c);
    expect(out).toEqual({ a: 1 });
  });
});

describe('expr-engine: $node by id and label', () => {
  it('resolves upstream output by node id', () => {
    const c = ctx({ input: null, nodeOutputs: { n1: 'result-A' }, labels: { n1: 'Fetch' } });
    expect(interpolate('{{ $node.n1.output }}', c)).toBe('result-A');
  });

  it('resolves upstream output by label', () => {
    const c = ctx({ input: null, nodeOutputs: { n1: '{"v":42}' }, labels: { n1: 'Fetch' } });
    expect(interpolate('{{ $node["Fetch"].json.v }}', c)).toBe(42);
  });
});

describe('expr-engine: JS expressions + helpers', () => {
  it('supports string methods and arithmetic', () => {
    const c = ctx({ input: '{"name":"ada"}' });
    expect(interpolate('{{ $json.name.toUpperCase() }}', c)).toBe('ADA');
    expect(interpolate('{{ 2 + 3 * 4 }}', c)).toBe(14);
    expect(interpolate('sum={{ 2 + 3 * 4 }}', c)).toBe('sum=14');
  });

  it('exposes Math and JSON helpers', () => {
    const c = ctx({});
    expect(interpolate('{{ Math.max(1, 9, 4) }}', c)).toBe(9);
  });

  it('$today is an ISO date string', () => {
    const c = ctx({});
    expect(interpolate('{{ $today }}', c)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('expr-engine: $env allow-list', () => {
  it('only exposes FAUNA_EXPR_-prefixed vars (stripped of prefix)', () => {
    process.env.FAUNA_EXPR_REGION = 'eu';
    process.env.SECRET_TOKEN = 'should-not-leak';
    const c = ctx({});
    expect(interpolate('{{ $env.REGION }}', c)).toBe('eu');
    expect(interpolate('{{ $env.SECRET_TOKEN }}', c)).toBe('');
    delete process.env.FAUNA_EXPR_REGION;
    delete process.env.SECRET_TOKEN;
  });
});

describe('expr-engine: safety', () => {
  it('cannot access require/process/global', () => {
    const c = ctx({});
    expect(evaluateExpression('typeof process', c)).toBe('undefined');
    expect(evaluateExpression('typeof require', c)).toBe('undefined');
    expect(evaluateExpression('typeof global', c)).toBe('undefined');
  });

  it('errors evaluate to undefined (graceful)', () => {
    const c = ctx({});
    expect(evaluateExpression('this is not valid js !!!', c)).toBeUndefined();
    expect(interpolate('x={{ nope.deep.field }}', c)).toBe('x=');
  });
});

describe('expr-engine: hasExpression gate', () => {
  it('detects $-expressions but ignores plain templates', () => {
    expect(hasExpression('{{ $json.x }}')).toBe(true);
    expect(hasExpression('{{ nodeId }}')).toBe(false);
    expect(hasExpression('no braces')).toBe(false);
  });

  it('interpolate leaves non-expression strings untouched', () => {
    const c = ctx({});
    expect(interpolate('plain text', c)).toBe('plain text');
  });
});

describe('expr-engine: $items / $item / $binary', () => {
  const items = [
    { json: { id: 1, name: 'a' } },
    { json: { id: 2, name: 'b' }, binary: { file: { data: 'AAA', mimeType: 'image/png', fileName: 'b.png' } } },
  ];

  it('$items exposes the full item array; $item defaults to the first', () => {
    const c = ctx({ items });
    expect(interpolate('{{ $items.length }}', c)).toBe(2);
    expect(interpolate('{{ $item.json.name }}', c)).toBe('a');
    expect(interpolate('{{ $json.name }}', c)).toBe('a');
  });

  it('scopes $json/$item/$binary to the supplied current item', () => {
    const c = ctx({ items, item: items[1] });
    expect(interpolate('{{ $json.id }}', c)).toBe(2);
    expect(interpolate('{{ $binary.file.fileName }}', c)).toBe('b.png');
  });

  it('$binary is an empty object when the item has none', () => {
    const c = ctx({ items, item: items[0] });
    expect(interpolate('{{ Object.keys($binary).length }}', c)).toBe(0);
  });
});


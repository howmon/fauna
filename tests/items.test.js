// Tests for the item model (server/lib/items.js) — n8n-style item arrays that
// bridge Fauna's legacy single-value node outputs to per-item fan-out + merge.

import { describe, it, expect } from 'vitest';
import {
  isItemArray, isItem, brandItems, toItems, toItem, fromItems, displayOutput, makeBinary,
} from '../server/lib/items.js';

describe('toItems normalisation', () => {
  it('wraps a scalar into a single item', () => {
    const items = toItems('hello');
    expect(isItemArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0].json).toBe('hello');
  });

  it('expands a plain array into one item per element', () => {
    const items = toItems([1, 2, 3]);
    expect(items).toHaveLength(3);
    expect(items.map(i => i.json)).toEqual([1, 2, 3]);
  });

  it('parses a JSON-array string into items', () => {
    const items = toItems('[{"a":1},{"a":2}]');
    expect(items).toHaveLength(2);
    expect(items[1].json).toEqual({ a: 2 });
  });

  it('returns an existing branded item array unchanged', () => {
    const orig = brandItems([{ json: 1 }]);
    expect(toItems(orig)).toBe(orig);
  });

  it('wraps a single item shape', () => {
    const items = toItems({ json: { x: 1 }, binary: { f: {} } });
    expect(items).toHaveLength(1);
    expect(items[0].json).toEqual({ x: 1 });
  });

  it('treats a plain object (no json key) as one item', () => {
    const items = toItems({ x: 1 });
    expect(items).toHaveLength(1);
    expect(items[0].json).toEqual({ x: 1 });
  });
});

describe('isItem / isItemArray', () => {
  it('distinguishes branded arrays from plain arrays of objects', () => {
    expect(isItemArray([{ json: 1 }])).toBe(false); // not branded
    expect(isItemArray(brandItems([{ json: 1 }]))).toBe(true);
  });
  it('isItem detects json-shaped objects', () => {
    expect(isItem({ json: 1 })).toBe(true);
    expect(isItem({ x: 1 })).toBe(false);
    expect(isItem([{ json: 1 }])).toBe(false);
    expect(isItem(null)).toBe(false);
  });
});

describe('fromItems collapse', () => {
  it('single item -> its json', () => {
    expect(fromItems(toItems('a'))).toBe('a');
  });
  it('many items -> array of json', () => {
    expect(fromItems(toItems([1, 2]))).toEqual([1, 2]);
  });
  it('empty item array -> null', () => {
    expect(fromItems(brandItems([]))).toBe(null);
  });
  it('non-item value passes through', () => {
    expect(fromItems('plain')).toBe('plain');
  });
});

describe('displayOutput', () => {
  it('renders a single-item array as its json text', () => {
    expect(displayOutput(toItems('hi'))).toBe('hi');
  });
  it('renders a multi-item array as JSON', () => {
    expect(displayOutput(toItems([1, 2]))).toBe('[1,2]');
  });
  it('stringifies a plain object', () => {
    expect(displayOutput({ a: 1 })).toBe('{"a":1}');
  });
  it('renders null/undefined as empty string', () => {
    expect(displayOutput(null)).toBe('');
    expect(displayOutput(undefined)).toBe('');
  });
});

describe('toItem', () => {
  it('passes an item through, wraps a scalar', () => {
    const it = { json: 1 };
    expect(toItem(it)).toBe(it);
    expect(toItem('x')).toEqual({ json: 'x' });
  });
});

describe('makeBinary', () => {
  it('base64-encodes a Buffer with metadata', () => {
    const b = makeBinary(Buffer.from('PNGDATA'), { mimeType: 'image/png', fileName: 'a.png' });
    expect(b.data).toBe(Buffer.from('PNGDATA').toString('base64'));
    expect(b.mimeType).toBe('image/png');
    expect(b.fileName).toBe('a.png');
  });
  it('accepts a base64 string directly and defaults metadata', () => {
    const b = makeBinary('YWJj');
    expect(b.data).toBe('YWJj');
    expect(b.mimeType).toBe('application/octet-stream');
  });
});

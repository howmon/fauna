import { describe, it, expect } from 'vitest';
import { compressToolOutput } from '../server/lib/compress-tool-output.js';

describe('compressToolOutput', () => {
  it('passes through output under the cap byte-identical', () => {
    const small = JSON.stringify([{ a: 1 }, { a: 2 }]);
    const r = compressToolOutput(small, { cap: 40000 });
    expect(r.modified).toBe(false);
    expect(r.text).toBe(small);
  });

  it('keeps an error item buried in the middle of a large array', () => {
    const items = [];
    for (let i = 0; i < 1000; i++) {
      items.push(i === 500 ? { id: i, status: 'ERROR: disk full' } : { id: i, status: 'ok' });
    }
    const raw = JSON.stringify(items);
    const r = compressToolOutput(raw, { cap: 4000 });
    expect(r.modified).toBe(true);
    expect(r.text.length).toBeLessThan(raw.length);
    expect(r.text).toContain('disk full');
    expect(r.original).toBe(raw);
  });

  it('keeps query-relevant rows', () => {
    const items = [];
    for (let i = 0; i < 1000; i++) {
      items.push({ id: i, name: i === 742 ? 'payment-service' : `svc-${i}` });
    }
    const raw = JSON.stringify(items);
    const r = compressToolOutput(raw, { cap: 4000, query: 'check the payment-service logs' });
    expect(r.modified).toBe(true);
    expect(r.text).toContain('payment-service');
  });

  it('compresses a wrapper object with a results array', () => {
    const results = [];
    for (let i = 0; i < 800; i++) results.push({ id: i, v: 'x'.repeat(20) });
    const raw = JSON.stringify({ total: 800, results });
    const r = compressToolOutput(raw, { cap: 3000 });
    expect(r.modified).toBe(true);
    expect(r.text.length).toBeLessThan(raw.length);
    // wrapper shape preserved (JSON portion parses)
    const jsonPart = r.text.split('\n')[0];
    const parsed = JSON.parse(jsonPart);
    expect(parsed.total).toBe(800);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeLessThan(800);
  });

  it('surfaces a FATAL line buried deep in a long log', () => {
    const lines = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(i === 4000 ? `line ${i} FATAL kernel panic` : `line ${i} info ok`);
    }
    const raw = lines.join('\n');
    const r = compressToolOutput(raw, { cap: 3000 });
    expect(r.modified).toBe(true);
    expect(r.text.length).toBeLessThan(raw.length);
    expect(r.text).toContain('FATAL kernel panic');
  });

  it('head/tail truncates non-line-structured oversized text', () => {
    const raw = 'x'.repeat(10000);
    const r = compressToolOutput(raw, { cap: 2000 });
    expect(r.modified).toBe(true);
    expect(r.text.length).toBeLessThan(raw.length);
    expect(r.text).toContain('truncated');
  });
});

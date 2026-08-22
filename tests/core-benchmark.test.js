import { describe, expect, it } from 'vitest';
import { percentile, runCoreBenchmarks } from '../scripts/benchmark-core.mjs';

describe('core benchmark contract', () => {
  it('calculates nearest-rank percentiles', () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
  });

  it('reports reproducible workload definitions and correctness', () => {
    const report = runCoreBenchmarks({ scale: 0.01 });
    expect(report.schemaVersion).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.results.map(result => result.name)).toEqual([
      'execution-event-envelope',
      'ledger-append-read-replay',
      'skill-routing',
      'vector-scoring',
    ]);
    for (const result of report.results) {
      expect(result.correctness).toBe(true);
      expect(result.samples).toBeGreaterThan(0);
      expect(result.workload).toBeTypeOf('object');
      expect(result.timingMs.p95).toBeGreaterThanOrEqual(0);
      expect(result.timingMs.stddev).toBeGreaterThanOrEqual(0);
    }
  });
});
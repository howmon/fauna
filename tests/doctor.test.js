import { describe, it, expect } from 'vitest';
import { runDoctor, formatDoctorReport } from '../server/lib/doctor.js';

describe('doctor', () => {
  it('runDoctor returns a structured report with per-check status', async () => {
    const report = await runDoctor();
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBe(report.total);
    expect(report.total).toBeGreaterThan(0);

    for (const c of report.checks) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.channel).toBe('string');
      expect(Array.isArray(c.backends)).toBe(true);
      expect(c).toHaveProperty('activeBackend');
      expect(['ok', 'warn', 'fail', 'off']).toContain(c.status);
      expect(typeof c.message).toBe('string');
    }
  });

  it('counts add up to the total number of checks', async () => {
    const report = await runDoctor();
    const { ok, warn, fail, off } = report.counts;
    expect(ok + warn + fail + off).toBe(report.total);
  });

  it('always reports the always-on capabilities as ok', async () => {
    const report = await runDoctor();
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    // Built-in fetch and the local stores have no external deps.
    expect(byName['Web fetch'].status).toBe('ok');
    expect(byName['Memory (facts)'].status).toBe('ok');
    expect(byName['Context store'].status).toBe('ok');
  });

  it('warn/fail checks carry a fix hint', async () => {
    const report = await runDoctor();
    for (const c of report.checks) {
      if (c.status === 'warn' || c.status === 'fail') {
        // A fix is expected for actionable non-ok states (the Local LLM check
        // never warns — "not configured" is reported as ok).
        expect(typeof c.fix === 'string' && c.fix.length > 0).toBe(true);
      }
    }
  });

  it('formatDoctorReport renders an icon line per check plus a summary', async () => {
    const report = await runDoctor();
    const text = formatDoctorReport(report);
    expect(text).toContain('Fauna Doctor');
    expect(text).toMatch(/healthy/);
    for (const c of report.checks) {
      expect(text).toContain(c.name);
    }
  });
});

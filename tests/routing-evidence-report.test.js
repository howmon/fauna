import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordRoutingDecision, recordRoutingOutcome } from '../lib/routing-evidence.js';
import { parseArgs, runRoutingEvidenceReport } from '../scripts/report-routing-evidence.mjs';

describe('routing evidence report CLI', () => {
  it('parses file and output arguments', () => {
    expect(parseArgs(['--file', 'input.jsonl', '--output', 'report.json'])).toEqual({
      file: 'input.jsonl',
      output: 'report.json',
    });
  });

  it('writes the deterministic report to the requested path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-routing-report-'));
    const file = path.join(dir, 'evidence.jsonl');
    const output = path.join(dir, 'reports', 'summary.json');
    recordRoutingDecision({ episodeId: 'episode-1', router: 'skill', query: 'debug', selection: 'debugging' }, { file, timestamp: 100 });
    recordRoutingOutcome({ episodeId: 'episode-1', verified: true }, { file, timestamp: 200 });

    const { report, json } = runRoutingEvidenceReport({ file, output });
    expect(report.totals).toMatchObject({ decisions: 1, matched: 1, passed: 1 });
    expect(fs.readFileSync(output, 'utf8')).toBe(json);
    expect(JSON.parse(json)).toEqual(report);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
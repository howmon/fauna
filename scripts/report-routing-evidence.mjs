#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoutingEvidenceReport } from '../lib/routing-evidence.js';

export function parseArgs(argv = []) {
  const fileIndex = argv.indexOf('--file');
  const outputIndex = argv.indexOf('--output');
  return {
    file: fileIndex >= 0 ? argv[fileIndex + 1] : null,
    output: outputIndex >= 0 ? argv[outputIndex + 1] : null,
  };
}

export function runRoutingEvidenceReport(opts = {}) {
  const report = buildRoutingEvidenceReport({
    file: opts.file ? path.resolve(opts.file) : undefined,
  });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (opts.output) {
    const output = path.resolve(opts.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, json);
  }
  return { report, json };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { report, json } = runRoutingEvidenceReport(parseArgs(process.argv.slice(2)));
  process.stdout.write(json);
  if (report.totals.events > 0 && report.totals.matched === 0) process.exitCode = 2;
}
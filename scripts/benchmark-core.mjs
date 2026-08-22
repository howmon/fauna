#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createExecutionEvent, appendEvent, readEvents, replay, EVENT_TYPES } from '../lib/run-ledger.js';
import { buildCatalog, routeSkill } from '../lib/skill-catalog.js';
import { prepareQuery, scoreStored } from '../server/lib/embeddings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function summarize(name, samples, workload, correctness) {
  const meanMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + ((value - meanMs) ** 2), 0) / samples.length;
  return {
    name,
    workload,
    samples: samples.length,
    correctness,
    timingMs: {
      mean: Number(meanMs.toFixed(4)),
      p50: Number(percentile(samples, 0.5).toFixed(4)),
      p95: Number(percentile(samples, 0.95).toFixed(4)),
      stddev: Number(Math.sqrt(variance).toFixed(4)),
      min: Number(Math.min(...samples).toFixed(4)),
      max: Number(Math.max(...samples).toFixed(4)),
    },
  };
}

function sample(iterations, operation) {
  const values = [];
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    operation(index);
    values.push(performance.now() - started);
  }
  return values;
}

function skillCatalog() {
  const skillsRoot = path.join(ROOT, 'skills');
  const skills = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
    .map(entry => ({
      name: entry.name,
      path: path.join(skillsRoot, entry.name, 'SKILL.md'),
      scope: 'bundled',
    }));
  return buildCatalog(skills);
}

export function runCoreBenchmarks(opts = {}) {
  const scale = Math.max(0.01, Number(opts.scale) || 1);
  const computeSamples = Math.max(5, Math.round(500 * scale));
  const ioSamples = Math.max(3, Math.round(20 * scale));
  const results = [];

  let finalEvent;
  const envelope = sample(computeSamples, index => {
    finalEvent = createExecutionEvent({ type: 'benchmark.event', runId: `run-${index}`, payload: { index } });
  });
  results.push(summarize('execution-event-envelope', envelope, {
    operation: 'createExecutionEvent',
    eventsPerSample: 1,
  }, finalEvent?.schemaVersion === 1 && finalEvent?.correlationId === finalEvent?.runId));

  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-benchmark-ledger-'));
  let replayed;
  const ledger = sample(ioSamples, index => {
    const file = path.join(ledgerDir, `${index}.jsonl`);
    appendEvent(file, { type: EVENT_TYPES.RUN_START, runId: `run-${index}` });
    for (let action = 0; action < 50; action++) appendEvent(file, { type: EVENT_TYPES.ACTION, runId: `run-${index}` });
    appendEvent(file, { type: EVENT_TYPES.RUN_END, runId: `run-${index}`, status: 'done' });
    replayed = replay(readEvents(file));
  });
  fs.rmSync(ledgerDir, { recursive: true, force: true });
  results.push(summarize('ledger-append-read-replay', ledger, {
    operation: 'append 52 JSONL events, read, parse, and replay',
    eventsPerSample: 52,
  }, replayed?.actions === 50 && replayed?.status === 'done'));

  const catalog = skillCatalog();
  const queries = [
    ['diagnose an intermittent production crash', 'diagnosing-bugs'],
    ['write a failing test before implementing behavior', 'test-driven-development'],
    ['clarify acceptance criteria for an ambiguous feature', 'spec-driven-development'],
  ];
  let routingCorrect = true;
  const routing = sample(computeSamples, index => {
    const [query, expected] = queries[index % queries.length];
    routingCorrect = routingCorrect && routeSkill(query, catalog).top === expected;
  });
  results.push(summarize('skill-routing', routing, {
    operation: 'route one fixed query over bundled skills',
    catalogSize: catalog.docs.length,
    queryCount: queries.length,
  }, routingCorrect));

  const dimension = 256;
  const query = Array.from({ length: dimension }, (_, index) => Math.sin(index + 1));
  const candidate = Array.from({ length: dimension }, (_, index) => Math.cos(index + 1));
  const prepared = prepareQuery(query);
  let score;
  const vector = sample(computeSamples, () => { score = scoreStored(prepared, candidate); });
  results.push(summarize('vector-scoring', vector, {
    operation: 'scoreStored cosine against fp32 vector',
    dimensions: dimension,
  }, Number.isFinite(score) && score >= -1 && score <= 1));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: os.cpus()[0]?.model || 'unknown',
      cpuCount: os.cpus().length,
      memoryBytes: os.totalmem(),
    },
    policy: 'Measurements are local evidence, not release thresholds or published speed claims.',
    scale,
    ok: results.every(result => result.correctness),
    results,
  };
}

function parseArgs(argv) {
  const scaleIndex = argv.indexOf('--scale');
  const outputIndex = argv.indexOf('--output');
  return {
    scale: scaleIndex >= 0 ? Number(argv[scaleIndex + 1]) : 1,
    output: outputIndex >= 0 ? argv[outputIndex + 1] : null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const report = runCoreBenchmarks({ scale: args.scale });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (args.output) fs.writeFileSync(path.resolve(args.output), json);
  process.stdout.write(json);
  if (!report.ok) process.exitCode = 1;
}
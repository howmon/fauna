import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scrubSecrets } from './redactor.js';

const execFileAsync = promisify(execFile);
export const TEST_OUTPUT_LIMIT = 64 * 1024;
const RECENT_RUN_LIMIT = 20;
const ACTIVE_STATUSES = new Set(['running', 'stopping']);

export function isTestCommand(command) {
  const executable = '(?:["\\\']?(?:[^\\s"\\\']*[/\\\\])?)';
  const manager = executable + '(?:bun|npm|pnpm|yarn)["\\\']?\\s+(?:run\\s+)?test(?::[\\w:-]+)?\\b';
  const runner = '(?:npx\\s+(?:--no-install\\s+)?)?' + executable + '(?:vitest|jest|pytest)["\\\']?\\b';
  const other = executable + 'python(?:3)?["\\\']?\\s+-m\\s+pytest\\b|' +
    executable + 'node["\\\']?\\s+--test\\b|(?:cargo|go|mvn|gradle)\\s+test\\b';
  return new RegExp('(?:^|[;&|\\n])\\s*(?:env\\s+)?(?:[A-Za-z_]\\w*=(?:"[^"]*"|\\\'[^\\\']*\\\'|\\S+)\\s+)*(?:' +
    manager + '|' + runner + '|' + other + ')').test(String(command || ''));
}

export async function readProcessMemory() {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress'],
    { timeout: 2500, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    const data = JSON.parse(stdout);
    return (Array.isArray(data) ? data : [data]).map(row => {
      const pid = Number(row.ProcessId);
      const ppid = Number(row.ParentProcessId);
      const rssBytes = Number(row.WorkingSetSize);
      if (![pid, ppid, rssBytes].every(Number.isFinite) || rssBytes < 0) {
        throw new Error('Invalid process memory sample');
      }
      return { pid, ppid, pgid: null, rssBytes };
    });
  }
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,rss='],
    { timeout: 2500, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [pid, ppid, pgid, rssKb] = line.trim().split(/\s+/).map(Number);
    if (![pid, ppid, pgid, rssKb].every(Number.isFinite)) throw new Error('Invalid process memory sample');
    return { pid, ppid, pgid, rssBytes: rssKb * 1024 };
  });
}

export function processTreeMemory(rows, rootPid) {
  const selected = new Set([rootPid]);
  for (const row of rows) if (row.pgid === rootPid) selected.add(row.pid);
  let previousSize;
  do {
    previousSize = selected.size;
    for (const row of rows) if (selected.has(row.ppid)) selected.add(row.pid);
  } while (selected.size !== previousSize);
  const processes = rows.filter(row => selected.has(row.pid));
  return {
    rssBytes: processes.reduce((sum, row) => sum + row.rssBytes, 0),
    processCount: processes.length,
    sampledAt: Date.now(),
  };
}

export function createTestRunRegistry({ sampleMemory = readProcessMemory } = {}) {
  const runs = new Map();
  let memoryPromise = null;
  let memorySample = null;
  let lastSampleAt = 0;
  let finishedOrder = 0;

  function prune() {
    [...runs.values()].filter(run => !ACTIVE_STATUSES.has(run.status))
      .sort((a, b) => b.finishedOrder - a.finishedOrder)
      .slice(RECENT_RUN_LIMIT).forEach(run => runs.delete(run.id));
  }

  function start({ command, cwd, pid, context = {}, stop }) {
    const id = randomUUID();
    runs.set(id, {
      id, command: scrubSecrets(String(command)).text.slice(0, 4096), cwd,
      pid: pid || null, kind: isTestCommand(command) ? 'test' : 'command',
      conversationId: context.conversationId || null, projectId: context.projectId || null,
      runId: context.runId || null, source: context.source || 'shell',
      startedAt: Date.now(), finishedAt: null, status: 'running',
      output: '', outputTruncated: false, lastOutputAt: null,
      exitCode: null, memory: null, stop,
    });
    return id;
  }

  function append(id, text) {
    const run = runs.get(id);
    if (!run) return;
    // Retain a little extra before redaction so tokens split across output
    // chunks are scrubbed as a whole, then bound the displayed tail.
    run.output = (run.output + String(text)).slice(-TEST_OUTPUT_LIMIT * 2);
    run.outputTruncated ||= run.output.length > TEST_OUTPUT_LIMIT;
    run.lastOutputAt = Date.now();
  }

  function stopping(id) {
    const run = runs.get(id);
    if (run && ACTIVE_STATUSES.has(run.status)) run.status = 'stopping';
  }

  function finish(id, result) {
    const run = runs.get(id);
    if (!run) return;
    run.status = result.timedOut ? 'timed_out' : result.killed ? 'stopped' : result.ok ? 'passed' : 'failed';
    run.exitCode = result.exitCode;
    run.finishedAt = Date.now();
    run.finishedOrder = ++finishedOrder;
    run.stop = null;
    prune();
  }

  async function refreshMemory() {
    if (!memoryPromise && (!memorySample || Date.now() - lastSampleAt >= 1000)) {
      memoryPromise = Promise.resolve().then(sampleMemory).then(rows => ({ rows, error: null })).catch(error => {
        console.warn('[test-monitor] process memory unavailable:', error.message);
        return { rows: null, error: error.message };
      }).then(sample => {
        memorySample = sample;
        lastSampleAt = Date.now();
        memoryPromise = null;
        return sample;
      });
    }
    const sample = memoryPromise ? await memoryPromise : memorySample;
    for (const run of runs.values()) {
      if (ACTIVE_STATUSES.has(run.status) && run.pid) {
        run.memory = sample.rows ? processTreeMemory(sample.rows, run.pid) : null;
      }
    }
    return sample.error;
  }

  function serialize(run, output = false) {
    const { stop, finishedOrder, output: rawOutput, ...data } = run;
    if (output) data.output = scrubSecrets(rawOutput).text.slice(-TEST_OUTPUT_LIMIT);
    return data;
  }

  async function list({ memory = false } = {}) {
    const memoryError = memory && [...runs.values()].some(run => ACTIVE_STATUSES.has(run.status))
      ? await refreshMemory() : null;
    const active = [...runs.values()].filter(run => ACTIVE_STATUSES.has(run.status));
    return {
      items: [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).map(run => serialize(run)),
      activeCount: active.length,
      testCount: active.filter(run => run.kind === 'test').length,
      memoryError,
    };
  }

  function get(id) {
    const run = runs.get(id);
    return run ? serialize(run, true) : null;
  }

  function stop(id) {
    const run = runs.get(id);
    if (!run) return { ok: false, status: 404, error: 'Test command not found' };
    if (!ACTIVE_STATUSES.has(run.status) || !run.stop) {
      return { ok: false, status: 409, error: 'This command has already finished' };
    }
    stopping(id);
    run.stop();
    return { ok: true };
  }

  return { start, append, stopping, finish, list, get, stop };
}

export const testRunRegistry = createTestRunRegistry();

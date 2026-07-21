import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearWorkspaceIndexes } from '../lib/workspace-index.js';
import { buildTestCommand, discoverTestsInSource, discoverWorkspaceTests, normalizeTestRun, parseFailureLocations } from '../lib/test-service.js';

const dirs = [];
afterEach(() => {
  clearWorkspaceIndexes();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('test service', () => {
  it('discovers nested suites with precise source locations', () => {
    const tests = discoverTestsInSource({ file: 'math.test.ts', content: [
      "describe('calculator', () => {",
      "  test('adds', () => {});",
      "  describe('negative', () => { it('adds', () => {}); });",
      '});',
    ].join('\n') });
    expect(tests).toMatchObject([
      { fullName: 'calculator > adds', line: 2, file: 'math.test.ts' },
      { fullName: 'calculator > negative > adds', line: 3, file: 'math.test.ts' },
    ]);
  });

  it('discovers a Vitest workspace from its package and files', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-tests-'));
    dirs.push(cwd);
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^4' } }));
    fs.mkdirSync(path.join(cwd, 'tests'));
    fs.writeFileSync(path.join(cwd, 'tests', 'unit.test.js'), "it('works', () => {});");
    const result = discoverWorkspaceTests({ cwd });
    expect(result).toMatchObject({ framework: 'vitest', total: 1 });
    expect(result.files[0].tests[0].name).toBe('works');
    expect(discoverWorkspaceTests({ cwd }).cache.hit).toBe(true);
  });

  it('builds a focused command without interpolating raw shell text', () => {
    expect(buildTestCommand({ framework: 'vitest', file: 'tests/a.test.js', fullName: "suite > user's case" }))
      .toBe("npx vitest run --reporter=json 'tests/a.test.js' -t 'suite user'\"'\"'s case'");
  });

  it('uses an ephemeral inspector port for debug runs', () => {
    expect(buildTestCommand({ framework: 'vitest', file: 'a.test.js', debug: true, debugPort: 43123 })).toContain('--inspectBrk 127.0.0.1:43123');
    expect(buildTestCommand({ framework: 'node', file: 'a.test.js', debug: true, debugPort: 43124 })).toContain('--inspect-brk=127.0.0.1:43124');
  });

  it('normalizes JSON reporter results', () => {
    const stdout = JSON.stringify({ testResults: [{ assertionResults: [
      { fullName: 'math adds', status: 'passed', duration: 4 },
      { fullName: 'math subtracts', status: 'failed', failureMessages: ['expected 2'] },
    ] }] });
    expect(normalizeTestRun({ framework: 'vitest', stdout, exitCode: 1 })).toMatchObject({
      ok: false, counts: { passed: 1, failed: 1, skipped: 0 },
    });
  });

  it('excludes framework-filtered tests from a focused run', () => {
    const stdout = JSON.stringify({ testResults: [{ assertionResults: [
      { fullName: 'math adds', status: 'passed' },
      { fullName: 'math subtracts', status: 'skipped' },
    ] }] });
    expect(normalizeTestRun({ framework: 'vitest', stdout, fullName: 'math > adds' })).toMatchObject({
      counts: { passed: 1, failed: 0, skipped: 0 }, tests: [{ fullName: 'math adds' }],
    });
    expect(normalizeTestRun({ framework: 'vitest', stdout, fullName: 'math > adds' }).output).toBe('PASS  math adds');
  });

  it('extracts navigable project failure locations', () => {
    const root = path.join(os.tmpdir(), 'project');
    expect(parseFailureLocations(`at add (${path.join(root, 'src/math.ts')}:9:4)`, root)[0])
      .toMatchObject({ file: 'src/math.ts', line: 9, column: 4 });
  });
});
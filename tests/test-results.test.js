import { describe, it, expect, vi } from 'vitest';

import { parseTestResults, runTestResults } from '../lib/test-results.js';
import { executeSelfTool } from '../self-tools.js';

describe('test results parser', () => {
  it('extracts Vitest-style failures', () => {
    const parsed = parseTestResults([
      ' FAIL  tests/example.test.js > feature > handles edge case',
      'AssertionError: expected true to be false',
      ' Test Files  1 failed | 2 passed (3)',
    ].join('\n'));

    expect(parsed.failures).toEqual([
      { name: 'tests/example.test.js > feature > handles edge case', message: 'AssertionError: expected true to be false', source: 'js-test' },
    ]);
    expect(parsed.summary.failed).toBe(1);
  });

  it('extracts pytest failures', () => {
    const parsed = parseTestResults('FAILED tests/test_api.py::test_auth - AssertionError: denied');

    expect(parsed.failures).toEqual([
      { name: 'tests/test_api.py::test_auth', message: 'AssertionError: denied', source: 'pytest' },
    ]);
  });

  it('extracts go test failures', () => {
    const parsed = parseTestResults('--- FAIL: TestWidget (0.12s)');

    expect(parsed.failures).toEqual([
      { name: 'TestWidget', duration: '0.12s', source: 'go-test' },
    ]);
  });

  it('runs a command through runShell and parses the output', async () => {
    const runShell = vi.fn(async () => 'FAILED tests/test_api.py::test_auth - AssertionError: denied');

    const result = await runTestResults({ command: 'pytest', cwd: '/tmp/project', runShell });

    expect(runShell).toHaveBeenCalledWith({
      command: 'pytest',
      cwd: '/tmp/project',
      timeoutMs: 180000,
      reason: 'structured test results',
    });
    expect(result.ok).toBe(true);
    expect(result.failures[0].name).toBe('tests/test_api.py::test_auth');
  });

  it('is exposed through fauna_test_results for supplied output', async () => {
    const raw = await executeSelfTool('fauna_test_results', {
      output: 'FAILED tests/test_api.py::test_auth - AssertionError: denied',
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(result.failures[0].source).toBe('pytest');
  });
});
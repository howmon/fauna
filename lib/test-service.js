import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { getWorkspaceIndex } from './workspace-index.js';

const TEST_FILE_RE = /(?:^|\/)(?:__tests__\/.*|[^/]*\.(?:test|spec))\.[cm]?[jt]sx?$/i;
const TEST_NAMES = new Set(['it', 'test']);
const SUITE_NAMES = new Set(['describe', 'suite']);
const _discoveryCache = new Map();

function _literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function _callName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return _callName(node.expression);
  return '';
}

function _location(source, node) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: start.line + 1, column: start.character + 1 };
}

export function discoverTestsInSource({ content, file = 'unknown.test.js' }) {
  const source = ts.createSourceFile(file, String(content || ''), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const tests = [];

  function visit(node, suites = []) {
    if (ts.isCallExpression(node)) {
      const name = _callName(node.expression);
      const title = _literalText(node.arguments[0]);
      if (title && SUITE_NAMES.has(name)) {
        const callback = node.arguments[1];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          ts.forEachChild(callback.body, child => visit(child, suites.concat(title)));
          return;
        }
      }
      if (title && TEST_NAMES.has(name)) {
        const location = _location(source, node);
        tests.push({
          id: `${file}:${location.line}:${location.column}`,
          name: title,
          fullName: suites.concat(title).join(' > '),
          file,
          ...location,
          status: 'idle',
        });
        return;
      }
    }
    ts.forEachChild(node, child => visit(child, suites));
  }

  visit(source);
  return tests;
}

function _detectFramework(root, pkg = {}) {
  const all = JSON.stringify({ scripts: pkg.scripts || {}, dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {} });
  if (/vitest/i.test(all)) return 'vitest';
  if (/@playwright\/test|playwright\s+test/i.test(all)) return 'playwright';
  if (/\bjest\b/i.test(all)) return 'jest';
  if (/node\s+--test/i.test(all)) return 'node';
  if (fs.existsSync(path.join(root, 'vitest.config.js')) || fs.existsSync(path.join(root, 'vitest.config.ts'))) return 'vitest';
  if (fs.existsSync(path.join(root, 'playwright.config.js')) || fs.existsSync(path.join(root, 'playwright.config.ts'))) return 'playwright';
  return 'node';
}

export function discoverWorkspaceTests(opts = {}) {
  const root = path.resolve(opts.cwd || process.cwd());
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (_) {}
  const framework = _detectFramework(root, pkg);
  const index = getWorkspaceIndex({ cwd: root });
  const cached = _discoveryCache.get(root);
  if (!opts.force && index.cache.hit && cached) return { ...cached, cache: { hit: true } };
  const files = [];
  let total = 0;
  for (const entry of index.entries) {
    if (!TEST_FILE_RE.test(entry.path)) continue;
    const tests = discoverTestsInSource({ content: entry.text, file: entry.path });
    if (!tests.length) continue;
    files.push({ id: entry.path, path: entry.path, name: path.basename(entry.path), tests, status: 'idle' });
    total += tests.length;
  }
  const result = { ok: true, root, framework, files, total, discoveredAt: Date.now(), cache: { hit: false } };
  _discoveryCache.set(root, result);
  return result;
}

function _shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function buildTestCommand({ framework, file, fullName, debug = false, debugPort = 9229 } = {}) {
  const target = file ? ` ${_shellQuote(file)}` : '';
  const pattern = fullName ? _shellQuote(fullName.replace(/ > /g, ' ')) : '';
  if (framework === 'vitest') return `npx vitest run --reporter=json${debug ? ` --inspectBrk 127.0.0.1:${debugPort} --no-file-parallelism` : ''}${target}${pattern ? ` -t ${pattern}` : ''}`;
  if (framework === 'jest') {
    const runner = debug ? `node --inspect-brk=127.0.0.1:${debugPort} ./node_modules/jest/bin/jest.js` : 'npx jest';
    return `${runner} --runInBand --json${target}${pattern ? ` -t ${pattern}` : ''}`;
  }
  if (framework === 'playwright') return `${debug ? 'PWDEBUG=1 ' : ''}npx playwright test --reporter=json${target}${pattern ? ` -g ${pattern}` : ''}`;
  const inspect = debug ? ` --inspect-brk=127.0.0.1:${debugPort}` : '';
  return `node${inspect} --test${target}${pattern ? ` --test-name-pattern=${pattern}` : ''}`;
}

export function parseFailureLocations(output = '', root = process.cwd()) {
  const locations = [];
  const seen = new Set();
  const locationRe = /(?:\(|\s|^)((?:[A-Za-z]:)?[^\s():]+\.[a-z0-9]+):(\d+):(\d+)(?:\)|\s|$)/gi;
  for (const line of String(output || '').split('\n')) {
    let match;
    while ((match = locationRe.exec(line))) {
      const absolute = path.resolve(root, match[1]);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (relative.startsWith('..')) continue;
      const key = `${relative}:${match[2]}:${match[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push({ file: relative, line: Number(match[2]), column: Number(match[3]), message: line.trim() });
    }
  }
  return locations.slice(0, 200);
}

function _status(value) {
  const text = String(value || '').toLowerCase();
  if (/pass|success/.test(text)) return 'passed';
  if (/skip|pending|todo|disabled/.test(text)) return 'skipped';
  return 'failed';
}

export function normalizeTestRun({ framework, stdout = '', stderr = '', exitCode = 0, root = process.cwd(), fullName = null } = {}) {
  const output = String(stdout || '') + (stderr ? `\n${stderr}` : '');
  const tests = [];
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    const suites = parsed.testResults || parsed.suites || [];
    for (const suite of suites) {
      const assertions = suite.assertionResults || suite.specs || suite.tests || [];
      for (const item of assertions) {
        tests.push({
          fullName: item.fullName || item.title || item.name || '',
          status: _status(item.status || item.outcome),
          duration: Number(item.duration || 0),
          failure: (item.failureMessages || item.errors || []).map(value => typeof value === 'string' ? value : value.message).filter(Boolean).join('\n'),
        });
      }
    }
  } catch (_) {
    for (const line of output.split('\n')) {
      const match = line.match(/^\s*(?:ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/i);
      if (match) tests.push({ fullName: match[1].trim(), status: /^\s*ok/i.test(line) ? 'passed' : 'failed', duration: 0, failure: '' });
    }
  }
  const wanted = fullName ? String(fullName).replace(/ > /g, ' ') : null;
  const selectedTests = wanted ? tests.filter(test => test.fullName === wanted || test.fullName.endsWith(wanted)) : tests;
  const counts = selectedTests.reduce((acc, test) => { acc[test.status] = (acc[test.status] || 0) + 1; return acc; }, { passed: 0, failed: 0, skipped: 0 });
  const transcript = selectedTests.map(test => {
    const label = test.status === 'passed' ? 'PASS' : test.status === 'skipped' ? 'SKIP' : 'FAIL';
    const duration = test.duration ? ` (${Math.round(test.duration * 100) / 100}ms)` : '';
    return `${label}  ${test.fullName}${duration}${test.failure ? `\n${test.failure}` : ''}`;
  }).join('\n');
  const displayOutput = transcript ? transcript + (stderr ? `\n\n${stderr.trim()}` : '') : output;
  return { ok: exitCode === 0, framework, exitCode, tests: selectedTests, counts, problems: parseFailureLocations(output, root), output: displayOutput.slice(-50000) };
}
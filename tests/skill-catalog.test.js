import { describe, it, expect } from 'vitest';
import { tokenize, indexSkill, buildCatalog, routeSkill } from '../lib/skill-catalog.js';

// Minimal skill fixtures mirroring Fauna's canonical skills (skills/*/SKILL.md).
// We supply the body inline so the test is offline and deterministic — the
// lexical router must pick the right skill from these alone.
const FIXTURES = [
  {
    name: 'test-driven-development',
    scope: 'repo',
    description: 'Use when writing new behavior — write a failing test first, then the minimal code to pass it.',
    body: [
      '---',
      'name: test-driven-development',
      'description: Use when writing new behavior — write a failing test first.',
      '---',
      '## When to Use',
      'When adding a new function, fixing a bug with a reproducible case, or you want a regression test.',
      '## Process',
      'Red, green, refactor. Write the failing unit test before implementation.',
    ].join('\n'),
  },
  {
    name: 'debugging-and-error-recovery',
    scope: 'repo',
    description: 'Use when something is broken, throwing an error, crashing, or behaving unexpectedly.',
    body: [
      '---',
      'name: debugging-and-error-recovery',
      'description: Use when something is broken, throwing an error, or crashing.',
      '---',
      '## When to Use',
      'When a stack trace appears, a test fails unexpectedly, or the app crashes at runtime.',
      '## Process',
      'Reproduce, isolate, form a hypothesis, add logging, fix the root cause.',
    ].join('\n'),
  },
  {
    name: 'code-review-and-quality',
    scope: 'repo',
    description: 'Use when reviewing a diff or pull request before merging for correctness and style.',
    body: [
      '---',
      'name: code-review-and-quality',
      'description: Use when reviewing a diff or pull request before merging.',
      '---',
      '## When to Use',
      'Before shipping, when reviewing a colleague pull request, or running final pre-merge checks.',
      '## Process',
      'Check correctness, security, tests, and readability. Leave actionable comments.',
    ].join('\n'),
  },
  {
    name: 'spec-driven-development',
    scope: 'repo',
    description: 'Use when a task is ambiguous — write the specification and acceptance criteria before coding.',
    body: [
      '---',
      'name: spec-driven-development',
      'description: Use when a task is ambiguous — write the spec and acceptance criteria first.',
      '---',
      '## When to Use',
      'When requirements are unclear, a feature is large, or you need acceptance criteria before implementing.',
      '## Process',
      'Clarify the goal, list requirements, define acceptance criteria, then plan slices.',
    ].join('\n'),
  },
  {
    name: 'incremental-implementation',
    scope: 'repo',
    description: 'Use when building a large feature — slice it into small, independently shippable steps.',
    body: [
      '---',
      'name: incremental-implementation',
      'description: Use when building a large feature — slice it into small shippable steps.',
      '---',
      '## When to Use',
      'When a feature is too big for one commit, or you want to ship value continuously.',
      '## Process',
      'Break into vertical slices, implement one at a time, verify each before the next.',
    ].join('\n'),
  },
];

// Golden routes: prompt → the skill we expect to win. This is the regression
// guard — if routing quality drops, these fail.
const GOLDEN_ROUTES = [
  ['my app is throwing a TypeError and crashing on startup', 'debugging-and-error-recovery'],
  ['the test suite fails with an unexpected exception', 'debugging-and-error-recovery'],
  ['write a failing unit test first for this new parser function', 'test-driven-development'],
  ['add a regression test before I fix this bug', 'test-driven-development'],
  ['review this pull request diff before we merge it', 'code-review-and-quality'],
  ['run the final pre-merge quality checks on my branch', 'code-review-and-quality'],
  ['the requirements are ambiguous, help me write acceptance criteria', 'spec-driven-development'],
  ['this feature is huge, how do I slice it into shippable steps', 'incremental-implementation'],
];

describe('tokenize', () => {
  it('lowercases, strips punctuation, drops stopwords, and stems', () => {
    expect(tokenize('The App is CRASHING!!')).toEqual(['app', 'crash']);
  });
  it('returns empty for empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });
});

describe('indexSkill', () => {
  it('builds a weighted term bag with id + description signal', () => {
    const doc = indexSkill(FIXTURES[0]);
    expect(doc.name).toBe('test-driven-development');
    expect(doc.multiToken).toBe(true);
    expect(doc.terms.has('test')).toBe(true);
    expect(doc.terms.has('fail')).toBe(true);
    // "When to Use" tokens are indexed.
    expect(doc.terms.has('regression')).toBe(true);
  });
});

describe('routeSkill — golden routes', () => {
  const catalog = buildCatalog(FIXTURES);

  for (const [prompt, expected] of GOLDEN_ROUTES) {
    it(`routes "${prompt.slice(0, 40)}…" → ${expected}`, () => {
      const r = routeSkill(prompt, catalog);
      expect(r.ok).toBe(true);
      expect(r.top).toBe(expected);
    });
  }

  it('overall accuracy is 100% on the golden set', () => {
    let hits = 0;
    for (const [prompt, expected] of GOLDEN_ROUTES) {
      if (routeSkill(prompt, catalog).top === expected) hits += 1;
    }
    expect(hits).toBe(GOLDEN_ROUTES.length);
  });
});

describe('routeSkill — confidence + clarification', () => {
  const catalog = buildCatalog(FIXTURES);

  it('returns evidence for the top match', () => {
    const r = routeSkill('the app is crashing with an error', catalog);
    expect(r.plan[0].evidence.length).toBeGreaterThan(0);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('emits a clarify question when nothing matches', () => {
    const r = routeSkill('what is the weather like in paris today', catalog);
    expect(r.top).toBeNull();
    expect(typeof r.clarify).toBe('string');
    expect(r.clarify.length).toBeGreaterThan(0);
  });

  it('asks for the goal on an empty query', () => {
    const r = routeSkill('   ', catalog);
    expect(r.clarify).toBeTruthy();
  });

  it('does not let a short single-word skill id hijack a natural prompt', () => {
    // "list" as a bare skill id must NOT outrank a real match. We add a decoy
    // single-word skill and confirm it never wins a "todo list app" style query.
    const withDecoy = buildCatalog([
      ...FIXTURES,
      { name: 'list', scope: 'repo', description: 'A generic list helper.', body: '## When to Use\nFor listing things.' },
    ]);
    const r = routeSkill('write a failing test for my todo list app', withDecoy);
    expect(r.top).toBe('test-driven-development');
  });
});

describe('routeSkill — graph proximity', () => {
  it('biases toward skills related to the active skill via shared domains', () => {
    const catalog = buildCatalog(FIXTURES);
    // Tie-ish query nudged by activeSkill relation should still be deterministic.
    const r = routeSkill('slice this large feature into steps', catalog, { activeSkill: 'spec-driven-development' });
    expect(r.ok).toBe(true);
    expect(r.top).toBe('incremental-implementation');
  });
});

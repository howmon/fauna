import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scoreAmbiguity,
  passesAmbiguityGate,
  interviewQuestions,
  createSeed,
  getSeed,
  listSeeds,
} from '../lib/seed-store.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-seeds-'));
}

describe('scoreAmbiguity', () => {
  it('scores a well-specified spec as low ambiguity', () => {
    const s = scoreAmbiguity({
      goal: 'Add a POST /api/parakeet-model-delete route that removes the model files and returns 200',
      acceptanceCriteria: [
        'DELETE removes all four model files',
        'returns 404 when model not installed',
        'existing whisper routes still pass their tests',
      ],
      constraints: ['do not touch whisper routes'],
      ontology: ['model', 'route'],
    });
    expect(s).toBeLessThanOrEqual(0.2);
  });

  it('scores a vague one-liner as high ambiguity', () => {
    const s = scoreAmbiguity({ goal: 'make it better somehow' });
    expect(s).toBeGreaterThan(0.5);
  });

  it('raises ambiguity for unanswered open questions', () => {
    const base = { goal: 'Add a settings toggle for dark mode', acceptanceCriteria: ['toggle persists'] };
    const withQs = scoreAmbiguity({ ...base, openQuestions: ['which storage?', 'default value?'] });
    const without = scoreAmbiguity(base);
    expect(withQs).toBeGreaterThan(without);
  });

  it('returns a value clamped to 0..1', () => {
    const s = scoreAmbiguity({ goal: '', openQuestions: Array(20).fill('q') });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe('passesAmbiguityGate', () => {
  it('blocks a vague goal at the default threshold', () => {
    expect(passesAmbiguityGate({ goal: 'improve stuff' })).toBe(false);
  });
  it('admits a concrete spec', () => {
    expect(passesAmbiguityGate({
      goal: 'Add a keyboard shortcut Cmd+K that focuses the search input',
      acceptanceCriteria: ['Cmd+K focuses #search', 'does not fire inside text fields'],
      constraints: ['macOS + Windows'],
    })).toBe(true);
  });
});

describe('interviewQuestions', () => {
  it('asks for acceptance criteria when missing', () => {
    const qs = interviewQuestions({ goal: 'Build a thing that does the work' });
    expect(qs.join(' ')).toMatch(/acceptance criteria/i);
  });
  it('asks to disambiguate vague terms', () => {
    const qs = interviewQuestions({ goal: 'make it faster and better', acceptanceCriteria: ['a', 'b'], constraints: ['x'] });
    expect(qs.join(' ')).toMatch(/vague|measurable/i);
  });
  it('always returns at least one question', () => {
    const qs = interviewQuestions({
      goal: 'A fully concrete goal with plenty of detail here',
      acceptanceCriteria: ['a', 'b'],
      constraints: ['c'],
    });
    expect(qs.length).toBeGreaterThan(0);
  });
});

describe('Seed persistence', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  const goodSpec = {
    goal: 'Add a POST /api/parakeet-model-delete route removing the four model files',
    acceptanceCriteria: ['removes all files', 'returns 404 when absent', 'whisper tests pass'],
    constraints: ['do not touch whisper'],
    ontology: ['model'],
  };

  it('creates and reads back an immutable seed', () => {
    const r = createSeed(goodSpec, { dir });
    expect(r.ok).toBe(true);
    expect(r.seed.immutable).toBe(true);
    expect(r.seed.id).toBeTruthy();
    const back = getSeed(r.seed.id, { dir });
    expect(back.goal).toBe(goodSpec.goal);
    expect(back.acceptanceCriteria.length).toBe(3);
  });

  it('blocks creation when ambiguity exceeds the gate', () => {
    const r = createSeed({ goal: 'improve things somehow' }, { dir });
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.questions.length).toBeGreaterThan(0);
    expect(fs.readdirSync(dir).length).toBe(0);
  });

  it('allows a forced seed despite ambiguity', () => {
    const r = createSeed({ goal: 'improve things somehow' }, { dir, force: true });
    expect(r.ok).toBe(true);
  });

  it('lists seeds newest-first', () => {
    createSeed({ ...goodSpec, goal: goodSpec.goal + ' one' }, { dir });
    createSeed({ ...goodSpec, goal: goodSpec.goal + ' two' }, { dir });
    const list = listSeeds({ dir });
    expect(list.length).toBe(2);
  });
});

// Tests for lib/self-updater.js — covers the pure logic (parsing,
// state-machine transitions, path derivation). The network + spawn
// orchestration is wrapped in createSelfUpdater() and exercised in
// integration only — we don't unit-test that because it would mean
// mocking https + child_process + fs at three different layers.

import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  parseGithubRepo,
  findAppBundlePath,
  nextUpdateState,
  INITIAL_STATE,
} from '../lib/self-updater.js';

describe('parseGithubRepo', () => {
  it('parses git+https URLs', () => {
    expect(parseGithubRepo('git+https://github.com/howmon/fauna.git')).toEqual({ owner: 'howmon', repo: 'fauna' });
  });
  it('parses bare https URLs', () => {
    expect(parseGithubRepo('https://github.com/howmon/fauna.git')).toEqual({ owner: 'howmon', repo: 'fauna' });
  });
  it('parses https without .git suffix', () => {
    expect(parseGithubRepo('https://github.com/howmon/fauna')).toEqual({ owner: 'howmon', repo: 'fauna' });
  });
  it('parses git@github.com SSH URLs', () => {
    expect(parseGithubRepo('git@github.com:howmon/fauna.git')).toEqual({ owner: 'howmon', repo: 'fauna' });
  });
  it('tolerates trailing slash / path / query', () => {
    expect(parseGithubRepo('https://github.com/howmon/fauna/')).toEqual({ owner: 'howmon', repo: 'fauna' });
    expect(parseGithubRepo('https://github.com/howmon/fauna#readme')).toEqual({ owner: 'howmon', repo: 'fauna' });
  });
  it('returns null for non-github URLs', () => {
    expect(parseGithubRepo('https://gitlab.com/owner/repo.git')).toBeNull();
    expect(parseGithubRepo('https://bitbucket.org/owner/repo')).toBeNull();
  });
  it('returns null for empty / invalid input', () => {
    expect(parseGithubRepo('')).toBeNull();
    expect(parseGithubRepo(null)).toBeNull();
    expect(parseGithubRepo(undefined)).toBeNull();
    expect(parseGithubRepo(42)).toBeNull();
  });
});

describe('findAppBundlePath', () => {
  it('returns the .app dir when given a path inside it', () => {
    expect(findAppBundlePath('/Applications/Fauna.app/Contents/Resources/app.asar')).toBe('/Applications/Fauna.app');
    expect(findAppBundlePath('/Applications/Fauna.app/Contents/MacOS/Fauna')).toBe('/Applications/Fauna.app');
  });
  it('returns the .app dir when given the .app itself', () => {
    expect(findAppBundlePath('/Applications/Fauna.app')).toBe('/Applications/Fauna.app');
  });
  it('handles user-installed paths (not /Applications)', () => {
    expect(findAppBundlePath('/Users/me/Downloads/Fauna.app/Contents/Resources/app.asar')).toBe('/Users/me/Downloads/Fauna.app');
  });
  it('returns null when not inside any .app', () => {
    expect(findAppBundlePath('/Users/me/dev/fauna/main.js')).toBeNull();
    expect(findAppBundlePath('/tmp')).toBeNull();
  });
  it('returns null on bad input', () => {
    expect(findAppBundlePath('')).toBeNull();
    expect(findAppBundlePath(null)).toBeNull();
  });
});

describe('nextUpdateState — state machine', () => {
  it('check_start sets checking + clears error', () => {
    const prev = { ...INITIAL_STATE, error: 'something old' };
    const next = nextUpdateState(prev, { type: 'check_start' });
    expect(next.checking).toBe(true);
    expect(next.error).toBeNull();
    expect(next.phase).toBe('checking');
  });

  it('check_result with NEW sha sets updateAvailable + records latestSha', () => {
    const prev = { ...INITIAL_STATE, currentSha: 'abc123' };
    const next = nextUpdateState(prev, { type: 'check_result', latestSha: 'def456' });
    expect(next.updateAvailable).toBe(true);
    expect(next.latestSha).toBe('def456');
    expect(next.phase).toBe('available');
    expect(next.message).toContain('def456'.slice(0, 7));
  });

  it('check_result with MATCHING sha leaves updateAvailable=false', () => {
    const prev = { ...INITIAL_STATE, currentSha: 'abc123' };
    const next = nextUpdateState(prev, { type: 'check_result', latestSha: 'abc123' });
    expect(next.updateAvailable).toBe(false);
    expect(next.phase).toBe('current');
    expect(next.message).toMatch(/up to date/i);
  });

  it('check_result with null sha leaves updateAvailable=false (no claim of update)', () => {
    const prev = { ...INITIAL_STATE, currentSha: 'abc123' };
    const next = nextUpdateState(prev, { type: 'check_result', latestSha: null });
    expect(next.updateAvailable).toBe(false);
  });

  it('check_error stamps the error + clears checking', () => {
    const prev = { ...INITIAL_STATE, checking: true };
    const next = nextUpdateState(prev, { type: 'check_error', message: 'HTTP 503' });
    expect(next.checking).toBe(false);
    expect(next.error).toBe('HTTP 503');
    expect(next.phase).toBe('error');
    expect(next.message).toContain('HTTP 503');
  });

  it('install_start clears logs + sets running', () => {
    const prev = { ...INITIAL_STATE, logs: [{ ts: 1, message: 'stale' }] };
    const next = nextUpdateState(prev, { type: 'install_start' });
    expect(next.running).toBe(true);
    expect(next.logs).toEqual([]);
    expect(next.phase).toBe('starting');
  });

  it('install_log appends + trims to 160 entries', () => {
    let state = nextUpdateState(INITIAL_STATE, { type: 'install_start' });
    for (let i = 0; i < 200; i++) {
      state = nextUpdateState(state, { type: 'install_log', message: `line ${i}`, phase: 'download' });
    }
    expect(state.logs.length).toBe(160);
    // Oldest 40 lines should have been dropped.
    expect(state.logs[0].message).toBe('line 40');
    expect(state.logs[state.logs.length - 1].message).toBe('line 199');
    expect(state.phase).toBe('download');
  });

  it('install_complete clears running + updates currentSha', () => {
    const prev = nextUpdateState(INITIAL_STATE, { type: 'install_start' });
    const next = nextUpdateState(prev, { type: 'install_complete', installedSha: 'fedcba' });
    expect(next.running).toBe(false);
    expect(next.phase).toBe('complete');
    expect(next.currentSha).toBe('fedcba');
    expect(next.updateAvailable).toBe(false);
  });

  it('install_error clears running + records error', () => {
    const prev = nextUpdateState(INITIAL_STATE, { type: 'install_start' });
    const next = nextUpdateState(prev, { type: 'install_error', message: 'npm install failed' });
    expect(next.running).toBe(false);
    expect(next.phase).toBe('error');
    expect(next.error).toBe('npm install failed');
  });

  it('unknown events are no-ops (defensive)', () => {
    const prev = { ...INITIAL_STATE, message: 'unchanged' };
    const next = nextUpdateState(prev, { type: 'nonsense' });
    expect(next).toEqual(prev);
  });
});

describe('INITIAL_STATE', () => {
  it('is a sane idle state', () => {
    expect(INITIAL_STATE.checking).toBe(false);
    expect(INITIAL_STATE.running).toBe(false);
    expect(INITIAL_STATE.updateAvailable).toBe(false);
    expect(INITIAL_STATE.phase).toBe('idle');
    expect(INITIAL_STATE.logs).toEqual([]);
  });
  it('is frozen so callers can\'t mutate the shared instance', () => {
    expect(Object.isFrozen(INITIAL_STATE)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { evaluateParallelCandidates, evaluateWorktreeRollout } from '../lib/worktree-evaluation.js';

const repository = {
  isGit: true,
  clean: true,
  supportsWorktrees: true,
  baseCommit: '1234567890abcdef',
};

const candidates = [
  { id: 'api', fileScope: ['server/api'], verifyCommand: 'npm test -- api', blockedBy: [] },
  { id: 'ui', fileScope: ['public/ui'], verifyCommand: 'npm test -- ui', blockedBy: [] },
];

describe('worktree candidate evaluation', () => {
  it('requires explicit approval after all isolation checks pass', () => {
    const preview = evaluateParallelCandidates({ candidates, repository });
    expect(preview).toMatchObject({ ok: true, eligible: false, requiresApproval: true, blockers: [] });
    expect(evaluateParallelCandidates({ candidates, repository, approved: true })).toMatchObject({
      ok: true,
      eligible: true,
      mode: 'evaluation-only',
    });
  });

  it('rejects overlapping file ownership', () => {
    const result = evaluateParallelCandidates({
      candidates: [candidates[0], { ...candidates[1], fileScope: ['server/api/routes'] }],
      repository,
      approved: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/overlap/i);
  });

  it('rejects unresolved dependencies and unsafe repository state', () => {
    const result = evaluateParallelCandidates({
      candidates: [{ ...candidates[0], blockedBy: ['schema'] }, candidates[1]],
      repository: { ...repository, clean: false },
      approved: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/unresolved blockers/i),
      'base working tree must be clean',
    ]));
  });

  it('rejects dependencies within the candidate set even if reported complete', () => {
    const result = evaluateParallelCandidates({
      candidates: [{ ...candidates[0], blockedBy: ['ui'] }, candidates[1]],
      completedIds: ['ui'],
      repository,
      approved: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/depends on another parallel candidate/i);
  });

  it('requires repository-relative scopes and independent verifiers', () => {
    const result = evaluateParallelCandidates({
      candidates: [
        { id: 'bad', fileScope: ['../outside'], blockedBy: [] },
        candidates[1],
      ],
      repository,
      approved: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/verification command/i),
      expect.stringMatching(/repository-relative/i),
    ]));
  });

  it('rejects root and glob scopes because they do not prove isolation', () => {
    const result = evaluateParallelCandidates({
      candidates: [
        { ...candidates[0], fileScope: ['.'] },
        { ...candidates[1], fileScope: ['public/**'] },
      ],
      repository,
      approved: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.filter(error => /repository-relative/i.test(error))).toHaveLength(2);
  });
});

describe('worktree rollout evaluation', () => {
  const successfulRun = {
    mergeConflict: false,
    verifierPassed: true,
    humanRework: false,
    cleanupSucceeded: true,
  };

  it('withholds rollout until the minimum sample is collected', () => {
    const result = evaluateWorktreeRollout({ runs: Array(9).fill(successfulRun) });
    expect(result.rolloutReady).toBe(false);
    expect(result.criteria.sampleSize).toBe(false);
  });

  it('permits rollout only when every metric clears its threshold', () => {
    const result = evaluateWorktreeRollout({ runs: Array(10).fill(successfulRun) });
    expect(result.rolloutReady).toBe(true);
    expect(result.criteria).toEqual({
      sampleSize: true,
      mergeConflicts: true,
      verifierPasses: true,
      humanRework: true,
      cleanup: true,
    });
  });

  it('blocks rollout on conflict, verifier, rework, or cleanup regressions', () => {
    const failingRun = {
      mergeConflict: true,
      verifierPassed: false,
      humanRework: true,
      cleanupSucceeded: false,
    };
    const result = evaluateWorktreeRollout({ runs: [failingRun, ...Array(9).fill(successfulRun)] });
    expect(result.rolloutReady).toBe(false);
    expect(result.criteria).toMatchObject({
      mergeConflicts: false,
      verifierPasses: true,
      humanRework: true,
      cleanup: false,
    });
  });
});
const DEFAULT_THRESHOLDS = Object.freeze({
  minimumRuns: 10,
  maximumMergeConflictRate: 0.05,
  minimumVerifierPassRate: 0.9,
  maximumHumanReworkRate: 0.1,
  minimumCleanupSuccessRate: 1,
});

function textList(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map(item => String(item || '').trim()).filter(Boolean))];
}

function normalizeRelativePath(value) {
  const normalized = String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) return null;
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || /[*?[\]{}]/.test(normalized)) return null;
  return normalized;
}

function scopesOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function evaluateParallelCandidates({ candidates, completedIds = [], repository = {}, approved = false } = {}) {
  const errors = [];
  const blockers = [];
  const completed = new Set(textList(completedIds));
  const normalized = (Array.isArray(candidates) ? candidates : []).map((candidate, index) => ({
    id: String(candidate?.id || candidate?.key || '').trim(),
    verifyCommand: String(candidate?.verifyCommand || '').trim(),
    blockedBy: textList(candidate?.blockedBy),
    fileScope: textList(candidate?.fileScope).map(normalizeRelativePath),
    index,
  }));

  if (normalized.length < 2) errors.push('at least two candidate cards are required');
  const ids = new Set();
  for (const candidate of normalized) {
    const label = candidate.id || `candidate ${candidate.index + 1}`;
    if (!candidate.id) errors.push(`candidate ${candidate.index + 1} requires an id`);
    else if (ids.has(candidate.id)) errors.push(`duplicate candidate id "${candidate.id}"`);
    else ids.add(candidate.id);
    if (!candidate.verifyCommand) errors.push(`${label} requires an independent verification command`);
    if (candidate.fileScope.length === 0) errors.push(`${label} requires a non-empty fileScope`);
    if (candidate.fileScope.includes(null)) errors.push(`${label} fileScope must contain only repository-relative paths`);
    const unresolved = candidate.blockedBy.filter(id => !completed.has(id));
    if (unresolved.length) blockers.push(`${label} has unresolved blockers: ${unresolved.join(', ')}`);
  }

  for (const candidate of normalized) {
    const candidateDependencies = candidate.blockedBy.filter(id => ids.has(id));
    if (candidateDependencies.length) {
      blockers.push(`${candidate.id} depends on another parallel candidate: ${candidateDependencies.join(', ')}`);
    }
  }

  for (let leftIndex = 0; leftIndex < normalized.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex++) {
      const left = normalized[leftIndex];
      const right = normalized[rightIndex];
      for (const leftPath of left.fileScope.filter(Boolean)) {
        for (const rightPath of right.fileScope.filter(Boolean)) {
          if (scopesOverlap(leftPath, rightPath)) {
            blockers.push(`${left.id || `candidate ${left.index + 1}`} and ${right.id || `candidate ${right.index + 1}`} overlap at ${leftPath} / ${rightPath}`);
          }
        }
      }
    }
  }

  if (repository.isGit !== true) blockers.push('repository must be a Git worktree');
  if (repository.clean !== true) blockers.push('base working tree must be clean');
  if (repository.supportsWorktrees !== true) blockers.push('Git worktree support must be confirmed');
  if (!/^[0-9a-f]{7,64}$/i.test(String(repository.baseCommit || ''))) blockers.push('a resolved base commit is required');

  const uniqueBlockers = [...new Set(blockers)];
  return {
    ok: errors.length === 0,
    eligible: errors.length === 0 && uniqueBlockers.length === 0 && approved === true,
    mode: 'evaluation-only',
    approved: approved === true,
    requiresApproval: approved !== true,
    errors,
    blockers: uniqueBlockers,
    candidates: normalized.map(({ index, ...candidate }) => candidate),
  };
}

function rate(count, total) {
  return total > 0 ? Number((count / total).toFixed(4)) : 0;
}

export function evaluateWorktreeRollout({ runs, thresholds = {} } = {}) {
  const errors = [];
  const normalizedThresholds = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const values = Object.values(normalizedThresholds);
  if (!Number.isInteger(normalizedThresholds.minimumRuns) || normalizedThresholds.minimumRuns < 1) {
    errors.push('minimumRuns must be a positive integer');
  }
  if (values.slice(1).some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    errors.push('rate thresholds must be numbers between 0 and 1');
  }

  const trials = Array.isArray(runs) ? runs : [];
  for (const [index, trial] of trials.entries()) {
    for (const field of ['mergeConflict', 'verifierPassed', 'humanRework', 'cleanupSucceeded']) {
      if (typeof trial?.[field] !== 'boolean') errors.push(`run ${index + 1} requires boolean ${field}`);
    }
  }

  const total = trials.length;
  const metrics = {
    runs: total,
    mergeConflictRate: rate(trials.filter(item => item?.mergeConflict === true).length, total),
    verifierPassRate: rate(trials.filter(item => item?.verifierPassed === true).length, total),
    humanReworkRate: rate(trials.filter(item => item?.humanRework === true).length, total),
    cleanupSuccessRate: rate(trials.filter(item => item?.cleanupSucceeded === true).length, total),
  };
  const criteria = {
    sampleSize: total >= normalizedThresholds.minimumRuns,
    mergeConflicts: metrics.mergeConflictRate <= normalizedThresholds.maximumMergeConflictRate,
    verifierPasses: metrics.verifierPassRate >= normalizedThresholds.minimumVerifierPassRate,
    humanRework: metrics.humanReworkRate <= normalizedThresholds.maximumHumanReworkRate,
    cleanup: metrics.cleanupSuccessRate >= normalizedThresholds.minimumCleanupSuccessRate,
  };
  return {
    ok: errors.length === 0,
    rolloutReady: errors.length === 0 && Object.values(criteria).every(Boolean),
    errors,
    thresholds: normalizedThresholds,
    metrics,
    criteria,
  };
}

export default { evaluateParallelCandidates, evaluateWorktreeRollout };

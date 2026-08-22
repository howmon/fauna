function normalizeOutcome(value) {
  return {
    ok: value?.ok === true,
    exitCode: Number.isInteger(value?.exitCode) ? value.exitCode : null,
    summary: String(value?.summary || '').trim(),
  };
}

export function validateDiagnosisReport(input = {}) {
  const errors = [];
  const reproduction = {
    command: String(input.reproduction?.command || '').trim(),
    symptom: String(input.reproduction?.symptom || '').trim(),
    before: normalizeOutcome(input.reproduction?.before),
    after: normalizeOutcome(input.reproduction?.after),
  };
  if (!reproduction.command) errors.push('reproduction.command is required');
  if (!reproduction.symptom) errors.push('reproduction.symptom is required');
  if (input.reproduction?.before?.ok !== false) errors.push('reproduction.before must explicitly demonstrate the pre-fix failure');
  if (!reproduction.before.summary) errors.push('reproduction.before.summary is required');
  if (!reproduction.after.ok) errors.push('reproduction.after must demonstrate the post-fix pass');
  if (!reproduction.after.summary) errors.push('reproduction.after.summary is required');

  const hypotheses = Array.isArray(input.hypotheses)
    ? input.hypotheses.map((hypothesis, index) => ({
        rank: Number.isInteger(hypothesis?.rank) ? hypothesis.rank : index + 1,
        claim: String(hypothesis?.claim || '').trim(),
        prediction: String(hypothesis?.prediction || '').trim(),
        evidence: String(hypothesis?.evidence || '').trim(),
        status: String(hypothesis?.status || '').trim().toLowerCase(),
      })).sort((left, right) => left.rank - right.rank)
    : [];
  if (hypotheses.length < 2) errors.push('hypotheses must contain at least two ranked alternatives');
  const ranks = new Set();
  for (const [index, hypothesis] of hypotheses.entries()) {
    const label = `hypotheses[${index}]`;
    if (hypothesis.rank < 1 || ranks.has(hypothesis.rank)) errors.push(`${label}.rank must be a unique positive integer`);
    ranks.add(hypothesis.rank);
    if (!hypothesis.claim) errors.push(`${label}.claim is required`);
    if (!hypothesis.prediction) errors.push(`${label}.prediction is required`);
    if (!hypothesis.evidence) errors.push(`${label}.evidence is required`);
    if (!['supported', 'rejected'].includes(hypothesis.status)) errors.push(`${label}.status must be supported or rejected`);
  }
  if (hypotheses.length >= 2 && !hypotheses.some(hypothesis => hypothesis.status === 'supported')) {
    errors.push('at least one hypothesis must be supported by evidence');
  }

  const regressionTest = {
    file: String(input.regressionTest?.file || '').trim(),
    name: String(input.regressionTest?.name || '').trim(),
    failedBefore: input.regressionTest?.failedBefore === true,
    passedAfter: input.regressionTest?.passedAfter === true,
  };
  if (!regressionTest.file) errors.push('regressionTest.file is required');
  if (!regressionTest.name) errors.push('regressionTest.name is required');
  if (!regressionTest.failedBefore) errors.push('regression test must fail before the fix');
  if (!regressionTest.passedAfter) errors.push('regression test must pass after the fix');
  if (input.instrumentationRemoved !== true) errors.push('temporary instrumentation must be removed');

  return {
    ok: errors.length === 0,
    errors,
    report: {
      type: 'bug-diagnosis',
      reproduction,
      hypotheses,
      regressionTest,
      instrumentationRemoved: input.instrumentationRemoved === true,
    },
  };
}

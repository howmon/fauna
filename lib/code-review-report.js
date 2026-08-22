const VERDICTS = new Set(['pass', 'changes-required', 'not-reviewed']);
const SEVERITIES = new Set(['critical', 'required', 'nit', 'optional', 'fyi']);

function normalizeFindings(value, axis, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${axis}.findings must be an array`);
    return [];
  }
  return value.map((finding, index) => {
    const normalized = {
      severity: String(finding?.severity || '').trim().toLowerCase(),
      message: String(finding?.message || '').trim(),
      file: String(finding?.file || '').trim(),
      line: Number(finding?.line),
    };
    const label = `${axis}.findings[${index}]`;
    if (!SEVERITIES.has(normalized.severity)) errors.push(`${label} has an invalid severity`);
    if (!normalized.message) errors.push(`${label} requires a message`);
    if (!normalized.file) errors.push(`${label} requires file evidence`);
    if (!Number.isInteger(normalized.line) || normalized.line < 1) errors.push(`${label} requires a positive line number`);
    return normalized;
  });
}

function normalizeAxis(value, axis, errors) {
  const normalized = {
    contextId: String(value?.contextId || '').trim(),
    verdict: String(value?.verdict || '').trim().toLowerCase(),
    summary: String(value?.summary || '').trim(),
    findings: normalizeFindings(value?.findings, axis, errors),
  };
  if (!normalized.contextId) errors.push(`${axis}.contextId is required`);
  if (!VERDICTS.has(normalized.verdict)) errors.push(`${axis}.verdict is invalid`);
  if (!normalized.summary) errors.push(`${axis}.summary is required`);
  return normalized;
}

export function validateCodeReviewReport(input = {}) {
  const errors = [];
  const diff = {
    baseRef: String(input.diff?.baseRef || '').trim(),
    headRef: String(input.diff?.headRef || '').trim(),
    mergeBase: String(input.diff?.mergeBase || '').trim(),
    files: Array.isArray(input.diff?.files)
      ? [...new Set(input.diff.files.map(file => String(file).trim()).filter(Boolean))]
      : [],
  };
  if (!diff.baseRef) errors.push('diff.baseRef is required');
  if (!diff.headRef) errors.push('diff.headRef is required');
  if (!diff.mergeBase) errors.push('diff.mergeBase is required');
  if (diff.baseRef && !/^[0-9a-f]{7,64}$/i.test(diff.baseRef)) errors.push('diff.baseRef must be a resolved commit id');
  if (diff.headRef && !/^[0-9a-f]{7,64}$/i.test(diff.headRef)) errors.push('diff.headRef must be a resolved commit id');
  if (diff.mergeBase && !/^[0-9a-f]{7,64}$/i.test(diff.mergeBase)) errors.push('diff.mergeBase must be a resolved commit id');
  if (diff.baseRef && diff.headRef && diff.baseRef === diff.headRef) errors.push('diff base and head must resolve to different commits');
  if (diff.files.length === 0) errors.push('three-dot diff must contain at least one changed file');

  const spec = {
    status: String(input.spec?.status || '').trim().toLowerCase(),
    reference: String(input.spec?.reference || '').trim(),
    reason: String(input.spec?.reason || '').trim(),
  };
  if (!['available', 'unavailable'].includes(spec.status)) errors.push('spec.status must be available or unavailable');
  if (spec.status === 'available' && !spec.reference) errors.push('spec.reference is required when a spec is available');
  if (spec.status === 'unavailable' && !spec.reason) errors.push('spec.reason is required when no spec is available');

  const standards = normalizeAxis(input.standards, 'standards', errors);
  const specReview = normalizeAxis(input.specReview, 'specReview', errors);
  if (standards.verdict === 'not-reviewed') errors.push('Standards review cannot be skipped');
  if (standards.contextId && standards.contextId === specReview.contextId) {
    errors.push('Standards and Spec reviews must use isolated context ids');
  }
  if (spec.status === 'available' && specReview.verdict === 'not-reviewed') {
    errors.push('Spec review cannot be skipped when a spec is available');
  }
  if (spec.status === 'unavailable' && specReview.verdict !== 'not-reviewed') {
    errors.push('Spec review verdict must be not-reviewed when no spec is available');
  }

  const commands = Array.isArray(input.verification?.commands)
    ? input.verification.commands.map(command => ({
        command: String(command?.command || '').trim(),
        ok: command?.ok === true,
        summary: String(command?.summary || '').trim(),
      }))
    : [];
  if (commands.length === 0) errors.push('verification.commands must contain at least one result');
  for (const [index, command] of commands.entries()) {
    if (!command.command) errors.push(`verification.commands[${index}].command is required`);
    if (!command.summary) errors.push(`verification.commands[${index}].summary is required`);
  }

  return {
    ok: errors.length === 0,
    errors,
    report: {
      type: 'code-review',
      diff,
      spec,
      standards,
      specReview,
      verification: { commands },
    },
  };
}

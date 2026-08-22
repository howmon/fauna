import { describe, expect, it } from 'vitest';
import { validateCodeReviewReport } from '../lib/code-review-report.js';

function validReport() {
  return {
    diff: { baseRef: '1111111', headRef: '2222222', mergeBase: '1111111', files: ['src/auth.js'] },
    spec: { status: 'available', reference: 'docs/spec.md' },
    standards: { contextId: 'standards-1', verdict: 'pass', summary: 'Clean', findings: [] },
    specReview: { contextId: 'spec-1', verdict: 'pass', summary: 'Complete', findings: [] },
    verification: { commands: [{ command: 'npm test', ok: true, summary: '42 tests passed' }] },
  };
}

describe('validateCodeReviewReport', () => {
  it('accepts isolated review axes with provenance and verification', () => {
    expect(validateCodeReviewReport(validReport())).toMatchObject({ ok: true, errors: [] });
  });

  it('rejects an empty or unresolved diff', () => {
    const input = validReport();
    input.diff = { baseRef: 'same', headRef: 'same', mergeBase: '', files: [] };
    const result = validateCodeReviewReport(input);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('diff base and head must resolve to different commits');
    expect(result.errors).toContain('three-dot diff must contain at least one changed file');
  });

  it('requires isolated reviewer contexts', () => {
    const input = validReport();
    input.specReview.contextId = input.standards.contextId;
    expect(validateCodeReviewReport(input).errors).toContain('Standards and Spec reviews must use isolated context ids');
  });

  it('requires resolved commit ids and a completed Standards pass', () => {
    const input = validReport();
    input.diff.baseRef = 'main';
    input.standards.verdict = 'not-reviewed';
    const result = validateCodeReviewReport(input);
    expect(result.errors).toContain('diff.baseRef must be a resolved commit id');
    expect(result.errors).toContain('Standards review cannot be skipped');
  });

  it('requires file and line evidence for findings', () => {
    const input = validReport();
    input.standards.findings = [{ severity: 'required', message: 'Handle the error' }];
    const result = validateCodeReviewReport(input);
    expect(result.errors).toContain('standards.findings[0] requires file evidence');
    expect(result.errors).toContain('standards.findings[0] requires a positive line number');
  });

  it('records an explicit unavailable spec axis', () => {
    const input = validReport();
    input.spec = { status: 'unavailable', reason: 'No originating specification exists' };
    input.specReview = { contextId: 'spec-1', verdict: 'not-reviewed', summary: 'No spec available', findings: [] };
    expect(validateCodeReviewReport(input).ok).toBe(true);
  });
});

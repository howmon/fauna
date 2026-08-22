import { describe, expect, it } from 'vitest';
import { validateDiagnosisReport } from '../lib/diagnosis-report.js';

function validReport() {
  return {
    reproduction: {
      command: 'npx vitest run tests/auth.test.js',
      symptom: 'Expired sessions return 500 instead of 401',
      before: { ok: false, exitCode: 1, summary: 'Expected 401, received 500' },
      after: { ok: true, exitCode: 0, summary: '1 test passed' },
    },
    hypotheses: [
      { rank: 1, claim: 'Expiry is not handled', prediction: 'The decoder throws on an expired token', evidence: 'Focused trace reaches decoder throw', status: 'supported' },
      { rank: 2, claim: 'The route skips auth', prediction: 'Middleware is absent', evidence: 'Route includes auth middleware', status: 'rejected' },
    ],
    regressionTest: { file: 'tests/auth.test.js', name: 'expired session returns 401', failedBefore: true, passedAfter: true },
    instrumentationRemoved: true,
  };
}

describe('validateDiagnosisReport', () => {
  it('accepts a complete red-green diagnosis', () => {
    expect(validateDiagnosisReport(validReport())).toMatchObject({ ok: true, errors: [] });
  });

  it('requires the original loop to fail before and pass after', () => {
    const input = validReport();
    input.reproduction.before.ok = true;
    input.reproduction.after.ok = false;
    const result = validateDiagnosisReport(input);
    expect(result.errors).toContain('reproduction.before must explicitly demonstrate the pre-fix failure');
    expect(result.errors).toContain('reproduction.after must demonstrate the post-fix pass');
  });

  it('does not treat missing pre-fix status as failure evidence', () => {
    const input = validReport();
    delete input.reproduction.before.ok;
    expect(validateDiagnosisReport(input).errors).toContain('reproduction.before must explicitly demonstrate the pre-fix failure');
  });

  it('requires several falsifiable hypotheses with evidence', () => {
    const input = validReport();
    input.hypotheses = [{ rank: 1, claim: 'Guess', prediction: '', evidence: '', status: 'rejected' }];
    const result = validateDiagnosisReport(input);
    expect(result.errors).toContain('hypotheses must contain at least two ranked alternatives');
    expect(result.errors).toContain('hypotheses[0].prediction is required');
    expect(result.errors).toContain('hypotheses[0].evidence is required');
  });

  it('requires regression red-green evidence and cleanup', () => {
    const input = validReport();
    input.regressionTest.failedBefore = false;
    input.instrumentationRemoved = false;
    const result = validateDiagnosisReport(input);
    expect(result.errors).toContain('regression test must fail before the fix');
    expect(result.errors).toContain('temporary instrumentation must be removed');
  });
});

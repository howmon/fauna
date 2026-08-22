---
name: code-review-and-quality
maturity: promoted
description: Performs isolated Standards and Spec code-review passes before merge, then records evidence on the work-item run. Use when a Kanban card enters review, when evaluating code another agent produced, or before merging a change.
---

# Code Review and Quality

## Overview

Every change gets two independent reviews before merge:

- **Standards** checks the diff against repository rules and engineering quality.
- **Spec** checks the diff against the originating intent and acceptance criteria.

Run these passes in separate subagent contexts. Do not let one review's findings
anchor the other, and do not collapse the results into a single score.

**Approval standard:** Approve when the change definitely improves overall
code health, even if it isn't perfect. Don't block because it isn't exactly
how you would have written it. Don't rubber-stamp either.

## When to Use

- A Kanban card has moved to the `review` column
- Before merging any PR
- When evaluating code another agent produced
- After completing a feature implementation

## Process

### Step 1: Resolve the Review Boundary

1. Resolve immutable base and head revisions.
2. Compute the merge base and inspect the non-empty `base...head` diff.
3. List the changed files from that same three-dot diff.
4. Identify the originating spec, ticket acceptance criteria, or request.
5. If no spec exists, record `spec.status="unavailable"` and explain why. Do
	not silently omit the Spec axis.

Stop if the revisions are unresolved or the three-dot diff is empty.

### Step 2: Standards Pass

Start a fresh subagent context with only:

- the resolved diff;
- repository instructions and engineering rules;
- relevant test and verifier output.

When the diff changes ownership, public interfaces, dependencies, or migration
structure, load the `codebase-design` reference into this pass. Use its shared
vocabulary and verification checks; do not turn every heuristic into a finding.

Do not provide the product spec to this pass. Review correctness, readability,
architecture, security, performance, and test quality. Repository rules are
requirements; heuristic smells must be labeled `optional`, `nit`, or `fyi`.

### Step 3: Spec Pass

Start a different fresh subagent context with only:

- the same resolved diff;
- the originating spec and acceptance criteria;
- relevant test and verifier output.

Review missing behavior, wrong behavior, and scope creep. Do not import findings
from the Standards pass. If no spec exists, return `not-reviewed` with the
explicit no-spec reason.

If acceptance depends on established domain terms or invariants, load the
`domain-modeling` reference. Use it to interpret recorded intent, not to invent
requirements that are absent from the spec.

### Step 4: Evidence Format

Each finding must contain:

- severity: `critical`, `required`, `nit`, `optional`, or `fyi`;
- a concrete message;
- repository-relative file path;
- a positive line number.

No findings is a valid result. Inventing a low-value finding to make the report
look substantive is not.

### Step 5: Record the Review

Run the relevant verifier and call `fauna_workitem_record_review` with:

- base, head, merge base, and changed-file list;
- explicit spec provenance or unavailable reason;
- Standards and Spec outputs with distinct context ids;
- the commands, pass/fail status, and concise output summaries.

Present Standards and Spec reports side by side. Never average them into one
approval score.

### Review the Tests First

```
- Do tests exist for the change?
- Do they test behavior (not implementation details)?
- Are edge cases covered?
- Would the tests catch a regression if the code changed?
```

### Standards Checklist

For each file changed, walk the five axes:

1. **Correctness** — Does this code do what the test says it should? Edge cases, error paths, off-by-one, race conditions.
2. **Readability** — Can another engineer understand this without the author explaining it? No clever tricks. Could this be done in fewer lines?
3. **Architecture** — Apply `codebase-design`: clear ownership and public boundaries, justified abstractions, and acyclic dependency direction.
4. **Security** — Input validated at boundaries? No secrets in code? Auth checks in place? External data treated as untrusted?
5. **Performance** — N+1 queries? Unbounded loops? Sync ops that should be async? Missing pagination?

### Finding Severity

| Prefix | Meaning |
|--------|---------|
| *(no prefix)* | Required change — must address before merge |
| **Critical:** | Blocks merge — security, data loss, broken functionality |
| **Nit:** | Minor — author may ignore |
| **Optional:** / **Consider:** | Suggestion worth considering |
| **FYI** | Informational only |

### Verification Evidence

```
- What tests were run? Cite the command and result.
- Did the build pass?
- Was the change tested manually?
- Screenshots for UI changes?
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It works, that's good enough" | Working code that's unreadable, insecure, or architecturally wrong creates debt that compounds. |
| "I wrote it, so I know it's correct" | Authors are blind to their own assumptions. Every change benefits from another set of eyes. |
| "We'll clean it up later" | Later never comes. The review is the quality gate — use it. |
| "AI-generated code is probably fine" | AI code needs more scrutiny, not less. It's confident and plausible, even when wrong. |
| "The tests pass, so it's good" | Tests are necessary but not sufficient. They don't catch architecture problems, security issues, or readability concerns. |

## Red Flags

- PRs merged without any review
- Review that only checks if tests pass (ignoring other axes)
- "LGTM" without evidence of actual review
- Standards and Spec passes sharing one context or seeing each other's findings
- Reviewing `HEAD` without recording a fixed base, head, and merge base
- Silently skipping the Spec axis because provenance is unavailable
- Security-sensitive changes without security-focused review
- Large PRs that are "too big to review properly" — split them
- No regression tests with bug-fix PRs
- Comments without severity labels

## Verification

After review is complete:

- [ ] All Critical issues resolved
- [ ] All required (no-prefix) issues resolved or explicitly deferred with justification
- [ ] Standards and Spec passes used distinct context ids
- [ ] Review used a resolved, non-empty three-dot diff
- [ ] Spec provenance or explicit unavailable status is recorded
- [ ] Every finding cites a file and line
- [ ] Tests pass — cite the command and summary line
- [ ] Build succeeds
- [ ] Verification story documented (what changed, how it was verified)
- [ ] `fauna_workitem_record_review` attached both axes and verifier evidence to the work-item run
- [ ] For UI changes: before/after screenshots attached

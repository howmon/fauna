---
name: code-review-and-quality
description: Performs multi-axis code review before merge. Use when a Kanban card enters the review column, when evaluating code another agent produced, or before merging any change. Reviews across correctness, readability, architecture, security, and performance.
---

# Code Review and Quality

## Overview

Every change gets reviewed before merge — no exceptions. Review covers five
axes: correctness, readability, architecture, security, performance.

**Approval standard:** Approve when the change definitely improves overall
code health, even if it isn't perfect. Don't block because it isn't exactly
how you would have written it. Don't rubber-stamp either.

## When to Use

- A Kanban card has moved to the `review` column
- Before merging any PR
- When evaluating code another agent produced
- After completing a feature implementation

## Process

### Step 1: Understand the Context

```
- What is this change trying to accomplish?
- What spec or task does it implement?
- What is the expected behavior change?
```

### Step 2: Review the Tests First

```
- Do tests exist for the change?
- Do they test behavior (not implementation details)?
- Are edge cases covered?
- Would the tests catch a regression if the code changed?
```

### Step 3: Review the Implementation

For each file changed, walk the five axes:

1. **Correctness** — Does this code do what the test says it should? Edge cases, error paths, off-by-one, race conditions.
2. **Readability** — Can another engineer understand this without the author explaining it? No clever tricks. Could this be done in fewer lines?
3. **Architecture** — Does this fit the system's design? Existing patterns? Clean module boundaries? No circular deps?
4. **Security** — Input validated at boundaries? No secrets in code? Auth checks in place? External data treated as untrusted?
5. **Performance** — N+1 queries? Unbounded loops? Sync ops that should be async? Missing pagination?

### Step 4: Categorize Findings

| Prefix | Meaning |
|--------|---------|
| *(no prefix)* | Required change — must address before merge |
| **Critical:** | Blocks merge — security, data loss, broken functionality |
| **Nit:** | Minor — author may ignore |
| **Optional:** / **Consider:** | Suggestion worth considering |
| **FYI** | Informational only |

### Step 5: Verify the Verification

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
- Security-sensitive changes without security-focused review
- Large PRs that are "too big to review properly" — split them
- No regression tests with bug-fix PRs
- Comments without severity labels

## Verification

After review is complete:

- [ ] All Critical issues resolved
- [ ] All required (no-prefix) issues resolved or explicitly deferred with justification
- [ ] Tests pass — cite the command and summary line
- [ ] Build succeeds
- [ ] Verification story documented (what changed, how it was verified)
- [ ] For UI changes: before/after screenshots attached

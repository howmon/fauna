---
name: diagnosing-bugs
description: Build a red-capable feedback loop before diagnosing and fixing broken behavior. Use when debugging a confirmed bug, regression, crash, flaky failure, or incorrect output that needs root-cause evidence and a regression test.
invocation: model-only
maturity: promoted
user-invocable: false
---

# Diagnosing Bugs

## Overview

The first deliverable is one command that reproduces the user's exact symptom.
Do not form a root-cause theory or edit production code until that loop is red.
The same command must pass after the fix.

## When to Use

- Existing behavior is broken or has regressed.
- A test, build, request, or UI workflow fails unexpectedly.
- A failure is intermittent and needs a measured reproduction rate.
- A previous attempted fix did not address the reported symptom.

Do not use this for new behavior, speculative cleanup, or review-only work.

## Process

### 1. Build the Feedback Loop

Translate the reported symptom into one focused command. Tighten it until it
fails for the right reason and can distinguish broken from fixed behavior. For
flaky failures, run enough repetitions to record a useful failure rate.

If no command can reproduce the symptom, stop and report the missing test seam
or environment dependency. Do not guess at a fix.

### 2. Reproduce and Minimize

Capture the exact command, environment, failing output, and expected behavior.
Remove unrelated setup while preserving the failure.

### 3. Rank Falsifiable Hypotheses

Write at least two alternatives. Each hypothesis must state:

- the suspected cause;
- one observable prediction;
- the evidence that supports or rejects it.

Instrument one prediction at a time. Prefer evidence that can disprove the
leading hypothesis quickly.

### 4. Lock the Regression

Add a regression test at the nearest public behavior seam. Demonstrate that it
fails before the production fix, then apply the smallest root-cause change.

If no stable public seam exists, stop and surface the architectural limitation
instead of coupling the test to private implementation details.

### 5. Close the Loop

Remove temporary logs, probes, flags, and debug-only dependencies. Rerun the
original reproduction command, not merely a neighboring test. Then call
`fauna_workitem_record_diagnosis` with the red/green outputs, hypotheses,
regression-test evidence, and cleanup confirmation.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The stack trace makes the cause obvious" | It identifies a location, not necessarily the cause. Build the loop first. |
| "I can test after the fix" | A test that never failed cannot prove it guards the reported bug. |
| "One plausible theory is enough" | Competing falsifiable hypotheses prevent confirmation bias. |
| "The focused test passed, so cleanup can wait" | Debug instrumentation is part of the change until removed. |

## Red Flags

- Production edits before a red-capable reproduction exists
- Repeated code changes without a prediction for each experiment
- A regression test that was only run after the fix
- Declaring success from a different command than the original reproduction
- Debug logging, flags, fixtures, or dependencies left behind
- Skipping a flaky failure instead of measuring and isolating it

## Verification

- [ ] One exact command reproduces the user's symptom before the fix.
- [ ] At least two ranked hypotheses include predictions and evidence.
- [ ] A regression test fails before and passes after the production fix.
- [ ] The original reproduction command passes after the fix.
- [ ] Temporary instrumentation is removed.
- [ ] `fauna_workitem_record_diagnosis` attaches all evidence to the work-item run.

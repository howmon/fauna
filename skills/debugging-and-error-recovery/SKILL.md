---
name: debugging-and-error-recovery
description: Five-step triage for tests failing, builds breaking, or behavior going unexpected. Use when a task has failed, when a previous step's actions returned errors, or when the autonomous loop has produced output that doesn't match expectations.
---

# Debugging and Error Recovery

## Overview

When something breaks, panic-fixing makes it worse. Follow a disciplined
triage: reproduce, localize, reduce, fix, guard. Stop-the-line — do not pile
new work on top of a broken state.

## When to Use

- A test failed
- The build broke
- An autonomous action returned an error
- The system's behaviour does not match the spec or your expectations
- A previously-working command is now failing

**When NOT to use:** Working code that you simply don't like. That's
`code-review-and-quality` or `code-simplification`.

## Process

### 1. Reproduce

Get the failure to happen on demand. If it's flaky, run it 10× and count
the failure rate. Capture the exact command, environment, and output.
Without a reliable reproduction, every "fix" is a guess.

### 2. Localize

Bisect. Which file, which function, which line? Use `git bisect`, console
logging, or printf-debugging if a debugger isn't available. Localize before
hypothesizing.

### 3. Reduce

Cut away everything that isn't essential to the failure. The smaller the
reproduction, the faster the fix. A 5-line reproduction beats a 500-line one
every time.

### 4. Fix

Write a test that captures the bug (`test-driven-development` — the
Prove-It pattern), then fix the bug. The test must fail before the fix and
pass after.

### 5. Guard

Once fixed, add a regression test or assertion so the bug cannot return
silently. If the bug came from a class of mistake (e.g. unhandled null),
audit nearby code for the same shape.

## Stop-the-Line Rule

When a CI build or a shared environment breaks, fixing it takes precedence
over any new work. Do not commit on top of a red build. Do not work around
a broken dep — fix it.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I know what's wrong, no need to reproduce" | Half the time you're wrong. Reproduce first. |
| "It's flaky, just re-run it" | Flaky tests hide real bugs. Investigate, don't retry. |
| "I'll add a try/catch and move on" | Swallowing the error hides the symptom and lets the bug spread. Catch only what you can handle meaningfully. |
| "It works on my machine" | The CI/agent environment is the source of truth. Reproduce there. |
| "The error message is unhelpful" | Then improve the error message as part of the fix. |

## Red Flags

- A "fix" that doesn't include a regression test
- A "fix" that touches more than the file containing the bug
- Debug output left in source code after the fix
- Try/catch added with an empty body or just `console.log(e)`
- "Flaky" tests skipped instead of fixed
- A new task started while CI is red

## Verification

After fixing any bug:

- [ ] The reproduction test fails on the pre-fix code (cite the failure)
- [ ] The reproduction test passes on the fixed code (cite the pass)
- [ ] The full test suite passes (cite the summary line)
- [ ] No debug `console.log`s or dead try/catches left behind
- [ ] If the bug was a class of mistake, nearby code was audited for the same shape
- [ ] CI / build is green

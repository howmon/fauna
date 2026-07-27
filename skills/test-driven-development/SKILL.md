---
name: test-driven-development
description: Drives development with tests written before the code. Use when implementing any logic, fixing any bug, or changing any behavior. Use when you need to prove that code works rather than asserting that it "looks right".
---

# Test-Driven Development

## Overview

Write the failing test before the code that makes it pass. For bug fixes,
reproduce the bug with a test before attempting a fix. Tests are proof —
"seems right" is not done. A codebase with good tests is an autonomous
agent's superpower; a codebase without tests is a liability.

## When to Use

- Implementing any new logic or behavior
- Fixing any bug (the Prove-It pattern)
- Modifying existing functionality
- Adding edge-case handling

**When NOT to use:** Pure configuration changes, documentation updates, or static content with no behavioral impact.

## Process

### RED — Write a Failing Test

Write the test first. It must fail. A test that passes immediately proves
nothing.

### GREEN — Make It Pass

Write the minimum code to make the test pass. Don't over-engineer.

### REFACTOR — Clean Up

With tests green, improve the code without changing behavior. Run tests
after every refactor step.

### The Prove-It Pattern (Bug Fixes)

```
Bug report arrives
       │
       ▼
  Write a test that demonstrates the bug
       │
       ▼
  Test FAILS (confirming the bug exists)
       │
       ▼
  Implement the fix
       │
       ▼
  Test PASSES (proving the fix works)
       │
       ▼
  Run full test suite (no regressions)
```

## Test Pyramid

```
        ╱╲
       ╱  ╲         E2E Tests (~5%)
      ╱    ╲        Full user flows, real browser
     ╱──────╲
    ╱        ╲      Integration Tests (~15%)
   ╱          ╲     Component interactions, API boundaries
  ╱────────────╲
 ╱              ╲   Unit Tests (~80%)
╱                ╲  Pure logic, isolated, milliseconds each
```

**The Beyonce Rule:** If you liked it, you should have put a test on it.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll write tests after the code works" | You won't. And tests written after the fact test implementation, not behavior. |
| "This is too simple to test" | Simple code gets complicated. The test documents the expected behavior. |
| "Tests slow me down" | Tests slow you down now. They speed you up every time you change the code later. |
| "I tested it manually" | Manual testing doesn't persist. Tomorrow's change might break it with no way to know. |
| "The code is self-explanatory" | Tests ARE the specification. They document what the code should do, not what it does. |
| "Let me run the tests again just to be extra sure" | After a clean test run, repeating the same command adds nothing unless the code has changed since. |

## Red Flags

- Writing code without any corresponding tests
- Tests that pass on the first run (they may not be testing what you think)
- "All tests pass" but no tests were actually run
- Bug fixes without reproduction tests
- Tests that test framework behavior instead of application behavior
- Skipping tests to make the suite pass
- Running the same test command twice in a row without any intervening code change

## Verification

After completing any implementation:

- [ ] Every new behavior has a corresponding test
- [ ] All tests pass — cite the command and the pass/fail summary line
- [ ] Bug fixes include a reproduction test that failed before the fix
- [ ] Test names describe the behavior being verified
- [ ] No tests were skipped or disabled

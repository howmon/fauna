---
name: incremental-implementation
description: Implements features in thin, verifiable vertical slices instead of one large change. Use when implementing any change that touches more than one file, when adding a new feature, or any time the work could be split into multiple commits.
---

# Incremental Implementation

## Overview

Ship thin vertical slices. Each slice does one observable thing end-to-end,
includes its own test, and leaves the system in a working state. Big-bang
implementations are the most common source of unreviewable changes,
regression bugs, and rollback nightmares.

## When to Use

- Any change touching more than 2 files
- Adding a new feature, API endpoint, or UI component
- Migrating data or behaviour
- Replacing or extracting a module

**When NOT to use:** Single-file typo fixes, dependency bumps, config-only changes.

## Process

1. **Identify the smallest end-to-end slice.** Not the smallest file change —
   the smallest *user-visible* slice. "Add a button that calls a stub
   endpoint that returns 200" is a slice. "Add a button" alone is not.

2. **Implement the slice.** Use feature flags or safe defaults so the new
   code path is off in production until you flip it.

3. **Test the slice.** Write the test before or alongside the code (see
   `test-driven-development`). If the slice has no test, it is not done.

4. **Verify locally.** Run the relevant test command. Check the build still
   passes. For UI work, screenshot before and after.

5. **Commit the slice atomically.** One concept per commit. The commit
   message names the slice, not the file list.

6. **Move to the next slice.** Do not bundle slices "because they're related"
   — they belong in separate commits.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "These three changes are too small to commit separately" | Three small commits are easier to review and revert than one medium commit. |
| "Splitting it would mean writing the same setup twice" | Test setup duplication is fine (DAMP). Production code duplication is not. |
| "I'll commit it all at the end" | At the end you have no idea what's working and what isn't. Commit each slice as it lands. |
| "Feature flags add complexity" | A feature flag is cheaper than a revert under a production incident. |

## Red Flags

- A single commit changes >300 lines of source (tests don't count toward this)
- The change can't be summarized in one imperative sentence
- The PR description lists more than 3 bullet points of "what changed"
- Tests were added "afterwards" rather than alongside the slice
- The change can't be safely deployed mid-rollout

## Verification

After each slice, confirm:

- [ ] The slice has at least one passing test that would fail without the change
- [ ] `npm test` (or equivalent) is green
- [ ] The build succeeds
- [ ] The slice could be reverted independently of later slices
- [ ] Commit message is one imperative sentence naming the slice
- [ ] For UI changes: a screenshot is attached to the card or PR

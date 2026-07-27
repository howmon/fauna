---
name: spec-driven-development
description: Defines what is being built before any code is written. Use when a Kanban card enters the backlog without acceptance criteria, when starting a new feature or significant change, or when the requirements are ambiguous enough that two engineers could implement the task differently.
---

# Spec-Driven Development

## Overview

Before writing any non-trivial code, write a short spec covering the
objective, the user-visible behaviour, the boundaries (what is and isn't in
scope), and the acceptance criteria. A spec is cheap to revise. Code built
on the wrong spec is expensive to revise.

## When to Use

- A new Kanban card enters the backlog with a title but no acceptance criteria
- Starting any feature, refactor, or migration that will touch more than 3 files
- The requirement could be implemented in more than one sensible way
- The work crosses module boundaries (frontend ↔ backend, etc.)

**When NOT to use:** Bug fixes with a clear reproduction. Typo fixes. Dependency bumps.

## Process

Write a spec with these sections (keep it to one screen — this is a contract,
not a design doc):

### 1. Objective

One sentence: what user outcome does this produce? Not "add a button" —
"let the user create a folder inside a project source so they can organise
files without leaving Fauna".

### 2. User-Visible Behaviour

Numbered list of what the user will see, click, or get back. Concrete
enough that you could write a UI test from it.

### 3. Acceptance Criteria

Bulleted list of testable conditions. Each one becomes a verification item
later. Format as Given/When/Then or "MUST/SHOULD/MUST NOT".

### 4. Out of Scope

The single most-skipped section. Name 2-3 things you could reasonably do
here but won't, with one-line reasons. Prevents scope creep mid-task.

### 5. Open Questions

If anything is ambiguous, list it here with your best-guess answer and a
"correct me now or I'll proceed with this" note.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The task title is enough" | Then writing a one-screen spec from it takes 60 seconds. Do it. |
| "I'll figure out the requirements as I code" | You will not. You will figure out your own preferences and call them requirements. |
| "The user will tell me if I get it wrong" | After 30 minutes of work. Spec first. |
| "The spec will lock me in" | The spec is revisable. The code built on the wrong spec is not. |

## Red Flags

- Implementation began before acceptance criteria existed
- "Acceptance criteria" that are too vague to be tested ("works correctly", "is fast")
- No "out of scope" section, leading to mid-task scope creep
- Open questions that were never asked
- The spec was written *after* the code and back-fitted

## Verification

Before leaving this skill:

- [ ] Spec exists and is attached to the card (or in the task description)
- [ ] Acceptance criteria are testable — each one maps to at least one verification step
- [ ] An "out of scope" section names 2-3 explicit non-goals
- [ ] Open questions have been raised with the user OR explicitly resolved with a documented assumption
- [ ] The spec was reviewed before code was written (not after)

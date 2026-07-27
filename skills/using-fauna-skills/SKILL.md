---
name: using-fauna-skills
description: Discovers and invokes Fauna skills. Use when starting a session or deciding which skill applies to the current task. This is the meta-skill that governs how all other skills are loaded via fauna_list_skills / fauna_get_skill.
---

# Using Fauna Skills

## Overview

Fauna ships a small set of lifecycle skills that encode senior-engineering
discipline for autonomous tasks. Each skill is a workflow with explicit
verification — not a reference doc. This meta-skill tells you when to load
which one.

## When to Use

- Starting a new autonomous task and unsure which skill applies
- A Kanban card is moving between columns and you need to know the gates
- The model is about to declare TASK_COMPLETE and you want to know what
  evidence the verification gate expects

## Discovery

Tasks arrive with a column or intent. Map to a skill:

```
Card in backlog  → spec-driven-development   (write acceptance criteria first)
Card in todo     → planning-and-task-breakdown
Card in_progress → incremental-implementation + test-driven-development
Card in review   → code-review-and-quality
Anything failing → debugging-and-error-recovery
```

The active skills for the current task are listed in your system prompt
under "ACTIVE SKILLS for this task". Load full bodies with
`fauna_get_skill(name)` — or fetch just one section with
`fauna_get_skill(name, "Verification")` to keep tokens low.

## Process

These behaviors apply at all times, across all skills. They are
non-negotiable:

1. **Surface assumptions** before acting on ambiguous requirements.
2. **Manage confusion** — stop and name it rather than guessing through it.
3. **Push back when warranted** — sycophancy is a failure mode.
4. **Enforce simplicity** — if 100 lines suffice, do not write 1000.
5. **Scope discipline** — touch only what you were asked to touch.
6. **Verify, do not assume** — "seems right" is never sufficient.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The skill is too generic for this task" | Skills are guardrails, not templates. Apply the discipline; skip steps that don't apply with a one-line note. |
| "I know how to do this without loading the skill" | Then loading it costs nothing. Load it anyway — the Verification section is what catches the mistakes you didn't think of. |
| "This task is too small for a verification gate" | Verification of a small task is cheap. Verification debt of a big task is expensive. |

## Red Flags

- Declaring TASK_COMPLETE without citing evidence from the active skill's Verification checklist
- Loading the same skill repeatedly within one task (load once, refer back)
- Picking a skill that doesn't match the task's actual phase (e.g. shipping-and-launch for a debug task)

## Verification

This is a meta-skill — it has no exit criteria of its own. Its presence is
verified by the autonomous loop: every TASK_COMPLETE goes through the
anti-rationalization gate, which reads the active skill's `Verification`
section and requires cited evidence for each item.

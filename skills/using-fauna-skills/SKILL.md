---
name: using-fauna-skills
maturity: promoted
description: Discovers and invokes Fauna skills. Use when starting a session or deciding which skill applies to the current task. This is the meta-skill that governs how all other skills are loaded via fauna_list_skills / fauna_get_skill.
---

# Using Fauna Skills

## Overview

Fauna ships lifecycle workflows and model-invoked reference primitives that
encode senior-engineering discipline for autonomous tasks. Workflows control
phases; references supply shared vocabulary and checks without starting a new
phase. This meta-skill tells you when to load which one.

## When to Use

- Starting a new autonomous task and unsure which skill applies
- A Kanban card is moving between columns and you need to know the gates
- The model is about to declare TASK_COMPLETE and you want to know what
  evidence the verification gate expects

## Discovery

For an engineering situation, call `fauna_route_engineering_flow` first. It
returns the current lifecycle phase, the skill or skills for that phase,
required and produced artifacts, and context guidance. Then load only the
returned skill bodies with `fauna_get_skill`.

Kanban columns still provide direct bindings when the phase is already known:

```
Card in backlog  → spec-driven-development   (write acceptance criteria first)
Accepted multi-session spec → to-tickets     (preview and approve the work graph)
Card in todo     → use the accepted flow phase; no default skill is forced
Card in_progress → incremental-implementation + test-driven-development
Card in review   → code-review-and-quality
Anything failing → diagnosing-bugs
```

Load reference primitives only when the active workflow needs them:

```
Ambiguous business terms or invariants → domain-modeling
Cross-module ownership or dependency decisions → codebase-design
```

Reference primitives never replace the active lifecycle skill and never start
another workflow. Fetch only the relevant section when that is sufficient.

## Phase Boundaries

At phase completion, blockage, a destination change, or when context use
approaches the model-specific threshold, call `fauna_route_engineering_flow`
with the known flow, phase, and task state. Use its `contextRecommendation`:

- `continue`: the next phase needs this conversation and budget remains;
- `clear`: the next work is self-contained or current context is irrelevant;
- `handoff`: context must cross a workspace, harness, owner, or blocker;
- `subagent`: a side task is tightly scoped and can run unattended;
- `compact`: relevant context must remain but token pressure is high;
- `none`: no real boundary exists, so do not interrupt the user.

Do not call this merely because a turn ended. Phase transitions and measured
context pressure are the triggers, not elapsed time or message count.

Kanban concurrency does not imply filesystem isolation. Before considering
parallel worktrees, use `fauna_evaluate_worktree_parallelism` on approved
ready-frontier cards with disjoint file scopes. Treat
`eligible-for-controlled-rollout` as evaluation evidence, not permission to
create worktrees automatically.

When a human explicitly asks which flow fits, tell them to invoke `ask-fauna`.
Do not invoke that user-only skill on their behalf.

When a human explicitly asks to split an accepted specification into Kanban
work, load `to-tickets`. It is also user-only: preview the validated graph, then
wait for explicit approval before publishing cards.

When a human explicitly asks to onboard a repository to Fauna's engineering
process, load `setup-fauna-engineering`. Preview its repository contract and
preserve existing files until the user approves any manual reconciliation.

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
- Guessing the lifecycle phase instead of calling `fauna_route_engineering_flow`

## Verification

This is a meta-skill — it has no exit criteria of its own. Its presence is
verified by the autonomous loop: every TASK_COMPLETE goes through the
anti-rationalization gate, which reads the active skill's `Verification`
section and requires cited evidence for each item.

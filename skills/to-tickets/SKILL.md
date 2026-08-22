---
name: to-tickets
description: Convert an accepted specification into narrow, independently verifiable Kanban tickets with explicit dependency edges. Use for multi-session work after scope and acceptance criteria are agreed. Preview the graph and obtain user approval before publishing cards.
invocation: user-only
maturity: promoted
disable-model-invocation: true
---

# To Tickets

## Overview

Turn an accepted specification into a dependency graph that Fauna can execute
through its existing Kanban scheduler.

## When to Use

- The behavior and acceptance criteria are already agreed.
- The work is too large for one focused implementation session.
- Multiple slices could proceed independently once their blockers are complete.

Do not use this skill to discover requirements, manage a one-ticket change, or
split work into database/frontend/testing layers that cannot deliver behavior
independently.

## Workflow

1. Read the accepted specification and identify observable end-to-end behaviors.
2. Draft narrow vertical tickets, each small enough for one fresh context.
3. Give every ticket a stable local key, explicit acceptance criteria, and one
   verification command that can fail before the ticket is complete.
4. Add only real `blockedBy` edges. Prefer the widest valid ready frontier.
   For tickets proposed for a worktree pilot, also declare a conservative
   repository-relative `fileScope`. Shared or overlapping paths mean the
   tickets must be serialized or resliced.
5. For wide migrations, use expand, migrate, and contract tickets with explicit
   edges between them.
6. Call `fauna_create_ticket_plan` with `approved=false`.
7. Show the user the validated ticket granularity, dependency edges, and ready
   frontier. Ask for approval or revisions.
8. Only after explicit approval, call the same tool with `approved=true`.

## Ticket Quality

Each ticket must:

- produce an observable behavior or a safely deployable migration state;
- include enough context to begin in a fresh session;
- have acceptance criteria that describe outcomes rather than implementation;
- name a focused verification command;
- avoid depending on a ticket merely because it appears earlier in the list.

## Worktree Evaluation

Parallel Kanban cards normally share one working tree. Do not assume scheduler
concurrency means Git isolation. For a controlled worktree experiment:

1. Select at least two ready-frontier cards with independent verifiers.
2. Confirm each card has an explicit, disjoint `fileScope`.
3. Resolve a clean Git base commit and confirm worktree support.
4. Preview with `fauna_evaluate_worktree_parallelism` and `approved=false`.
5. Obtain explicit approval for the candidate set and scopes before evaluating
   it with `approved=true`.
6. Run trials only through an external experimental harness. The evaluator
   never creates worktrees, starts tasks, merges branches, or enables rollout.
7. Keep rollout disabled until the configured minimum sample passes every
   conflict, verifier, human-rework, and cleanup threshold.

## Stop Conditions

- Stop and clarify if the specification is not accepted.
- Stop and revise if the validator reports unknown blockers or a cycle path.
- Stop after previewing until the user explicitly approves publication.
- Do not silently move published cards into progress.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The list order makes the dependencies obvious" | The scheduler only enforces explicit `blockedBy` ids. |
| "We can add verification later" | A ticket without a verifier is not independently executable. |
| "The user asked for tickets, so publication is implied" | The user must approve the previewed granularity and edges first. |

## Red Flags

- Tickets organized by technical layer instead of observable behavior
- A serial chain where tickets can actually run independently
- Acceptance criteria that only restate the title
- Publishing before an approval response

## Verification

- Every published card has acceptance criteria and a verification command.
- Every blocker resolves to an existing card id.
- The graph is acyclic and exposes its ready frontier.
- Unblocked Todo cards are claimable by the existing scheduler while blocked
  cards remain unclaimable.
- Any proposed worktree candidates have disjoint `fileScope` values and the
   evaluator reports both candidate eligibility and trial-metric status.

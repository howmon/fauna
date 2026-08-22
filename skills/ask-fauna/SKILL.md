---
name: ask-fauna
maturity: promoted
disable-model-invocation: true
description: Find the right Fauna engineering flow and next skill for the situation you are in.
---

# Ask Fauna

## Overview

Route the user's situation through Fauna's validated engineering lifecycle.
Recommend the next action and stop. Do not start the recommended workflow.

## When to Use

Use only when the user explicitly asks for `ask-fauna`, asks which engineering
flow fits, or wants to know what to do next. The model must not invoke this
skill autonomously.

## Process

1. Call `fauna_route_engineering_flow` with the user's situation. If the user
   names a known flow or phase, pass those fields too.
2. If the result contains `clarify`, ask that one discriminating question and
   stop. Do not guess between tied flows.
3. Otherwise report, concisely:
   - the selected flow and current phase;
   - why it fits and why the closest neighboring routes do not;
   - the exact next skill or skills to load;
   - artifacts required before the phase and artifacts it should produce;
   - the context recommendation for the next phase.
4. End by naming the next action. Do not load the skill, edit files, create
   tickets, or begin implementation.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The top semantic skill is enough" | A skill match does not identify lifecycle state, prerequisites, or the next transition. |
| "I can start the recommended work now" | This skill is a router. Starting work removes the user's phase-boundary decision. |
| "The situation is probably feature work" | A tie requires the returned clarification question, not a guess. |

## Red Flags

- Recommending a skill without calling `fauna_route_engineering_flow`
- Starting implementation or loading the recommended skill
- Omitting required or produced artifacts
- Hiding a low-confidence or tied route
- Listing every available skill instead of naming the next action

## Verification

- [ ] The response names exactly one flow and phase, or asks one clarification question.
- [ ] The next skill names come from the flow result.
- [ ] The response includes prerequisites, outputs, and context guidance.
- [ ] The response explains why the closest alternative does not fit.
- [ ] No recommended workflow was started.
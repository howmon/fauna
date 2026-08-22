---
name: codebase-design
invocation: model-only
maturity: promoted
description: Provides shared vocabulary and decision rules for module boundaries, public interfaces, ownership, dependencies, and migration structure. Use when a change crosses modules, introduces an abstraction, moves responsibilities, changes dependency direction, or requires an architectural tradeoff.
---

# Codebase Design

## Overview

Choose the smallest design that gives the requested behavior a clear owner and
a stable verification boundary. Existing repository structure and public APIs
are evidence. Do not impose an idealized architecture on a local change.

This is a model-invoked reference skill. It supplies shared terms and checks to
phase-level specification, implementation, debugging, and review workflows.

## When to Use

- A change crosses module, process, service, or frontend/backend boundaries.
- Responsibility or data ownership is unclear.
- A new interface, adapter, shared helper, or dependency is proposed.
- A migration must preserve old and new callers during rollout.
- Review identifies coupling, cycles, or leakage across a public boundary.

Do not use it to justify unrelated refactoring or abstractions with one caller.

## Process

1. Locate the code that directly owns the behavior. Distinguish decision logic
   from wiring, registration, transport, and rendering.
2. Identify the current public interface, its callers, its dependencies, and
   the cheapest test that observes the behavior at that boundary.
3. Assign one owner for each rule or state transition. Keep policy near the
   data and invariants it governs; keep infrastructure behind an adapter when
   substitution or isolation is materially useful.
4. Prefer dependencies that point from volatile details toward stable policy.
   Reject cycles and hidden access around a module's public interface.
5. Introduce an abstraction only when it removes meaningful duplication,
   isolates volatility, or matches an established repository pattern.
6. For migrations, use **expand, migrate, contract**: add a compatible path,
   move callers with verification, then remove the obsolete path.
7. Record durable, cross-cutting decisions in the repository's ADR location.
   Keep local implementation choices in code and tests.

## Shared Vocabulary

| Term | Meaning |
|---|---|
| Owner | The module responsible for a behavior, invariant, or state transition |
| Boundary | The public interface through which another part of the system interacts |
| Dependency direction | Which module knows about and calls another module |
| Adapter | Code that translates between a stable internal interface and an external detail |
| Seam | A boundary where behavior can be observed or substituted without invasive changes |
| Cohesion | How strongly a module's responsibilities belong together |
| Coupling | How much one module depends on another's details |
| Expand, migrate, contract | A compatible migration sequence that avoids one-step replacement risk |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| “We may need this abstraction later” | Add it when a real variation or second use exists. |
| “A shared utility removes duplication” | It can also hide ownership and couple unrelated callers. |
| “Moving files improves the architecture” | Boundaries change through interfaces and dependencies, not directory motion alone. |
| “Tests pass, so the dependency direction is fine” | Tests do not make cycles or leaked internals maintainable. |

## Red Flags

- Editing wiring while the behavior-owning module remains unchanged
- New bidirectional or circular dependencies
- Callers reaching around a public interface into internal state
- A generic abstraction named after mechanics rather than responsibility
- A migration that requires every caller to switch atomically
- An ADR for a small local choice, or no ADR for a durable cross-system choice

## Verification

- [ ] The behavior and each invariant have one identifiable owner.
- [ ] The changed public boundary and its callers are explicit.
- [ ] Dependency direction is acyclic and consistent with repository patterns.
- [ ] New abstractions solve demonstrated complexity or variation.
- [ ] A focused test observes behavior at the chosen boundary.
- [ ] Migrations preserve compatibility until callers are verified.
- [ ] Durable architectural decisions are recorded in the repository contract.

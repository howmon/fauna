---
name: domain-modeling
invocation: model-only
maturity: promoted
description: Establishes precise domain language, concepts, invariants, and context boundaries before specifications or implementation choices harden. Use when requirements use ambiguous business terms, multiple names describe the same concept, one term has conflicting meanings, or behavior depends on domain rules.
---

# Domain Modeling

## Overview

Build a small, evidence-based vocabulary for the problem being solved. The
goal is shared meaning, not a large abstract model. Prefer language used by
users and repository documentation over names inferred from implementation.

This is a model-invoked reference skill. A phase-level workflow may load it,
but it does not start a separate workflow or create work on its own.

## When to Use

- Requirements use important terms without defining them.
- Different files or people use different names for the same concept.
- One word means different things in different parts of the system.
- Acceptance criteria depend on business rules or state transitions.
- A durable domain decision needs a repository-owned definition.

Do not use it for a mechanical change whose vocabulary is already explicit.

## Process

1. Read `docs/agents/domain.md`, the active specification, and nearby public
   interfaces when they exist. Treat repository language as evidence, not as
   automatically correct.
2. Extract only terms that affect behavior. For each term, record its meaning,
   valid examples, non-examples, and any disputed aliases.
3. Classify concepts only when useful:
   - **entity:** identity persists while attributes change;
   - **value:** equality follows its contents;
   - **event:** a domain fact that already occurred;
   - **command:** a requested action that can succeed or fail;
   - **policy:** a rule that selects or constrains behavior;
   - **invariant:** a condition that must remain true.
4. Identify context boundaries only where language or rules genuinely change.
   State translations at those boundaries explicitly.
5. Express invariants as testable statements. Prefer “A card cannot be claimed
   while any blocker is incomplete” over a noun-only class diagram.
6. Reuse the agreed terms in the spec, tickets, tests, APIs, and user-facing
   copy. If the decision is durable, update the existing domain document or
   propose an ADR through the owning workflow.

## Shared Vocabulary

| Term | Meaning |
|---|---|
| Ubiquitous language | Terms used consistently by users, docs, code, and tests within one context |
| Context boundary | A place where a term or rule changes meaning and needs explicit translation |
| Entity | A concept identified by continuity rather than only by its attributes |
| Value | An immutable concept identified by its contents |
| Event | A named fact that occurred in the domain |
| Command | A request to perform an action, subject to validation and failure |
| Policy | A business rule that determines or constrains an outcome |
| Invariant | A condition the system must preserve across every valid transition |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| “The names in the database are the domain model” | Storage names reflect implementation and may preserve obsolete language. |
| “Every noun needs a class” | Model only concepts that clarify behavior or ownership. |
| “A glossary is enough” | Important terms also need rules, examples, and boundary translations. |
| “We can resolve naming during implementation” | Late vocabulary decisions spread incompatible names through code and tests. |

## Red Flags

- Inventing business rules without repository or user evidence
- Treating technical components as domain concepts
- Creating context boundaries solely to mirror directories or services
- Using multiple aliases in new code after choosing one canonical term
- Producing diagrams or abstractions that do not change a requirement or test

## Verification

- [ ] Every modeled term affects the requested behavior.
- [ ] Meanings come from user, specification, or repository evidence.
- [ ] Conflicts and assumptions are explicit rather than silently resolved.
- [ ] Invariants are testable and appear in acceptance criteria or tests.
- [ ] Boundary translations are named where meanings differ.
- [ ] The resulting spec and implementation use the agreed vocabulary.

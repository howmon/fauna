---
name: setup-fauna-engineering
description: Establish a repository-owned engineering contract for Fauna. Use when onboarding a project that lacks durable context, provider-neutral issue-tracker operations, triage role mappings, domain language, or ADR guidance.
invocation: user-only
maturity: promoted
disable-model-invocation: true
---

# Setup Fauna Engineering

## Overview

Create a small, committed Markdown contract that lets humans and agents recover
project intent after context resets. Repository files are the source of truth;
Fauna project metadata stores only a disposable location/version cache.

This workflow previews every file and never overwrites an existing document.

## When to Use

- A repository is being onboarded to Fauna engineering workflows.
- Tracker operations or triage meanings live only in people's memory.
- Agents repeatedly rediscover entry points, commands, and module boundaries.
- Architecture decisions have no durable, agreed location.

Do not use this to replace rich existing project documentation. Preserve those
files and integrate missing details manually.

## Process

1. Inspect the repository's existing documentation, manifests, test commands,
   entry points, and architectural boundaries.
   Load `codebase-design` when boundary or ownership terms need normalization.
2. Ask the user only for facts that cannot be derived safely:
   - tracker name and optional project URL;
   - how to search, create, update, comment on, and close work;
   - semantic triage roles and their current tracker mappings;
   - disputed or project-specific domain terms.
   Load `domain-modeling` to define those terms, examples, invariants, and
   context-specific meanings without inventing business rules.
3. Build a profile for `fauna_setup_engineering` containing tracker operations,
   triage roles, domain language, entry points, commands, and boundaries.
4. Call the tool with `approved=false` and show which files will be created or
   preserved. Existing files must remain untouched.
5. Ask the user to approve the proposed contract.
6. After explicit approval, call the same tool with `approved=true`.
7. Recommend committing the generated Markdown with the repository. Do not
   claim that Fauna's metadata cache is the source of truth.

## Generated Contract

| File | Ownership |
|---|---|
| `CONTEXT.md` | Project overview, entry points, commands, and boundaries |
| `docs/agents/issue-tracker.md` | Provider-neutral tracker operations |
| `docs/agents/triage-labels.md` | Stable semantic roles mapped to current tracker values |
| `docs/agents/domain.md` | Ubiquitous project language |
| `docs/adr/README.md` | ADR location, naming, and minimum contents |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The README already explains everything" | Preserve it, but verify that tracker operations, boundaries, and domain terms are explicit. |
| "We can encode the GitHub labels directly" | Stable semantic roles belong in the contract; provider labels are mappings. |
| "The generated files can overwrite stale docs" | Existing files may contain reviewed intent. Preserve and reconcile them manually. |
| "Fauna metadata is enough" | Local metadata is a cache; committed Markdown survives tools, people, and context resets. |

## Red Flags

- Writing outside the active project root
- Overwriting an existing contract file
- Inventing tracker operations, labels, domain definitions, or commands
- Provider-specific assumptions presented as universal workflow
- Creating the files before the user approves the preview
- Treating generated text as correct without repository and user review

## Verification

- [ ] The preview identifies every file as create or preserve.
- [ ] The user explicitly approved the preview before creation.
- [ ] Existing files are byte-for-byte unchanged.
- [ ] All generated paths remain inside the real project root.
- [ ] The contract covers tracker operations, triage mappings, domain language, context, and ADRs.
- [ ] The response identifies repository Markdown as the source of truth and reports metadata-cache status separately.

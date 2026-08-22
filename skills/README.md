# Fauna bundled skills

Skills shipped in-the-box with every Fauna install. Each subdirectory
contains a `SKILL.md` (YAML frontmatter + markdown body) that the model
sees in the manifest of every conversation and loads on demand via
`fauna_read_file`.

## What's here

| Skill | When it fires |
|-------|---------------|
| [ask-fauna](ask-fauna/SKILL.md) | User-invoked routing to the correct engineering flow and phase; recommends and stops |
| [codebase-design](codebase-design/SKILL.md) | Model-invoked reference for ownership, module boundaries, dependency direction, and migrations |
| [code-review-and-quality](code-review-and-quality/SKILL.md) | Review-column work and pre-merge checks |
| [debugging-and-error-recovery](debugging-and-error-recovery/SKILL.md) | Deprecated compatibility entry; migrate to `diagnosing-bugs` |
| [diagnosing-bugs](diagnosing-bugs/SKILL.md) | Feedback-loop-first diagnosis with enforced red/green evidence |
| [diagram-design](diagram-design/SKILL.md) | Architecture, process, data, circuit, and PCB diagrams |
| [domain-modeling](domain-modeling/SKILL.md) | Model-invoked reference for domain language, invariants, and context boundaries |
| [figma-design](figma-design/SKILL.md) | Any Figma design task via `figma_execute` — palettes, layout patterns, typography, QA loop |
| [incremental-implementation](incremental-implementation/SKILL.md) | Multi-file changes implemented as independently verifiable slices |
| [pptx](pptx/SKILL.md) | Any `.pptx` or `.potx` work — creating, editing, reading, or extracting text from PowerPoint decks and templates |
| [pr-writer](pr-writer/SKILL.md) | Pull request descriptions, commit messages, changelog entries |
| [simple-english](simple-english/SKILL.md) | Rewrite dense or unclear material in direct, accessible English |
| [setup-fauna-engineering](setup-fauna-engineering/SKILL.md) | Establish a repository-owned engineering contract with preview and approval |
| [spec-driven-development](spec-driven-development/SKILL.md) | Ambiguous or significant work that needs acceptance criteria before code |
| [test-driven-development](test-driven-development/SKILL.md) | New or changed behavior that should be proven test-first |
| [to-tickets](to-tickets/SKILL.md) | Convert an accepted multi-session spec into an approved dependency-aware Kanban plan |
| [using-fauna-skills](using-fauna-skills/SKILL.md) | Meta-skill for lifecycle routing, skill loading, and completion discipline |
| [watermarks](watermarks/SKILL.md) | Inspect or remove provenance and watermark data from owned content |

`engineering-flow.json` is the validated lifecycle graph behind
`fauna_route_engineering_flow`. The router can also recommend `continue`,
`clear`, `handoff`, `subagent`, or `compact` from task state, destination, and
the live model-specific context budget. It returns `none` outside a real phase
boundary or pressure event. The graph is not a skill and is never loaded into
the model context directly.

`governance.json` is the release evidence registry. It records compatibility,
minimum Fauna versions, golden and negative route cases, behavioral
evaluations, and deprecated-skill migration paths. `CHANGELOG.md` records the
bundled-skill release history.

Deprecated skills remain discoverable for migration but are excluded from
automatic routing.

## Precedence

Bundled skills are the **lowest priority** scope. Any skill of the same
name defined at agent / global / repo / user scope wins. Add or override:

- **User (personal, portable):** `~/.config/fauna/skills/<name>/SKILL.md`
- **Repo (team-shared, checked into git):** `<workspace>/skills/<name>/SKILL.md`
- **Global (across agents):** `<agentsDir>/_skills/<name>/SKILL.md`
- **Agent (only when that agent is active):** `<agentsDir>/<agent>/skills/<name>/SKILL.md`

## Adding a new bundled skill

1. Create a directory: `skills/<lowercase-hyphen-name>/`
2. Add `SKILL.md` with YAML frontmatter (`name`, `description`, `maturity`) + body.
   The `description` is the router prompt — start with "WHEN" and list
   every trigger phrase for model-invoked skills. User-only skills set
   `disable-model-invocation: true` and use a human-facing description.
3. Ship helper scripts alongside (`skills/<name>/scripts/`) if needed;
   reference them by relative path from inside `SKILL.md`.
4. Add the skill to this inventory, `governance.json`, and `CHANGELOG.md`.
   Promoted skills require positive and negative route cases plus a behavioral
   evaluation. Deprecated skills require a valid replacement and migration text.
5. Run `npm run skills:check`. Promotion fails on anatomy warnings, missing
   evidence, routing mismatches, packaging gaps, or high-severity findings in
   executable helper files.
6. Restart Fauna. The scanner picks it up automatically; it appears in
   the system-prompt manifest on the next turn.

Skills are packaged via `package.json → build.files → "skills/**"`.

# Fauna bundled skills

Skills shipped in-the-box with every Fauna install. Each subdirectory
contains a `SKILL.md` (YAML frontmatter + markdown body) that the model
sees in the manifest of every conversation and loads on demand via
`fauna_read_file`.

## What's here

| Skill | When it fires |
|-------|---------------|
| [figma-design](figma-design/SKILL.md) | Any Figma design task via `figma_execute` — palettes, layout patterns, typography, QA loop |
| [pptx](pptx/SKILL.md) | Any `.pptx` or `.potx` work — creating, editing, reading, or extracting text from PowerPoint decks and templates |
| [pr-writer](pr-writer/SKILL.md) | Pull request descriptions, commit messages, changelog entries |

## Precedence

Bundled skills are the **lowest priority** scope. Any skill of the same
name defined at agent / global / repo / user scope wins. Add or override:

- **User (personal, portable):** `~/.config/fauna/skills/<name>/SKILL.md`
- **Repo (team-shared, checked into git):** `<workspace>/skills/<name>/SKILL.md`
- **Global (across agents):** `<agentsDir>/_skills/<name>/SKILL.md`
- **Agent (only when that agent is active):** `<agentsDir>/<agent>/skills/<name>/SKILL.md`

## Adding a new bundled skill

1. Create a directory: `skills/<lowercase-hyphen-name>/`
2. Add `SKILL.md` with YAML frontmatter (`name`, `description`) + body.
   The `description` is the router prompt — start with "WHEN" and list
   every trigger phrase. See the two starter skills for the shape.
3. Ship helper scripts alongside (`skills/<name>/scripts/`) if needed;
   reference them by relative path from inside `SKILL.md`.
4. Restart Fauna. The scanner picks it up automatically; it appears in
   the system-prompt manifest on the next turn.

Skills are packaged via `package.json → build.files → "skills/**"`.

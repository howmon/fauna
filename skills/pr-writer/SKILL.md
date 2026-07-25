---
name: pr-writer
description: "Write a pull request description or commit message. Use whenever the user asks to draft, improve, summarize, or review a PR description, PR body, merge request text, commit message, or changelog entry. Also use when the user says \"open a PR\", \"write the PR\", \"summarize these commits\", or references a diff / patch that needs a human-readable summary."
---

# PR & commit message writer

Fast, honest, reviewer-first. Optimize for the reviewer who has 90 seconds.

## Structure (adjust to size)

### Title (always)

- Imperative mood, no period: `Add rate limit to /api/chat`
- Max ~72 chars — GitHub truncates the rest in list views
- Optional Conventional Commits prefix when the repo uses them: `feat:`, `fix:`, `perf:`, `refactor:`, `test:`, `docs:`, `chore:`. Never invent prefixes; check `git log --oneline -20` first.

### Body (small PR: skip, medium+: required)

Three sections, in this order:

**Why** (1–3 sentences)
- What problem this solves or what user need it addresses
- Link the issue / discussion / user report if there is one
- Skip abstract theory — name the concrete thing that broke or was missing

**What** (bullets, 3–8 lines)
- The user-visible change first, mechanics second
- Group by area if the PR touches multiple layers: `**Server:** …`, `**Client:** …`, `**Tests:** …`
- One bullet = one atomic change the reviewer would recognize in the diff

**How to verify** (bullets, required if the change is testable)
- Exact commands / clicks a reviewer runs
- Expected outcome for each
- Example: `npm test -- foo.test.js` → `all 12 pass`

### Optional trailing sections (add only when relevant)

- **Screenshots / video** — required for UI changes
- **Breaking changes** — call out explicitly, list migration steps
- **Follow-ups** — genuine deferred work, not "future improvements" filler
- **Rollback** — if non-obvious (`git revert <sha>` isn't enough)

## Rules

- **No filler.** Cut "This PR does…", "As part of…", "In this change we…". Start with the verb.
- **No lies of omission.** If the PR includes a drive-by refactor, mention it. Reviewers hate finding surprise changes.
- **Cite failure signals, not intent.** "Fixes NPE when user submits empty form" beats "Improves form validation".
- **Numbers over adjectives.** "Reduces p95 from 340ms → 190ms" beats "much faster".
- **No emoji in titles.** Bodies OK sparingly if the repo already uses them.
- **Never claim work you didn't do.** If tests aren't added, say why — don't handwave "existing coverage is sufficient" unless it truly is.
- **Never mark ready when it isn't.** Draft PR + explicit TODO list beats a finished-looking PR with silent gaps.

## Commit messages (when the user asks for one)

Same title rules as PR title. Body optional. When present:

```
<title, imperative, ≤72 chars>

<why in 1–3 sentences>
<blank line>
<what changed, bullets or prose>
<blank line>
<optional footer: Fixes #123, Co-authored-by: ..., BREAKING CHANGE: ...>
```

Prefer squash-friendly small commits over one giant one — but if the user is composing the final squash message for a merged PR, mirror the PR body.

## Sizing heuristic

| PR size | Format |
|---------|--------|
| ≤ 20 LOC, single file, obvious fix | Title only — no body needed |
| 20–200 LOC, single concern | Title + short Why + What |
| > 200 LOC OR multiple concerns | Title + Why + What + Verify + Screenshots/Breaking as needed |
| > 800 LOC | Suggest splitting the PR first; if user insists, add a **Reading order** section listing files in the order reviewer should open them |

## What to ask the user for (don't guess)

- The diff or a summary of it (`git diff origin/main...HEAD --stat` + selected file diffs)
- The linked issue / ticket ID / conversation
- Whether the repo uses Conventional Commits
- Whether reviewers expect screenshots for UI changes

If any of those are missing and non-inferable, ask before writing.

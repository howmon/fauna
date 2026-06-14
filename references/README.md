# Fauna References

Reference documents are reusable, read-only knowledge: server maps,
schemas, glossaries, architecture notes. They answer **"what is this?"**
questions.

For **"how do I do this?"** workflows, see `<repo>/skills/` instead.

The model finds references via the `fauna_list_references` tool and loads
one with `fauna_get_reference(name, section?)`. References are
progressively disclosed — the system prompt never carries them.

## Layout

```
references/
  fauna-server-map.md
  fauna-implementation-map.md
  fauna-sidebar-ia.md
```

A single `.md` per topic is the simplest layout. For larger references,
use `<name>/README.md`.

## Authoring

- Lead with an H1 (becomes the title in listings).
- The first non-heading line becomes the description in listings.
- Use `## Headings` for slice-able sections — the tool's `section` arg
  fetches one heading block at a time.

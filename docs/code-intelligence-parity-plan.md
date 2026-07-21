# Code Intelligence Parity Plan

## Goal

Make Fauna's repository discovery loop comparable to VS Code Copilot for common engineering work: locate the owning code, read only the needed range, follow symbols and references, edit safely, and validate without repeated shell round trips.

Parity is split into two claims:

- **Retrieval parity:** known-file reads, exact search, ranked discovery, and repeated workspace queries complete with structured results and low latency.
- **Semantic parity:** definitions, references, rename, and diagnostics use language-aware services rather than text heuristics.

Fauna must not label static regex results as semantic/LSP results.

## Baseline

Before this work, `fauna_read_file`, `fauna_grep`, `fauna_symbols`, `fauna_definition`, and `fauna_references` independently reread or rewalked the workspace. Symbol support was limited to JS/TS regex patterns. Natural-language implementation discovery required the model to guess grep terms or use shell commands.

Measured on the Fauna repository after the indexed retrieval implementation:

| Operation | Measured latency |
| --- | ---: |
| Cold ranked workspace search | 234 ms |
| Warm ranked workspace search | 70 ms |
| Warm workspace symbol search | 64 ms |
| Warm symbol references | 5.8 ms |

These are local development measurements, not hard-coded performance guarantees.

## Phase 1: Shared Retrieval Index

Status: **Implemented**

- One in-memory workspace index shared by ranged reads, grep, ranked search, symbols, definitions, references, and rename.
- Normalized paths, UTF-8 content, line arrays, size, and mtime metadata.
- Generated, dependency, cache, and VCS directories excluded by default.
- Files above the index limit remain readable directly and are not retained in memory.
- Recursive filesystem watcher keeps the index warm for realistic agent turns and invalidates external changes.
- Native Fauna writes invalidate synchronously.
- Platforms without recursive watch use a short TTL fallback.
- Index responses expose cache metadata for diagnostics and regression tests.

Acceptance:

- A second unchanged query reports a cache hit.
- A native write is visible on the next read.
- A refresh rereads changed files and reuses unchanged entries.
- Existing file read/search contracts remain compatible.

## Phase 2: Structured Discovery

Status: **Implemented**

- `fauna_workspace_search` ranks natural-language concepts against paths and source lines.
- `fauna_grep` uses indexed content for literal and regex search.
- `fauna_read_file` returns exact selected `startLine`/`endLine` metadata.
- Workspace symbols cover common JS/TS, Python, Go, Rust, Java/Kotlin, Swift, C/C++, C#, Ruby, PHP, Vue, and Svelte declaration forms.
- Language operations remain code-only; docs/config remain searchable but are excluded from rename.
- Ranked search is a free read-only tool, parallel-safe, customization-aware, and represented as typed Activity telemetry.

Acceptance:

- Conceptual queries return ranked `{path,line,score,snippet}` results.
- Exact queries remain routed to grep.
- Known identifiers remain routed to definitions/references.
- Search results never mutate files or consume the write-tool budget.

## Phase 3: Language Service Adapters

Status: **Implemented for JavaScript/TypeScript; planned for additional language servers**

Implemented:

- TypeScript 5.9 language service, loaded lazily and cached per workspace.
- JS/TS navigation-tree workspace symbols, including methods and nested declarations.
- Anchor-aware, scope-sensitive definitions and references using `{path,line,column}`.
- Semantic rename previews by default; `apply:true` is required to write anchored renames.
- Structured syntactic, semantic, and suggestion diagnostics without spawning a build command.
- Indexed heuristic fallback for unanchored calls and unsupported languages, with the engine identified in every result.

Add an adapter contract for language-aware engines:

```text
initialize(workspace)
workspaceSymbols(query)
definition(file, line, column)
references(file, line, column)
rename(file, line, column, newName, previewOnly)
diagnostics(files)
dispose()
```

Remaining adapters:

1. Pyright for Python.
2. Existing language servers discovered from project configuration or `PATH` for Rust, Go, Java, C/C++, and C#.
3. Static indexed fallback when no server is available.

Every result must identify its engine as `lsp`, `language-service`, or `workspace-index`. Rename defaults to preview and must return a workspace edit before applying changes.

Acceptance:

- Definitions and references exclude comments and unrelated same-name identifiers.
- Rename respects lexical scope and import/export bindings.
- Startup is lazy and does not delay unrelated conversations.
- Crashed language servers restart once and then fall back clearly.

## Phase 4: Semantic Code Retrieval

Status: **Planned**

- Chunk source by symbol and nearby comments instead of arbitrary character windows.
- Persist embeddings by content hash outside conversation history.
- Incrementally update only changed chunks.
- Blend semantic score, lexical score, path score, and symbol proximity.
- Keep local lexical/indexed search available when embeddings are disabled.

Acceptance:

- Behavior queries find implementations that share no exact query token.
- Results include source path, line range, symbol, score components, and index freshness.
- No source content leaves the configured embedding provider boundary without explicit policy approval.

## Phase 5: Evaluation And UX

Status: **Planned**

- Add a fixed corpus of repository-navigation tasks with expected owning files and symbols.
- Track cold latency, warm latency, files read, bytes returned, tool calls, and top-k accuracy.
- Show index engine/freshness in Activity details without exposing source content in the collapsed row.
- Add Settings diagnostics for indexed files, watcher state, language services, and last refresh.

Parity gate:

- Known ranged read: under 50 ms warm for ordinary source files.
- Exact reference lookup: under 100 ms warm on the Fauna repository.
- Ranked retrieval: relevant owning file in top 5 for at least 90% of the evaluation corpus.
- No stale result after a Fauna edit.
- Semantic rename is not advertised until a language-aware adapter passes scope-sensitive tests.
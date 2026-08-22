# What Fauna Can Learn from Ruflo

Assessment date: 2026-08-22

Upstream snapshot: [`ruvnet/ruflo@3c99b1c`](https://github.com/ruvnet/ruflo/commit/3c99b1c84a25948c42a163253bac6effed5fbbbb)

## Executive conclusion

Ruflo is useful to Fauna primarily as a catalogue of control-plane patterns,
not as an architecture to copy wholesale.

Fauna already has the important runtime foundations that Ruflo advertises:
agent delegation, durable task pipelines, bounded Kanban concurrency,
customizable lifecycle hooks, semantic memory with provenance, MCP bridging,
tool permissions, checkpoints, replayable run ledgers, skills, and engineering
governance. Ruflo's strongest transferable ideas are the way it tries to make
those concerns explicit and inspectable:

1. one lifecycle vocabulary across all execution surfaces;
2. declarative background-worker policies;
3. outcome-based routing and learning;
4. machine-readable capability and compatibility manifests;
5. first-class performance, reliability, and security gates.

Fauna should not copy Ruflo's package count, topology vocabulary, generated
agent volume, or unverified neural and performance claims. Fauna should keep
one canonical implementation per capability and add structure only where it
improves evidence, recovery, or operator control.

## Method

This assessment used a shallow clone of Ruflo's default branch and inspected
the live source tree, package manifests, tests, CI and release files, plugins,
customizations, ADRs, and implementation plans. It separately mapped Fauna's
current runtime surfaces so documentation claims were not mistaken for gaps.

The snapshot contained 5,607 tracked files and roughly 2,308 TypeScript or
JavaScript files. Fauna contained 658 tracked files at the time of comparison.
Raw repository size is not a capability metric: Ruflo includes generated
assets, compatibility layers, plans, package wrappers, and repeated
documentation alongside production code.

The assessment classifies upstream evidence as:

- **Implemented**: executable source with a reachable runtime path.
- **Integrated**: behavior delegated to `agentic-flow`, RuVector, or another
  package and therefore dependent on that package's contract.
- **Configured**: manifests, role files, skills, commands, or generated assets
  that shape an external agent runtime.
- **Planned**: ADRs, roadmaps, checklists, or claimed targets without a proven
  executable path and benchmark.

## What Ruflo actually is

Ruflo is a large TypeScript package constellation centered on
`v3/@claude-flow`. Its major surfaces include CLI and initialization, hooks and
background workers, memory and embeddings, MCP, guidance, security, browser
integration, deployment, and compatibility tooling. It also ships large
Claude Code and Codex customization catalogues.

The most relevant upstream paths are:

- `v3/@claude-flow/cli/src/`: command routing, initialization, MCP tools, and
  generated project guidance.
- `v3/@claude-flow/hooks/`: lifecycle hooks and background workers.
- `v3/@claude-flow/memory/`: AgentDB, HNSW, memory scopes, and learning bridges.
- `v3/@claude-flow/guidance/`: governance compilation, enforcement, evidence,
  and evolution.
- `v3/@claude-flow/mcp/`: the MCP server and compatibility surface.
- `v3/@claude-flow/security/`, `aidefence/`, and `claims/`: validation,
  defensive checks, and security claims.
- `v3/@claude-flow/testing/`: shared fixtures and compatibility validation.
- `v3/@claude-flow/agents/*.yaml`: declarative specialist roles.
- `plugins/ruflo-*`: capability-oriented distribution bundles.
- `v3/implementation/adrs/`: decisions mixed with proposed work.

Ruflo's public descriptions often collapse implemented, integrated,
configured, and planned behavior into one feature list. For example, claims
about Raft, Byzantine consensus, SONA, Flash Attention, or sub-millisecond
retrieval may be supplied by dependencies, represented in configuration, or
described as targets. They should not be treated as evidence that Ruflo owns a
complete, exercised implementation of each algorithm.

## Current Fauna baseline

The comparison must begin from Fauna's existing systems:

| Concern | Current Fauna implementation |
| --- | --- |
| Agent loop | `lib/agent-runner.js` streams model and tool events with policy decisions and bounded continuation. |
| Delegation | `server/routes/chat.js` and the renderer execute orchestrator delegations with scoped agents and tools. |
| Durable tasks | `task-manager.js` and `task-runner.js` persist schedules, retries, cancellation, pipeline DAGs, and node results. |
| Autonomous queue | `kanban-worker.js` enforces blockers, priorities, concurrency, quotas, recovery, verification, and review transitions. |
| Isolation planning | `lib/worktree-evaluation.js` proves candidate independence and scores controlled rollout evidence without executing worktrees. |
| Hooks | `lib/customization-registry.js` and `server/lib/hooks-runtime.js` support eight session, prompt, tool, compaction, subagent, and stop events. |
| Memory | `memory-store.js` supports scoped facts, expiry, supersession, source turns, secret redaction, quantized embeddings, and hybrid recall. |
| Tool boundary | `self-tools.js`, `tool-guard.js`, `permission-guard.js`, and custom MCP routing provide schemas, permissions, and dispatch. |
| Recovery | `server/lib/project-checkpoints.js`, task recovery, and Kanban inflight persistence protect mutations and interrupted work. |
| Observability | `lib/run-ledger.js` records replayable run, model, tool, denial, convergence, and completion events. |
| Governance | Skill anatomy, promotion governance, engineering-flow routing, ticket-plan validation, and release checks are executable policy. |

This means the target is consolidation and evidence, not replacement.

## Adopt now

### 1. A unified execution-event contract

**Ruflo lesson:** hooks, workers, memory, learning, and monitoring become much
more useful when they consume the same lifecycle vocabulary.

**Fauna gap:** chat tracing, task history, Kanban runs, hook results, security
events, and checkpoints each have useful but different event shapes. Cross-run
questions require bespoke adapters.

**Adaptation:** define a versioned envelope shared by all execution surfaces:

```js
{
  schemaVersion: 1,
  eventId,
  type,
  timestamp,
  runId,
  parentRunId,
  projectId,
  taskId,
  workItemId,
  agentId,
  correlationId,
  causationId,
  payload,
  outcome,
}
```

Keep domain payloads small and typed. Adapt existing emitters incrementally;
do not replace the append-only ledger or create a second event store.

**Gate:** one replay test reconstructs a chat-to-task-to-Kanban run after a
simulated restart, including a denied tool and failed verifier.

### 2. Declarative worker policies

**Ruflo lesson:** named workers such as audit, optimize, test-gap analysis, map,
and documentation make post-task automation discoverable.

**Fauna gap:** Fauna has strong workers and triggers, but their policies are
distributed across Kanban, task schedules, heartbeat, webhooks, workflows, and
route-specific code.

**Adaptation:** add a small worker registry over existing task execution:

- trigger event and filter;
- required permissions;
- concurrency key and quota;
- timeout and retry policy;
- idempotency key;
- success evidence;
- operator-visible status;
- default disabled/enabled policy.

Start with three evidence-producing workers: test-gap review after feature
completion, security review after permission changes, and documentation drift
after public contract changes.

**Gate:** duplicate delivery executes once, denied workers never start, failed
workers preserve evidence, and restart recovery cannot double-apply changes.

### 3. Outcome-based routing

**Ruflo lesson:** routing should use prior outcomes, not only static role names
or keyword matches.

**Fauna gap:** Fauna's skill and engineering-flow routers are explainable and
validated, but they do not yet close the loop from run outcomes back into
routing quality.

**Adaptation:** record a compact routing episode:

- normalized intent and repository signals;
- selected flow, skill, agent, model, and tools;
- confidence and alternatives;
- verifier result, retries, duration, token/tool cost, and human correction;
- privacy-safe outcome label.

Use episodes first for offline evaluation and recommendation. Do not allow
online self-modification of routing weights until shadow evaluation proves an
improvement.

**Gate:** a fixed routing corpus shows statistically credible improvement over
the current router with no regression in high-risk routes.

### 4. Capability manifests generated from runtime truth

**Ruflo lesson:** users and agents benefit from an inspectable catalogue of
agents, skills, hooks, workers, MCP tools, and compatibility requirements.

**Fauna gap:** Fauna has registries and generated capability data, but no single
contract links each advertised capability to its owner, permissions, maturity,
tests, and availability conditions.

**Adaptation:** generate a manifest from live registries with:

- stable ID, owner module, schema version, and maturity;
- runtime availability and platform constraints;
- permissions and side-effect classification;
- dependencies and fallback behavior;
- source, focused tests, and documentation;
- deprecation and compatibility metadata.

Fail release validation when a public tool or skill is missing its contract or
when documentation advertises an unavailable capability.

**Gate:** the manifest is reproducible from a clean checkout and a smoke test
resolves every advertised callable capability.

### 5. Benchmark and reliability contracts

**Ruflo lesson:** explicit performance targets can shape architecture and catch
regressions.

**Fauna correction:** Ruflo's claimed speedups are not themselves reusable
evidence. Fauna should copy the discipline of named workloads, not the numbers.

**Adaptation:** define representative workloads for:

- cold start and first useful response;
- tool-catalog construction;
- memory write and hybrid recall quality/latency;
- checkpoint creation and restore;
- task scheduling and restart recovery;
- hook overhead and timeout behavior;
- context construction and token budget;
- MCP startup, discovery, timeout, and reconnect.

Record hardware, data size, warm/cold state, percentiles, correctness, and
variance. Gate only stable measurements in CI; run hardware-sensitive suites
as scheduled evidence.

**Gate:** every published performance claim links to a reproducible workload
and baseline artifact.

### 6. Evidence-producing governance

**Ruflo lesson:** guidance is strongest when it follows a compile, enforce,
prove, and evolve loop.

**Fauna baseline:** Fauna already validates skill anatomy, maturity,
engineering flows, ticket plans, and promotion governance.

**Adaptation:** extend the existing governance system with explicit evidence
references. A promoted workflow should identify the fixture corpus, focused
tests, recent outcome window, owner, and rollback condition that justify its
status.

**Gate:** promotion fails closed when evidence is stale, absent, or below its
declared threshold.

### 7. Agent-role contracts, used sparingly

**Ruflo lesson:** machine-readable role files make ownership, tools, inputs,
outputs, and handoffs inspectable.

**Fauna baseline:** agent manifests already model names, tools, permissions,
subagents, and orchestrator behavior.

**Adaptation:** add optional contract fields rather than a second role system:

- accepted work types and required artifacts;
- produced artifacts and completion evidence;
- allowed delegation targets;
- maximum autonomy and cost budget;
- escalation and handoff conditions;
- independent verifier role.

**Gate:** manifest validation rejects circular delegation, impossible tool
requirements, and self-verification for protected workflows.

### 8. Operational readiness as a product feature

**Ruflo lesson:** configuration checks, diagnostics, migrations, and deployment
readiness deserve a coherent operator surface.

**Fauna baseline:** diagnostics, release checks, model discovery, permission
checks, MCP lifecycle state, and updater validation already exist.

**Adaptation:** expose one readiness report with required, degraded, and
optional checks. It should identify remediation without printing credentials
and export machine-readable evidence for support.

**Gate:** packaged-app smoke tests exercise startup, one model path, one safe
tool, memory, checkpointing, and clean shutdown on supported platforms.

## Adapt later

### Dynamic topology selection

Ruflo exposes hierarchical, mesh, ring, star, hybrid, consensus, and leader
vocabulary. For a local engineering assistant, most of this is premature.
Fauna should first measure whether planner-worker-reviewer, parallel research,
and independent verification require different coordination semantics. Add a
new topology only when it changes ownership, message flow, or fault recovery in
a measurable way.

### Advanced vector indexes and knowledge graphs

Fauna already supports compact embeddings and hybrid retrieval. HNSW, graph
ranking, and community detection become valuable only when the corpus and
latency make linear or filtered search inadequate. Capture corpus size,
recall-at-k, latency, update cost, and memory use before choosing an index.

### External execution federation

Ruflo's federation and remote orchestration ideas may eventually help teams,
cloud workers, or isolated build environments. Fauna should not add them until
its event envelope, identity, permissions, artifact provenance, cancellation,
and reconciliation semantics are stable locally.

### Plugin packaging

Capability-oriented plugins are attractive, but they require signed package
identity, compatibility ranges, permission review, isolation, migrations,
rollback, and ownership. Fauna's current skills, agents, MCP servers, and
customizations should share those contracts before a broader marketplace is
introduced.

## Do not copy

### Feature counts as architecture

Counts of agents, commands, tools, hooks, or packages reward duplication and
generated surface area. Fauna should report exercised workflows, successful
outcomes, recovery behavior, and contract coverage instead.

### Documentation as implementation evidence

Ruflo contains extensive ADRs, plans, and checklists, some with proposed files
and unchecked tasks. Fauna should clearly label proposed, experimental,
available, and default behavior and generate public capability lists from
runtime truth.

### Suppressed validation failures

The audited Ruflo tree contained many uses of `|| true`; sampled Docker
regression scripts also use fallback echoes around commands. Some uses may be
intentional cleanup or probes, but success suppression is unacceptable in a
release gate. Fauna should preserve non-zero exits unless a specific expected
failure is asserted and recorded.

### Unqualified performance claims

Claims such as `150x`, `12,500x`, sub-millisecond search, or routing accuracy
are meaningless without workload, baseline, hardware, corpus, percentile, and
correctness criteria. Fauna should never inherit upstream marketing numbers.

### Multiple public implementations of one capability

Ruflo's CLI, MCP, hook, plugin, compatibility, and generated command surfaces
can obscure which implementation is canonical. Fauna should keep adapters
thin: all fronts call one domain service and share one schema and error model.

### Neural terminology without an evaluated need

Attention, MoE, SONA, EWC++, reinforcement learning, and consensus algorithms
may be legitimate techniques, but naming them does not improve an engineering
assistant. Adopt an algorithm only after a measured baseline identifies the
failure mode it addresses.

## Prioritized roadmap

### P0: Establish runtime truth

Deliverables:

1. Versioned execution-event envelope and adapters for chat, task, Kanban,
   hook, verifier, permission, and checkpoint events.
2. Generated capability manifest linked to owners, permissions, tests, and
   maturity.
3. Failure-propagation audit for build, release, smoke, and regression scripts.

Acceptance:

- cross-surface replay survives a simulated process restart;
- every public capability resolves to a live registry entry;
- no required validation step can report success after its command fails;
- existing persisted ledgers remain readable.

### P1: Make automation declarative

Deliverables:

1. Worker registry over the existing task runner.
2. Security-review, test-gap, and documentation-drift worker definitions.
3. Idempotency, quotas, permission declarations, retries, and operator status.

Acceptance:

- duplicate and out-of-order events are safe;
- workers cannot exceed task or project permissions;
- restart recovery does not duplicate side effects;
- each worker stores verifier evidence and an actionable failure.

### P2: Close the routing feedback loop

Deliverables:

1. Privacy-safe routing episode schema.
2. Offline corpus and baseline metrics for skill, flow, agent, and model choice.
3. Shadow recommendations from prior outcomes.
4. Evidence references in governance promotion decisions.

Acceptance:

- no online policy mutation;
- high-risk routing has no regression;
- improvements reproduce on a held-out fixture set;
- stale or insufficient evidence cannot promote a workflow.

### P3: Operational evidence

Deliverables:

1. Benchmark harness and versioned workload definitions.
2. Unified readiness report for source and packaged applications.
3. Platform smoke tests and artifact provenance.
4. Reliability dashboard derived from the execution ledger.

Acceptance:

- claims include workload, baseline, environment, percentile, and correctness;
- package smoke tests cover startup through clean shutdown;
- regressions fail the relevant gate instead of becoming warnings;
- telemetry and exported evidence redact secrets by construction.

### P4: Reassess advanced features

Only after P0-P3 provide measurements, evaluate:

- HNSW or another approximate vector index;
- knowledge-graph retrieval;
- dynamic coordination strategies;
- remote worker federation;
- signed plugin packaging;
- learned routing beyond shadow mode.

Each proposal must name the measured bottleneck, simpler alternatives, threat
model, rollback path, maintenance owner, and experiment threshold.

## Recommended sequencing decision

The first implementation should be P0's execution-event envelope, not a new
swarm coordinator. It connects systems Fauna already owns and supplies the
evidence required for every later decision. The smallest useful slice is:

1. define the envelope and compatibility adapter in `lib/`;
2. emit it from `ChatTracer` and task/Kanban completion paths;
3. replay one end-to-end fixture;
4. generate a minimal capability manifest from current registries;
5. add release checks without changing existing user-facing behavior.

That slice directly tests the assessment's main hypothesis: better shared
contracts and evidence will improve Fauna more than additional agent types or
coordination algorithms.

## Implementation status

Implemented on 2026-08-22 as a deliberately narrow first slice:

- `lib/run-ledger.js` now stamps append-only run and chat events with a
  backward-compatible schema-versioned execution envelope. Existing top-level
  fields and replay behavior are preserved.
- `scripts/gen-capabilities.cjs` now generates a deterministic schema-v2
  manifest for live self tools, dynamic widget tools, and bundled
  customizations. Repeated tool metadata uses schema defaults to avoid catalog
  bloat.
- `lib/routing-evidence.js` records privacy-safe routing decisions and linked
  verifier or human-correction outcomes. Raw routing queries are not stored and
  no online routing behavior changes.
- `npm run routing:report` now produces a deterministic offline summary of
  decision/outcome coverage, pass, failure, correction, retry, duration, cost,
  router, and selection evidence. It reports pending and orphan episodes rather
  than inferring success, and accepts alternate input/output paths for audits.
- Autonomous task chat calls now propagate their task ID as the routing run ID.
  Generic task completion records an observed outcome; explicit task failures
  record a definitive failure. When a Kanban verifier subsequently runs, its
  pass or fail upgrades the observation exactly once, while skipped and
  infrastructure-only checks remain observational. Equal-timestamp upgrades
  follow append order. Evidence writes remain best-effort and cannot alter task
  or board outcomes. Router self-tool tests use an isolated evidence file
  instead of the user's live ledger.
- `scripts/benchmark-core.mjs` defines correctness-checked workloads for event
  creation, ledger append/read/replay, skill routing, and vector scoring. It
  reports environment, workload size, mean, p50, p95, and standard deviation
  without declaring arbitrary release thresholds.
- `lib/skill-governance.js` now requires promoted skills to resolve concrete,
  repository-local evidence, an owner, a positive review window, and a valid
  rollback action. Shared policy defaults avoid repeating the same contract in
  every skill entry.
- `lib/customization-registry.js` now accepts optional artifact, handoff,
  tool/time/cost budget, escalation, and independent-verifier contracts in the
  existing agent frontmatter. Invalid budgets, self-handoffs, and
  self-verification fail validation; no new role runtime was introduced.
- `server/lib/doctor.js` now includes one backward-compatible operational
  readiness summary covering required health, the capability manifest,
  bundled customization validity, release metadata, and optional integration
  degradation. No separate readiness tool or dashboard was added.
- `lib/execution-event.js` now owns the pure envelope constructor, while
  `lib/run-ledger.js` re-exports it for compatibility. Existing task history,
  autonomous-run JSONL, security records, work-item verification, aggregate
  hook results, and checkpoint metadata are stamped at their current creation
  or persistence boundaries. Legacy fields, storage locations, filtering,
  replay, restore, and index shapes remain intact.

Intentionally not implemented in this slice:

- a new event bus or telemetry database;
- automatic routing-policy mutation;
- a generic background-worker framework;
- new orchestration topologies;
- a readiness dashboard or automatic remediation;
- a centralized event store or cross-surface replay service.

The initial 2026-08-22 local capture exposed 10 decisions produced by repeated
self-tool tests rather than real workflows. Those exact fixture records were
backed up, removed, and prevented from recurring through context-injected test
storage. The corrected live baseline contains no routing episodes, so policy
promotion remains blocked until real autonomous runs produce linked outcomes.
A full-scale core benchmark on the same date passed correctness for all four
workloads; its environment and timings remain a local baseline under Fauna's
config directory, not a release threshold or public performance claim.

Release validation on 2026-08-22 produced an arm64 `Fauna.app` signed with the
configured Developer ID and hardened runtime. Apple accepted notarization
submission `5a8191ea-a1f6-495a-95b3-b06799390c1e`; the ticket was stapled, and
strict codesign, Gatekeeper, stapler validation, and the `v2.2.4` release
contract all passed. The affected routing, task, Kanban, verifier, self-tool,
and ledger surface passed 208 tests. A separate full-suite run exposed existing
test debt outside this implementation: stale agent-builder and history-limit
assertions plus memory/profile fixtures that do not isolate atomic config-file
persistence. Those failures were not masked or treated as release evidence for
this slice.

The next expansion gate is evidence from actual use. Add another adapter or
automation surface only when an operator query, recovery path, or repeated
workflow cannot be served by the current contracts.

## Sources

Primary Ruflo sources inspected:

- [Ruflo repository](https://github.com/ruvnet/ruflo)
- [Ruflo v3 overview](https://github.com/ruvnet/ruflo/tree/main/v3)
- [CLI initialization](https://github.com/ruvnet/ruflo/tree/main/v3/%40claude-flow/cli/src/init)
- [Hooks package](https://github.com/ruvnet/ruflo/tree/main/v3/%40claude-flow/hooks)
- [Memory package](https://github.com/ruvnet/ruflo/tree/main/v3/%40claude-flow/memory)
- [Guidance package](https://github.com/ruvnet/ruflo/tree/main/v3/%40claude-flow/guidance)
- [MCP package](https://github.com/ruvnet/ruflo/tree/main/v3/%40claude-flow/mcp)
- [Testing package](https://github.com/ruvnet/ruflo/tree/main/v3/%40claude-flow/testing)
- [Implementation ADRs](https://github.com/ruvnet/ruflo/tree/main/v3/implementation/adrs)
- [Ruflo plugins](https://github.com/ruvnet/ruflo/tree/main/plugins)

The assessment intentionally does not repeat upstream benchmark or accuracy
claims as facts unless Fauna can reproduce them under a declared workload.
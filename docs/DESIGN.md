# Design

This is the public design sketch for `pi-dag-compact`. It is a plan and an
evaluation contract, not implementation evidence.

The idea for DAG-shaped working memory with durable research records came from
**aimatlow** on Discord.

## Decision

Build a small Pi extension:

| Concern | Choice |
|---|---|
| Active graph | Graphology, with `graphology-dag` for `depends_on` only |
| Durable records | Task-scoped SQLite, one writer |
| Schema | TypeBox |
| Compaction | Classic remains default; explicit handoff is opt-in |
| Idle work | Event-driven only |

The Graphology instance is a disposable in-memory view rebuilt from durable
state. Stored schema is independent of Graphology serialization.

## Three layers

| Layer | Lifetime | Contents |
|---|---|---|
| Active working set | Bounded, current branch | Objective, constraints, baseline, current work, blockers, next actions, relevant rejections |
| Research ledger | Whole task | Observations, interpretations, decisions, superseding records |
| Evidence artifacts | Files | Manifests, stdout, timings, patches, profiler captures |

Pi JSONL stores small references. SQLite stores records and checkpoints.
Enabling recording requires an explicit task directory.

## Record sketch (M1)

Node kinds: `goal`, `constraint`, `task`, `hypothesis`, `decision`, `blocker`.
Statuses: `open`, `blocked`, `done`, `rejected`, `stale`.
Edges: `depends_on`, `supports`, `supersedes`, `alternative_to`.

Only `depends_on` must be acyclic. Validate whole batches on prospective
state, then commit.

Initial active-set limits to test (not measured results): 200 nodes, 400
edges, 128 KiB serialized, whichever comes first.

## Retrieval

Reads are bounded and say so. `dag_query` searches the active set or archived
history, resolves typed record IDs, or reads one oversized record in chunks;
`session_read` returns a bounded chunk of a transcript entry. Every response
carries a `coverage` block naming the scope it searched, the bytes it scanned
and whether that scan finished, so an incomplete search is never reported as a
definitive no-match. An active miss says nothing about unsearched history.

| Contract | Value |
|---|---|
| Query output | 20 records and 8 KiB per response, measured on the serialized response |
| Batched ID read | 8 IDs, within the same output budget |
| History scan | At most 4 MiB of archived payload per request |

Search is literal: matching happens in process over record fields, so `%` and
`_` are ordinary characters rather than SQL wildcards.

A cursor is bound to its scope, its query and either the active revision or a
frozen archive high-water mark. Presenting it after a mutation, or under a
different query, is rejected by name rather than reinterpreted. History resumes
by the composite `(id, revision)` key, so a page boundary cannot step over a
second archived version of the same record, and records appended while the
caller is paging fall outside that scan's declared scope.

A bounded ID read reports each ID separately as `found`, `missing`,
`unavailable_source` or `partial`; IDs that did not fit are named rather than
dropped. A record too large for any response is delivered as UTF-8-safe chunks
with a forward-progressing byte offset, so pagination never stalls and nothing
is silently truncated.

## Handoff (M2)

`/compact`, threshold compaction, and overflow recovery stay classic during
the MVP. `/dag-handoff` is explicit: it arms a reviewed checkpoint, appends a
`dag_handoff_marker`, and supplies the working-set card as compaction content.
A stale review falls back to classic. A failed extension compaction append
fences further handoffs and agent input until repair.

## Stages

| Stage | Exit |
|---|---|
| **M0** | Reproducible classic baseline |
| **M1** | Recover baseline, constraints, rejections, and next action from durable records |
| **M2** | First A/B evidence of value, or a documented failure to improve |
| **M3** | 300-turn deterministic stress + artifact-replay CUDA question; live CUDA speedup and cross-model claims are separate |

Stop handoff rollout if bookkeeping exceeds savings, constraints disappear, or
the ledger duplicates existing records without helping decisions.

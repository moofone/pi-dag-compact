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

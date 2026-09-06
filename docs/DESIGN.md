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
the MVP. `/dag-handoff` is explicit and is refused unless a reviewed
checkpoint, persisted Pi reference, and provider-valid post-cut message
sequence all succeed.

## Stages

| Stage | Exit |
|---|---|
| **M0** | Reproducible classic baseline |
| **M1** | Recover baseline, constraints, rejections, and next action from durable records |
| **M2** | First A/B evidence of value, or a documented failure to improve |
| **M3** | Bounded real pilot and longer stress; CUDA speedup is a separate measurement |

Stop handoff rollout if bookkeeping exceeds savings, constraints disappear, or
the ledger duplicates existing records without helping decisions.

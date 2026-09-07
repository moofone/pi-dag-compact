# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Publication is driven by the branch pointer, not by a SQLite commit. Explicit
  `prepared` / `selected` / `unselected` operation states, expected-parent
  comparison on acknowledgement and on recovery, idempotent receipts that append
  no second reference, and a pending operation that must be acknowledged or
  quarantined before another update on the same position.
- One full immutable snapshot per revision; checkpoint identity equals revision
  identity and `checkpoints` is a view over `revisions`. The separate checkpoint
  payload table and the 32-mutation replay bound are gone.
- Reconstruction recomputes the snapshot and selection hashes from the loaded
  JSON and revalidates schema, dependency subgraph and parent linkage. An
  unreadable reference on the branch is reported rather than dropped, and a
  refused load publishes nothing and refuses reduced context.
- `npm run measure:revisions` reports database, WAL and session growth for 300
  near-cap revisions. Reported, not claimed as a property.

## [0.4.0] - 2026-09-06

### Added

- Deterministic 300-turn stress: unique hypotheses, archival, ten real
  `/dag-handoff` cuts, restart reconstruct, fork divergence, interrupted-run
  fencing. Measures query/update p95, RSS, and metadata; does not claim the
  design targets as properties.
- CUDA artifact-replay pilot: reads fixture NCU/manifest/result files, rejects
  fusion for pipeline regression, accepts the schedule candidate. No GPU.
- `eval:live` gate: refuses paid providers even when `PI_DAG_COMPACT_LIVE=1`.
  Cross-model and hundreds-of-turn memory claims remain out of scope.

## [0.3.0] - 2026-09-06

### Added

- Explicit `/dag-handoff` in `explicit-handoff` mode. Manual compact stays
  classic unless a fresh reviewed checkpoint is armed. Threshold and overflow
  compaction stay classic.
- Custom `dag_handoff_marker` as the post-cut suffix boundary. The card is the
  compaction summary; the marker contributes no ordinary messages.
- Failed-append fence: `session_compact_failed` with `fromExtension` blocks
  further handoffs, agent input, and compaction until the session is repaired.
  Stale review falls back to classic and is counted.
- Experiment run registry: a started run cannot relaunch until it is
  reconciled. Origin-qualified `session_read` resolves copied fork entries and
  reports uncopied evidence as unavailable.
- Faux A/B eval: DAG arm loads the real extension, calls `dag_update`, and
  cuts through `/dag-handoff`. `npm run eval:ab` runs three variant pairs.

### Notes

- Faux plumbing is not a live-model value claim. Keep explicit-handoff opt-in.
  Do not advertise token savings until live scored variants run.

## [0.2.0] - 2026-09-06

### Added

- Record-only working memory: Graphology + `graphology-dag` for `depends_on`
  validation, task-scoped SQLite store, batched `dag_update` / `dag_query`,
  `session_read`, experiment ingest, and `/dag`.
- Commit protocol with operation IDs, pending Pi references, checkpoints every
  32 deltas, archival, writer locking, and branch reconstruction.
- Tests for cycle rejection, rollback, idempotent operation IDs, pending-ref
  reconciliation, fork divergence, restart recovery, and competing writers.

### Notes

- Classic compaction is unchanged. `/dag-handoff` is still unavailable (M2).

## [0.1.0] - 2026-09-06

### Added

- Public TypeScript Pi-package skeleton. The extension loads in `disabled`
  mode and does not register graph tools or intercept compaction.
- M0 evaluation harness: 16-turn synthetic research fixture, fake experiment
  runner, expected-state oracle, and isolated classic-compaction runner.
- Faux-provider integration test that requires three real scheduled
  compactions (after turns 4, 8, and 12) with a 1,536-token retained tail.

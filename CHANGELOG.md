# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

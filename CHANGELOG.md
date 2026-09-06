# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-06

### Added

- Public TypeScript Pi-package skeleton. The extension loads in `disabled`
  mode and does not register graph tools or intercept compaction.
- M0 evaluation harness: 16-turn synthetic research fixture, fake experiment
  runner, expected-state oracle, and isolated classic-compaction runner.
- Faux-provider integration test that requires three real scheduled
  compactions (after turns 4, 8, and 12) with a 1,536-token retained tail.

### Notes

- Graphology, SQLite working memory, and `/dag-handoff` are not implemented.
  This release is the classic baseline, not a DAG result.

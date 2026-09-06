# pi-dag-compact

Bounded working memory and durable research evidence for the
[Pi](https://pi.dev) coding agent.

Research that spans many turns needs two things: a small map of what matters
*now*, and an addressable record of what was already learned. This package is
a Pi extension plus an evaluation harness for that problem.

> **Idea credit.** The idea for a DAG-shaped working memory with durable
> research evidence came from **aimatlow** on Discord. This repository is an
> implementation and evaluation of that idea.

**Status: M0.** This release ships a reproducible classic-compaction baseline.
The Graphology/SQLite working set, research ledger, and `/dag-handoff` path
are not implemented yet. Nothing here is a benchmark result, a CUDA speedup,
or proof that DAG handoff beats ordinary compaction.

## Why this exists

Pi already compacts long sessions. Classic compaction is the default and stays
the default. The question this project measures is narrower:

> Can an explicit, reviewable working-set handoff preserve hard constraints and
> research decisions through scheduled context cuts better than ordinary
> compaction, at a lower total token cost?

The first value test is a 16-turn scripted research scenario with scheduled
cuts after turns 4, 8, and 12. That is an **accelerated compaction test**, not
an estimate of savings under Pi's default 20k-token retained tail.

## Current milestone (M0)

| Piece | What shipped |
|---|---|
| Fixture | 16-turn synthetic CUDA-style optimization scenario |
| Runner | Fake experiment command; no GPU, no network |
| Oracle | Machine-readable expected state after each scored turn |
| Harness | Isolated Pi SDK session, faux provider, file-backed session |
| Cuts | Explicit classic compaction; three real cuts required |
| Extension | Loads, default `disabled`; no graph tools |

Exit for M0: a reproducible classic baseline. DAG code is not required.

## Install

The package is a [Pi package](https://pi.dev). After M1 it will be useful as:

```bash
pi install git:github.com/moofone/pi-dag-compact
```

Until graph tools exist, prefer running the harness from a clone:

```bash
git clone https://github.com/moofone/pi-dag-compact.git
cd pi-dag-compact
npm ci
npm run check
npm run eval:classic
```

`npm run eval:classic` uses Pi's faux provider. It does not call paid models
and it does not run CUDA.

## Repository layout

```text
src/index.ts                 Pi extension factory (disabled by default)
src/eval/                    Isolated classic-compaction harness
src/schema/                  TypeBox contracts
fixtures/scenario-16/        Scenario, oracle, workspace snapshot
test/                        Unit and integration tests
docs/                        Design and evaluation contract
```

## Evaluation in one paragraph

Both future arms receive the same objective, artifacts, and user corrections.
Arm A uses ordinary Pi compaction. Arm B will use the DAG working set. Cuts
are invoked between completed turns, not while a tool is running. A cut that
does not remove old entries is a failed boundary. Scoring uses commands,
artifact citations, and the expected-state oracle — not the model claiming it
remembered.

See [docs/evaluation.md](docs/evaluation.md) and [docs/DESIGN.md](docs/DESIGN.md).

## Configuration

| Mode | Meaning |
|---|---|
| `disabled` | Default. No graph tools, no compaction intercept |
| `record-only` | M1. Durable records, classic compaction remains |
| `explicit-handoff` | M2. Opt-in `/dag-handoff` after safety tests |

Set `PI_DAG_COMPACT_MODE` or write `.pi/pi-dag-compact.json` in a trusted
project. Disabled sessions must not receive graph tool schemas.

## Acknowledgments

- **aimatlow** on Discord, for the original idea
- [Pi](https://github.com/earendil-works/pi) by Earendil Works, for the
  extension API, session model, and compaction machinery
- [Graphology](https://graphology.github.io/), planned for M1 graph operations

## License

[MIT](LICENSE)

# Contributing

Thanks for considering a contribution.

## Requirements

- Node.js 24 (see `.nvmrc`), or at least 22.19.0
- npm
- No paid LLM provider calls in tests
- No GPU execution in tests

## Setup

```bash
git clone https://github.com/moofone/pi-dag-compact.git
cd pi-dag-compact
npm ci
npm run check
```

`npm ci` installs development dependencies, including pinned Pi packages used
by the evaluation harness. The published extension factory does not require
those packages at runtime until later milestones register tools.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Pi extension factory |
| `src/eval/` | Isolated classic-compaction harness |
| `src/schema/` | TypeBox contracts for fixtures and reports |
| `fixtures/scenario-16/` | 16-turn research scenario and workspace snapshot |
| `test/unit/` | Oracle, runner, and schema tests |
| `test/integration/` | Faux-provider 16-turn compaction proof |

## Rules

1. Pin dependency versions. Do not introduce floating ranges in
   `devDependencies`.
2. Keep classic compaction classic. Do not change Pi's summary prompt to help
   the DAG arm.
3. Label accelerated compaction tests as such. The retained-tail budget is
   1,024–2,048 tokens, not Pi's default 20k.
4. Do not claim CUDA speedups, semantic completeness, or production memory
   savings from the short fixture.
5. Eval outputs belong under `artifacts/` or an explicit `--out` directory,
   never in git.
6. A skipped or no-op compaction invalidates that scheduled boundary.

## Pull requests

Use the PR template. One focused change per PR. Include the `npm run check`
result. New evaluation behavior needs a machine-readable oracle update before
a scored run is added.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

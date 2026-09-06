# Synthetic pipeline benchmark (W1)

This workspace is a **fixture**. Numbers from `node bench.mjs` are synthetic.
They are not CUDA measurements.

## Metric contract

- Objective: minimize complete-pipeline p50 latency (`pipeline_p50_ms`)
- Not sufficient: kernel-only improvement
- Correctness: numeric check must pass; untested is not passing
- Resource ceiling is supplied by the user and may change

## How to run

```bash
node bench.mjs run --candidate baseline --workload W1
```

Candidates: `baseline`, `A`, `B`, `C`, `D`, `E`.

Each run writes `runs/<run-id>/manifest.json` and `result.json`. Repeating a
candidate reuses the same run id and appends `runs/invocations.jsonl`.

## Notes

Write durable decisions to `notes/state.json`. Do not invent speedups.

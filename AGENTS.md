# Agent notes

This is a public Pi package. Treat it as shareable source, not a scratch pad.

## Current milestone

M0: fixture and classic baseline. Do not implement Graphology, SQLite, or
explicit DAG handoff unless the user asks to start M1/M2.

## Hard rules

- Never call paid providers from tests or the default `eval:classic` path.
- Never execute GPU workloads from tests or the fake runner.
- Never commit eval artifacts, `.env`, or session JSONL.
- Pin dependency versions.
- Do not describe unmeasured token savings or CUDA speedups as results.

## Commands

```bash
npm ci
npm run check
npm run eval:classic
```

## Git

Do not run destructive git commands (`reset`, `restore`, `checkout`, `clean`,
`rebase`, force push). Additive `add` / `commit` / `push` only.

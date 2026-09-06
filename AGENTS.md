# Agent notes

This is a public Pi package. Treat it as shareable source, not a scratch pad.

## Current milestone

M1: record-only working memory. Do not implement `/dag-handoff` unless asked
to start M2. Classic compaction stays default.

## Hard rules

- Never call paid providers from tests or the default `eval:classic` path.
- Never execute GPU workloads from tests or the fake runner.
- Never commit eval artifacts, `.env`, or session JSONL.
- Pin dependency versions.
- Do not describe unmeasured token savings or CUDA speedups as results.
- Do not open BrowserOS neo tabs in the foreground. Use `background: true`.

## Commands

```bash
npm ci
npm run check
npm run eval:classic
```

## Git

Do not run destructive git commands (`reset`, `restore`, `checkout`, `clean`,
`rebase`, force push). Additive `add` / `commit` / `push` only.

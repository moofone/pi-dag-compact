# Agent notes

This is a public Pi package. Treat it as shareable source, not a scratch pad.

## Current milestone

M3: deterministic 300-turn stress and CUDA artifact-replay. Classic `/compact`,
threshold, and overflow stay classic. Do not call paid providers. Do not
execute GPU workloads. Do not claim token savings or CUDA speedups.

## Hard rules

- Never call paid providers from tests or the default `eval:classic` /
  `eval:ab` / `eval:stress` / `eval:cuda-pilot` path. `eval:live` is a refuse
  gate, not a provider client.
- Never execute GPU workloads from tests or the fake/replay runners.
- Never commit eval artifacts, `.env`, or session JSONL.
- Pin dependency versions.
- Do not describe unmeasured token savings or CUDA speedups as results.
- Do not open BrowserOS neo tabs in the foreground. Use `background: true`.

## Commands

```bash
npm ci
npm run check
npm run eval:classic
npm run eval:ab
npm run eval:stress
npm run eval:cuda-pilot
```

## Git

Do not run destructive git commands (`reset`, `restore`, `checkout`, `clean`,
`rebase`, force push). Additive `add` / `commit` / `push` only.

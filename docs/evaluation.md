# Evaluation contract (M0–M2)

This is an **accelerated compaction test**. It is not an estimate of savings
under Pi's default retained-tail budget. Faux A/B is plumbing, not a
live-model value claim.

## Scenario

Sixteen scripted user/environment turns. Tool continuations and compaction
summaries are extra provider calls and are counted separately.

Scheduled cuts after completed turns **4, 8, and 12**. Cuts run between
agent turns, never while a tool is executing.

| Turn | What must survive |
|---|---|
| 1 | Objective, complete-pipeline metric, resource ceiling, correctness rule |
| 2 | Exact baseline / source / workload |
| 3 | Candidate A rejected: kernel improved, pipeline regressed |
| 4 | Cut. Baseline and rejected A |
| 5 | User tightens the shared-memory ceiling; the new ceiling supersedes the old |
| 6 | Candidate B never promoted (correctness failure) |
| 7 | Candidate C is evidence-backed |
| 8 | Cut. Accepted baseline is C |
| 9 | Candidate D is inconclusive (confounded measurement) |
| 10 | Next experiment is not an unmotivated repeat of A or B |
| 11 | Follow-up compared against the right baseline, within the new ceiling |
| 12 | Cut. Updated decision |
| 13 | Historical configuration retrieved from artifacts |
| 14 | Rejection of A recalled; retest needs a new justification |
| 15 | Next action uses current baseline, ceiling, and blockers |
| 16 | Final result does not invent a speedup or completion claim |

Synthetic numbers in the fixture are not CUDA results.

## Arms

| Arm | Behavior |
|---|---|
| A — classic | Ordinary Pi compaction at the scheduled boundaries |
| B — DAG | Real extension in `explicit-handoff`; `/dag-handoff` at the same boundaries |

Arm A keeps read/write/bash. Do not disable useful baseline note-taking.
Neither arm may see the oracle answer key.

## Classic cut calibration

- `keepRecentTokens`: **1536** (inside the 1,024–2,048 band)
- Threshold compaction is not the cut mechanism; the host calls
  `session.compact()` after the scheduled turns
- A cut is real only if a compaction entry is saved, old entries leave
  `buildContextEntries()`, and the next provider request does not include the
  raw dropped user text (summary text may still mention the facts)
- A skipped or no-op compaction invalidates that boundary

## Oracle

Score commands, artifact citations, and structured state. Do not treat a
model's self-report as proof.

Initial gates:

- No lost hard constraints
- No false baseline promotions
- No unsupported completion claims
- Unjustified reruns are counted, not silently corrected

## Local rules

Tests and `npm run eval:classic` / `eval:ab` / `eval:stress` / `eval:cuda-pilot`
must not call paid providers or execute GPU workloads. `eval:live` is a refuse
gate. Live-model baselines and real CUDA speedup are out of CI.

## Report fields

```text
arm, variant, model_config, scenario_turns, provider_calls
compaction_attempts, actual_cuts, fallbacks, retained_tokens_per_cut
input_tokens, cached_input_tokens, output_tokens, reported_reasoning_tokens
maintenance_tokens, summary_or_checkpoint_tokens, recovery_calls
constraint_errors, false_promotions, unjustified_reruns, evidence_errors
task_elapsed_ms, recovery_elapsed_ms, peak_rss, metadata_bytes
```

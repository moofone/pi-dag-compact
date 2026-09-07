# The observed Pi host boundary, and what this extension may therefore claim

Observed against the installed peer `@earendil-works/pi-coding-agent` 0.85.1,
through the real `AgentSession` and the real file-backed `SessionManager`. The
fixtures that reproduce each observation are named beside it.

## The claim ceiling

> An extension may refuse to **schedule** goal-owned work, may **charge** a
> request it observes, and may **abort** after the fact. It cannot prevent a
> provider request the host has already issued, and it cannot know that an
> append reached disk.

Anything in this repository that implies more than that is a defect in the
statement, not a feature to build. In particular: an observational
`before_provider_request` callback is never a deny channel, a returned API value
is never a durable acknowledgement, and "durable" here only ever means "these
bytes were read back out of the session file".

## What the host does

| # | Observation | Established by |
|---|---|---|
| 1 | `SessionManager._appendEntry` pushes the entry into memory, indexes it and advances the leaf **before** it calls `_persist`. A throwing `_persist` leaves the entry as the leaf, on the branch, and in `buildContextEntries()`. Nothing is rolled back. | observed — `test/integration/p01-append-failure.test.ts` |
| 2 | The first file write is deferred until the session holds an assistant message. Until then `appendXxx()` returns a real entry id while no session file exists at all. | observed — `test/integration/p02-deferred-persistence.test.ts` |
| 3 | That deferred first flush opens the session file with the exclusive `wx` flag and rewrites every buffered entry. If the open fails, nothing at all is written and every previously accepted append is lost together. | observed — `test/integration/p02-deferred-persistence.test.ts` |
| 4 | A single failed append leaves a hole in the parent chain. The live process still walks the full branch; a restart resolves only the entries after the hole, `getTree()` reports an extra orphan root, and no error is raised at load. | observed — `test/integration/p01-append-failure.test.ts` |
| 5 | Nothing on the append path calls `fsync`. Reading an entry back out of the file proves the bytes are in the file, never that they survive power loss. | source — `dist/core/session-manager.js` (`_persist`, `_rewriteFile`) |
| 6 | `before_provider_request` is a payload-transform chain. `emitBeforeProviderRequest` catches every handler error and continues, and the only honoured result is a replacement payload. There is no cancel channel. | source — `dist/core/extensions/runner.js`, `dist/core/sdk.js` |
| 7 | `before_agent_start` can add a message or replace the system prompt. It has no cancel field, and its handler errors are swallowed too. | source — `dist/core/extensions/runner.js` |
| 8 | The refusal channels that do work are `input` → `{action:"handled"}` (the turn never starts), `tool_call` → `{block:true, terminate:true}` (the continuation never starts), `session_before_*` → `{cancel:true}`, and `AgentSession.abort()` after the fact. | observed — `test/integration/p04-owned-admission.test.ts` |
| 9 | `input` does not fire for a slash command issued through `AgentSession.prompt`, so a command has to consult the fence itself. | observed — `test/integration/p03-core-fence.test.ts` |

## What this extension does about it

`src/host/durability.ts` classifies each append as `not_persisted`, `deferred`,
`present_in_file` or `absent_from_file` by reading the session file back.
`src/host/fence.ts` is an **extension-level** fence over that unfenced host: once
an append of the extension's own is not in the file, the extension refuses its
own downstream paths — input, its own append, manual and automatic compaction,
the handoff fallback, the context rebuild and the restart reconcile — and keeps
refusing after a restart, because the fence is stored beside the extension's own
records rather than in the session that is in doubt.

`src/host/admission.ts` binds goal-scheduled work to one owner with a finite
allowance, reserved through the two channels above. Transport attempts are
recorded separately from logical request ids, so a transport retry is not
charged twice and a logical retry is charged like anything else. A provider
request the host issued with no reservation is recorded as an uncharged
host-issued attempt; it never drives a counter negative, and the residual gap is
reported rather than absorbed.

None of this is a core guarantee, and none of it is described as one.

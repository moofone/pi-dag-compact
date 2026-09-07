/**
 * Task 4.3 — the foreign-origin half of Q01, deferred out of R6.
 *
 * R6 left `resolveId` answering every ID out of the engine's own task, whatever
 * origin the caller named. A research reference carries `taskId`; a session
 * reference carries `sessionId`. Both are part of the reference's identity, and
 * answering a foreign-origin request from a local record with the same ID is
 * how a fork ends up citing the wrong measurement.
 *
 * Every case here pairs the foreign request with the identical unqualified
 * request, so "unavailable" can never pass because the record was absent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { queryWorkingSet } from "../../src/memory/query.ts";
import { branchAt, seedBatch } from "../support/d0x-fixtures.ts";
import { asQueryResult } from "../support/retrieval-shape.ts";
import { makeTempDir } from "../support/tmp.ts";

interface Fixture {
	engine: MemoryEngine;
	recordId: string;
	revisionId: string;
	cleanup: () => void;
}

function build(): Fixture {
	const tmp = makeTempDir("pi-dag-l04-");
	const engine = MemoryEngine.open(tmp.path, "s-local");
	const commit = engine.update(seedBatch("l04-1"), branchAt("s-local"));
	engine.acknowledgeRef(commit.operationId, "entry-1");
	const research = engine.ingestResearchRecord({
		operationId: "l04-r1",
		kind: "observation",
		payload: { note: "local measurement", runId: "run-local" },
	});
	return {
		engine,
		recordId: research.recordId,
		revisionId: commit.revisionId,
		cleanup: () => {
			engine.release();
			tmp.cleanup();
		},
	};
}

function outcome(result: ReturnType<typeof asQueryResult>, id: string) {
	return (result.ids ?? []).find((entry) => entry.id === id);
}

test("4.3 a research ID qualified with a foreign task is unavailable, not resolved locally", () => {
	const fixture = build();
	try {
		const own = asQueryResult(
			queryWorkingSet(fixture.engine, { scope: "history", ids: [fixture.recordId] }),
		);
		assert.equal(
			outcome(own, fixture.recordId)?.status,
			"found",
			"sanity: the record really is here and really does resolve",
		);

		const foreign = asQueryResult(
			queryWorkingSet(fixture.engine, {
				scope: "history",
				ids: [fixture.recordId],
				origin: { taskId: "some-other-research-task" },
			}),
		);
		const found = outcome(foreign, fixture.recordId);
		assert.equal(
			found?.status,
			"unavailable_source",
			"a reference to another task's record is not answered from this task's store",
		);
		assert.equal(found?.reason, "foreign_task_origin");
		assert.equal(
			foreign.complete,
			false,
			"and a request that could not be answered is never reported complete",
		);
	} finally {
		fixture.cleanup();
	}
});

test("4.3 the engine's own task and session qualify successfully", () => {
	const fixture = build();
	try {
		const sameTask = asQueryResult(
			queryWorkingSet(fixture.engine, {
				scope: "history",
				ids: [fixture.recordId],
				origin: { taskId: fixture.engine.taskId },
			}),
		);
		assert.equal(outcome(sameTask, fixture.recordId)?.status, "found");

		const sameSession = asQueryResult(
			queryWorkingSet(fixture.engine, {
				scope: "history",
				ids: [fixture.revisionId],
				origin: { sessionId: fixture.engine.sessionId },
			}),
		);
		assert.equal(outcome(sameSession, fixture.revisionId)?.status, "found");
	} finally {
		fixture.cleanup();
	}
});

test("4.3 an unrelated origin session cannot claim this session's records", () => {
	const fixture = build();
	try {
		const unrelated = asQueryResult(
			queryWorkingSet(fixture.engine, {
				scope: "history",
				ids: [fixture.revisionId],
				origin: { sessionId: "an-unrelated-session" },
			}),
		);
		const found = outcome(unrelated, fixture.revisionId);
		assert.equal(found?.status, "unavailable_source");
		assert.equal(found?.reason, "foreign_session_origin");
	} finally {
		fixture.cleanup();
	}
});

test("4.3 an attached origin session resolves, because the attachment is recorded", () => {
	const fixture = build();
	try {
		const before = asQueryResult(
			queryWorkingSet(fixture.engine, {
				scope: "history",
				ids: [fixture.revisionId],
				origin: { sessionId: "origin-session" },
			}),
		);
		assert.equal(
			outcome(before, fixture.revisionId)?.status,
			"unavailable_source",
			"sanity: without an attachment the origin is foreign",
		);

		fixture.engine.attachFork("origin-session", fixture.revisionId);
		const after = asQueryResult(
			queryWorkingSet(fixture.engine, {
				scope: "history",
				ids: [fixture.revisionId],
				origin: { sessionId: "origin-session" },
			}),
		);
		assert.equal(
			outcome(after, fixture.revisionId)?.status,
			"found",
			"an origin this session verifiably attached to is not foreign",
		);
	} finally {
		fixture.cleanup();
	}
});

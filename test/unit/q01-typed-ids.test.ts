/**
 * Q01 — typed ID resolution.
 *
 * Selected node, revision, checkpoint and research IDs resolve, archived
 * evidence included. History ID reads never silently ignore `ids`. Missing,
 * unavailable-source and partial-record are three distinct outcomes.
 *
 * Foreign-origin sub-cases (an unrelated session ID with a matching local entry
 * ID; copied origin evidence surviving transcript removal) are deferred to task
 * 4.3, because they need R3's writer claims and origin/copy mappings.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { LIMITS, utf8Bytes } from "../../src/memory/limits.ts";
import { dagStatus, queryWorkingSet } from "../../src/memory/query.ts";
import { commit } from "../support/commit.ts";
import { asQueryResult } from "../support/retrieval-shape.ts";
import { makeTempDir } from "../support/tmp.ts";

interface Fixture {
	engine: MemoryEngine;
	cleanup: () => void;
	checkpointId: string;
	liveRevisionId: string;
	unselectedRevisionId: string;
	researchRecordId: string;
}

function build(prefix: string): Fixture {
	const tmp = makeTempDir(prefix);
	const engine = MemoryEngine.open(tmp.path, "s");
	const branch = { sessionId: "s", leafId: "l" };

	const first = commit(
		engine,
		{
			operationId: "q01-1",
			upsertNodes: [
				{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
				{
					id: "h-a",
					kind: "hypothesis",
					title: "tiling reduces launch overhead",
					body: "measured on W1",
					status: "open",
					evidence: [{ kind: "artifact", path: "runs/run-a/result.json", sha256: "aa11" }],
				},
				{ id: "h-b", kind: "hypothesis", title: "fusion helps", body: "", status: "open" },
				{ id: "h-c", kind: "hypothesis", title: "smem split helps", body: "", status: "open" },
			],
		},
		branch,
	);

	const second = commit(
		engine,
		{
			operationId: "q01-2",
			setStatus: [
				{ id: "h-a", status: "done" },
				{ id: "h-b", status: "done" },
				{ id: "h-c", status: "done" },
			],
			archiveIds: ["h-a", "h-b", "h-c"],
		},
		branch,
	);

	const research = engine.ingestResearchRecord({
		operationId: "q01-r1",
		kind: "observation",
		payload: { note: "fusion regressed the pipeline", runId: "run-fusion" },
	});

	const third = commit(
		engine,
		{
			operationId: "q01-3",
			upsertNodes: [
				{ id: "h-d", kind: "hypothesis", title: "later idea", body: "", status: "open" },
			],
		},
		branch,
	);
	engine.markUnselected(third.operationId);

	assert.equal(typeof first.checkpointId, "string");
	return {
		engine,
		cleanup: tmp.cleanup,
		checkpointId: first.checkpointId as string,
		liveRevisionId: second.revisionId,
		unselectedRevisionId: third.revisionId,
		researchRecordId: research.recordId,
	};
}

test("Q01 history ID reads resolve exactly the requested records", () => {
	const fixture = build("pi-dag-q01-");
	try {
		const all = asQueryResult(queryWorkingSet(fixture.engine, { scope: "history" }));
		assert.equal(
			all.records.length >= 3,
			true,
			"sanity: history holds all three archived records before the ID read",
		);

		const one = asQueryResult(queryWorkingSet(fixture.engine, { scope: "history", ids: ["h-a"] }));
		assert.deepEqual(
			one.records.map((record) => record.id),
			["h-a"],
			"a history ID read must return only the requested record, never the whole archive",
		);
		assert.equal(one.records[0]?.title, "tiling reduces launch overhead");
		assert.deepEqual(
			one.records[0]?.evidence,
			[{ kind: "artifact", path: "runs/run-a/result.json", sha256: "aa11" }],
			"archived evidence refs survive archival and come back with the record",
		);
	} finally {
		fixture.engine.close();
		fixture.cleanup();
	}
});

test("Q01 missing, unavailable-source and partial are three distinct outcomes", () => {
	const fixture = build("pi-dag-q01-");
	try {
		const result = asQueryResult(
			queryWorkingSet(fixture.engine, {
				scope: "history",
				ids: ["h-a", "never-existed", fixture.unselectedRevisionId],
			}),
		);
		assert.ok(Array.isArray(result.ids), "a bounded ID read reports a per-ID outcome");
		const byId = new Map((result.ids ?? []).map((outcome) => [outcome.id, outcome]));

		assert.equal(byId.get("h-a")?.status, "found");
		assert.equal(byId.get("h-a")?.type, "archived_node");

		assert.equal(byId.get("never-existed")?.status, "missing");

		const unselected = byId.get(fixture.unselectedRevisionId);
		assert.equal(
			unselected?.status,
			"unavailable_source",
			"a revision that exists but was unselected is unavailable, not missing",
		);
		assert.equal(unselected?.type, "revision");
		assert.equal(typeof unselected?.reason, "string");
		assert.notEqual(
			byId.get("never-existed")?.status,
			unselected?.status,
			"missing and unavailable-source must not collapse into one failure",
		);
	} finally {
		fixture.engine.close();
		fixture.cleanup();
	}
});

test("Q01 revision, checkpoint and research IDs resolve by type", () => {
	const fixture = build("pi-dag-q01-");
	try {
		const result = asQueryResult(
			queryWorkingSet(fixture.engine, {
				scope: "history",
				ids: [fixture.liveRevisionId, fixture.checkpointId, fixture.researchRecordId],
			}),
		);
		assert.ok(Array.isArray(result.ids), "typed durable IDs resolve through a bounded read");
		const byId = new Map((result.ids ?? []).map((outcome) => [outcome.id, outcome]));

		assert.equal(byId.get(fixture.liveRevisionId)?.type, "revision");
		assert.equal(byId.get(fixture.liveRevisionId)?.status, "found");

		// D1: checkpoint identity equals revision identity, so a checkpoint id is
		// a revision id and resolves as one. The checkpoint is still addressable
		// under that same id, materialized from the revision's own row.
		assert.equal(byId.get(fixture.checkpointId)?.type, "revision");
		assert.equal(byId.get(fixture.checkpointId)?.status, "found");
		assert.equal(
			(byId.get(fixture.checkpointId)?.record as { checkpointId?: string } | undefined)
				?.checkpointId,
			fixture.checkpointId,
			"a resolved revision declares that it is its own checkpoint",
		);
		const checkpoint = fixture.engine.checkpointMeta(fixture.checkpointId);
		assert.equal(
			checkpoint?.workingRevisionId,
			fixture.checkpointId,
			"the checkpoint under that id is the revision itself",
		);
		assert.equal(checkpoint?.schemaVersion, 2);

		const research = byId.get(fixture.researchRecordId);
		assert.equal(research?.type, "research");
		assert.equal(research?.status, "found");
		assert.equal(
			JSON.stringify(research?.record).includes("fusion regressed the pipeline"),
			true,
			"a resolved research record carries its payload",
		);

		assert.equal(
			utf8Bytes(JSON.stringify(result)) <= LIMITS.maxQueryBytes,
			true,
			"a typed resolve response stays inside the query output budget",
		);
	} finally {
		fixture.engine.close();
		fixture.cleanup();
	}
});

test("Q01 the card's record IDs resolve in at most two bounded retrieval calls", () => {
	const tmp = makeTempDir("pi-dag-q01-card-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		const branch = { sessionId: "s", leafId: "l" };
		const nodes = [
			{ id: "goal", kind: "goal" as const, title: "minimize pipeline p50" },
			{ id: "c1", kind: "constraint" as const, title: "smem le 64pct" },
			{ id: "c2", kind: "constraint" as const, title: "ulp2 correctness" },
			{ id: "c3", kind: "constraint" as const, title: "no new deps" },
			{ id: "d-base", kind: "decision" as const, title: "schedule kept" },
			{ id: "d-obs", kind: "decision" as const, title: "fusion fastest observed" },
			{ id: "d-val", kind: "decision" as const, title: "tiling validated" },
			{ id: "t1", kind: "task" as const, title: "profile W1" },
			{ id: "t2", kind: "task" as const, title: "profile W2" },
			{ id: "h1", kind: "hypothesis" as const, title: "does tiling help" },
			{ id: "h2", kind: "hypothesis" as const, title: "does fusion help" },
			{ id: "t3", kind: "task" as const, title: "write the report" },
		];
		commit(
			engine,
			{
				operationId: "q01-card",
				upsertNodes: nodes.map((node) => ({
					id: node.id,
					kind: node.kind,
					title: node.title,
					body: "",
					status: node.kind === "decision" ? ("done" as const) : ("open" as const),
				})),
				setSelection: {
					goalBinding: null,
					objectiveId: "goal",
					constraintIds: ["c1", "c2", "c3"],
					acceptedBaselineRecordId: "d-base",
					bestObservedRecordId: "d-obs",
					bestValidatedRecordId: "d-val",
					currentWorkIds: ["t1", "t2"],
					unresolvedIds: ["h1", "h2"],
					nextActionIds: ["t3"],
					rejectedApproachIds: [],
					pinnedIds: [],
				},
			},
			branch,
		);

		const status = dagStatus(engine);
		const cardIds = [
			...new Set(
				[
					...status.objective,
					...status.constraints,
					...status.acceptedBaseline,
					...status.bestObserved,
					...status.bestValidated,
					...status.currentWork,
					...status.unresolved,
					...status.nextAction,
					...status.rejected,
				].map((record) => record.id),
			),
		];
		assert.equal(
			cardIds.length > LIMITS.maxIdReads,
			true,
			"sanity: the card names more IDs than one bounded read can carry",
		);

		const pages: string[][] = [];
		for (let index = 0; index < cardIds.length; index += LIMITS.maxIdReads) {
			pages.push(cardIds.slice(index, index + LIMITS.maxIdReads));
		}
		assert.equal(pages.length <= 2, true, "the card resolves in at most two bounded calls");

		const seen = new Set<string>();
		for (const page of pages) {
			const result = asQueryResult(queryWorkingSet(engine, { scope: "active", ids: page }));
			assert.equal(
				utf8Bytes(JSON.stringify(result)) <= LIMITS.maxQueryBytes,
				true,
				"each retrieval call respects the query output budget",
			);
			assert.ok(Array.isArray(result.ids), "each call reports a per-ID outcome");
			for (const outcome of result.ids ?? []) {
				assert.equal(outcome.status, "found", `card record ${outcome.id} must resolve`);
				assert.equal(outcome.type, "node");
				seen.add(outcome.id);
			}
			assert.equal(result.deferredIds?.length ?? 0, 0, "no card ID is deferred out of its page");
		}
		assert.deepEqual([...seen].sort(), [...cardIds].sort());

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

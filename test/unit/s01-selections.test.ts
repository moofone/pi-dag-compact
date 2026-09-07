import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { assertHandoffEligible, formatHandoffCard } from "../../src/memory/handoff.ts";
import { dagStatus } from "../../src/memory/query.ts";
import { commit } from "../support/commit.ts";
import { makeTempDir } from "../support/tmp.ts";

const BRANCH = { sessionId: "s", leafId: "leaf-1" };

function emptySelection() {
	return {
		goalBinding: null,
		objectiveId: "",
		constraintIds: [],
		acceptedBaselineRecordId: null,
		bestObservedRecordId: null,
		bestValidatedRecordId: null,
		currentWorkIds: [],
		unresolvedIds: [],
		nextActionIds: [],
		rejectedApproachIds: [],
		pinnedIds: [],
	};
}

test("S01 an explicit selection picks exactly one baseline among many done decisions", () => {
	const tmp = makeTempDir("pi-dag-s01-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		commit(
			engine,
			{
				operationId: "s01-a",
				upsertNodes: [
					{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
					{
						id: "dec-a",
						kind: "decision",
						title: "accepted baseline A",
						body: "run-A",
						status: "done",
					},
					{
						id: "dec-b",
						kind: "decision",
						title: "accepted baseline B",
						body: "run-B",
						status: "done",
					},
					{
						id: "dec-c",
						kind: "decision",
						title: "superseded baseline C",
						body: "run-C",
						status: "done",
					},
				],
				setSelection: {
					...emptySelection(),
					objectiveId: "goal",
					acceptedBaselineRecordId: "dec-b",
				},
			},
			BRANCH,
		);
		const status = dagStatus(engine);
		assert.equal(status.acceptedBaseline.length, 1);
		assert.equal(status.acceptedBaseline[0]?.id, "dec-b");
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S01 selection names never determine scientific validity", () => {
	const tmp = makeTempDir("pi-dag-s01-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		commit(
			engine,
			{
				operationId: "s01-b",
				upsertNodes: [
					{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
					{
						id: "dec-named",
						kind: "decision",
						title: "accepted baseline shiny",
						body: "unvalidated marketing title",
						status: "done",
					},
					{
						id: "dec-plain",
						kind: "decision",
						title: "schedule variant kept after replay",
						body: "run-schedule-W1",
						status: "done",
					},
				],
				setSelection: {
					...emptySelection(),
					objectiveId: "goal",
					acceptedBaselineRecordId: "dec-plain",
				},
			},
			BRANCH,
		);
		const status = dagStatus(engine);
		assert.deepEqual(
			status.acceptedBaseline.map((node) => node.id),
			["dec-plain"],
		);
		const card = formatHandoffCard(engine);
		assert.equal(card.text.includes("schedule variant kept after replay"), true);
		assert.equal(card.text.includes("accepted baseline shiny"), false);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S01 stale constraints stay out of the current context", () => {
	const tmp = makeTempDir("pi-dag-s01-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		commit(
			engine,
			{
				operationId: "s01-c",
				upsertNodes: [
					{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
					{ id: "c-live", kind: "constraint", title: "smem <= 64%", body: "", status: "open" },
					{ id: "c-stale", kind: "constraint", title: "smem <= 80%", body: "", status: "stale" },
				],
			},
			BRANCH,
		);
		const status = dagStatus(engine);
		assert.deepEqual(
			status.constraints.map((node) => node.id),
			["c-live"],
		);
		const card = formatHandoffCard(engine);
		assert.equal(card.text.includes("smem <= 80%"), false);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S01 unresolved hypotheses stay distinct from blockers", () => {
	const tmp = makeTempDir("pi-dag-s01-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		commit(
			engine,
			{
				operationId: "s01-d",
				upsertNodes: [
					{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
					{
						id: "h-open",
						kind: "hypothesis",
						title: "does tiling help W1?",
						body: "",
						status: "open",
					},
					{
						id: "b-open",
						kind: "blocker",
						title: "profiler capture missing",
						body: "",
						status: "open",
					},
				],
			},
			BRANCH,
		);
		const status = dagStatus(engine);
		const unresolvedIds = status.unresolved.map((node) => node.id);
		const blockerIds = status.blockers.map((node) => node.id);
		assert.equal(unresolvedIds.includes("h-open"), true);
		assert.equal(unresolvedIds.includes("b-open"), false);
		assert.equal(blockerIds.includes("b-open"), true);
		assert.equal(blockerIds.includes("h-open"), false);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S01 an ambiguous baseline with no explicit selection refuses handoff", () => {
	const tmp = makeTempDir("pi-dag-s01-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		commit(
			engine,
			{
				operationId: "s01-e",
				upsertNodes: [
					{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
					{ id: "dec-a", kind: "decision", title: "keep variant A", body: "", status: "done" },
					{ id: "dec-b", kind: "decision", title: "keep variant B", body: "", status: "done" },
					{ id: "next", kind: "task", title: "run E", body: "", status: "open" },
				],
			},
			BRANCH,
		);
		assert.throws(
			() => assertHandoffEligible(engine),
			(error: unknown) => error instanceof DagError && error.code === "handoff_refused",
		);
		commit(
			engine,
			{
				operationId: "s01-e2",
				setSelection: {
					...emptySelection(),
					objectiveId: "goal",
					acceptedBaselineRecordId: "dec-b",
				},
			},
			BRANCH,
		);
		const card = assertHandoffEligible(engine);
		assert.equal(card.text.includes("keep variant B"), true);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S01 a selection naming an unknown record is refused before commit", () => {
	const tmp = makeTempDir("pi-dag-s01-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		const first = commit(
			engine,
			{
				operationId: "s01-f",
				upsertNodes: [
					{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
				],
			},
			BRANCH,
		);
		assert.throws(
			() =>
				commit(
					engine,
					{
						operationId: "s01-f2",
						setSelection: {
							...emptySelection(),
							objectiveId: "goal",
							acceptedBaselineRecordId: "ghost",
						},
					},
					BRANCH,
				),
			(error: unknown) => error instanceof DagError && error.code === "unknown_node",
		);
		assert.equal(engine.snapshot().revisionId, first.revisionId);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

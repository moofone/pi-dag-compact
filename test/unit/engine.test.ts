import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { dagStatus } from "../../src/memory/query.ts";
import { makeTempDir } from "../support/tmp.ts";

function branch(sessionId = "s1", leafId = "leaf-1") {
	return { sessionId, leafId };
}

function openEngine(dir: string, sessionId = "s1"): MemoryEngine {
	return MemoryEngine.open(dir, sessionId);
}

test("recovers baseline, constraints, rejections, and next action", () => {
	const tmp = makeTempDir("pi-dag-engine-");
	try {
		const engine = openEngine(tmp.path);
		const commit = engine.update(
			{
				operationId: "seed",
				upsertNodes: [
					{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
					{
						id: "ceiling",
						kind: "constraint",
						title: "smem <= 64%",
						body: "tightened ceiling",
						status: "open",
					},
					{
						id: "baseline",
						kind: "decision",
						title: "accepted baseline E",
						body: "run-E-W1",
						status: "done",
					},
					{
						id: "A",
						kind: "hypothesis",
						title: "fusion A",
						body: "pipeline regression",
						status: "rejected",
					},
					{
						id: "next",
						kind: "task",
						title: "investigate resource pressure",
						body: "",
						status: "open",
					},
				],
			},
			branch(),
		);
		engine.acknowledgeRef(commit.operationId, "entry-1");
		engine.close();

		const restarted = openEngine(tmp.path);
		restarted.reconstruct([{ customType: "dag_checkpoint_ref", data: commit.piRef }]);
		const status = dagStatus(restarted);
		assert.equal(status.objective[0]?.id, "goal");
		assert.equal(status.constraints[0]?.id, "ceiling");
		assert.equal(status.acceptedBaseline[0]?.id, "baseline");
		assert.equal(status.rejected[0]?.id, "A");
		assert.equal(status.nextAction[0]?.id, "next");
		restarted.close();
	} finally {
		tmp.cleanup();
	}
});

test("failed batches leave published state unchanged", () => {
	const tmp = makeTempDir("pi-dag-engine-");
	try {
		const engine = openEngine(tmp.path);
		const first = engine.update(
			{
				operationId: "ok",
				upsertNodes: [
					{ id: "a", kind: "task", title: "a", body: "", status: "open" },
					{ id: "b", kind: "task", title: "b", body: "", status: "open" },
				],
				addEdges: [{ from: "a", to: "b", kind: "depends_on" }],
			},
			branch(),
		);
		engine.acknowledgeRef(first.operationId, "e1");
		assert.throws(
			() =>
				engine.update(
					{
						operationId: "bad",
						addEdges: [{ from: "b", to: "a", kind: "depends_on" }],
					},
					branch(),
				),
			(error: unknown) => error instanceof DagError && error.code === "cycle",
		);
		assert.equal(engine.snapshot().revisionId, first.revisionId);
		assert.equal(engine.snapshot().edges.length, 1);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("operation ids are idempotent and reject conflicting payloads", () => {
	const tmp = makeTempDir("pi-dag-engine-");
	try {
		const engine = openEngine(tmp.path);
		const batch = {
			operationId: "same",
			upsertNodes: [
				{ id: "n", kind: "goal" as const, title: "g", body: "", status: "open" as const },
			],
		};
		const first = engine.update(batch, branch());
		const again = engine.update(batch, branch());
		assert.equal(again.revisionId, first.revisionId);
		assert.throws(
			() =>
				engine.update(
					{
						operationId: "same",
						upsertNodes: [{ id: "n", kind: "goal", title: "other", body: "", status: "open" }],
					},
					branch(),
				),
			(error: unknown) => error instanceof DagError && error.code === "op_conflict",
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("pending operations reconcile only on the expected branch", () => {
	const tmp = makeTempDir("pi-dag-engine-");
	try {
		const engine = openEngine(tmp.path);
		const pending = engine.update(
			{
				operationId: "pend",
				upsertNodes: [{ id: "g", kind: "goal", title: "g", body: "", status: "open" }],
			},
			branch("s1", "leaf-a"),
		);
		assert.equal(pending.status, "pending_ref");

		engine.reconstruct([]);
		const ignored: string[] = [];
		engine.reconcilePending(branch("s1", "leaf-b"), (ref) => {
			ignored.push(ref.revisionId);
			return "should-not-append";
		});
		assert.deepEqual(ignored, []);
		assert.equal(engine.snapshot().revisionId, null);

		const appended: string[] = [];
		engine.reconcilePending(branch("s1", "leaf-a"), (ref) => {
			appended.push(ref.revisionId);
			return "entry-pend";
		});
		assert.deepEqual(appended, [pending.revisionId]);
		assert.equal(engine.snapshot().nodes[0]?.id, "g");
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("forks inherit a revision and then diverge", () => {
	const tmp = makeTempDir("pi-dag-engine-");
	try {
		const parent = openEngine(tmp.path, "origin");
		const first = parent.update(
			{
				operationId: "origin-op",
				upsertNodes: [{ id: "g", kind: "goal", title: "g", body: "", status: "open" }],
			},
			branch("origin", "leaf-1"),
		);
		parent.acknowledgeRef(first.operationId, "e1");
		parent.release();

		const child = openEngine(tmp.path, "fork");
		child.reconstruct([{ customType: "dag_revision_ref", data: first.piRef }]);
		child.attachFork("origin", first.revisionId);
		const diverged = child.update(
			{
				operationId: "fork-op",
				upsertNodes: [
					{ id: "c", kind: "constraint", title: "ceiling 64", body: "", status: "open" },
				],
			},
			branch("fork", "leaf-2"),
		);
		assert.notEqual(diverged.revisionId, first.revisionId);
		assert.equal(child.snapshot().nodes.length, 2);
		child.close();
	} finally {
		tmp.cleanup();
	}
});

test("competing writers are refused until release", () => {
	const tmp = makeTempDir("pi-dag-engine-");
	try {
		const owner = openEngine(tmp.path, "owner");
		assert.throws(
			() => openEngine(tmp.path, "other"),
			(error: unknown) => error instanceof DagError && error.code === "competing_writer",
		);
		owner.release();
		const next = openEngine(tmp.path, "other");
		next.close();
	} finally {
		tmp.cleanup();
	}
});

test("history search is not an active miss", () => {
	const tmp = makeTempDir("pi-dag-engine-");
	try {
		const engine = openEngine(tmp.path);
		engine.update(
			{
				operationId: "keep",
				upsertNodes: [
					{ id: "keep", kind: "goal", title: "keep", body: "", status: "open" },
					{
						id: "old",
						kind: "hypothesis",
						title: "rejected fusion",
						body: "A",
						status: "rejected",
					},
				],
			},
			branch(),
		);
		engine.update(
			{
				operationId: "archive",
				archiveIds: ["old"],
			},
			branch(),
		);
		assert.equal(
			engine.snapshot().nodes.some((node) => node.id === "old"),
			false,
		);
		const archived = engine.archivedSearch("fusion", 8);
		assert.equal(archived[0]?.id, "old");
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("sqlite path is created under the task directory", () => {
	const tmp = makeTempDir("pi-dag-engine-");
	try {
		const engine = openEngine(join(tmp.path, "task"));
		engine.close();
		assert.equal(existsSync(join(tmp.path, "task", "memory.sqlite")), true);
	} finally {
		tmp.cleanup();
	}
});

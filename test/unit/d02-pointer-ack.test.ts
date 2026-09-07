/**
 * D02 — the pointer and the acknowledgement are separate boundaries.
 *
 * Four things happen in order and any of them can be the last thing that
 * happened: the SQLite commit, the Pi reference append, the SQLite selection
 * acknowledgement, and the compaction append. Recovery has to be decided from
 * durable evidence alone.
 *
 * A pointer that is on the branch with no acknowledgement in SQLite reconciles
 * once — the branch pointer is the selection authority, so the pointer wins and
 * no second reference is appended. A revision with no pointer is appended only
 * if the expected branch *and the expected parent* still match; otherwise it is
 * retained as unselected and never applied to a different branch.
 *
 * The real four-boundary restart runs as a subprocess in
 * `test/integration/d02-pointer-ack-crashes.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import type { PiRefData } from "../../src/schema/working.ts";
import { branchAt, seedBatch } from "../support/d0x-fixtures.ts";
import { makeTempDir } from "../support/tmp.ts";

function checkpointRef(ref: PiRefData): { customType: string; data: PiRefData } {
	return { customType: "dag_checkpoint_ref", data: ref };
}

test("D02 a persisted pointer with a missing acknowledgement reconciles exactly once", () => {
	const tmp = makeTempDir("pi-dag-d02-");
	try {
		const first = (() => {
			const engine = MemoryEngine.open(tmp.path, "s1");
			// The Pi append happened; the process died before the SQLite
			// acknowledgement, so the row is still prepared.
			const commit = engine.update(seedBatch("d02-1"), branchAt("s1", "leaf-a"));
			assert.equal(
				engine.revisionStatus(commit.revisionId),
				"prepared",
				"sanity: the acknowledgement really is missing",
			);
			engine.close();
			return commit;
		})();

		for (const round of [1, 2]) {
			const engine = MemoryEngine.open(tmp.path, "s1");
			engine.reconstruct([checkpointRef(first.piRef)]);
			assert.equal(
				engine.snapshot().revisionId,
				first.revisionId,
				`round ${round}: the branch pointer selects its revision`,
			);
			assert.equal(
				engine.revisionStatus(first.revisionId),
				"selected",
				`round ${round}: a pointer on the branch reconciles the missing acknowledgement`,
			);

			const appended: string[] = [];
			engine.reconcilePending(branchAt("s1", "leaf-a"), (ref) => {
				appended.push(ref.revisionId);
				return "duplicate-entry";
			});
			assert.deepEqual(
				appended,
				[],
				`round ${round}: an already-referenced revision must not be appended again`,
			);
			engine.close();
		}
	} finally {
		tmp.cleanup();
	}
});

test("D02 a missing pointer is not appended when the expected parent no longer matches", () => {
	const tmp = makeTempDir("pi-dag-d02-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s1");
		const first = engine.update(seedBatch("d02-1"), branchAt("s1", "leaf-a"));
		engine.acknowledgeRef(first.operationId, "entry-1");
		const second = engine.update(
			{
				operationId: "d02-2",
				upsertNodes: [
					{
						id: "extra",
						kind: "task",
						title: "committed but unreferenced",
						body: "",
						status: "open",
					},
				],
			},
			branchAt("s1", "leaf-a"),
		);
		assert.equal(
			engine.revisionMeta(second.revisionId)?.parentRevisionId,
			first.revisionId,
			"sanity: the pending revision expects the first revision as its parent",
		);

		// The branch moved off that ancestry entirely: nothing on it selects the
		// first revision any more, so the pending revision's expected parent is
		// no longer the published revision.
		engine.reconstruct([]);
		assert.equal(engine.snapshot().revisionId, null, "sanity: nothing is published");

		const appended: string[] = [];
		engine.reconcilePending(branchAt("s1", "leaf-a"), (ref) => {
			appended.push(ref.revisionId);
			return "entry-2";
		});
		assert.deepEqual(
			appended,
			[],
			"a pending revision whose expected parent is not published must not be appended",
		);
		assert.equal(
			engine.revisionStatus(second.revisionId),
			"unselected",
			"it is retained as unselected rather than applied to a different branch",
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("D02 a missing pointer is appended when branch and parent both still match", () => {
	const tmp = makeTempDir("pi-dag-d02-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s1");
		const first = engine.update(seedBatch("d02-1"), branchAt("s1", "leaf-a"));
		engine.acknowledgeRef(first.operationId, "entry-1");
		const second = engine.update(
			{
				operationId: "d02-2",
				upsertNodes: [
					{
						id: "extra",
						kind: "task",
						title: "committed but unreferenced",
						body: "",
						status: "open",
					},
				],
			},
			branchAt("s1", "leaf-a"),
		);
		engine.close();

		const reopened = MemoryEngine.open(tmp.path, "s1");
		reopened.reconstruct([checkpointRef(first.piRef)]);
		assert.equal(
			reopened.snapshot().revisionId,
			first.revisionId,
			"sanity: the expected parent is the published revision",
		);

		const appended: string[] = [];
		reopened.reconcilePending(branchAt("s1", "leaf-a"), (ref) => {
			appended.push(ref.revisionId);
			return "entry-2";
		});
		assert.deepEqual(appended, [second.revisionId], "the missing pointer is appended once");
		assert.equal(reopened.revisionStatus(second.revisionId), "selected");
		assert.equal(reopened.snapshot().revisionId, second.revisionId);

		const again: string[] = [];
		reopened.reconcilePending(branchAt("s1", "leaf-a"), (ref) => {
			again.push(ref.revisionId);
			return "entry-3";
		});
		assert.deepEqual(again, [], "repeated recovery does not duplicate the logical update");
		reopened.close();
	} finally {
		tmp.cleanup();
	}
});

test("D02 a pointer on the branch cannot reconcile onto ancestry it was not prepared against", () => {
	const tmp = makeTempDir("pi-dag-d02-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s1");
		const first = engine.update(seedBatch("d02-1"), branchAt("s1", "leaf-a"));
		engine.acknowledgeRef(first.operationId, "entry-1");
		const second = engine.update(
			{
				operationId: "d02-2",
				upsertNodes: [{ id: "extra", kind: "task", title: "second", body: "", status: "open" }],
			},
			branchAt("s1", "leaf-b"),
		);
		assert.equal(
			engine.revisionMeta(second.revisionId)?.parentRevisionId,
			first.revisionId,
			"sanity: the pending revision was prepared against the first revision",
		);
		engine.close();

		// The branch carries the second revision's pointer, but nothing selects the
		// first one before it. Reconciling the missing acknowledgement here would
		// publish a revision onto ancestry it was never prepared against.
		const reopened = MemoryEngine.open(tmp.path, "s1");
		assert.throws(
			() => reopened.reconstruct([checkpointRef(second.piRef)]),
			(error: unknown) => error instanceof DagError && error.code === "expected_parent_mismatch",
		);
		assert.equal(reopened.snapshot().revisionId, null, "nothing is published");
		assert.equal(
			reopened.revisionStatus(second.revisionId),
			"prepared",
			"the record keeps its state rather than being selected by the wrong branch",
		);
		reopened.close();
	} finally {
		tmp.cleanup();
	}
});

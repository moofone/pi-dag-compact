/**
 * D03 — idempotent receipts.
 *
 * A retry of the same operation with the same payload returns the receipt that
 * already exists. It does not move the published branch backward, it does not
 * append a second reference, and it does not become a new pending operation.
 * Reuse of the operation id with a different payload, or from a different
 * scope, is a conflict rather than a silent second meaning for one identity.
 *
 * The "no second reference" half is asserted through the real `dag_update`
 * tool and the real Pi pointer path in
 * `test/integration/d0x-publication-paths.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import type { PiRefData } from "../../src/schema/working.ts";
import { branchAt, seedBatch } from "../support/d0x-fixtures.ts";
import { makeTempDir } from "../support/tmp.ts";

const laterBatch = {
	operationId: "d03-2",
	upsertNodes: [
		{ id: "later", kind: "task" as const, title: "later work", body: "", status: "open" as const },
	],
};

function checkpointRef(ref: PiRefData): { customType: string; data: PiRefData } {
	return { customType: "dag_checkpoint_ref", data: ref };
}

test("D03 a replay after later revisions and after a branch switch returns the same receipt", () => {
	const tmp = makeTempDir("pi-dag-d03-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s1");
		const batch = seedBatch("d03-1");
		const first = engine.update(batch, branchAt("s1", "leaf-a"));
		engine.acknowledgeRef(first.operationId, "entry-1");

		const immediate = engine.update(batch, branchAt("s1", "leaf-a"));
		assert.equal(immediate.revisionId, first.revisionId, "an immediate retry returns its receipt");
		assert.equal(engine.snapshot().revisionId, first.revisionId);

		const second = engine.update(laterBatch, branchAt("s1", "leaf-b"));
		engine.acknowledgeRef(second.operationId, "entry-2");
		assert.equal(
			engine.snapshot().revisionId,
			second.revisionId,
			"sanity: a later revision is published before the replay",
		);

		const afterLater = engine.update(batch, branchAt("s1", "leaf-b"));
		assert.equal(afterLater.revisionId, first.revisionId);
		assert.equal(
			engine.snapshot().revisionId,
			second.revisionId,
			"a replay must not move the published branch backward",
		);

		// Branch switch: the published revision goes back to the first one.
		engine.reconstruct([checkpointRef(first.piRef)]);
		assert.equal(engine.snapshot().revisionId, first.revisionId, "sanity: the branch switched");
		const afterSwitch = engine.update(batch, branchAt("s1", "leaf-a"));
		assert.equal(afterSwitch.revisionId, first.revisionId);
		assert.equal(
			engine.revisionStatus(second.revisionId),
			"selected",
			"the replay leaves the other revision's own status alone",
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("D03 reusing an operation id with a different payload conflicts", () => {
	const tmp = makeTempDir("pi-dag-d03-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s1");
		const first = engine.update(seedBatch("d03-1"), branchAt("s1", "leaf-a"));
		engine.acknowledgeRef(first.operationId, "entry-1");
		assert.throws(
			() => engine.update(seedBatch("d03-1", "a different next action"), branchAt("s1", "leaf-a")),
			(error: unknown) => error instanceof DagError && error.code === "op_conflict",
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("D03 reusing an operation id from a different scope conflicts", () => {
	const tmp = makeTempDir("pi-dag-d03-");
	try {
		const batch = seedBatch("d03-1");
		const engine = MemoryEngine.open(tmp.path, "s1");
		const first = engine.update(batch, branchAt("s1", "leaf-a"));
		engine.acknowledgeRef(first.operationId, "entry-1");
		engine.release();

		const other = MemoryEngine.open(tmp.path, "s2");
		other.reconstruct([checkpointRef(first.piRef)]);
		assert.throws(
			() => other.update(batch, branchAt("s2", "leaf-x")),
			(error: unknown) => error instanceof DagError && error.code === "scope_conflict",
			"one operation id may not mean two different publication scopes",
		);
		other.close();
	} finally {
		tmp.cleanup();
	}
});

test("D03 pending work recorded on a different branch stays unselected", () => {
	const tmp = makeTempDir("pi-dag-d03-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s1");
		const first = engine.update(seedBatch("d03-1"), branchAt("s1", "leaf-a"));
		engine.acknowledgeRef(first.operationId, "entry-1");
		const pending = engine.update(laterBatch, branchAt("s1", "leaf-a"));
		assert.equal(
			engine.revisionStatus(pending.revisionId),
			"prepared",
			"sanity: there is pending work to leave unselected",
		);

		const appended: string[] = [];
		engine.reconcilePending(branchAt("s1", "leaf-elsewhere"), (ref) => {
			appended.push(ref.revisionId);
			return "wrong-branch-entry";
		});
		assert.deepEqual(appended, [], "pending work is never applied to a different branch");
		assert.notEqual(
			engine.revisionStatus(pending.revisionId),
			"selected",
			"pending work from a different branch stays unselected",
		);
		assert.equal(engine.snapshot().revisionId, first.revisionId);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

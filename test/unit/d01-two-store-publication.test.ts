/**
 * D01 — two-store publication.
 *
 * SQLite and the Pi session are two stores and there is no transaction across
 * them. Between the SQLite commit and the Pi acknowledgement the update exists
 * durably and is selected by nothing: the branch pointer is selection
 * authority, and a SQLite row is not a branch pointer.
 *
 * So the public snapshot, the public query and the handoff card must all keep
 * showing the previous selection until the reference is acknowledged, and a
 * pending operation must be resolved or quarantined before another update is
 * accepted on the same scope. Otherwise revision N+1 silently inherits state
 * that no branch ever selected.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { formatHandoffCard } from "../../src/memory/handoff.ts";
import { dagStatus } from "../../src/memory/query.ts";
import { branchAt, seedBatch, selection } from "../support/d0x-fixtures.ts";
import { makeTempDir } from "../support/tmp.ts";

function withEngine(fn: (engine: MemoryEngine, dir: string) => void): void {
	const tmp = makeTempDir("pi-dag-d01-");
	const engine = MemoryEngine.open(tmp.path, "s1");
	try {
		fn(engine, tmp.path);
	} finally {
		engine.close();
		tmp.cleanup();
	}
}

const secondBatch = {
	operationId: "d01-2",
	upsertNodes: [
		{
			id: "next-b",
			kind: "task" as const,
			title: "second next action",
			body: "",
			status: "open" as const,
		},
	],
	setSelection: selection({
		objectiveId: "goal",
		constraintIds: ["ceiling"],
		nextActionIds: ["next-b"],
	}),
};

test("D01 a committed but unacknowledged revision is not published", () => {
	withEngine((engine) => {
		const first = engine.update(seedBatch("d01-1"), branchAt());
		engine.acknowledgeRef(first.operationId, "entry-1");
		const publishedSelection = engine.snapshot().selection.selectionRevision;

		const second = engine.update(secondBatch, branchAt());

		// Sanity: the SQLite side really did commit. Without this the assertions
		// below could pass because nothing was written at all.
		assert.equal(
			engine.revisionMeta(second.revisionId)?.revision,
			2,
			"sanity: the second revision is committed in SQLite",
		);
		assert.equal(
			engine.revisionStatus(second.revisionId),
			"prepared",
			"a committed revision with no acknowledged Pi reference is prepared, never selected",
		);
		assert.equal(
			engine.snapshot().revisionId,
			first.revisionId,
			"the published snapshot stays on the acknowledged revision",
		);
		assert.equal(
			engine.snapshot().selection.selectionRevision,
			publishedSelection,
			"the published selection is unchanged until acknowledgement",
		);
		assert.deepEqual(
			dagStatus(engine).nextAction.map((node) => node.id),
			["next-a"],
			"the public query must not expose an unacknowledged selection",
		);
		assert.equal(
			formatHandoffCard(engine).text.includes("second next action"),
			false,
			"the handoff card must not carry an unacknowledged revision",
		);
	});
});

test("D01 a pending operation blocks another update on the same scope", () => {
	withEngine((engine) => {
		const first = engine.update(seedBatch("d01-1"), branchAt());
		engine.acknowledgeRef(first.operationId, "entry-1");
		const second = engine.update(secondBatch, branchAt());
		assert.equal(
			engine.revisionStatus(second.revisionId),
			"prepared",
			"sanity: there is a pending operation to be blocked by",
		);

		assert.throws(
			() =>
				engine.update(
					{
						operationId: "d01-3",
						upsertNodes: [
							{ id: "next-c", kind: "task", title: "third next action", body: "", status: "open" },
						],
					},
					branchAt(),
				),
			(error: unknown) => error instanceof DagError && error.code === "pending_operation",
			"an update on a scope with unresolved pending work must be refused",
		);
	});
});

test("D01 an update accepted after a quarantine cannot inherit pending state", () => {
	withEngine((engine) => {
		const first = engine.update(seedBatch("d01-1"), branchAt());
		engine.acknowledgeRef(first.operationId, "entry-1");
		const second = engine.update(secondBatch, branchAt());

		// The Pi append failed. The operation is quarantined, not published.
		engine.markUnselected(second.operationId);
		assert.equal(
			engine.revisionStatus(second.revisionId),
			"unselected",
			"sanity: the pending operation really was quarantined",
		);
		assert.equal(
			engine.snapshot().revisionId,
			first.revisionId,
			"quarantine leaves the published selection where it was",
		);

		const third = engine.update(
			{
				operationId: "d01-3",
				upsertNodes: [
					{ id: "next-c", kind: "task", title: "third next action", body: "", status: "open" },
				],
			},
			branchAt(),
		);
		assert.equal(
			engine.revisionMeta(third.revisionId)?.parentRevisionId,
			first.revisionId,
			"the next accepted update descends from the published revision, not the quarantined one",
		);
		assert.equal(
			third.nodes.some((node) => node.id === "next-b"),
			false,
			"the next accepted update cannot inherit quarantined state",
		);
	});
});

/**
 * D01 and D03 through the public tool and the actual Pi pointer path.
 *
 * The whole route is production: the real `AgentSession`, the real file-backed
 * `SessionManager`, the real extension, the real `dag_update` tool, the real
 * host boundary and its fence. The only interception is at
 * `SessionManager._persist`, the host's write boundary, so the fixture can make
 * a Pi append fail without replacing publication, selection or reconstruction.
 *
 * D01: a Pi failure must leave the previous selection published everywhere the
 * public surfaces can see it, and the update that follows must not inherit the
 * failed one.
 *
 * D03: retrying one operation id with the same payload must not put a second
 * reference on the branch or a second revision in the store.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createClassicHarness } from "../../src/eval/harness.ts";
import { loadEvalConfig } from "../../src/eval/load.ts";
import { createIsolatedWorkspace } from "../../src/eval/workspace.ts";
import { openStoreDirect } from "../support/d0x-fixtures.ts";
import { createOperationFactory } from "../support/d02-crash-child.ts";

const config = loadEvalConfig();
const DAG_REF_TYPES = new Set(["dag_revision_ref", "dag_checkpoint_ref"]);
const workspaces: Array<{ cleanup: () => void }> = [];

function isolated() {
	const workspace = createIsolatedWorkspace();
	workspaces.push(workspace);
	return workspace;
}

function dagRefs(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.filter(
		(entry) => entry.type === "custom" && DAG_REF_TYPES.has(entry.customType ?? ""),
	);
}

/**
 * References that were read back out of the session file.
 *
 * R1 recorded that a failed append still becomes the leaf and stays in
 * `getBranch()`, so the branch is not evidence of what was written. The file is
 * what a restart will see, so it is what "reached the branch" has to mean here.
 * The branch count is recorded separately, as characterisation.
 */
function durableDagRefs(harness: {
	sessionManager: { getBranch(): readonly SessionEntry[] };
	persistedEntryIds(): Set<string>;
}): number {
	const persisted = harness.persistedEntryIds();
	return dagRefs(harness.sessionManager.getBranch()).filter((entry) => persisted.has(entry.id))
		.length;
}

function revisionRows(taskDir: string): Array<{ operationId: string; status: string }> {
	const db = openStoreDirect(taskDir);
	try {
		return (
			db.prepare("SELECT operation_id, status FROM revisions ORDER BY revision").all() as Array<{
				operation_id: string;
				status: string;
			}>
		).map((row) => ({ operationId: String(row.operation_id), status: String(row.status) }));
	} finally {
		db.close();
	}
}

// ------------------------------------------------------------------ D01
const d01Workspace = isolated();
const d01TaskDir = `${d01Workspace.cwd}/research-task`;
const d01Emitted: string[] = [];
const d01 = await createClassicHarness(d01Workspace, config, {
	dag: true,
	fauxFactory: createOperationFactory(d01Emitted),
});
await d01.session.prompt("Warm-up turn: force the deferred first session flush.");
await d01.session.prompt("Record the working set. OP=d01-a");
const acceptedRefs = durableDagRefs(d01);
const acceptedRevisionId = d01.dagRuntime?.engine?.snapshot().revisionId ?? null;
const acceptedSelection = d01.dagRuntime?.engine?.snapshot().selection.selectionRevision ?? null;

// The SQLite commit succeeds; the Pi append does not.
d01.persist.arm({ failCustomTypes: [...DAG_REF_TYPES], maxFailures: 1 });
await d01.session.prompt("Record the next working set. OP=d01-b");
d01.persist.disarm();

const afterFailure = {
	refs: durableDagRefs(d01),
	refsOnBranch: dagRefs(d01.sessionManager.getBranch()).length,
	publishedRevisionId: d01.dagRuntime?.engine?.snapshot().revisionId ?? null,
	selection: d01.dagRuntime?.engine?.snapshot().selection.selectionRevision ?? null,
	nodeIds: (d01.dagRuntime?.engine?.snapshot().nodes ?? []).map((node) => node.id),
	rows: revisionRows(d01TaskDir),
	fenceRaised: d01.fence.raised,
};
const commandsBefore = d01.commandOutputs.length;
await d01.session.prompt("/dag");
const statusOutput = d01.commandOutputs
	.slice(commandsBefore)
	.map((entry) => entry.output)
	.join("\n");

// An explicit repair — R8 owns the `/dag-repair` surface; here the fence is
// cleared directly so the next accepted update can be observed.
d01.fence.clear();
await d01.session.prompt("Record a third working set. OP=d01-c");
const afterRepair = {
	refs: durableDagRefs(d01),
	publishedRevisionId: d01.dagRuntime?.engine?.snapshot().revisionId ?? null,
	nodeIds: (d01.dagRuntime?.engine?.snapshot().nodes ?? []).map((node) => node.id),
	rows: revisionRows(d01TaskDir),
};
const d01ParentOfThird = (() => {
	const third = afterRepair.rows.find((row) => row.operationId === "d01-c");
	if (!third) return undefined;
	const db = openStoreDirect(d01TaskDir);
	try {
		const row = db
			.prepare("SELECT parent_revision_id FROM revisions WHERE operation_id = ?")
			.get("d01-c") as { parent_revision_id?: string | null } | undefined;
		return row?.parent_revision_id ?? null;
	} finally {
		db.close();
	}
})();
await d01.cleanup();

// ------------------------------------------------------------------ D03
const d03Workspace = isolated();
const d03TaskDir = `${d03Workspace.cwd}/research-task`;
const d03Emitted: string[] = [];
const d03 = await createClassicHarness(d03Workspace, config, {
	dag: true,
	fauxFactory: createOperationFactory(d03Emitted),
});
await d03.session.prompt("Warm-up turn: force the deferred first session flush.");
await d03.session.prompt("Record the working set. OP=d03-a");
const d03FirstRefs = dagRefs(d03.sessionManager.getBranch()).length;
const d03FirstDurableRefs = durableDagRefs(d03);
await d03.session.prompt("Record the working set again, same identity. OP=d03-a");
const d03AfterRetry = {
	refs: dagRefs(d03.sessionManager.getBranch()).length,
	durableRefs: durableDagRefs(d03),
	rows: revisionRows(d03TaskDir),
	publishedRevisionId: d03.dagRuntime?.engine?.snapshot().revisionId ?? null,
};
await d03.cleanup();

after(() => {
	for (const workspace of workspaces) workspace.cleanup();
});

test("D01 a Pi failure leaves the previous selection published on every public surface", () => {
	assert.deepEqual(d01Emitted, ["d01-a", "d01-b", "d01-c"], "sanity: three real tool calls ran");
	assert.equal(acceptedRefs, 1, "sanity: the accepted update put one reference on the branch");
	assert.ok(acceptedRevisionId, "sanity: the accepted update published a revision");
	assert.equal(
		afterFailure.rows.some((row) => row.operationId === "d01-b"),
		true,
		"sanity: the failed operation really did commit to SQLite",
	);

	assert.equal(afterFailure.refs, 1, "no reference reached the session file for the failed append");
	assert.equal(
		afterFailure.refsOnBranch,
		2,
		"characterisation (R1): the host leaves the failed entry in the branch anyway",
	);
	assert.equal(
		afterFailure.publishedRevisionId,
		acceptedRevisionId,
		"the public snapshot still exposes the previous selection",
	);
	assert.equal(afterFailure.selection, acceptedSelection);
	assert.equal(
		afterFailure.nodeIds.includes("n-d01-b"),
		false,
		"the failed update's records are not in the published working set",
	);
	assert.notEqual(
		afterFailure.rows.find((row) => row.operationId === "d01-b")?.status,
		"selected",
		"a revision with no acknowledged reference is never selected",
	);
	assert.equal(afterFailure.fenceRaised, true, "the host boundary fence went up");
	assert.equal(
		statusOutput.includes(acceptedRevisionId ?? "unreachable"),
		true,
		`/dag reports the published revision, not the pending one: ${statusOutput}`,
	);
});

test("D01 the next accepted update cannot inherit the pending state", () => {
	assert.equal(afterRepair.refs, 2, "the third update published its own durable reference");
	assert.notEqual(afterRepair.publishedRevisionId, acceptedRevisionId);
	assert.equal(
		afterRepair.nodeIds.includes("n-d01-c"),
		true,
		"sanity: the third update's own record is published",
	);
	assert.equal(
		afterRepair.nodeIds.includes("n-d01-b"),
		false,
		"the quarantined operation's records stay out of the published working set",
	);
	assert.equal(
		d01ParentOfThird,
		acceptedRevisionId,
		"the third update descends from the published revision, not the quarantined one",
	);
	assert.equal(
		afterRepair.rows.find((row) => row.operationId === "d01-b")?.status,
		"unselected",
		"the pending operation is quarantined rather than left to be inherited",
	);
});

test("D03 retrying one operation id appends no second reference and stores no second revision", () => {
	assert.deepEqual(d03Emitted, ["d03-a", "d03-a"], "sanity: the tool really ran twice");
	assert.equal(d03FirstRefs, 1, "sanity: the first call published one reference");
	assert.equal(d03FirstDurableRefs, 1, "sanity: that reference is in the session file");
	assert.equal(d03AfterRetry.durableRefs, 1, "and no second reference was written");
	assert.equal(
		d03AfterRetry.refs,
		1,
		"a replayed operation returns its receipt without appending another reference",
	);
	assert.deepEqual(
		d03AfterRetry.rows.map((row) => row.operationId),
		["d03-a"],
		"a replayed operation creates no second revision",
	);
	assert.equal(d03AfterRetry.rows[0]?.status, "selected");
});

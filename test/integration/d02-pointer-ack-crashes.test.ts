/**
 * D02 — restart after every boundary, through the real host.
 *
 * Four boundaries, four subprocesses, each one killed with `process.exit` at
 * exactly one instant: after the SQLite commit, after the Pi reference append,
 * after the SQLite selection acknowledgement, and after the compaction append.
 * Every crash is a real process death over a real file-backed session, and
 * every recovery is the production `session_start` path reached through the
 * real `/dag` command.
 *
 * Recovery runs twice per boundary. Reconciling twice must not duplicate the
 * logical update, and at no boundary may the branch carry two references to one
 * revision.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createClassicHarness } from "../../src/eval/harness.ts";
import { loadEvalConfig } from "../../src/eval/load.ts";
import { createIsolatedWorkspace } from "../../src/eval/workspace.ts";
import { openStoreDirect } from "../support/d0x-fixtures.ts";
import {
	type ChildInfo,
	CRASH_EXIT_CODE,
	type CrashBoundary,
	childInfoPath,
	createOperationFactory,
	reopenWorkspace,
} from "../support/d02-crash-child.ts";

const config = loadEvalConfig();
const childPath = fileURLToPath(new URL("../support/d02-crash-child.ts", import.meta.url));
const DAG_REF_TYPES = new Set(["dag_revision_ref", "dag_checkpoint_ref"]);
const workspaces: Array<{ cleanup: () => void }> = [];

/**
 * Read the crashed operation's revision straight out of SQLite, without opening
 * an engine over it: the crashed process is gone but its writer row is not, and
 * the probe must not take ownership away from the recovery that follows.
 */
function readRevisionByOperation(
	taskDir: string,
): { revisionId: string; status: string } | undefined {
	const db = openStoreDirect(taskDir);
	try {
		const row = db
			.prepare("SELECT revision_id, status FROM revisions WHERE operation_id = ?")
			.get("d02-op") as { revision_id?: string; status?: string } | undefined;
		if (!row?.revision_id) return undefined;
		return { revisionId: String(row.revision_id), status: String(row.status) };
	} finally {
		db.close();
	}
}

function dagRefEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.filter(
		(entry) => entry.type === "custom" && DAG_REF_TYPES.has(entry.customType ?? ""),
	);
}

interface RecoveryRound {
	refCount: number;
	refsInFile: number;
	publishedRevisionId: string | null;
	status: string | undefined;
	nextActionTitles: string[];
}

interface BoundaryOutcome {
	boundary: CrashBoundary;
	childExit: number | null;
	childStderr: string;
	/** Dag references on the branch immediately after the crash, before recovery. */
	refsAfterCrash: number;
	/** The revision the crashed process committed, read straight out of SQLite. */
	crashedRevisionId: string | null;
	statusAfterCrash: string | undefined;
	rounds: RecoveryRound[];
	compactionEntries: number;
}

async function runBoundary(boundary: CrashBoundary): Promise<BoundaryOutcome> {
	const workspace = createIsolatedWorkspace();
	workspaces.push(workspace);
	const child = spawnSync(
		process.execPath,
		["--experimental-strip-types", childPath, workspace.root, boundary],
		{ encoding: "utf8", timeout: 120_000 },
	);
	const info = JSON.parse(readFileSync(childInfoPath(workspace.root), "utf8")) as ChildInfo;

	// What the crashed process left behind, read without running any recovery.
	const beforeRecovery = await createClassicHarness(reopenWorkspace(workspace.root), config, {
		dag: false,
		sessionFile: info.sessionFile,
	});
	const refsAfterCrash = dagRefEntries(beforeRecovery.sessionManager.getBranch()).length;
	await beforeRecovery.cleanup();

	const crashed = readRevisionByOperation(info.taskDir);
	const crashedRevisionId = crashed?.revisionId ?? null;
	const statusAfterCrash = crashed?.status;

	const rounds: RecoveryRound[] = [];
	let compactionEntries = 0;
	for (const round of [1, 2]) {
		const harness = await createClassicHarness(reopenWorkspace(workspace.root), config, {
			dag: true,
			fauxFactory: createOperationFactory(),
			sessionFile: info.sessionFile,
		});
		// The real command, which boots the runtime: reconstruct from the branch,
		// then reconcile whatever the crash left pending.
		await harness.session.prompt("/dag");
		const engine = harness.dagRuntime?.engine;
		const branch = harness.sessionManager.getBranch();
		const persisted = harness.persistedEntryIds();
		const revisionId = crashedRevisionId;
		rounds.push({
			refCount: dagRefEntries(branch).length,
			refsInFile: dagRefEntries(branch).filter((entry) => persisted.has(entry.id)).length,
			publishedRevisionId: engine?.snapshot().revisionId ?? null,
			status: revisionId ? engine?.revisionStatus(revisionId) : undefined,
			nextActionTitles:
				engine
					?.snapshot()
					.nodes.filter((node) => node.id === "next-a")
					.map((node) => node.title) ?? [],
		});
		if (round === 2) {
			compactionEntries = branch.filter((entry) => entry.type === "compaction").length;
		}
		await harness.cleanup();
	}

	return {
		boundary,
		childExit: child.status,
		childStderr: child.stderr ?? "",
		refsAfterCrash,
		crashedRevisionId,
		statusAfterCrash,
		rounds,
		compactionEntries,
	};
}

const outcomes = new Map<CrashBoundary, BoundaryOutcome>();
for (const boundary of [
	"after_sqlite_commit",
	"after_pi_append",
	"after_sqlite_ack",
	"after_compaction_append",
] satisfies CrashBoundary[]) {
	outcomes.set(boundary, await runBoundary(boundary));
}

after(() => {
	for (const workspace of workspaces) workspace.cleanup();
});

function outcome(boundary: CrashBoundary): BoundaryOutcome {
	const found = outcomes.get(boundary);
	assert.ok(found, `sanity: ${boundary} produced an outcome`);
	return found;
}

test("D02 every boundary really crashed a real process", () => {
	for (const [boundary, result] of outcomes) {
		assert.equal(
			result.childExit,
			CRASH_EXIT_CODE,
			`${boundary}: the child must die at its boundary, not exit cleanly (${result.childStderr.slice(-400)})`,
		);
		assert.ok(
			result.crashedRevisionId,
			`${boundary}: sanity — the crashed process committed a revision to SQLite`,
		);
	}
});

test("D02 a crash before the Pi append leaves nothing selected, and recovery appends it once", () => {
	const result = outcome("after_sqlite_commit");
	assert.equal(result.refsAfterCrash, 0, "the crash happened before the host saw any pointer");
	for (const [index, round] of result.rounds.entries()) {
		assert.equal(round.refCount, 1, `round ${index + 1}: exactly one reference on the branch`);
		assert.equal(round.refsInFile, 1, `round ${index + 1}: that reference is in the session file`);
		assert.equal(round.publishedRevisionId, result.crashedRevisionId);
		assert.equal(round.status, "selected");
		assert.deepEqual(round.nextActionTitles, ["next after d02-op"]);
	}
});

test("D02 a persisted pointer with a missing acknowledgement reconciles once", () => {
	const result = outcome("after_pi_append");
	assert.equal(result.refsAfterCrash, 1, "the host wrote the pointer before the process died");
	for (const [index, round] of result.rounds.entries()) {
		assert.equal(
			round.refCount,
			1,
			`round ${index + 1}: reconciliation must not append a second reference`,
		);
		assert.equal(round.publishedRevisionId, result.crashedRevisionId);
		assert.equal(
			round.status,
			"selected",
			`round ${index + 1}: the branch pointer is the selection authority`,
		);
	}
});

test("D02 a crash after the acknowledgement reconstructs the same revision", () => {
	const result = outcome("after_sqlite_ack");
	assert.equal(result.refsAfterCrash, 1);
	assert.equal(result.statusAfterCrash, "selected");
	for (const [index, round] of result.rounds.entries()) {
		assert.equal(round.refCount, 1, `round ${index + 1}: no reference was added by recovery`);
		assert.equal(round.publishedRevisionId, result.crashedRevisionId);
		assert.deepEqual(round.nextActionTitles, ["next after d02-op"]);
	}
});

test("D02 a crash after the compaction append reconstructs the same revision", () => {
	const result = outcome("after_compaction_append");
	assert.equal(
		result.compactionEntries >= 1,
		true,
		"sanity: the compaction entry survived the crash",
	);
	for (const [index, round] of result.rounds.entries()) {
		assert.equal(round.refCount, 1, `round ${index + 1}: exactly one reference on the branch`);
		assert.equal(round.publishedRevisionId, result.crashedRevisionId);
		assert.equal(round.status, "selected");
	}
});

/**
 * L02 — the real session lifecycle owns the writer claim.
 *
 * Every transition here is emitted by Pi's own `AgentSessionRuntime`:
 * `session_start` on startup, resume and fork; `session_shutdown` on quit and
 * on every replacement; `session_tree` on a real tree navigation. A fork is a
 * real new session file with a new session ID and host-copied entries.
 *
 * No case calls `engine.release()`, `engine.detach()` or any other store method
 * to make a transition happen. Ownership is only ever released by the runtime
 * under test, reacting to a host event.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadEvalConfig } from "../../src/eval/load.ts";
import { createIsolatedWorkspace } from "../../src/eval/workspace.ts";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { openStoreDirect } from "../support/d0x-fixtures.ts";
import { createOperationFactory } from "../support/d02-crash-child.ts";
import { createLifecycleHost, lastUserEntryId } from "../support/lifecycle-harness.ts";

const config = loadEvalConfig();
const workspaces: Array<{ cleanup: () => void }> = [];

after(() => {
	for (const workspace of workspaces) workspace.cleanup();
});

function workspace() {
	const created = createIsolatedWorkspace();
	workspaces.push(created);
	return created;
}

function isCompeting(error: unknown): boolean {
	return error instanceof DagError && error.code === "competing_writer";
}

function attachments(taskDir: string): Array<Record<string, unknown>> {
	const db = openStoreDirect(taskDir);
	try {
		return db.prepare("SELECT * FROM attachments ORDER BY created_at").all() as Array<
			Record<string, unknown>
		>;
	} finally {
		db.close();
	}
}

function claims(taskDir: string): Array<Record<string, unknown>> {
	const db = openStoreDirect(taskDir);
	try {
		const present = Number(
			(
				db
					.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'writer_claims'")
					.get() as {
					n: number;
				}
			).n,
		);
		if (present === 0) return [];
		return db.prepare("SELECT * FROM writer_claims").all() as Array<Record<string, unknown>>;
	} finally {
		db.close();
	}
}

function refEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.filter(
		(entry) =>
			entry.type === "custom" &&
			(entry.customType === "dag_checkpoint_ref" || entry.customType === "dag_revision_ref"),
	);
}

test("L02 an orderly shutdown releases writer ownership", async () => {
	const space = workspace();
	const host = await createLifecycleHost(space, config, {
		fauxFactory: createOperationFactory(),
	});
	await host.session.prompt("Warm-up turn: force the deferred first session flush.");
	await host.session.prompt("Record the working set. OP=l02-shutdown");

	const engine = host.dag()?.engine;
	assert.ok(engine, "sanity: the extension booted from the host's own session_start");
	assert.ok(engine.snapshot().revisionId, "sanity: the live session published a revision");
	assert.throws(
		() => MemoryEngine.open(host.taskDir, "outsider"),
		isCompeting,
		"sanity: while the session is live, nobody else may write",
	);

	await host.dispose();
	assert.ok(
		host.events.some((event) => event.type === "session_shutdown" && event.reason === "quit"),
		"sanity: the host really emitted session_shutdown",
	);

	const later = MemoryEngine.open(host.taskDir, "outsider");
	assert.equal(
		later.claimToken !== null,
		true,
		"an orderly detach releases ownership, so a later session may attach",
	);
	later.release();
	assert.deepEqual(claims(host.taskDir), [], "and the released claim leaves nothing behind");
});

test("L02 a fork acquires a distinct claim and records its real origin", async () => {
	const space = workspace();
	const host = await createLifecycleHost(space, config, {
		fauxFactory: createOperationFactory(),
	});
	await host.session.prompt("Warm-up turn: force the deferred first session flush.");
	await host.session.prompt("Record the working set. OP=l02-fork-origin");

	const originSessionId = host.sessionId;
	const originEngine = host.dag()?.engine;
	assert.ok(originEngine);
	const originRevisionId = originEngine.snapshot().revisionId;
	assert.ok(originRevisionId, "sanity: the origin published a revision before the fork");
	const originClaim = claims(host.taskDir)[0]?.claim_token;
	assert.equal(typeof originClaim, "string", "sanity: the origin holds a claim");

	const checkpointEntry = refEntries(host.session.sessionManager.getEntries()).at(-1);
	assert.ok(checkpointEntry, "sanity: the origin's checkpoint reference is on its branch");

	const forked = await host.host.fork(checkpointEntry.id, { position: "at" });
	assert.equal(forked.cancelled, false, "sanity: the host really forked");
	assert.notEqual(host.sessionId, originSessionId, "a fork is a new session id");
	assert.ok(
		host.events.some((event) => event.type === "session_start" && event.reason === "fork"),
		"sanity: the fork arrived as a real session_start",
	);

	const forkClaims = claims(host.taskDir);
	assert.equal(forkClaims.length, 1, "the origin released its claim and the fork took its own");
	assert.equal(
		String(forkClaims[0]?.session_id),
		host.sessionId,
		"the live claim belongs to the fork",
	);
	assert.notEqual(
		forkClaims[0]?.claim_token,
		originClaim,
		"writer transfer is exclusive: a fork does not inherit the origin's token",
	);

	const records = attachments(host.taskDir);
	assert.equal(records.length, 1, "the fork records exactly one attachment");
	assert.equal(
		String(records[0]?.session_id),
		host.sessionId,
		"the attachment belongs to the fork",
	);
	assert.equal(
		String(records[0]?.origin_session_id),
		originSessionId,
		"the attachment names the real origin session, not a placeholder",
	);
	assert.equal(
		String(records[0]?.inherited_revision_id),
		originRevisionId,
		"the fork records the revision it actually inherited",
	);

	const forkEngine = host.dag()?.engine;
	assert.ok(forkEngine);
	assert.equal(
		forkEngine.snapshot().revisionId,
		originRevisionId,
		"forking at the checkpoint inherits exactly that revision",
	);
	await host.dispose();
});

test("L02 forks before and after a checkpoint inherit different ancestry and then diverge", async () => {
	const space = workspace();
	const host = await createLifecycleHost(space, config, {
		fauxFactory: createOperationFactory(),
	});
	await host.session.prompt("Warm-up turn: force the deferred first session flush.");
	await host.session.prompt("Record the working set. OP=l02-diverge-origin");

	const originSessionId = host.sessionId;
	const originFile = host.sessionFile;
	assert.ok(originFile, "sanity: the origin is persisted");
	const originRevisionId = host.dag()?.engine?.snapshot().revisionId ?? null;
	assert.ok(originRevisionId);
	const preCheckpointEntry = lastUserEntryId(host.session);
	const checkpointEntry = refEntries(host.session.sessionManager.getEntries()).at(-1);
	assert.ok(checkpointEntry);

	// Fork after the checkpoint, then diverge.
	await host.host.fork(checkpointEntry.id, { position: "at" });
	const afterSessionId = host.sessionId;
	assert.equal(host.dag()?.engine?.snapshot().revisionId, originRevisionId);
	await host.session.prompt("Record the working set. OP=l02-after-fork");
	const afterRevisionId = host.dag()?.engine?.snapshot().revisionId ?? null;
	assert.ok(afterRevisionId);
	assert.notEqual(afterRevisionId, originRevisionId, "the fork's first update is a new revision");
	assert.equal(
		host.dag()?.engine?.revisionMeta(afterRevisionId)?.parentRevisionId,
		originRevisionId,
		"and it takes the inherited revision as its parent",
	);

	// Back to the origin through a real session switch, then fork before the
	// checkpoint from the same origin position.
	const switched = await host.host.switchSession(originFile);
	assert.equal(switched.cancelled, false, "sanity: the host really switched back");
	assert.equal(host.sessionId, originSessionId);
	await host.host.fork(preCheckpointEntry, { position: "at" });
	const beforeSessionId = host.sessionId;
	assert.notEqual(beforeSessionId, afterSessionId, "the two forks are different sessions");
	assert.equal(
		host.dag()?.engine?.snapshot().revisionId,
		null,
		"forking before the checkpoint inherits no revision at all",
	);
	assert.equal(
		String(attachments(host.taskDir).at(-1)?.inherited_revision_id ?? "null"),
		"null",
		"and records that it inherited nothing, rather than the origin's later work",
	);

	await host.session.prompt("Record the working set. OP=l02-before-fork");
	const beforeRevisionId = host.dag()?.engine?.snapshot().revisionId ?? null;
	assert.ok(beforeRevisionId);
	assert.notEqual(beforeRevisionId, afterRevisionId, "the two forks diverged");
	assert.equal(
		host.dag()?.engine?.revisionMeta(beforeRevisionId)?.parentRevisionId ?? null,
		null,
		"the pre-checkpoint fork's first revision has no inherited parent",
	);
	assert.equal(claims(host.taskDir).length, 1, "only ever one writer across all of it");
	await host.dispose();
});

test("L02 a tree navigation restores the branch-local selection", async () => {
	const space = workspace();
	const host = await createLifecycleHost(space, config, {
		fauxFactory: createOperationFactory(),
	});
	await host.session.prompt("Warm-up turn: force the deferred first session flush.");
	await host.session.prompt("Record the working set. OP=l02-tree-one");
	const firstRevisionId = host.dag()?.engine?.snapshot().revisionId ?? null;
	const firstRef = refEntries(host.session.sessionManager.getEntries()).at(-1);
	assert.ok(firstRef);
	await host.session.prompt("Record the working set. OP=l02-tree-two");
	const secondRevisionId = host.dag()?.engine?.snapshot().revisionId ?? null;
	assert.notEqual(firstRevisionId, secondRevisionId, "sanity: two revisions exist on this branch");

	await host.session.navigateTree(firstRef.id);
	assert.ok(
		host.events.some((event) => event.type === "session_tree"),
		"sanity: the host emitted a real session_tree event",
	);
	assert.equal(
		host.dag()?.engine?.snapshot().revisionId,
		firstRevisionId,
		"the branch pointer selects the revision, so navigation restores that selection",
	);
	assert.equal(
		claims(host.taskDir).length,
		1,
		"tree navigation is not a writer transfer and does not disturb the claim",
	);
	await host.dispose();
});

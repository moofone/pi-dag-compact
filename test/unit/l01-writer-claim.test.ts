/**
 * L01 (in-process half) — an exclusive writer claim, not a session-name check.
 *
 * The process-boundary half of L01 lives in
 * `test/integration/l01-writer-claim.test.ts`, where two real processes race
 * behind an IPC barrier. This file covers what is observable inside one
 * process: a second writer for the *same* session ID is still a competing
 * writer, the claim carries a verifiable process identity rather than a bare
 * session name, and a released handle's token cannot write again.
 *
 * No case here waits for time to pass. Nothing in the claim is reclaimable by
 * elapsed time; a timeout-based reclaim would be the defect this gate exists to
 * prevent.
 */

import assert from "node:assert/strict";
import { hostname } from "node:os";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { branchAt, openStoreDirect, seedBatch } from "../support/d0x-fixtures.ts";
import { makeTempDir } from "../support/tmp.ts";

function step(id: string) {
	return {
		operationId: id,
		upsertNodes: [
			{
				id: `t-${id}`,
				kind: "task" as const,
				title: `step ${id}`,
				body: "",
				status: "open" as const,
			},
		],
	};
}

function isCode(code: string) {
	return (error: unknown): boolean => error instanceof DagError && error.code === code;
}

test("L01 a second writer for the same session ID is refused while the first holds the claim", () => {
	const tmp = makeTempDir("pi-dag-l01-");
	try {
		const owner = MemoryEngine.open(tmp.path, "s-shared");
		const first = owner.update(seedBatch("l01-a"), branchAt("s-shared"));
		owner.acknowledgeRef(first.operationId, "entry-1");
		assert.equal(
			owner.snapshot().revisionId,
			first.revisionId,
			"sanity: the holder really is a writer with published state",
		);

		assert.throws(
			() => MemoryEngine.open(tmp.path, "s-shared"),
			isCode("competing_writer"),
			"two writers reopening the same session ID are still competing writers",
		);

		// The refusal must not have cost the holder anything.
		const second = owner.update(step("l01-b"), branchAt("s-shared", "leaf-2"));
		owner.acknowledgeRef(second.operationId, "entry-2");
		assert.equal(owner.snapshot().revisionId, second.revisionId);

		owner.release();
		const next = MemoryEngine.open(tmp.path, "s-shared");
		assert.equal(
			next.snapshotRevisionId(),
			null,
			"sanity: a fresh handle publishes nothing until it reconstructs",
		);
		next.close();
	} finally {
		tmp.cleanup();
	}
});

test("L01 the claim records a verifiable process identity, not a bare session ID", () => {
	const tmp = makeTempDir("pi-dag-l01-");
	const owner = MemoryEngine.open(tmp.path, "s-identity");
	const db = openStoreDirect(tmp.path);
	try {
		const tables = db
			.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'writer_claims'")
			.get() as { n: number };
		assert.equal(Number(tables.n), 1, "ownership is a claim record, not a session-name column");

		const row = db.prepare("SELECT * FROM writer_claims WHERE task_id = 'default'").get() as
			| Record<string, unknown>
			| undefined;
		assert.ok(row, "the open writer holds exactly one claim row for its task");
		assert.equal(String(row?.session_id), "s-identity");
		assert.equal(String(row?.host), hostname(), "the claim records the host that made it");
		assert.equal(Number(row?.pid), process.pid, "the claim records the owning process");
		assert.equal(
			typeof row?.claim_token === "string" && String(row.claim_token).length > 0,
			true,
			"the claim carries a process-instance token in addition to the session id",
		);
		assert.equal(
			String(row?.claim_token),
			owner.claimToken,
			"the engine holds the token that is actually stored",
		);
		assert.equal(
			Number(row?.process_started_at) > 0,
			true,
			"the claim records when the owning process started, so a reused pid is not mistaken for it",
		);
	} finally {
		db.close();
		owner.release();
		tmp.cleanup();
	}
});

test("L01 an orderly detach releases ownership, and the released token can no longer write", () => {
	const tmp = makeTempDir("pi-dag-l01-");
	try {
		const first = MemoryEngine.open(tmp.path, "s-detach");
		const committed = first.update(seedBatch("l01-detach"), branchAt("s-detach"));
		first.acknowledgeRef(committed.operationId, "entry-1");
		const releasedToken = first.claimToken;
		assert.equal(typeof releasedToken, "string", "sanity: the first writer held a token");

		first.detach();
		const second = MemoryEngine.open(tmp.path, "s-detach");
		assert.notEqual(second.claimToken, releasedToken, "a new claim is a new token");

		assert.throws(
			() => first.update(step("l01-stale"), branchAt("s-detach", "leaf-2")),
			isCode("not_writer"),
			"a released handle is no longer a writer, whatever it still points at",
		);

		// A stale release must not clear the newer owner's claim.
		first.detach();
		assert.throws(
			() => MemoryEngine.open(tmp.path, "s-other"),
			isCode("competing_writer"),
			"a stale detach cannot hand the store to a third writer",
		);
		assert.equal(
			typeof second.update(step("l01-live"), branchAt("s-detach", "leaf-3")).revisionId,
			"string",
			"the live owner is unaffected by the stale handle",
		);

		first.close();
		second.release();
	} finally {
		tmp.cleanup();
	}
});

test("L01 a writer whose claim was recovered from underneath it cannot write", () => {
	const tmp = makeTempDir("pi-dag-l01-");
	try {
		const writer = MemoryEngine.open(tmp.path, "s-token");
		const committed = writer.update(seedBatch("l01-token"), branchAt("s-token"));
		writer.acknowledgeRef(committed.operationId, "entry-1");
		assert.equal(
			writer.writerClaim()?.claimToken,
			writer.claimToken,
			"sanity: the handle holds the claim that is actually stored",
		);

		// Exactly what another process's explicit recovery does to the stored
		// claim. This handle still believes it is the writer.
		const db = openStoreDirect(tmp.path);
		db.prepare("DELETE FROM writer_claims WHERE task_id = 'default'").run();
		db.close();

		assert.throws(
			() => writer.update(step("l01-token-2"), branchAt("s-token", "leaf-2")),
			isCode("stale_claim"),
			"every mutation validates the token, not just the session name",
		);
		assert.throws(
			() => writer.acknowledgeRef(committed.operationId, "entry-2"),
			isCode("stale_claim"),
			"publication is a mutation too",
		);

		// And its release must not take the store from whoever holds it now.
		const next = MemoryEngine.open(tmp.path, "s-token-next");
		writer.detach();
		assert.equal(
			next.writerClaim()?.claimToken,
			next.claimToken,
			"a stale release leaves the current owner's claim exactly where it was",
		);
		next.release();
		writer.close();
	} finally {
		tmp.cleanup();
	}
});

test("L01 a reader attaches without taking the claim and refuses every mutation", () => {
	const tmp = makeTempDir("pi-dag-l01-");
	try {
		const owner = MemoryEngine.open(tmp.path, "s-reader");
		const committed = owner.update(seedBatch("l01-reader"), branchAt("s-reader"));
		owner.acknowledgeRef(committed.operationId, "entry-1");

		const reader = MemoryEngine.open(tmp.path, "s-observer", "default", { role: "reader" });
		assert.equal(reader.claimToken, null, "a reader holds no claim");
		assert.equal(
			reader.revisionMeta(committed.revisionId)?.revisionId,
			committed.revisionId,
			"sanity: the reader really can read the owner's durable records",
		);
		assert.throws(
			() => reader.update(step("l01-reader-write"), branchAt("s-observer")),
			isCode("not_writer"),
			"an attached observer never mutates",
		);
		reader.close();

		assert.equal(
			owner.update(step("l01-owner-still"), branchAt("s-reader", "leaf-2")).revision,
			2,
			"the reader's open and close left the owner's claim intact",
		);
		owner.release();
	} finally {
		tmp.cleanup();
	}
});

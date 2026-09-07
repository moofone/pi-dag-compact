import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendPiRef } from "../../src/extension/session.ts";
import { makeTempDir } from "../support/tmp.ts";

/**
 * P02-deferred-persistence (unit boundary). TRUE ASSERTION.
 *
 * This is the fixture that keeps the rest of the design honest. An API return
 * is not a durable acknowledgement. Pi hands an entry id back after the entry
 * is already in memory and already the leaf, and the write it then attempts is
 * deferred until an assistant message exists, is never fsynced, and is never
 * checked. So the extension's own append must report the durability it
 * observed, not a bare id, and it must never report a deferred or unpersisted
 * write as acknowledged.
 *
 * "Acknowledged" here means the bytes were read back out of the session file.
 * It is not, and must never be described as, a power-loss guarantee.
 */

const REF = {
	v: 1 as const,
	taskId: "t-1",
	operationId: "op-1",
	revisionId: "r-1",
	payloadHash: "0123456789abcdef",
	checkpointId: "c-1",
};

function fileEntryIds(file: string | undefined): string[] {
	if (!file || !existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => String((JSON.parse(line) as { id?: unknown }).id ?? "(header)"));
}

test("an extension append reports observed durability, not a bare entry id", () => {
	const tmp = makeTempDir("p02-unit-shape-");
	try {
		const session = SessionManager.inMemory(tmp.path);
		const appended = appendPiRef(session, REF, false);
		assert.equal(
			typeof appended,
			"object",
			"an append must report what the host did with it, not just the id it handed back",
		);
		assert.equal(typeof appended.entryId, "string");
		assert.equal(typeof appended.durability, "string");
		assert.equal(typeof appended.acknowledged, "boolean");
	} finally {
		tmp.cleanup();
	}
});

test("an in-memory session acknowledges nothing at all", () => {
	const tmp = makeTempDir("p02-unit-memory-");
	try {
		const session = SessionManager.inMemory(tmp.path);
		const appended = appendPiRef(session, REF, false);
		assert.equal(appended.durability, "not_persisted");
		assert.equal(appended.acknowledged, false);
		assert.equal(session.getSessionFile(), undefined);
		assert.ok(
			session.getEntries().some((entry) => entry.id === appended.entryId),
			"the entry is real in memory; only its durability is absent",
		);
	} finally {
		tmp.cleanup();
	}
});

test("the deferred initial write means a returned id has no file behind it", () => {
	const tmp = makeTempDir("p02-unit-deferred-");
	try {
		const session = SessionManager.create(tmp.path, tmp.path);
		const file = session.getSessionFile();
		assert.ok(file, "the host names a session file up front");
		assert.equal(existsSync(file), false, "and does not create it");

		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "start" }],
			timestamp: Date.now(),
		});
		const appended = appendPiRef(session, REF, false);
		assert.equal(appended.durability, "deferred");
		assert.equal(
			appended.acknowledged,
			false,
			"a returned entry id before the first flush is not an acknowledgement",
		);
		assert.equal(existsSync(file), false, "still no session file exists");
		assert.deepEqual(fileEntryIds(file), []);
	} finally {
		tmp.cleanup();
	}
});

test("the first assistant message is what makes earlier appends readable back", () => {
	const tmp = makeTempDir("p02-unit-flush-");
	try {
		const session = SessionManager.create(tmp.path, tmp.path);
		const file = session.getSessionFile();
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "start" }],
			timestamp: Date.now(),
		});
		const deferred = appendPiRef(session, REF, false);
		assert.equal(deferred.acknowledged, false);

		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);

		assert.equal(existsSync(file ?? ""), true, "the deferred flush created the file");
		assert.ok(
			fileEntryIds(file).includes(deferred.entryId),
			"the entry that was not acknowledged earlier is readable now",
		);
		const after = appendPiRef(session, { ...REF, revisionId: "r-2" }, false);
		assert.equal(after.durability, "present_in_file");
		assert.equal(after.acknowledged, true);
	} finally {
		tmp.cleanup();
	}
});

test("ids readable out of the file are a strict subset of the ids the host reports", () => {
	const tmp = makeTempDir("p02-unit-subset-");
	try {
		const session = SessionManager.create(tmp.path, tmp.path);
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "start" }],
			timestamp: Date.now(),
		});
		appendPiRef(session, REF, false);
		const inMemory = session.getEntries().map((entry) => entry.id);
		const onDisk = fileEntryIds(session.getSessionFile());
		assert.ok(inMemory.length > 0);
		assert.equal(onDisk.length, 0);
		assert.ok(
			inMemory.every((id) => !onDisk.includes(id)),
			"before the first flush every id the host reports is undurable",
		);
	} finally {
		tmp.cleanup();
	}
});

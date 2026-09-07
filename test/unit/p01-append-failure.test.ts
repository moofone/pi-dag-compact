import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRuntime } from "../../src/extension/runtime.ts";
import { fakeExtensionApi } from "../support/fake-pi.ts";
import { makeTempDir } from "../support/tmp.ts";

/**
 * P01-append-failure (unit boundary). CHARACTERISATION plus one assertion.
 *
 * The recorded half of this fixture states what the host does with an append
 * whose write failed. It does not require the host to do anything: Pi pushes
 * the entry into memory, indexes it, and advances the leaf before it tries to
 * write, and it does not roll any of that back. Every assertion below that is
 * about the host is labelled CHARACTERISATION and is a record, not a demand.
 *
 * The one required assertion is about this extension: when an append it made is
 * not in the session file, it must notice and fence its own downstream work.
 * That fence is extension-level. It is not a core guarantee.
 */

type Persister = { _persist(entry: unknown): void };

function flushedSession(dir: string): SessionManager {
	const session = SessionManager.create(dir, dir);
	session.appendMessage({
		role: "user",
		content: [{ type: "text", text: "start" }],
		timestamp: Date.now(),
	});
	// Pi defers the first file write until an assistant message exists.
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
	return session;
}

function failNextPersist(session: SessionManager): () => void {
	const raw = session as unknown as Persister;
	const real = raw._persist.bind(session);
	let armed = true;
	raw._persist = (entry: unknown) => {
		if (armed) {
			armed = false;
			throw new Error("injected persist failure");
		}
		real(entry);
	};
	return () => {
		raw._persist = real;
	};
}

test("the extension runtime owns a host durability observer", () => {
	const runtime = createRuntime(fakeExtensionApi());
	assert.equal(
		typeof runtime.boundary?.durability?.recordFailedAppend,
		"function",
		"an extension over an unfenced host must be able to record what a failed append left behind",
	);
	assert.equal(typeof runtime.boundary?.guardedAppend, "function");
});

test("CHARACTERISATION: a failed append is still the leaf, the branch and the context", () => {
	const tmp = makeTempDir("p01-unit-");
	try {
		const session = flushedSession(tmp.path);
		const runtime = createRuntime(fakeExtensionApi());
		const known = new Set(session.getEntries().map((entry) => entry.id));
		const restore = failNextPersist(session);
		let thrown: unknown;
		try {
			session.appendCustomEntry("dag_revision_ref", { v: 1, revisionId: "r-1" });
		} catch (error) {
			thrown = error;
		}
		restore();
		assert.ok(thrown, "the host propagates the write failure to the caller");

		const leak = runtime.boundary?.durability?.recordFailedAppend(thrown, session, known);
		assert.ok(leak, "the extension must record what the failed append left behind");
		assert.ok(leak.entryId, "the entry the host failed to write is still in memory");
		// Recorded, not required. The host does not roll back and is not asked to.
		assert.equal(leak.isLeaf, true, "CHARACTERISATION: the failed entry is the leaf");
		assert.equal(leak.inBranch, true, "CHARACTERISATION: the failed entry is on the branch");
		assert.equal(
			leak.inContextEntries,
			true,
			"CHARACTERISATION: the context builder still selects the failed entry",
		);
		assert.equal(leak.inFile, false, "CHARACTERISATION: nothing about it reached the file");
	} finally {
		tmp.cleanup();
	}
});

test("the extension fences itself when its own append fails", () => {
	const tmp = makeTempDir("p01-unit-fence-");
	try {
		const session = flushedSession(tmp.path);
		const runtime = createRuntime(fakeExtensionApi());
		assert.equal(runtime.boundary?.fence?.raised, false);
		const restore = failNextPersist(session);
		assert.equal(typeof runtime.boundary?.guardedAppend, "function");
		assert.throws(() =>
			runtime.boundary?.guardedAppend(session, () =>
				session.appendCustomEntry("dag_revision_ref", { v: 1, revisionId: "r-2" }),
			),
		);
		restore();
		assert.equal(runtime.boundary?.fence?.raised, true, "the extension must fence downstream work");
		assert.equal(runtime.boundary?.fence?.reason, "append_failed");
		assert.equal(runtime.boundary?.durability?.leaks.length, 1);
	} finally {
		tmp.cleanup();
	}
});

test("a deferred append is uncertain but is not a fence", () => {
	const tmp = makeTempDir("p01-unit-deferred-");
	try {
		// No assistant message yet, so Pi has not created the session file at all.
		const session = SessionManager.create(tmp.path, tmp.path);
		const runtime = createRuntime(fakeExtensionApi());
		assert.equal(typeof runtime.boundary?.guardedAppend, "function");
		const observation = runtime.boundary?.guardedAppend(session, () =>
			session.appendCustomEntry("dag_revision_ref", { v: 1, revisionId: "r-3" }),
		);
		assert.equal(observation.durability, "deferred");
		assert.equal(observation.acknowledged, false);
		assert.equal(
			runtime.boundary?.fence?.raised,
			false,
			"a deferred write is the host's normal behaviour, not a detected hole",
		);
	} finally {
		tmp.cleanup();
	}
});

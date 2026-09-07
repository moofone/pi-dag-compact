/**
 * L03 — origin-qualified evidence resolves through a verified mapping, or not
 * at all.
 *
 * A `sessionId` on an evidence reference names where the evidence came from. It
 * is never a hint to be dropped in favour of "some local entry with the same
 * id": entry ids are only unique within a session, and a fork copies them
 * verbatim, so a bare same-id lookup will confidently return the wrong entry.
 *
 * Every case here carries a sanity assertion that the local entry it must *not*
 * substitute really exists and really is readable. Otherwise "unavailable" would
 * pass for the wrong reason.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveSessionEvidence } from "../../src/extension/session.ts";
import { makeTempDir } from "../support/tmp.ts";

function entry(id: string, text = id): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-07T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	} as SessionEntry;
}

function manager(options: {
	sessionId: string;
	branch: SessionEntry[];
	offBranch?: SessionEntry[];
}) {
	const all = [...options.branch, ...(options.offBranch ?? [])];
	return {
		getSessionId: () => options.sessionId,
		getBranch: () => options.branch,
		getEntry: (id: string) => all.find((item) => item.id === id),
	};
}

function noOrigin() {
	return {
		copiedEntryId: () => undefined,
		sourceTranscript: () => undefined,
	};
}

test("L03 an unrelated session ID with a matching local entry ID is unavailable", () => {
	const shared = entry("shared-entry", "the fork's own turn");
	const host = manager({ sessionId: "fork-session", branch: [shared] });

	const local = resolveSessionEvidence(host, "fork-session", "shared-entry");
	assert.equal(
		"entry" in local && local.entry.id,
		"shared-entry",
		"sanity: the entry really is present and readable under its own session id",
	);

	const foreign = resolveSessionEvidence(host, "unrelated-session", "shared-entry", {
		origin: noOrigin(),
	});
	assert.deepEqual(
		foreign,
		{ unavailable: true, reason: "uncopied_foreign_entry" },
		"an unrelated origin is not satisfied by a same-id local entry",
	);
});

test("L03 a local entry outside the branch is not substituted for foreign evidence", () => {
	const offBranch = entry("off-branch-entry", "abandoned branch");
	const host = manager({
		sessionId: "fork-session",
		branch: [entry("on-branch")],
		offBranch: [offBranch],
	});
	assert.equal(
		host.getEntry("off-branch-entry")?.id,
		"off-branch-entry",
		"sanity: the entry exists in the session, just not on this branch",
	);

	const foreign = resolveSessionEvidence(host, "unrelated-session", "off-branch-entry", {
		origin: noOrigin(),
	});
	assert.deepEqual(foreign, { unavailable: true, reason: "uncopied_foreign_entry" });
});

test("L03 an off-branch entry of the current session is a distinct answer from a missing one", () => {
	const host = manager({
		sessionId: "current",
		branch: [entry("on-branch")],
		offBranch: [entry("off-branch")],
	});
	const off = resolveSessionEvidence(host, "current", "off-branch");
	const missing = resolveSessionEvidence(host, "current", "never-existed");
	assert.deepEqual(off, { unavailable: true, reason: "off_branch_entry" });
	assert.deepEqual(missing, { unavailable: true, reason: "missing_entry" });
	assert.notEqual(
		"reason" in off && off.reason,
		"reason" in missing && missing.reason,
		"reconstruction is branch-scoped, and an off-branch entry says so",
	);
});

test("L03 verified copied origin evidence resolves through its mapping", () => {
	const copied = entry("origin-entry", "the origin's measurement");
	const host = manager({ sessionId: "fork-session", branch: [copied] });
	const resolved = resolveSessionEvidence(host, "origin-session", "origin-entry", {
		origin: {
			copiedEntryId: (originSessionId: string, originEntryId: string) =>
				originSessionId === "origin-session" && originEntryId === "origin-entry"
					? "origin-entry"
					: undefined,
			sourceTranscript: () => undefined,
		},
	});
	assert.equal("entry" in resolved && resolved.entry.id, "origin-entry");
	assert.equal(
		"chunk" in resolved && resolved.chunk.text.includes("the origin's measurement"),
		true,
		"the copy carries the origin's content",
	);
});

test("L03 uncopied evidence resolves from an explicitly attached source transcript", () => {
	const tmp = makeTempDir("pi-dag-l03-");
	try {
		const source = join(tmp.path, "origin.jsonl");
		writeFileSync(
			source,
			`${JSON.stringify({ type: "session", id: "origin-session", version: 5 })}\n${JSON.stringify(
				entry("only-in-origin", "measured 1.83x on W1"),
			)}\n`,
		);
		const host = manager({ sessionId: "fork-session", branch: [entry("local-only")] });

		const resolved = resolveSessionEvidence(host, "origin-session", "only-in-origin", {
			origin: {
				copiedEntryId: () => undefined,
				sourceTranscript: (originSessionId: string) =>
					originSessionId === "origin-session" ? source : undefined,
			},
		});
		assert.equal("entry" in resolved && resolved.entry.id, "only-in-origin");
		assert.equal(
			"chunk" in resolved && resolved.chunk.text.includes("measured 1.83x on W1"),
			true,
			"an attached source is read, not guessed at",
		);
	} finally {
		tmp.cleanup();
	}
});

test("L03 an attached source that cannot be read is unavailable, never a local same-ID entry", () => {
	const tmp = makeTempDir("pi-dag-l03-");
	try {
		const shared = entry("shared-entry", "a local entry that merely shares the id");
		const host = manager({ sessionId: "fork-session", branch: [shared] });
		assert.equal(
			"entry" in resolveSessionEvidence(host, "fork-session", "shared-entry"),
			true,
			"sanity: the local same-id entry is present and readable",
		);

		const resolved = resolveSessionEvidence(host, "origin-session", "shared-entry", {
			origin: {
				copiedEntryId: () => undefined,
				sourceTranscript: () => join(tmp.path, "removed.jsonl"),
			},
		});
		assert.deepEqual(resolved, { unavailable: true, reason: "unavailable_origin_source" });
	} finally {
		tmp.cleanup();
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveSessionEvidence } from "../../src/extension/session.ts";

function entry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text: id }], timestamp: Date.now() },
	} as SessionEntry;
}

test("current-session missing entries are unavailable", () => {
	const resolved = resolveSessionEvidence(
		{
			getSessionId: () => "current",
			getBranch: () => [],
			getEntry: () => undefined,
		},
		"current",
		"missing",
	);
	assert.deepEqual(resolved, { unavailable: true, reason: "missing_entry" });
});

test("origin-qualified copied entries resolve on the fork branch", () => {
	const copied = entry("origin-entry");
	const resolved = resolveSessionEvidence(
		{
			getSessionId: () => "fork",
			getBranch: () => [copied],
			getEntry: (id) => (id === copied.id ? copied : undefined),
		},
		"origin",
		"origin-entry",
	);
	assert.equal("entry" in resolved && resolved.entry.id, "origin-entry");
});

test("uncopied foreign evidence is unavailable", () => {
	const resolved = resolveSessionEvidence(
		{
			getSessionId: () => "fork",
			getBranch: () => [entry("local")],
			getEntry: () => undefined,
		},
		"origin",
		"missing-from-copy",
	);
	assert.deepEqual(resolved, { unavailable: true, reason: "uncopied_foreign_entry" });
});

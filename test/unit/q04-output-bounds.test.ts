/**
 * Q04 — output bounds.
 *
 * Envelopes, separators, multibyte text, large refs and paths, and a single
 * oversized entry. Every response respects its byte budget or returns a bounded
 * chunk with forward progress, and `session_read` never emits an entire
 * unbounded transcript entry.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveSessionEvidence } from "../../src/extension/session.ts";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { LIMITS, utf8Bytes } from "../../src/memory/limits.ts";
import { queryWorkingSet } from "../../src/memory/query.ts";
import { commit } from "../support/commit.ts";
import {
	asQueryResult,
	asSessionEvidence,
	type QueryResultShape,
} from "../support/retrieval-shape.ts";
import { makeTempDir } from "../support/tmp.ts";

const BRANCH = { sessionId: "s", leafId: "l" };

function sizedNode(
	id: string,
	title: string,
	target: number,
): { id: string; kind: "hypothesis"; title: string; body: string; status: "open" } {
	const draft = { id, kind: "hypothesis" as const, title, body: "", status: "open" as const };
	const base = utf8Bytes(JSON.stringify({ ...draft, evidence: [], paths: [], revision: 1 }));
	return { ...draft, body: "x".repeat(Math.max(0, target - base)) };
}

function pageThrough(engine: MemoryEngine): {
	pages: QueryResultShape[];
	ids: string[];
	oversized: string[];
} {
	const pages: QueryResultShape[] = [];
	const ids: string[] = [];
	const oversized: string[] = [];
	let cursor: string | undefined;
	for (let guard = 0; guard < 40; guard += 1) {
		const page = asQueryResult(
			queryWorkingSet(engine, { scope: "active", ...(cursor ? { cursor } : {}) }),
		);
		pages.push(page);
		for (const record of page.records) ids.push(record.id);
		for (const entry of page.oversized ?? []) oversized.push(entry.id);
		if (page.complete || !page.cursor) break;
		assert.notEqual(page.cursor, cursor, "a cursor must advance so paging makes forward progress");
		cursor = page.cursor;
	}
	return { pages, ids, oversized };
}

test("Q04 the whole response, envelope and separators included, fits the byte budget", () => {
	const tmp = makeTempDir("pi-dag-q04-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		const expected: string[] = [];
		const upsertNodes = [];
		for (let index = 0; index < 8; index += 1) {
			const id = `e${index}`;
			expected.push(id);
			upsertNodes.push(sizedNode(id, `envelope record ${index}`, 1024));
		}
		commit(engine, { operationId: "q04-env", upsertNodes }, BRANCH);

		const first = asQueryResult(queryWorkingSet(engine, { scope: "active" }));
		assert.equal(first.records.length >= 1, true, "sanity: the page is not empty");
		assert.equal(
			utf8Bytes(JSON.stringify(first)) <= LIMITS.maxQueryBytes,
			true,
			"the serialized response, not just the sum of record payloads, respects 8 KiB",
		);
		assert.equal(first.complete, false, "eight 1 KiB records do not fit one 8 KiB response");
		assert.equal(typeof first.cursor, "string");

		const { ids, pages } = pageThrough(engine);
		for (const page of pages) {
			assert.equal(utf8Bytes(JSON.stringify(page)) <= LIMITS.maxQueryBytes, true);
		}
		assert.deepEqual([...ids].sort(), [...expected].sort(), "paging still covers every record");

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("Q04 multibyte text is measured in bytes and never split", () => {
	const tmp = makeTempDir("pi-dag-q04-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		const upsertNodes = [];
		for (let index = 0; index < 8; index += 1) {
			upsertNodes.push({
				id: `m${index}`,
				kind: "hypothesis" as const,
				title: `カーネル融合 🚀 ${index}`,
				body: "測定値".repeat(120),
				status: "open" as const,
			});
		}
		commit(engine, { operationId: "q04-multibyte", upsertNodes }, BRANCH);

		const { pages, ids } = pageThrough(engine);
		for (const page of pages) {
			assert.equal(
				utf8Bytes(JSON.stringify(page)) <= LIMITS.maxQueryBytes,
				true,
				"multibyte pages are bounded by UTF-8 bytes, not code units",
			);
			for (const record of page.records) {
				assert.equal(record.title.includes("🚀"), true, "multibyte text round-trips intact");
				assert.equal(record.title.includes("�"), false, "no replacement characters");
			}
		}
		assert.equal(ids.length, 8, "every multibyte record is reachable by paging");
		assert.equal(pages.length >= 2, true, "these records need more than one page");

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("Q04 a single oversized record returns a bounded chunk with forward progress", () => {
	const tmp = makeTempDir("pi-dag-q04-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		// A record larger than one 16 KiB mutation batch is built over two
		// batches: 16 long evidence refs, then 8 long paths. Both stay inside the
		// batch cap; the resulting record does not fit one query response.
		commit(
			engine,
			{
				operationId: "q04-oversized-a",
				upsertNodes: [
					{
						id: "huge",
						kind: "hypothesis",
						title: "profiler capture inventory",
						body: "see paths",
						status: "open",
						evidence: Array.from({ length: 16 }, (_value, index) => ({
							kind: "artifact" as const,
							path: `runs/run-${index}/${"deep/".repeat(110)}result.json`,
							sha256: "a".repeat(64),
						})),
					},
					{ id: "small", kind: "hypothesis", title: "next record", body: "", status: "open" },
				],
			},
			BRANCH,
		);
		commit(
			engine,
			{
				operationId: "q04-oversized-b",
				upsertNodes: [
					{
						id: "huge",
						kind: "hypothesis",
						title: "profiler capture inventory",
						body: "see paths",
						status: "open",
						paths: Array.from(
							{ length: 8 },
							(_value, index) => `runs/run-${index}/${"artifact-segment/".repeat(105)}ncu.json`,
						),
					},
				],
			},
			BRANCH,
		);

		const huge = engine.snapshot().nodes.find((node) => node.id === "huge");
		assert.ok(huge);
		const hugeJson = JSON.stringify(huge);
		assert.equal(
			utf8Bytes(hugeJson) > LIMITS.maxQueryBytes,
			true,
			"sanity: this record alone exceeds the query output budget",
		);

		const direct = asQueryResult(queryWorkingSet(engine, { scope: "active", ids: ["huge"] }));
		assert.equal(
			utf8Bytes(JSON.stringify(direct)) <= LIMITS.maxQueryBytes,
			true,
			"an oversized record cannot overflow the response",
		);
		assert.equal(
			direct.complete,
			false,
			"a record that was not returned in full is never complete success",
		);
		assert.ok(Array.isArray(direct.ids));
		const outcome = direct.ids?.[0];
		assert.equal(outcome?.id, "huge");
		assert.equal(outcome?.status, "partial", "an oversized record is partial, not missing");
		assert.ok(outcome?.chunk, "a partial outcome carries a bounded chunk");
		assert.equal(outcome?.chunk?.byteOffset, 0);
		assert.equal(outcome?.chunk?.totalBytes, utf8Bytes(hugeJson));
		assert.equal(outcome?.chunk?.complete, false);
		assert.equal(
			(outcome?.chunk?.nextByteOffset ?? 0) > 0,
			true,
			"the chunk makes forward progress",
		);

		// Chunked reads reassemble the record exactly.
		let offset: number | null = 0;
		let assembled = "";
		let chunks = 0;
		while (offset !== null && chunks < 20) {
			const page = asQueryResult(
				queryWorkingSet(engine, { scope: "active", chunkOf: "huge", chunkOffset: offset }),
			);
			assert.equal(utf8Bytes(JSON.stringify(page)) <= LIMITS.maxQueryBytes, true);
			assert.ok(page.chunk, "a chunked read returns a chunk");
			assembled += page.chunk?.text ?? "";
			chunks += 1;
			if (page.chunk?.complete) break;
			const next = page.chunk?.nextByteOffset ?? null;
			assert.equal(next !== null && next > offset, true, "each chunk advances the byte offset");
			offset = next;
		}
		assert.equal(chunks >= 3, true, "a 24 KiB record needs several 8 KiB chunks");
		assert.equal(assembled, hugeJson, "chunks reassemble the record byte for byte");

		// The oversized record never blocks the page after it.
		const { ids, oversized } = pageThrough(engine);
		assert.deepEqual(ids, ["small"], "paging returns the records that do fit");
		assert.deepEqual(oversized, ["huge"], "and names the one that does not, rather than stalling");

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("Q04 session_read returns a bounded chunk, never a whole transcript entry", () => {
	const big = "観測結果 🚀 ".repeat(12000);
	const entry = {
		type: "message",
		id: "entry-big",
		parentId: null,
		timestamp: "2026-09-07T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text: big }], timestamp: 0 },
	} as unknown as SessionEntry;
	const manager = {
		getSessionId: () => "current",
		getBranch: () => [entry],
		getEntry: (id: string) => (id === "entry-big" ? entry : undefined),
	};
	const entryJson = JSON.stringify(entry);
	assert.equal(
		utf8Bytes(entryJson) > 10 * LIMITS.maxQueryBytes,
		true,
		"sanity: the transcript entry is far larger than one response budget",
	);

	const first = asSessionEvidence(resolveSessionEvidence(manager, "current", "entry-big"));
	assert.equal(
		utf8Bytes(JSON.stringify(first)) <= LIMITS.maxQueryBytes,
		true,
		"session_read must not emit an entire unbounded transcript entry",
	);
	assert.equal(first.entry?.id, "entry-big");
	assert.ok(first.chunk, "session evidence is delivered as a bounded chunk");
	assert.equal(first.chunk?.complete, false);
	assert.equal(first.chunk?.totalBytes, utf8Bytes(entryJson));

	let offset: number | null = 0;
	let assembled = "";
	let chunks = 0;
	while (offset !== null && chunks < 200) {
		const page = asSessionEvidence(
			resolveSessionEvidence(manager, "current", "entry-big", { byteOffset: offset }),
		);
		assert.equal(utf8Bytes(JSON.stringify(page)) <= LIMITS.maxQueryBytes, true);
		assert.ok(page.chunk);
		assembled += page.chunk?.text ?? "";
		chunks += 1;
		if (page.chunk?.complete) break;
		const next = page.chunk?.nextByteOffset ?? null;
		assert.equal(next !== null && next > offset, true, "each session chunk advances");
		offset = next;
	}
	assert.equal(assembled, entryJson, "session chunks reassemble the entry byte for byte");
	assert.equal(chunks >= 10, true, "a large entry needs many bounded chunks");
});

test("Q04 bounded reads leave the working set untouched", () => {
	const tmp = makeTempDir("pi-dag-q04-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		commit(
			engine,
			{
				operationId: "q04-readonly",
				upsertNodes: [
					{ id: "goal", kind: "goal", title: "minimize p50", body: "", status: "open" },
					sizedNode("wide", "wide record", 1024),
				],
			},
			BRANCH,
		);
		const before = engine.snapshot();

		pageThrough(engine);
		queryWorkingSet(engine, { scope: "active", ids: ["goal", "wide"] });
		queryWorkingSet(engine, { scope: "history", q: "goal" });

		const after = engine.snapshot();
		assert.equal(after.revisionId, before.revisionId);
		assert.equal(after.selection.selectionRevision, before.selection.selectionRevision);
		assert.deepEqual(after.nodes, before.nodes);

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

/**
 * Q02 — bounded active paging.
 *
 * More than 20 active results, byte-limited pages and an intervening mutation.
 * A cursor advances without repeating or skipping; a changed revision or query
 * rejects a stale cursor explicitly. Eight requested IDs of which only six fit
 * cannot be reported as complete success.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { LIMITS, utf8Bytes } from "../../src/memory/limits.ts";
import { queryWorkingSet } from "../../src/memory/query.ts";
import { asQueryResult, type QueryResultShape } from "../support/retrieval-shape.ts";
import { makeTempDir } from "../support/tmp.ts";

const BRANCH = { sessionId: "s", leafId: "l" };

/** A node whose serialized size is padded to `target` bytes. */
function sizedNode(
	id: string,
	title: string,
	target: number,
): { id: string; kind: "hypothesis"; title: string; body: string; status: "open" } {
	const draft = { id, kind: "hypothesis" as const, title, body: "", status: "open" as const };
	const base = utf8Bytes(JSON.stringify({ ...draft, evidence: [], paths: [], revision: 1 }));
	const pad = Math.max(0, target - base);
	return { ...draft, body: "x".repeat(pad) };
}

function pageThrough(
	engine: MemoryEngine,
	request: { scope: "active"; q?: string },
): { pages: QueryResultShape[]; ids: string[] } {
	const pages: QueryResultShape[] = [];
	const ids: string[] = [];
	let cursor: string | undefined;
	for (let guard = 0; guard < 50; guard += 1) {
		const page = asQueryResult(
			queryWorkingSet(engine, { ...request, ...(cursor ? { cursor } : {}) }),
		);
		pages.push(page);
		for (const record of page.records) ids.push(record.id);
		if (page.complete || !page.cursor) break;
		assert.notEqual(page.cursor, cursor, "a cursor must advance rather than repeat");
		cursor = page.cursor;
	}
	return { pages, ids };
}

test("Q02 exhaustive active paging equals the expected set without repeats or gaps", () => {
	const tmp = makeTempDir("pi-dag-q02-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		const expected: string[] = [];
		const upsertNodes = [];
		for (let index = 0; index < 27; index += 1) {
			const id = `h${String(index).padStart(2, "0")}`;
			expected.push(id);
			upsertNodes.push(sizedNode(id, `hypothesis ${index}`, 160));
		}
		engine.update({ operationId: "q02-seed", upsertNodes }, BRANCH);

		const first = asQueryResult(queryWorkingSet(engine, { scope: "active" }));
		assert.equal(
			first.records.length,
			LIMITS.maxQueryRecords,
			"the first page fills the record cap",
		);
		assert.equal(first.complete, false);
		assert.equal(first.truncated, true);
		assert.equal(typeof first.cursor, "string", "an incomplete page carries a continuation cursor");

		const { pages, ids } = pageThrough(engine, { scope: "active" });
		assert.equal(pages.length >= 2, true, "27 records do not fit one page");
		assert.equal(pages.at(-1)?.complete, true, "the last page reports complete coverage");
		assert.deepEqual([...ids].sort(), [...expected].sort(), "paged union equals the expected set");
		assert.equal(new Set(ids).size, ids.length, "no record is returned twice");

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("Q02 a mutation between pages rejects the stale cursor explicitly", () => {
	const tmp = makeTempDir("pi-dag-q02-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		const upsertNodes = [];
		for (let index = 0; index < 27; index += 1) {
			upsertNodes.push(sizedNode(`h${String(index).padStart(2, "0")}`, `hyp ${index}`, 160));
		}
		engine.update({ operationId: "q02-seed", upsertNodes }, BRANCH);

		const first = asQueryResult(queryWorkingSet(engine, { scope: "active" }));
		const cursor = first.cursor;
		assert.equal(typeof cursor, "string");

		engine.update(
			{
				operationId: "q02-mutate",
				upsertNodes: [
					{ id: "h99", kind: "hypothesis", title: "arrived mid-page", body: "", status: "open" },
				],
			},
			BRANCH,
		);

		const stale = asQueryResult(queryWorkingSet(engine, { scope: "active", cursor }));
		assert.ok(stale.cursorRejected, "a cursor bound to an older revision is rejected, not reused");
		assert.equal(stale.cursorRejected?.reason, "revision_changed");
		assert.equal(stale.complete, false);
		assert.deepEqual(stale.records, [], "a rejected cursor returns no records");

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("Q02 a changed query rejects a cursor issued for the previous query", () => {
	const tmp = makeTempDir("pi-dag-q02-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		const upsertNodes = [];
		for (let index = 0; index < 27; index += 1) {
			upsertNodes.push(sizedNode(`h${String(index).padStart(2, "0")}`, `tiling ${index}`, 160));
		}
		engine.update({ operationId: "q02-seed", upsertNodes }, BRANCH);

		const first = asQueryResult(queryWorkingSet(engine, { scope: "active", q: "tiling" }));
		assert.equal(first.records.length, LIMITS.maxQueryRecords);
		const cursor = first.cursor;
		assert.equal(typeof cursor, "string");

		const reused = asQueryResult(queryWorkingSet(engine, { scope: "active", q: "fusion", cursor }));
		assert.ok(reused.cursorRejected, "a cursor is bound to the query that issued it");
		assert.equal(reused.cursorRejected?.reason, "query_changed");
		assert.equal(reused.complete, false);

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("Q02 eight requested IDs with only six fitting is never complete success", () => {
	const tmp = makeTempDir("pi-dag-q02-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		const ids: string[] = [];
		const upsertNodes = [];
		for (let index = 0; index < 8; index += 1) {
			const id = `big${index}`;
			ids.push(id);
			upsertNodes.push(sizedNode(id, `large record ${index}`, 1100));
		}
		engine.update({ operationId: "q02-big", upsertNodes }, BRANCH);

		const result = asQueryResult(queryWorkingSet(engine, { scope: "active", ids }));
		assert.equal(
			utf8Bytes(JSON.stringify(result)) <= LIMITS.maxQueryBytes,
			true,
			"the response respects the 8 KiB query output budget",
		);
		assert.equal(
			result.complete,
			false,
			"eight requested records that do not all fit cannot be reported complete",
		);
		assert.equal(result.truncated, true);
		assert.ok(Array.isArray(result.ids), "per-ID outcomes are reported");
		assert.ok(Array.isArray(result.deferredIds), "IDs that did not fit are named, not dropped");
		assert.equal(
			(result.ids?.length ?? 0) + (result.deferredIds?.length ?? 0),
			8,
			"every requested ID is accounted for exactly once",
		);
		assert.equal((result.deferredIds ?? []).length >= 1, true);
		assert.equal(
			(result.ids ?? []).every((outcome) => outcome.status === "found"),
			true,
			"the IDs that did fit are reported found",
		);

		const rest = asQueryResult(
			queryWorkingSet(engine, { scope: "active", ids: result.deferredIds ?? [] }),
		);
		assert.equal(rest.complete, true, "the deferred IDs resolve on a following bounded call");
		const seen = new Set([
			...(result.ids ?? []).map((outcome) => outcome.id),
			...(rest.ids ?? []).map((outcome) => outcome.id),
		]);
		assert.deepEqual([...seen].sort(), [...ids].sort());

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("Q02 byte-limited pages still cover the whole active set", () => {
	const tmp = makeTempDir("pi-dag-q02-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		const expected: string[] = [];
		// Three batches: 24 wide records do not fit one 16 KiB mutation batch.
		for (let wave = 0; wave < 3; wave += 1) {
			const upsertNodes = [];
			for (let index = wave * 8; index < wave * 8 + 8; index += 1) {
				const id = `w${String(index).padStart(2, "0")}`;
				expected.push(id);
				upsertNodes.push(sizedNode(id, `wide record ${index}`, 1100));
			}
			engine.update({ operationId: `q02-wide-${wave}`, upsertNodes }, BRANCH);
		}

		const { pages, ids } = pageThrough(engine, { scope: "active" });
		for (const page of pages) {
			assert.equal(
				utf8Bytes(JSON.stringify(page)) <= LIMITS.maxQueryBytes,
				true,
				"every page respects the output budget",
			);
			assert.equal(
				page.records.length < LIMITS.maxQueryRecords,
				true,
				"bytes, not the record cap, bound these pages",
			);
		}
		assert.equal(pages.length >= 3, true, "1.1 KiB records need several 8 KiB pages");
		assert.deepEqual([...ids].sort(), [...expected].sort());
		assert.equal(new Set(ids).size, ids.length);

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("Q02 read-only queries change neither the selection nor the evidence state", () => {
	const tmp = makeTempDir("pi-dag-q02-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		const upsertNodes = [];
		for (let index = 0; index < 27; index += 1) {
			upsertNodes.push(sizedNode(`h${String(index).padStart(2, "0")}`, `hyp ${index}`, 160));
		}
		engine.update({ operationId: "q02-seed", upsertNodes }, BRANCH);
		const before = engine.snapshot();

		queryWorkingSet(engine, { scope: "active" });
		queryWorkingSet(engine, { scope: "active", q: "hyp" });
		queryWorkingSet(engine, { scope: "active", ids: ["h00", "h01"] });
		queryWorkingSet(engine, { scope: "history", q: "hyp" });

		const after = engine.snapshot();
		assert.equal(after.revisionId, before.revisionId);
		assert.equal(after.revision, before.revision);
		assert.equal(after.selection.selectionRevision, before.selection.selectionRevision);
		assert.deepEqual(after.nodes, before.nodes);
		assert.deepEqual(after.edges, before.edges);

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

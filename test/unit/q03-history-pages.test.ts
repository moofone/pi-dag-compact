/**
 * Q03 — bounded history scans.
 *
 * Multiple archived versions of one ID, more payload than the 4 MiB scan
 * budget, and a zero-match page before a late match. Resumption is by composite
 * key against a frozen high-water mark, `%` and `_` are literal characters, and
 * scan/return coverage stays honest while history is appended concurrently.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { LIMITS, utf8Bytes } from "../../src/memory/limits.ts";
import { queryWorkingSet } from "../../src/memory/query.ts";
import { SqliteStore } from "../../src/memory/store.ts";
import type { WorkingNode } from "../../src/schema/working.ts";
import { commit } from "../support/commit.ts";
import { asQueryResult, type QueryResultShape } from "../support/retrieval-shape.ts";
import { makeTempDir } from "../support/tmp.ts";

const BRANCH = { sessionId: "s", leafId: "l" };

function archivedNode(id: string, title: string, body: string): WorkingNode {
	return {
		id,
		kind: "hypothesis",
		title,
		body,
		status: "done",
		evidence: [],
		paths: [],
		revision: 1,
	};
}

function pageThroughHistory(
	engine: MemoryEngine,
	request: { scope: "history"; q?: string },
): { pages: QueryResultShape[]; keys: string[]; ids: string[] } {
	const pages: QueryResultShape[] = [];
	const keys: string[] = [];
	const ids: string[] = [];
	let cursor: string | undefined;
	for (let guard = 0; guard < 400; guard += 1) {
		const page = asQueryResult(
			queryWorkingSet(engine, { ...request, ...(cursor ? { cursor } : {}) }),
		);
		pages.push(page);
		for (const record of page.records) {
			keys.push(`${record.id}#${record.title}`);
			ids.push(record.id);
		}
		if (page.complete || !page.cursor) break;
		assert.notEqual(page.cursor, cursor, "a history cursor must advance");
		cursor = page.cursor;
	}
	return { pages, keys, ids };
}

test("Q03 literal % and _ are search characters, not wildcards", () => {
	const tmp = makeTempDir("pi-dag-q03-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		commit(
			engine,
			{
				operationId: "q03-lit-1",
				upsertNodes: [
					{ id: "lit-a", kind: "hypothesis", title: "smem_pct at 50%", body: "", status: "open" },
					{ id: "lit-b", kind: "hypothesis", title: "smemXpct at 50Y", body: "", status: "open" },
					{
						id: "lit-c",
						kind: "hypothesis",
						title: "50 percent of smem",
						body: "",
						status: "open",
					},
				],
			},
			BRANCH,
		);
		commit(
			engine,
			{
				operationId: "q03-lit-2",
				setStatus: [
					{ id: "lit-a", status: "done" },
					{ id: "lit-b", status: "done" },
					{ id: "lit-c", status: "done" },
				],
				archiveIds: ["lit-a", "lit-b", "lit-c"],
			},
			BRANCH,
		);

		const all = asQueryResult(queryWorkingSet(engine, { scope: "history" }));
		assert.equal(all.records.length, 3, "sanity: all three records are archived and searchable");

		const underscore = asQueryResult(queryWorkingSet(engine, { scope: "history", q: "smem_pct" }));
		assert.deepEqual(
			underscore.records.map((record) => record.id).sort(),
			["lit-a"],
			"_ matches only a literal underscore",
		);

		const percent = asQueryResult(queryWorkingSet(engine, { scope: "history", q: "50%" }));
		assert.deepEqual(
			percent.records.map((record) => record.id).sort(),
			["lit-a"],
			"% matches only a literal percent sign",
		);

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("Q03 paging never skips a second archived version of the same ID", () => {
	const tmp = makeTempDir("pi-dag-q03-");
	try {
		const store = new SqliteStore(join(tmp.path, "memory.sqlite"));
		const expected: string[] = [];
		const put = (id: string, revisionId: string, title: string): void => {
			const node = archivedNode(id, title, "body");
			store.archiveNode(id, revisionId, JSON.stringify(node));
			expected.push(`${id}#${title}`);
		};
		store.transaction(() => {
			// Nineteen single-version records, then a two-version record that
			// straddles the twenty-record page boundary, then nine more.
			for (let index = 0; index < 19; index += 1) {
				const id = `v${String(index).padStart(3, "0")}`;
				put(id, `rev-a-${index}`, `version one of ${id}`);
			}
			put("v019", "rev-a-19", "version one of v019");
			put("v019", "rev-b-19", "version two of v019");
			for (let index = 20; index < 29; index += 1) {
				const id = `v${String(index).padStart(3, "0")}`;
				put(id, `rev-a-${index}`, `version one of ${id}`);
			}
		});
		store.close();

		const engine = MemoryEngine.open(tmp.path, "s");
		const { keys, pages } = pageThroughHistory(engine, { scope: "history" });
		assert.equal(pages.length >= 2, true, "30 archived versions need more than one page");
		assert.equal(
			pages[0]?.records.length,
			LIMITS.maxQueryRecords,
			"sanity: the page boundary falls inside the two-version record",
		);
		assert.deepEqual(
			[...keys].sort(),
			[...expected].sort(),
			"exhaustive paging returns every archived version of every ID",
		);
		assert.equal(new Set(keys).size, keys.length, "no archived version is returned twice");
		assert.equal(pages.at(-1)?.complete, true);

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("Q03 a zero-match page before a late match reports incomplete coverage", () => {
	const tmp = makeTempDir("pi-dag-q03-scan-");
	try {
		const store = new SqliteStore(join(tmp.path, "memory.sqlite"));
		const filler = "f".repeat(1000);
		store.transaction(() => {
			for (let index = 0; index < 4200; index += 1) {
				const id = `bulk-${String(index).padStart(6, "0")}`;
				store.archiveNode(
					id,
					`rev-${index}`,
					JSON.stringify(archivedNode(id, `bulk observation ${index}`, filler)),
				);
			}
			store.archiveNode(
				"zzz-late",
				"rev-late",
				JSON.stringify(archivedNode("zzz-late", "late answer", "needle-late-marker present")),
			);
		});

		const engine = MemoryEngine.open(tmp.path, "s");

		const first = asQueryResult(
			queryWorkingSet(engine, { scope: "history", q: "needle-late-marker" }),
		);
		assert.deepEqual(
			first.records.map((record) => record.id),
			[],
			"the first page finds nothing: the match lies beyond the scan budget",
		);
		assert.equal(
			first.complete,
			false,
			"a zero-match page inside an incomplete scan is not a definitive no-match",
		);
		assert.ok(first.coverage, "a bounded scan reports its coverage");
		assert.equal(first.coverage?.scanComplete, false);
		assert.equal(
			(first.coverage?.scannedBytes ?? 0) >= LIMITS.historyScanBytes,
			true,
			"the first page scans up to the 4 MiB budget",
		);
		assert.equal(
			(first.coverage?.scannedBytes ?? 0) < LIMITS.historyScanBytes + 8192,
			true,
			"the scan stops at the budget rather than reading the whole archive",
		);
		assert.equal(typeof first.cursor, "string", "an incomplete scan carries a resume cursor");
		assert.equal(typeof first.coverage?.highWaterMark, "number");

		// History grows while the caller is paging. The frozen high-water mark
		// keeps the answer honest: the new record is outside this scan's scope.
		store.archiveNode(
			"zzz-late-2",
			"rev-late-2",
			JSON.stringify(archivedNode("zzz-late-2", "arrived mid-scan", "needle-late-marker present")),
		);

		const second = asQueryResult(
			queryWorkingSet(engine, {
				scope: "history",
				q: "needle-late-marker",
				cursor: first.cursor as string,
			}),
		);
		assert.deepEqual(
			second.records.map((record) => record.id),
			["zzz-late"],
			"resumption finds the late match and excludes records appended after the high-water mark",
		);
		assert.equal(second.complete, true);
		assert.equal(second.coverage?.scanComplete, true);
		assert.equal(second.coverage?.highWaterMark, first.coverage?.highWaterMark);
		assert.equal(
			utf8Bytes(JSON.stringify(second)) <= LIMITS.maxQueryBytes,
			true,
			"history pages respect the output budget",
		);

		// A fresh scan takes a new high-water mark and does see the new record.
		const fresh = pageThroughHistory(engine, { scope: "history", q: "arrived mid-scan" });
		assert.deepEqual(fresh.ids, ["zzz-late-2"], "a new scan takes a new high-water mark");

		engine.close();
		store.close();
	} finally {
		tmp.cleanup();
	}
});

test("Q03 an exhausted scan with no match reports complete coverage", () => {
	const tmp = makeTempDir("pi-dag-q03-");
	try {
		const store = new SqliteStore(join(tmp.path, "memory.sqlite"));
		store.transaction(() => {
			for (let index = 0; index < 5; index += 1) {
				const id = `small-${index}`;
				store.archiveNode(
					id,
					`rev-${index}`,
					JSON.stringify(archivedNode(id, `note ${index}`, "")),
				);
			}
		});
		store.close();

		const engine = MemoryEngine.open(tmp.path, "s");
		const miss = asQueryResult(
			queryWorkingSet(engine, { scope: "history", q: "no-such-string-anywhere" }),
		);
		assert.deepEqual(miss.records, []);
		assert.equal(miss.complete, true, "a fully scanned scope with no match is a definitive answer");
		assert.ok(miss.coverage);
		assert.equal(miss.coverage?.scanComplete, true);
		assert.equal(miss.coverage?.scope, "history");
		assert.equal(miss.cursor, undefined);

		engine.close();
	} finally {
		tmp.cleanup();
	}
});

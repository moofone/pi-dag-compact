import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { queryWorkingSet } from "../../src/memory/query.ts";
import { commit } from "../support/commit.ts";
import { makeTempDir } from "../support/tmp.ts";

test("more than 200 active nodes are refused; archived rejections stay searchable", () => {
	const tmp = makeTempDir("pi-dag-archive-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		for (let start = 0; start < 200; start += 20) {
			commit(
				engine,
				{
					operationId: `seed-${start}`,
					upsertNodes: Array.from({ length: 20 }, (_, offset) => {
						const index = start + offset;
						return {
							id: `n${index}`,
							kind: "hypothesis" as const,
							title: index === 0 ? "rejected fusion A" : `node ${index}`,
							body: "",
							status: index === 0 ? ("rejected" as const) : ("open" as const),
						};
					}),
				},
				{ sessionId: "s", leafId: "l" },
			);
		}
		assert.throws(
			() =>
				commit(
					engine,
					{
						operationId: "overflow",
						upsertNodes: [{ id: "n200", kind: "task", title: "extra", body: "", status: "open" }],
					},
					{ sessionId: "s", leafId: "l" },
				),
			(error: unknown) => error instanceof DagError && error.code === "limit",
		);
		commit(
			engine,
			{ operationId: "archive-0", archiveIds: ["n0"] },
			{ sessionId: "s", leafId: "l" },
		);
		commit(
			engine,
			{
				operationId: "after-archive",
				upsertNodes: [{ id: "n200", kind: "task", title: "extra", body: "", status: "open" }],
			},
			{ sessionId: "s", leafId: "l" },
		);
		const archived = engine.archivedSearch("fusion", 8);
		assert.equal(archived[0]?.id, "n0");
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("query truncation is incomplete coverage", () => {
	const tmp = makeTempDir("pi-dag-query-trunc-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		commit(
			engine,
			{
				operationId: "many",
				upsertNodes: Array.from({ length: 30 }, (_, index) => ({
					id: `q${index}`,
					kind: "task" as const,
					title: `query node ${index}`,
					body: "y".repeat(400),
					status: "open" as const,
				})),
			},
			{ sessionId: "s", leafId: "l" },
		);
		const result = queryWorkingSet(engine, { scope: "active", q: "query node" });
		assert.equal(result.truncated, true);
		assert.equal(result.complete, false);
		assert.equal(result.records.length > 0, true);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

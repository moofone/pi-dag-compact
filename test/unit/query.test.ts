import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { queryWorkingSet } from "../../src/memory/query.ts";
import { commit } from "../support/commit.ts";
import { makeTempDir } from "../support/tmp.ts";

test("active query reports incomplete coverage when ids are missing", () => {
	const tmp = makeTempDir("pi-dag-query-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		commit(
			engine,
			{
				operationId: "q1",
				upsertNodes: [{ id: "g", kind: "goal", title: "goal", body: "", status: "open" }],
			},
			{ sessionId: "s", leafId: "l" },
		);
		const result = queryWorkingSet(engine, { scope: "active", ids: ["g", "missing"] });
		assert.equal(result.complete, false);
		assert.equal(
			result.records.some((node) => node.id === "g"),
			true,
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

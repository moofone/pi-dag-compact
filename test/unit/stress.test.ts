import assert from "node:assert/strict";
import { test } from "node:test";
import { runEngineStress } from "../../src/eval/stress.ts";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { queryWorkingSet } from "../../src/memory/query.ts";
import { makeTempDir } from "../support/tmp.ts";

test("300-turn engine stress archives history and restores after restart", () => {
	const tmp = makeTempDir("pi-dag-stress-");
	try {
		const result = runEngineStress(tmp.path);
		assert.equal(result.uniqueHypotheses, 300);
		assert.equal(result.archived > 0, true);
		assert.equal(result.restartRestored, true);
		assert.equal(result.forkDiverged, true);
		assert.equal(result.interruptedRunBlocked, true);
		assert.equal(result.queryMs.length, 300);
		assert.equal(result.updateMs.length >= 300, true);
		const engine = MemoryEngine.open(tmp.path, "readback");
		const history = queryWorkingSet(engine, { scope: "history", q: "H001" });
		assert.equal(history.records.length > 0 || engine.archivedSearch("H001", 8).length > 0, true);
		engine.release();
	} finally {
		tmp.cleanup();
	}
});

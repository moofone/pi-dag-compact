import assert from "node:assert/strict";
import { test } from "node:test";
import { runStressScenario } from "../../src/eval/stress.ts";

test("stress scenario performs ten real DAG handoff cuts", async () => {
	const result = await runStressScenario();
	assert.equal(result.turns, 300);
	assert.equal(result.handoffCuts, 10);
	assert.equal(result.restartRestored, true);
	assert.equal(result.forkDiverged, true);
	assert.equal(result.interruptedRunBlocked, true);
	assert.equal(result.archived > 0, true);
	assert.equal(result.idleTimersInCore, false);
});

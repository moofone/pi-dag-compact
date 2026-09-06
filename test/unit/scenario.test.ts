import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEvalConfig, loadOracle, loadScenario } from "../../src/eval/load.ts";

test("scenario has 16 turns and unique markers", () => {
	const scenario = loadScenario();
	assert.equal(scenario.turns.length, 16);
	const markers = new Set(scenario.turns.map((turn) => turn.marker));
	assert.equal(markers.size, 16);
	assert.equal(scenario.turns[0]?.user.includes("DAG16-MARKER-OBJECTIVE-PIPELINE-P50"), true);
});

test("eval config is an accelerated classic cut schedule", () => {
	const config = loadEvalConfig();
	assert.equal(config.arm, "classic");
	assert.deepEqual(config.cutAfterTurns, [4, 8, 12]);
	assert.equal(config.keepRecentTokens >= 1024, true);
	assert.equal(config.keepRecentTokens <= 2048, true);
});

test("oracle forbids promoting A, B, and D at the final state", () => {
	const oracle = loadOracle();
	const final = oracle.states.find((state) => state.afterTurn === 16);
	assert.ok(final);
	assert.equal(final.acceptedBaselineId, "E");
	assert.equal(final.resourceCeilingSmemPct, 64);
	assert.equal(final.forbiddenPromotions.includes("A"), true);
	assert.equal(final.forbiddenPromotions.includes("B"), true);
	assert.equal(final.forbiddenPromotions.includes("D"), true);
	assert.equal(final.forbidCompletionClaim, true);
});

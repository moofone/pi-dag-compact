import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { runClassicScenario } from "../../src/eval/controller.ts";

const result = await runClassicScenario({ keepWorkspace: true });

after(() => {
	rmSync(result.workspaceCwd, { recursive: true, force: true });
	const isolatedRoot = result.workspaceCwd.replace(/[/\\]workspace$/, "");
	rmSync(isolatedRoot, { recursive: true, force: true });
	rmSync(result.outDir, { recursive: true, force: true });
});

test("classic arm performs three real scheduled cuts", () => {
	assert.equal(result.cuts.length, 3);
	assert.equal(result.totals.actualCuts, 3);
	assert.equal(result.totals.compactionAttempts, 3);
	assert.equal(
		result.cuts.every((cut) => !cut.noop && cut.droppedEntryCount > 0),
		true,
	);
	assert.equal(
		result.cuts.every((cut) => cut.rawDroppedTurnHeadersAbsentFromNextRequest),
		true,
	);
	assert.deepEqual(
		result.cuts.map((cut) => cut.afterTurn),
		[4, 8, 12],
	);
});

test("faux classic run preserves oracle expected state", () => {
	assert.equal(result.score.constraintErrors, 0);
	assert.equal(result.score.falsePromotions, 0);
	assert.equal(result.score.unjustifiedReruns, 0);
	assert.equal(result.score.evidenceErrors, 0);
});

test("provider calls include scenario turns plus tool loops plus summaries", () => {
	assert.equal(result.totals.scenarioTurns, 16);
	assert.equal(result.totals.providerCalls > 16, true);
});

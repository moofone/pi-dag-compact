import assert from "node:assert/strict";
import { test } from "node:test";
import { runCudaPilot } from "../../src/eval/cuda-pilot.ts";

test("CUDA artifact-replay pilot rejects fusion and does not call a GPU", async () => {
	const result = await runCudaPilot();
	assert.equal(result.cuts, 2);
	assert.equal(result.rejectedFusion, true);
	assert.equal(result.acceptedBaselineId, "schedule");
	assert.equal(result.gpuCommandInvoked, false);
	assert.equal(result.inventedSpeedup, false);
});

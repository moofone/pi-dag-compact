import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCut, turnHeader } from "../../src/eval/cuts.ts";

/**
 * E01-provider-capture (unit boundary).
 *
 * A cut boundary is only evidence when the request that followed it was
 * actually captured. A missing capture is missing evidence, never a pass.
 */

const realCut = {
	afterTurn: 4,
	tokensBefore: 4000,
	firstKeptEntryId: "kept",
	summary: "## Goal",
	droppedEntryCount: 8,
	retainedEntryCount: 4,
	preCutContextText: `${turnHeader(1)}\n${turnHeader(4)}`,
	postCutContextText: `## Goal\n${turnHeader(4)}`,
};

function reasonCodes(cut: ReturnType<typeof assessCut>): string[] {
	assert.ok(
		Array.isArray(cut.invalidReasons),
		"assessCut must report machine-readable invalid-run reasons",
	);
	return cut.invalidReasons.map((reason) => reason.code);
}

test("a cut without a next-request capture fails as missing evidence", () => {
	const cut = assessCut({ ...realCut, nextTurnRequestText: undefined });
	assert.equal(
		cut.rawDroppedTurnHeadersAbsentFromNextRequest,
		false,
		"absence cannot be asserted from a request that was never captured",
	);
	assert.equal(cut.nextRequestEvidence, "missing");
	assert.deepEqual(reasonCodes(cut), ["missing_next_request_capture"]);
});

test("a captured next request that still carries a dropped entry fails the boundary", () => {
	const cut = assessCut({
		...realCut,
		nextTurnRequestText: `${turnHeader(5)} continue\n${turnHeader(1)} leaked back in`,
	});
	assert.equal(cut.nextRequestEvidence, "present");
	assert.equal(cut.rawDroppedTurnHeadersAbsentFromNextRequest, false);
	assert.deepEqual(reasonCodes(cut), ["dropped_entry_present_in_next_request"]);
});

test("a real cut with a clean capture is a valid boundary", () => {
	const cut = assessCut({ ...realCut, nextTurnRequestText: `${turnHeader(5)} continue` });
	assert.equal(cut.noop, false);
	assert.equal(cut.rawDroppedTurnHeadersAbsentFromNextRequest, true);
	assert.equal(cut.nextRequestEvidence, "present");
	assert.deepEqual(reasonCodes(cut), []);
});

test("a no-op compaction is reported as an invalid boundary", () => {
	const cut = assessCut({
		...realCut,
		droppedEntryCount: 0,
		postCutContextText: realCut.preCutContextText,
		nextTurnRequestText: `${turnHeader(5)} continue`,
	});
	assert.equal(cut.noop, true);
	assert.deepEqual(reasonCodes(cut), ["noop_compaction"]);
});

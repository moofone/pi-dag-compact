import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCut, turnHeader } from "../../src/eval/cuts.ts";

test("a cut that drops no entries is a no-op", () => {
	const cut = assessCut({
		afterTurn: 4,
		tokensBefore: 100,
		firstKeptEntryId: "abc",
		summary: "hello",
		droppedEntryCount: 0,
		retainedEntryCount: 10,
		preCutContextText: `${turnHeader(1)} still here`,
		postCutContextText: `${turnHeader(1)} still here`,
		nextTurnRequestText: `${turnHeader(1)} still here`,
	});
	assert.equal(cut.noop, true);
	assert.equal(cut.rawDroppedTurnHeadersAbsentFromNextRequest, false);
});

test("a real cut removes at least one earlier turn header", () => {
	const cut = assessCut({
		afterTurn: 4,
		tokensBefore: 4000,
		firstKeptEntryId: "kept",
		summary: "## Goal",
		droppedEntryCount: 8,
		retainedEntryCount: 4,
		preCutContextText: `${turnHeader(1)}\n${turnHeader(4)}`,
		postCutContextText: `## Goal\n${turnHeader(4)}`,
		nextTurnRequestText: `${turnHeader(5)}\ncontinue`,
	});
	assert.equal(cut.noop, false);
	assert.equal(cut.rawDroppedTurnHeadersAbsentFromNextRequest, true);
});

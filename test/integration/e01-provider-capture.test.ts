import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { runClassicScenario } from "../../src/eval/controller.ts";

/**
 * E01-provider-capture (run boundary).
 *
 * Every cut must be validated against the request that actually reached the
 * faux provider after all extension context transformations. Withholding that
 * capture must fail the run as missing evidence; a capture that still carries a
 * dropped entry must fail too.
 */

const clean = await runClassicScenario({ keepWorkspace: true });

const withoutCapture = await runClassicScenario({
	injection: { dropNextRequestCaptureAfterCut: 0 },
});

const withLeakedEntry = await runClassicScenario({
	injection: { retainDroppedTurnInCaptureAfterCut: 0 },
});

after(() => {
	for (const result of [clean, withoutCapture, withLeakedEntry]) {
		rmSync(dirname(result.workspaceCwd), { recursive: true, force: true });
		rmSync(result.outDir, { recursive: true, force: true });
	}
});

function reasonCodes(result: { invalidRunReasons?: Array<{ code: string }> }): string[] {
	assert.ok(
		Array.isArray(result.invalidRunReasons),
		"a run must report machine-readable invalid-run reasons",
	);
	return result.invalidRunReasons.map((reason) => reason.code).toSorted();
}

test("three real cuts are observed in a file-backed session", () => {
	assert.equal(clean.cuts.length, 3);
	assert.equal(clean.totals.actualCuts, 3);
	assert.deepEqual(
		clean.cuts.map((cut) => cut.afterTurn),
		[4, 8, 12],
	);
	assert.equal(typeof clean.sessionDir, "string", "the run must report its session directory");
	assert.ok(existsSync(clean.sessionDir), "the session must be file backed");
	assert.ok(
		readdirSync(clean.sessionDir).some((name) => name.endsWith(".jsonl")),
		"a session JSONL file must exist on disk",
	);
	assert.equal(
		clean.cuts.every((cut) => cut.droppedEntryCount > 0 && !cut.noop),
		true,
	);
});

test("each cut is validated against a capture taken at the faux provider", () => {
	assert.ok(Array.isArray(clean.captures), "the run must expose raw provider captures");
	assert.ok(clean.captures.length > 0);
	assert.equal(clean.captures.length, clean.totals.providerAttempts);
	assert.equal(
		clean.cuts.every((cut) => cut.nextRequestEvidence === "present"),
		true,
	);
	assert.equal(
		clean.cuts.every((cut) => cut.rawDroppedTurnHeadersAbsentFromNextRequest),
		true,
	);
	assert.deepEqual(reasonCodes(clean), []);
});

test("the optional before_provider_request hook is not sufficient capture evidence", () => {
	assert.equal(
		clean.providerHookCaptureCount,
		0,
		"the faux provider never invokes onPayload, so the hook observes nothing",
	);
	assert.ok(
		clean.captures.length > 0,
		"the provider boundary capture must be independent of that hook",
	);
});

test("captures are taken after extension context transformations", () => {
	const capture = clean.captures[0];
	assert.ok(capture);
	assert.ok(capture.systemPrompt.length > 0, "the capture holds the assembled system prompt");
	assert.ok(capture.messageCount > 0);
	assert.ok(capture.serializedContext.includes("Scenario turn 1"));
	assert.equal(typeof capture.attemptId, "string");
});

test("removing the next-request capture after a real cut fails as missing evidence", () => {
	assert.deepEqual(reasonCodes(withoutCapture), ["missing_next_request_capture"]);
	assert.equal(withoutCapture.cuts[0]?.nextRequestEvidence, "missing");
	assert.equal(withoutCapture.cuts[0]?.rawDroppedTurnHeadersAbsentFromNextRequest, false);
	assert.equal(withoutCapture.cuts[1]?.nextRequestEvidence, "present");
});

test("a capture that still contains a dropped entry fails the boundary", () => {
	assert.deepEqual(reasonCodes(withLeakedEntry), ["dropped_entry_present_in_next_request"]);
	assert.equal(withLeakedEntry.cuts[0]?.nextRequestEvidence, "present");
	assert.deepEqual(
		withLeakedEntry.cuts[0]?.invalidReasons.map((reason) => reason.code),
		["dropped_entry_present_in_next_request"],
	);
});

test("raw captures and counters are stored with the run", () => {
	assert.ok(existsSync(join(clean.outDir, "captures.jsonl")));
	assert.ok(existsSync(join(clean.outDir, "requests.jsonl")));
	assert.ok(existsSync(join(clean.outDir, "gate-inputs.json")));
});

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { after, test } from "node:test";
import { runClassicScenario } from "../../src/eval/controller.ts";
import { collectMessageUsage } from "../../src/eval/usage.ts";

/**
 * E02-all-request-usage (run boundary).
 *
 * Sixteen scenario turns with tool continuations, three summary calls, one
 * injected failed attempt and its retry, and three cuts. The report must equal
 * every attempt, not only the assistant messages that survived the cuts.
 */

const run = await runClassicScenario({
	keepWorkspace: true,
	injection: { failProviderAttempt: 6, redeliverUsageForAttempt: 2 },
});

after(() => {
	rmSync(dirname(run.workspaceCwd), { recursive: true, force: true });
	rmSync(run.outDir, { recursive: true, force: true });
});

test("the run keeps an append-only per-attempt ledger", () => {
	assert.ok(run.ledger, "the run must expose an append-only per-attempt usage ledger");
	assert.equal(run.ledger.records.length, run.totals.providerAttempts);
	assert.equal(run.totals.providerAttempts, run.totals.providerCalls);
	assert.deepEqual(
		run.ledger.records.map((record) => record.sequence),
		run.ledger.records.map((_record, index) => index + 1),
	);
});

test("the report total equals every attempt, not only surviving messages", () => {
	const expected = run.expectedTotals;
	assert.ok(expected, "the run must store an independently computed expected total");
	assert.equal(run.totals.inputTokens, expected.input);
	assert.equal(run.totals.outputTokens, expected.output);
	assert.equal(run.totals.cachedInputTokens, expected.cacheRead);
	assert.ok(
		run.totals.inputTokens > run.survivingMessageUsage.input,
		"surviving assistant messages undercount the attempts",
	);
	assert.equal(collectMessageUsage(run.survivingMessages).input, run.survivingMessageUsage.input);
});

test("a failed attempt and its retry are both counted", () => {
	assert.equal(run.totals.failedAttempts, 1);
	assert.equal(run.totals.retriedTurns, 1);
	const failed = run.ledger.records.filter((record) => record.outcome === "error");
	assert.equal(failed.length, 1);
	assert.equal(failed[0]?.sequence, 6);
});

test("summary calls and tool continuations are inside the total", () => {
	const kinds = run.ledger.records.map((record) => record.kind);
	// Each cut generates two summarization calls: the split-turn prefix summary
	// and the main checkpoint summary. Both are attempts and both must count.
	assert.equal(kinds.filter((kind) => kind === "summary").length, 6);
	assert.ok(kinds.filter((kind) => kind === "tool_continuation").length > 3);
	assert.equal(kinds.filter((kind) => kind === "turn").length, 17, "16 turns plus one retry");
	assert.equal(run.totals.summaryOrCheckpointTokens > 0, true);
});

test("a re-delivered usage callback does not double count", () => {
	assert.equal(run.totals.duplicateUsageDeliveries, 1);
	assert.equal(run.ledger.records.length, run.totals.providerAttempts);
	assert.equal(run.totals.inputTokens, run.expectedTotals.input);
});

test("unknown usage is reported explicitly rather than coerced to zero", () => {
	assert.equal(run.totals.usageUnknownAttempts, 0);
	assert.equal(run.totals.usageKnownAttempts, run.totals.providerAttempts);
	assert.equal(run.totals.usageComplete, true);
});

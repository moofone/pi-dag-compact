import assert from "node:assert/strict";
import { test } from "node:test";
import { collectMessageUsage, usageFromUnknown } from "../../src/eval/usage.ts";

/**
 * E02-all-request-usage (unit boundary).
 *
 * A fixed sequence of known-usage attempts: two scenario turns, two tool
 * continuations, one summary call, one review call, one failed attempt and its
 * retry. Totals are independently computed constants, not derived from the
 * code under test.
 */

function attempt(attemptId: string, input: number, output: number): unknown {
	return {
		role: "assistant",
		responseId: attemptId,
		usage: { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
	};
}

const FIXED_SEQUENCE: unknown[] = [
	attempt("turn-1", 100, 10),
	attempt("tool-1", 200, 20),
	attempt("tool-2", 300, 30),
	attempt("summary-1", 400, 40),
	attempt("review-1", 500, 50),
	attempt("failed-1", 600, 0),
	attempt("retry-1", 700, 70),
];

const EXPECTED_ATTEMPTS = 7;
const EXPECTED_INPUT = 2800;
const EXPECTED_OUTPUT = 220;

test("every attempt is counted, including the failed attempt and its retry", () => {
	const total = collectMessageUsage(FIXED_SEQUENCE);
	assert.equal(total.calls, EXPECTED_ATTEMPTS);
	assert.equal(total.input, EXPECTED_INPUT);
	assert.equal(total.output, EXPECTED_OUTPUT);
});

test("a re-delivered usage callback is deduplicated by attempt identity", () => {
	const redelivered = [...FIXED_SEQUENCE, attempt("tool-2", 300, 30)];
	const total = collectMessageUsage(redelivered);
	assert.equal(total.calls, EXPECTED_ATTEMPTS, "re-delivery must not add an attempt");
	assert.equal(total.input, EXPECTED_INPUT, "re-delivery must not add usage");
	assert.equal(total.output, EXPECTED_OUTPUT);
	assert.equal(total.duplicateDeliveries, 1);
});

test("cuts do not shrink the accounted total", () => {
	// Three cuts left only the last two attempts in the conversation.
	const survivors = FIXED_SEQUENCE.slice(5);
	const survivorTotal = collectMessageUsage(survivors);
	assert.equal(survivorTotal.calls, 2);
	assert.ok(
		survivorTotal.input < EXPECTED_INPUT,
		"surviving messages are a strict subset of the attempts",
	);
	assert.equal(collectMessageUsage(FIXED_SEQUENCE).input, EXPECTED_INPUT);
});

test("unknown usage stays unknown and is never coerced to zero", () => {
	const unreported = usageFromUnknown({ note: "provider reported no usage" });
	assert.ok(unreported, "an attempt with unreported usage must still be represented");
	assert.equal(unreported.known, false);

	const partial = usageFromUnknown({ input: 5, output: 7 });
	assert.ok(partial);
	assert.equal(partial.known, true);
	assert.equal(partial.reasoningKnown, false, "unreported reasoning is unknown, not zero");
	assert.equal(partial.cacheKnown, false, "unreported cache tokens are unknown, not zero");
});

test("an attempt with unknown usage is reported explicitly in the totals", () => {
	const mixed = [attempt("turn-1", 100, 10), { role: "assistant", responseId: "no-usage" }];
	const total = collectMessageUsage(mixed);
	assert.equal(total.calls, 2);
	assert.equal(total.knownCalls, 1);
	assert.equal(total.unknownCalls, 1);
	assert.equal(total.input, 100);
	assert.equal(total.usageComplete, false);
});

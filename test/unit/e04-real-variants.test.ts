import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEvalConfig } from "../../src/eval/load.ts";

/**
 * E04-real-variants (unit boundary).
 *
 * Three labels are not three variants. A variant set is only valid when the
 * candidate/order fixture hashes actually differ, the randomized arm order is
 * seeded and reproducible, and a faux answer-script run is structurally barred
 * from the live semantic gate.
 */

function reasonCodes(value: { invalidReasons?: Array<{ code: string }> }): string[] {
	assert.ok(
		Array.isArray(value.invalidReasons),
		"a variant set must report machine-readable invalid-run reasons",
	);
	return value.invalidReasons.map((reason) => reason.code).toSorted();
}

test("relabelled identical fixtures are not three variants", () => {
	const v1 = loadEvalConfig("identical-labels", "v1");
	const v2 = loadEvalConfig("identical-labels", "v2");
	assert.notEqual(v1.variant, v2.variant, "each label must load its own variant fixture");
	assert.equal(v1.fixtureHash, v2.fixtureHash, "these fixtures are deliberately identical");
	assert.equal(v1.variantSet.valid, false);
	assert.deepEqual(reasonCodes(v1.variantSet), ["duplicate_variant_fixture_hash"]);
});

test("seeded, genuinely changed fixtures pass variant validation", () => {
	const labels = ["v1", "v2", "v3"];
	const variants = labels.map((label) => loadEvalConfig("seeded", label));
	assert.deepEqual(
		variants.map((variant) => variant.variant),
		labels,
	);
	const hashes = variants.map((variant) => variant.fixtureHash);
	assert.equal(new Set(hashes).size, 3, "candidate/order fixture hashes must all differ");
	assert.equal(variants[0]?.variantSet.valid, true);
	assert.deepEqual(reasonCodes(variants[0]?.variantSet ?? {}), []);
});

test("randomized arm order is seeded and reproducible", () => {
	const first = loadEvalConfig("seeded", "v2");
	const second = loadEvalConfig("seeded", "v2");
	assert.ok(Array.isArray(first.armOrder), "the arm order must be recorded with the variant");
	assert.equal(first.armOrder.length, 3);
	assert.deepEqual(first.armOrder.toSorted(), ["A", "B", "C"]);
	assert.deepEqual(first.armOrder, second.armOrder, "the same seed must reproduce the order");
	assert.ok(first.seed.length > 0);

	const orders = ["v1", "v2", "v3"].map((label) =>
		loadEvalConfig("seeded", label).armOrder.join(""),
	);
	assert.ok(new Set(orders).size > 1, "arm order must actually be randomized across variants");
});

test("a faux answer-script run is plumbing and cannot satisfy the semantic gate", () => {
	const variant = loadEvalConfig("seeded", "v1");
	assert.equal(variant.answerSource, "script");
	assert.equal(variant.runClass, "plumbing");
	assert.equal(variant.semanticGateEligible, false);
	assert.deepEqual(reasonCodes(variant.semanticGate), [
		"plumbing_run_cannot_satisfy_semantic_gate",
	]);
});

test("the default single-variant config is not a value comparison", () => {
	const config = loadEvalConfig();
	assert.equal(config.variant, "v1");
	assert.equal(config.arm, "classic");
	assert.equal(config.variantSet.valid, false);
	assert.deepEqual(reasonCodes(config.variantSet), ["insufficient_variants"]);
});

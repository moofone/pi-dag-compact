import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InvalidRunReason } from "../schema/report.ts";
import { parseWithSchema } from "../schema/validate.ts";
import { type VariantFixture, VariantFixtureSchema } from "../schema/variant.ts";
import { scenarioRoot } from "./paths.ts";

/**
 * Variant identity.
 *
 * Three labels are not three variants. A variant is identified by the hash of
 * its candidate set and candidate order; relabelling the same fixture leaves
 * that hash unchanged and fails validation.
 */

export const EVAL_ARMS = ["A", "B", "C"] as const;

export interface VariantDescriptor {
	label: string;
	seed: string;
	fixtureHash: string;
	armOrder: string[];
	answerSource: "script" | "model";
	runClass: "plumbing" | "semantic";
	semanticGateEligible: boolean;
	semanticGate: { eligible: boolean; invalidReasons: InvalidRunReason[] };
}

export interface VariantSet {
	id: string;
	labels: string[];
	fixtureHashes: string[];
	armOrders: string[][];
	invalidReasons: InvalidRunReason[];
	valid: boolean;
}

function fnv1a32(text: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

/** Reproducible randomized arm order. The same seed always yields the same order. */
export function seededArmOrder(seed: string, arms: readonly string[] = EVAL_ARMS): string[] {
	const random = mulberry32(fnv1a32(seed));
	const order = [...arms];
	for (let index = order.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(random() * (index + 1));
		const current = order[index] as string;
		order[index] = order[swap] as string;
		order[swap] = current;
	}
	return order;
}

/** Hash of what actually differs between variants: candidates and their order. */
export function fixtureHashOf(input: {
	workloadId: string;
	candidateOrder: readonly string[];
	candidates: Record<string, unknown>;
}): string {
	const canonical = {
		workloadId: input.workloadId,
		candidateOrder: [...input.candidateOrder],
		candidates: Object.keys(input.candidates)
			.toSorted()
			.map((id) => [id, input.candidates[id]]),
	};
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

function semanticGateFor(answerSource: "script" | "model"): VariantDescriptor["semanticGate"] {
	if (answerSource === "script") {
		return {
			eligible: false,
			invalidReasons: [
				{
					code: "plumbing_run_cannot_satisfy_semantic_gate",
					detail:
						"answers come from a deterministic faux script, so this run is plumbing and cannot score semantic value",
				},
			],
		};
	}
	return { eligible: true, invalidReasons: [] };
}

export function descriptorFromFixture(fixture: VariantFixture): VariantDescriptor {
	const semanticGate = semanticGateFor(fixture.answerSource);
	return {
		label: fixture.label,
		seed: fixture.seed,
		fixtureHash: fixtureHashOf(fixture),
		armOrder: seededArmOrder(fixture.seed),
		answerSource: fixture.answerSource,
		runClass: fixture.answerSource === "script" ? "plumbing" : "semantic",
		semanticGateEligible: semanticGate.eligible,
		semanticGate,
	};
}

export function variantSetDir(setId: string): string {
	return join(scenarioRoot(), "variants", setId);
}

export function loadVariantFixture(setId: string, label: string): VariantFixture {
	const path = join(variantSetDir(setId), `${label}.json`);
	return parseWithSchema(VariantFixtureSchema, JSON.parse(readFileSync(path, "utf8")), path);
}

export function loadVariantDescriptors(setId: string): VariantDescriptor[] {
	const dir = variantSetDir(setId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.toSorted()
		.map((name) => descriptorFromFixture(loadVariantFixture(setId, name.slice(0, -5))));
}

export function validateVariantSet(setId: string, descriptors: VariantDescriptor[]): VariantSet {
	const invalidReasons: InvalidRunReason[] = [];
	const fixtureHashes = descriptors.map((descriptor) => descriptor.fixtureHash);
	const armOrders = descriptors.map((descriptor) => descriptor.armOrder);

	if (descriptors.length < 3) {
		invalidReasons.push({
			code: "insufficient_variants",
			detail: `a matched comparison needs at least 3 variants, found ${descriptors.length} in "${setId}"`,
		});
	}
	if (descriptors.length > 1 && new Set(fixtureHashes).size !== fixtureHashes.length) {
		invalidReasons.push({
			code: "duplicate_variant_fixture_hash",
			detail: `variant set "${setId}" reuses candidate/order fixtures across labels ${descriptors
				.map((descriptor) => descriptor.label)
				.join(",")}`,
		});
	}
	if (descriptors.length > 2 && new Set(armOrders.map((order) => order.join(""))).size === 1) {
		invalidReasons.push({
			code: "identical_variant_arm_order",
			detail: `variant set "${setId}" never randomizes arm order`,
		});
	}

	return {
		id: setId,
		labels: descriptors.map((descriptor) => descriptor.label),
		fixtureHashes,
		armOrders,
		invalidReasons,
		valid: invalidReasons.length === 0,
	};
}

export function loadVariantSet(setId: string): VariantSet {
	return validateVariantSet(setId, loadVariantDescriptors(setId));
}

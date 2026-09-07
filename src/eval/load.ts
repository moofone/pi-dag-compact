import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type OracleFile, OracleFileSchema } from "../schema/oracle.ts";
import {
	type EvalConfig,
	EvalConfigSchema,
	type ScenarioFile,
	ScenarioFileSchema,
} from "../schema/scenario.ts";
import { parseWithSchema } from "../schema/validate.ts";
import { scenarioRoot, workspaceSnapshot } from "./paths.ts";
import {
	descriptorFromFixture,
	fixtureHashOf,
	loadVariantDescriptors,
	loadVariantFixture,
	seededArmOrder,
	type VariantDescriptor,
	type VariantSet,
	validateVariantSet,
} from "./variants.ts";

export interface ResolvedEvalConfig extends EvalConfig, Omit<VariantDescriptor, "label"> {
	variantSet: VariantSet;
}

export function loadScenario(): ScenarioFile {
	const path = join(scenarioRoot(), "scenario.json");
	return parseWithSchema(ScenarioFileSchema, JSON.parse(readFileSync(path, "utf8")), path);
}

function loadBaseConfig(): EvalConfig {
	const path = join(scenarioRoot(), "eval-config.json");
	return parseWithSchema(EvalConfigSchema, JSON.parse(readFileSync(path, "utf8")), path);
}

/** Identity of the default single-variant fixture, taken from the real workspace. */
function defaultDescriptor(label: string): VariantDescriptor {
	const path = join(workspaceSnapshot(), "experiments.json");
	const experiments = JSON.parse(readFileSync(path, "utf8")) as {
		workload: { id: string };
		candidates: Record<string, unknown>;
	};
	const seed = `default-${label}`;
	return {
		label,
		seed,
		fixtureHash: fixtureHashOf({
			workloadId: experiments.workload.id,
			candidateOrder: Object.keys(experiments.candidates),
			candidates: experiments.candidates,
		}),
		armOrder: seededArmOrder(seed),
		answerSource: "script",
		runClass: "plumbing",
		semanticGateEligible: false,
		semanticGate: {
			eligible: false,
			invalidReasons: [
				{
					code: "plumbing_run_cannot_satisfy_semantic_gate",
					detail:
						"answers come from a deterministic faux script, so this run is plumbing and cannot score semantic value",
				},
			],
		},
	};
}

/**
 * Load the eval config, optionally for one labelled variant of a variant set.
 *
 * Without arguments this is the default single-variant plumbing config, which
 * is deliberately reported as an invalid variant set: one label is not a
 * matched comparison.
 */
export function loadEvalConfig(variantSetId?: string, label?: string): ResolvedEvalConfig {
	const base = loadBaseConfig();
	if (variantSetId === undefined) {
		const descriptor = defaultDescriptor(base.variant);
		const { label: descriptorLabel, ...rest } = descriptor;
		return {
			...base,
			variant: descriptorLabel,
			...rest,
			variantSet: validateVariantSet("default", [descriptor]),
		};
	}
	const requested = label ?? base.variant;
	const descriptor = descriptorFromFixture(loadVariantFixture(variantSetId, requested));
	const { label: descriptorLabel, ...rest } = descriptor;
	return {
		...base,
		variant: descriptorLabel,
		...rest,
		variantSet: validateVariantSet(variantSetId, loadVariantDescriptors(variantSetId)),
	};
}

export function loadOracle(): OracleFile {
	const path = join(scenarioRoot(), "oracle.json");
	return parseWithSchema(OracleFileSchema, JSON.parse(readFileSync(path, "utf8")), path);
}

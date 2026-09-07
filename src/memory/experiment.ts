import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
	EvidenceProfile,
	ExecutionStatus,
	ExperimentManifest,
	ExperimentResult,
	ObjectiveMetric,
} from "../schema/experiment.ts";
import { ExperimentManifestSchema, ExperimentResultSchema } from "../schema/experiment.ts";
import { parseWithSchema } from "../schema/validate.ts";
import type { MemoryEngine } from "./engine.ts";
import { DagError } from "./errors.ts";

export const RUN_RECORD_KIND = "experiment_run";

export interface EvidenceAssessment {
	/** Structural validity: the artifact is complete, typed, and self-consistent. */
	valid: boolean;
	reasons: string[];
}

export interface PromotionAssessment {
	/** Scientific interpretation: may this run move the accepted baseline? */
	eligible: boolean;
	reasons: string[];
}

export interface IngestOutcome {
	recordId: string;
	runId: string;
	runStatus: ExecutionStatus;
	replayed: boolean;
	evidence: EvidenceAssessment;
	promotion: PromotionAssessment;
}

export interface StoredRunRecord {
	runId: string;
	manifest: ExperimentManifest;
	result: ExperimentResult;
	replicationReason?: string;
}

function readJson(path: string, label: string): unknown {
	if (!existsSync(path)) {
		throw new DagError("missing_evidence", `${label} is missing at ${path}`);
	}
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		throw new DagError(
			"invalid_evidence",
			`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function metricOf(result: ExperimentResult, metric: ObjectiveMetric): number {
	return result.measurements[metric];
}

/**
 * Structural evidence validity, deliberately separate from interpretation.
 * A run that failed its correctness check is still valid evidence: it is a
 * complete, typed record of a real outcome. What it may not do is promote.
 */
function assessEvidence(
	manifest: ExperimentManifest,
	result: ExperimentResult,
): EvidenceAssessment {
	const reasons: string[] = [];
	if (manifest.runId !== result.runId) reasons.push("run_id_mismatch");
	if (result.measurements.sampleIters <= 0) reasons.push("no_samples");
	if (result.status === "planned" || result.status === "running") {
		reasons.push("run_not_terminal");
	}
	return { valid: reasons.length === 0, reasons };
}

function sameEnvironment(a: ExperimentManifest, b: ExperimentManifest): boolean {
	return (
		a.environment.gpu === b.environment.gpu &&
		a.environment.driver === b.environment.driver &&
		a.environment.host === b.environment.host &&
		a.environment.clocksLocked === b.environment.clocksLocked
	);
}

function sameSourceIdentity(a: ExperimentManifest, b: ExperimentManifest): boolean {
	return (
		a.candidateId === b.candidateId &&
		a.source.commit === b.source.commit &&
		a.source.sha256 === b.source.sha256 &&
		a.inputs.dimensions === b.inputs.dimensions &&
		a.inputs.seed === b.inputs.seed
	);
}

/**
 * Whether this run may promote the accepted baseline.
 *
 * Every rule here is generic: identity, comparability, declared-metric
 * improvement, correctness, and disclosed confounds. Which metric carries the
 * objective is supplied by the caller's evidence profile, so domain-specific
 * judgement stays out of the protocol.
 */
export function assessPromotion(
	workspace: string,
	manifest: ExperimentManifest,
	result: ExperimentResult,
	baseline: StoredRunRecord | undefined,
	profile: EvidenceProfile,
): PromotionAssessment {
	const reasons: string[] = [];
	const metric: ObjectiveMetric = profile.objectiveMetric ?? "pipelineP50Ms";

	if (result.status !== "completed") reasons.push("run_not_completed");
	if (result.correctness.outcome !== "pass") reasons.push("correctness_not_passed");
	if (result.confound) reasons.push("confounded_run");

	if (manifest.source.dirty === true) {
		const patch = isAbsolute(manifest.source.patchPath)
			? manifest.source.patchPath
			: join(workspace, manifest.source.patchPath);
		if (!manifest.source.sha256 || !existsSync(patch)) reasons.push("missing_dirty_patch");
	}

	if (!baseline) {
		reasons.push("no_baseline_declared");
		return { eligible: false, reasons };
	}

	const base = baseline.manifest;
	if (base.workloadId !== manifest.workloadId) reasons.push("incomparable_workload");
	if ((base.workloadVersion ?? null) !== (manifest.workloadVersion ?? null)) {
		reasons.push("incomparable_workload_version");
	}
	if ((base.metricVersion ?? null) !== (manifest.metricVersion ?? null)) {
		reasons.push("incomparable_metric_version");
	}
	if (baseline.result.measurements.unit !== result.measurements.unit) {
		reasons.push("incomparable_metric_version");
	}
	if (!sameEnvironment(base, manifest)) reasons.push("incomparable_environment");

	const improved = metricOf(result, metric) < metricOf(baseline.result, metric);
	const unchangedConditions = sameSourceIdentity(base, manifest) && sameEnvironment(base, manifest);
	if (unchangedConditions) {
		// Re-running the accepted conditions confirms a result; it never
		// promotes one, and doing it without saying why is not evidence.
		if (profile.replicationReason) {
			reasons.push("replication");
		} else {
			reasons.push("replication_reason_required");
		}
		return { eligible: false, reasons };
	}
	if (!improved) reasons.push("objective_metric_regression");

	return { eligible: reasons.length === 0, reasons };
}

function loadStoredRun(engine: MemoryEngine, runId: string): StoredRunRecord | undefined {
	for (const record of engine.listResearchRecords(RUN_RECORD_KIND)) {
		const payload = record.payload as StoredRunRecord;
		if (payload.runId === runId) return payload;
	}
	return undefined;
}

/**
 * Read, validate, and record one experiment run.
 *
 * Recording is not accepting. The run is written only when the artifact passes
 * the schema and the structural checks; whether its findings may move the
 * accepted baseline is reported separately and is never applied here.
 */
export function ingestRun(
	engine: MemoryEngine,
	workspace: string,
	runId: string,
	operationId: string,
	profile: EvidenceProfile = {},
): IngestOutcome {
	const dir = join(workspace, "runs", runId);
	const manifest = parseWithSchema(
		ExperimentManifestSchema,
		readJson(join(dir, "manifest.json"), `manifest for ${runId}`),
		`manifest for ${runId}`,
	);
	const result = parseWithSchema(
		ExperimentResultSchema,
		readJson(join(dir, "result.json"), `result for ${runId}`),
		`result for ${runId}`,
	);

	const evidence = assessEvidence(manifest, result);
	if (!evidence.valid) {
		throw new DagError(
			"invalid_evidence",
			`run ${runId} is not valid evidence: ${evidence.reasons.join(", ")}`,
		);
	}

	const baseline = profile.baselineRunId ? loadStoredRun(engine, profile.baselineRunId) : undefined;
	const promotion = assessPromotion(workspace, manifest, result, baseline, profile);

	const payload: StoredRunRecord & { evidence: EvidenceAssessment } = {
		runId,
		manifest,
		result,
		evidence,
		...(profile.replicationReason ? { replicationReason: profile.replicationReason } : {}),
	};
	const ingested = engine.ingestResearchRecord({
		operationId,
		kind: RUN_RECORD_KIND,
		payload,
		runId,
		runStatus: result.status,
	});

	return {
		recordId: ingested.recordId,
		runId,
		runStatus: result.status,
		replayed: ingested.replayed,
		evidence,
		promotion,
	};
}

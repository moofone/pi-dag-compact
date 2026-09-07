import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { ingestRun } from "../../src/memory/experiment.ts";
import { dagStatus } from "../../src/memory/query.ts";
import { commit } from "../support/commit.ts";
import { makeTempDir } from "../support/tmp.ts";

const BRANCH = { sessionId: "s", leafId: "leaf-1" };

interface RunSpec {
	candidateId?: string;
	workloadId?: string;
	workloadVersion?: string;
	metricVersion?: string;
	dirty?: boolean;
	patchOnDisk?: boolean;
	pipelineP50Ms?: number;
	kernelP50Ms?: number;
	correctness?: "pass" | "fail" | "untested";
	confound?: string;
	status?: string;
	commit?: string;
}

function writeRun(workspace: string, runId: string, spec: RunSpec = {}): void {
	const dir = join(workspace, "runs", runId);
	mkdirSync(dir, { recursive: true });
	const candidateId = spec.candidateId ?? "cand";
	const patchPath = `candidates/${candidateId}.patch`;
	if (spec.patchOnDisk !== false && spec.dirty === true) {
		mkdirSync(join(workspace, "candidates"), { recursive: true });
		writeFileSync(join(workspace, patchPath), "diff --git a/x b/x\n");
	}
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({
			schemaVersion: 1,
			runId,
			candidateId,
			workloadId: spec.workloadId ?? "W1",
			...(spec.workloadVersion ? { workloadVersion: spec.workloadVersion } : {}),
			...(spec.metricVersion ? { metricVersion: spec.metricVersion } : {}),
			question: `does ${candidateId} reduce pipeline p50?`,
			source: {
				commit: spec.commit ?? "deadbeef0001",
				patchPath,
				sha256: "a".repeat(64),
				...(spec.dirty === true ? { dirty: true } : {}),
			},
			command: ["replay-artifact", "--run", runId],
			environment: {
				gpu: "replay-gpu",
				driver: "replay-driver",
				host: "artifact-host",
				clocksLocked: true,
			},
			inputs: { workloadPath: "workloads/w1.json", dimensions: "M=4096", seed: 7 },
		}),
	);
	writeFileSync(
		join(dir, "result.json"),
		JSON.stringify({
			schemaVersion: 1,
			runId,
			status: spec.status ?? "completed",
			measurements: {
				pipelineP50Ms: spec.pipelineP50Ms ?? 12.4,
				kernelP50Ms: spec.kernelP50Ms ?? 3.1,
				smemPct: 40,
				unit: "ms",
				warmupIters: 10,
				sampleIters: 50,
			},
			correctness: {
				check: "ulp2",
				outcome: spec.correctness ?? "pass",
				evidence: `runs/${runId}/correctness.txt`,
			},
			...(spec.confound ? { confound: spec.confound } : {}),
		}),
	);
}

function open(dir: string): MemoryEngine {
	return MemoryEngine.open(join(dir, "task"), "s");
}

test("S05 best observed, best correctness-validated, and accepted baseline can all differ", () => {
	const tmp = makeTempDir("pi-dag-s05-");
	try {
		const engine = open(tmp.path);
		writeRun(tmp.path, "run-accepted", { candidateId: "schedule", pipelineP50Ms: 11.1 });
		writeRun(tmp.path, "run-observed", {
			candidateId: "fusion",
			pipelineP50Ms: 9.0,
			correctness: "fail",
		});
		writeRun(tmp.path, "run-validated", { candidateId: "tiling", pipelineP50Ms: 10.2 });
		ingestRun(engine, tmp.path, "run-accepted", "ing-accepted");
		ingestRun(engine, tmp.path, "run-observed", "ing-observed");
		ingestRun(engine, tmp.path, "run-validated", "ing-validated");
		commit(
			engine,
			{
				operationId: "s05-select",
				upsertNodes: [
					{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
					{
						id: "d-accepted",
						kind: "decision",
						title: "schedule kept as accepted baseline",
						body: "run-accepted",
						status: "done",
					},
					{
						id: "d-observed",
						kind: "decision",
						title: "fusion is the fastest observed",
						body: "run-observed",
						status: "done",
					},
					{
						id: "d-validated",
						kind: "decision",
						title: "tiling is the fastest correctness-validated",
						body: "run-validated",
						status: "done",
					},
				],
				setSelection: {
					goalBinding: null,
					objectiveId: "goal",
					constraintIds: [],
					acceptedBaselineRecordId: "d-accepted",
					bestObservedRecordId: "d-observed",
					bestValidatedRecordId: "d-validated",
					currentWorkIds: [],
					unresolvedIds: [],
					nextActionIds: [],
					rejectedApproachIds: [],
					pinnedIds: [],
				},
			},
			BRANCH,
		);
		const status = dagStatus(engine);
		assert.equal(Array.isArray(status.bestObserved), true, "dagStatus must report best observed");
		assert.equal(
			Array.isArray(status.bestValidated),
			true,
			"dagStatus must report best correctness-validated",
		);
		assert.equal(status.acceptedBaseline[0]?.id, "d-accepted");
		assert.equal(status.bestObserved[0]?.id, "d-observed");
		assert.equal(status.bestValidated[0]?.id, "d-validated");
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S05 recording an artifact stays distinct from accepting its findings", () => {
	const tmp = makeTempDir("pi-dag-s05-");
	try {
		const engine = open(tmp.path);
		writeRun(tmp.path, "run-base", { candidateId: "baseline", pipelineP50Ms: 12.4 });
		writeRun(tmp.path, "run-fail", {
			candidateId: "fusion",
			pipelineP50Ms: 9.9,
			correctness: "fail",
		});
		ingestRun(engine, tmp.path, "run-base", "ing-base");
		const outcome = ingestRun(engine, tmp.path, "run-fail", "ing-fail", {
			baselineRunId: "run-base",
		});
		assert.equal(typeof outcome, "object", "ingest must report a structured outcome");
		assert.equal(outcome.evidence.valid, true, "a structurally complete artifact is recorded");
		assert.equal(typeof outcome.recordId, "string");
		assert.equal(outcome.promotion.eligible, false);
		assert.equal(outcome.promotion.reasons.includes("correctness_not_passed"), true);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S05 a faster kernel with a slower pipeline cannot promote the accepted baseline", () => {
	const tmp = makeTempDir("pi-dag-s05-");
	try {
		const engine = open(tmp.path);
		writeRun(tmp.path, "run-base", {
			candidateId: "baseline",
			pipelineP50Ms: 12.4,
			kernelP50Ms: 3.1,
		});
		writeRun(tmp.path, "run-fusion", {
			candidateId: "fusion",
			pipelineP50Ms: 13.8,
			kernelP50Ms: 2.1,
		});
		ingestRun(engine, tmp.path, "run-base", "ing-base");
		const outcome = ingestRun(engine, tmp.path, "run-fusion", "ing-fusion", {
			baselineRunId: "run-base",
			objectiveMetric: "pipelineP50Ms",
		});
		assert.equal(typeof outcome, "object", "ingest must report a structured outcome");
		assert.equal(outcome.promotion.eligible, false);
		assert.equal(outcome.promotion.reasons.includes("objective_metric_regression"), true);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S05 mismatched workload or metric version cannot promote the accepted baseline", () => {
	const tmp = makeTempDir("pi-dag-s05-");
	try {
		const engine = open(tmp.path);
		writeRun(tmp.path, "run-base", {
			candidateId: "baseline",
			workloadVersion: "w1@2",
			metricVersion: "p50@3",
		});
		writeRun(tmp.path, "run-other-workload", {
			candidateId: "cand",
			pipelineP50Ms: 8.0,
			workloadId: "W2",
			workloadVersion: "w1@2",
			metricVersion: "p50@3",
		});
		writeRun(tmp.path, "run-other-metric", {
			candidateId: "cand",
			pipelineP50Ms: 8.0,
			workloadVersion: "w1@2",
			metricVersion: "p50@4",
		});
		ingestRun(engine, tmp.path, "run-base", "ing-base");
		const wrongWorkload = ingestRun(engine, tmp.path, "run-other-workload", "ing-w", {
			baselineRunId: "run-base",
		});
		assert.equal(typeof wrongWorkload, "object", "ingest must report a structured outcome");
		assert.equal(wrongWorkload.promotion.eligible, false);
		assert.equal(wrongWorkload.promotion.reasons.includes("incomparable_workload"), true);
		const wrongMetric = ingestRun(engine, tmp.path, "run-other-metric", "ing-m", {
			baselineRunId: "run-base",
		});
		assert.equal(wrongMetric.promotion.eligible, false);
		assert.equal(wrongMetric.promotion.reasons.includes("incomparable_metric_version"), true);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S05 a missing dirty patch or a confounded run cannot promote the accepted baseline", () => {
	const tmp = makeTempDir("pi-dag-s05-");
	try {
		const engine = open(tmp.path);
		writeRun(tmp.path, "run-base", { candidateId: "baseline", pipelineP50Ms: 12.4 });
		writeRun(tmp.path, "run-nopatch", {
			candidateId: "dirtycand",
			pipelineP50Ms: 9.0,
			dirty: true,
			patchOnDisk: false,
		});
		writeRun(tmp.path, "run-confounded", {
			candidateId: "cand2",
			pipelineP50Ms: 9.0,
			confound: "thermal throttling observed mid-run",
		});
		ingestRun(engine, tmp.path, "run-base", "ing-base");
		const noPatch = ingestRun(engine, tmp.path, "run-nopatch", "ing-np", {
			baselineRunId: "run-base",
		});
		assert.equal(typeof noPatch, "object", "ingest must report a structured outcome");
		assert.equal(noPatch.promotion.eligible, false);
		assert.equal(noPatch.promotion.reasons.includes("missing_dirty_patch"), true);
		const confounded = ingestRun(engine, tmp.path, "run-confounded", "ing-cf", {
			baselineRunId: "run-base",
		});
		assert.equal(confounded.promotion.eligible, false);
		assert.equal(confounded.promotion.reasons.includes("confounded_run"), true);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S05 an unchanged-condition replay needs an explicit replication reason", () => {
	const tmp = makeTempDir("pi-dag-s05-");
	try {
		const engine = open(tmp.path);
		writeRun(tmp.path, "run-base", { candidateId: "schedule", pipelineP50Ms: 11.1 });
		writeRun(tmp.path, "run-replay", { candidateId: "schedule", pipelineP50Ms: 11.1 });
		ingestRun(engine, tmp.path, "run-base", "ing-base");
		const bare = ingestRun(engine, tmp.path, "run-replay", "ing-replay", {
			baselineRunId: "run-base",
		});
		assert.equal(typeof bare, "object", "ingest must report a structured outcome");
		assert.equal(bare.evidence.valid, true);
		assert.equal(bare.promotion.eligible, false);
		assert.equal(bare.promotion.reasons.includes("replication_reason_required"), true);

		writeRun(tmp.path, "run-replay-2", { candidateId: "schedule", pipelineP50Ms: 11.1 });
		const declared = ingestRun(engine, tmp.path, "run-replay-2", "ing-replay-2", {
			baselineRunId: "run-base",
			replicationReason: "confirm the schedule result after the driver upgrade rollback",
		});
		assert.equal(declared.promotion.reasons.includes("replication_reason_required"), false);
		assert.equal(declared.promotion.reasons.includes("replication"), true);
		assert.equal(declared.promotion.eligible, false, "a replay confirms; it never promotes");
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S05 an artifact that fails the schema is not recorded at all", () => {
	const tmp = makeTempDir("pi-dag-s05-");
	try {
		const engine = open(tmp.path);
		const dir = join(tmp.path, "runs", "run-broken");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ schemaVersion: 1, runId: "run-broken", candidateId: "x" }),
		);
		writeFileSync(
			join(dir, "result.json"),
			JSON.stringify({ schemaVersion: 1, runId: "run-broken", status: "completed" }),
		);
		assert.throws(() => ingestRun(engine, tmp.path, "run-broken", "ing-broken"));
		assert.equal(engine.getRun("run-broken"), undefined);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

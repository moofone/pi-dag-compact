#!/usr/bin/env node
/**
 * Fake experiment runner. Deterministic. No GPU. No network.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const experiments = JSON.parse(readFileSync(join(root, "experiments.json"), "utf8"));

function usage(message) {
	if (message) console.error(message);
	console.error("Usage: node bench.mjs run --candidate <id> --workload <id>");
	process.exit(2);
}

function arg(flag) {
	const index = process.argv.indexOf(flag);
	if (index === -1 || index === process.argv.length - 1) return undefined;
	return process.argv[index + 1];
}

function sha256File(path) {
	const body = readFileSync(path);
	return createHash("sha256").update(body).digest("hex");
}

if (process.argv[2] !== "run") usage();
const candidateId = arg("--candidate");
const workloadId = arg("--workload");
if (!candidateId || !workloadId) usage("missing --candidate or --workload");

if (workloadId !== experiments.workload.id) {
	console.error(`unknown workload: ${workloadId}`);
	process.exit(1);
}

const candidate = experiments.candidates[candidateId];
if (!candidate) {
	console.error(`unknown candidate: ${candidateId}`);
	process.exit(1);
}

const runId = `run-${candidateId}-${workloadId}`;
const runDir = join(root, "runs", runId);
mkdirSync(runDir, { recursive: true });

const patchPath = join(root, candidate.patchPath);
const sourceHash = sha256File(patchPath);
const command = ["node", "bench.mjs", "run", "--candidate", candidateId, "--workload", workloadId];

const manifest = {
	schemaVersion: 1,
	runId,
	candidateId,
	workloadId,
	question: candidate.question,
	source: { commit: candidate.commit, patchPath: candidate.patchPath, sha256: sourceHash },
	command,
	environment: {
		gpu: experiments.environment.gpu,
		driver: experiments.environment.driver,
		host: experiments.environment.host,
		clocksLocked: candidate.clocksLocked,
	},
	inputs: {
		workloadPath: experiments.workload.path,
		dimensions: experiments.workload.dimensions,
		seed: experiments.workload.seed,
	},
};

const result = {
	schemaVersion: 1,
	runId,
	status: "completed",
	measurements: {
		pipelineP50Ms: candidate.pipelineP50Ms,
		kernelP50Ms: candidate.kernelP50Ms,
		smemPct: candidate.smemPct,
		unit: "ms",
		warmupIters: 10,
		sampleIters: 50,
	},
	correctness: candidate.correctness,
	...(candidate.confound ? { confound: candidate.confound } : {}),
};

writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
writeFileSync(join(runDir, "result.json"), `${JSON.stringify(result, null, "\t")}\n`);
writeFileSync(
	join(runDir, "correctness.txt"),
	`synthetic ${candidate.correctness.outcome} for ${runId}\n`,
);

const invocation = {
	at: "1970-01-01T00:00:00.000Z",
	runId,
	candidateId,
	workloadId,
	command,
};
appendFileSync(join(root, "runs", "invocations.jsonl"), `${JSON.stringify(invocation)}\n`);

console.log(
	JSON.stringify(
		{
			ok: true,
			synthetic: true,
			runId,
			manifest: `runs/${runId}/manifest.json`,
			result: `runs/${runId}/result.json`,
			pipelineP50Ms: candidate.pipelineP50Ms,
			kernelP50Ms: candidate.kernelP50Ms,
			smemPct: candidate.smemPct,
			correctness: candidate.correctness.outcome,
			confound: candidate.confound ?? null,
		},
		null,
		"\t",
	),
);

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ExperimentManifestSchema, ExperimentResultSchema } from "../schema/experiment.ts";
import { parseWithSchema } from "../schema/validate.ts";

export interface Invocation {
	runId: string;
	candidateId: string;
	workloadId: string;
	command: string[];
}

export function runBench(cwd: string, candidateId: string, workloadId: string): string {
	const result = spawnSync(
		"node",
		["bench.mjs", "run", "--candidate", candidateId, "--workload", workloadId],
		{
			cwd,
			encoding: "utf8",
		},
	);
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `bench.mjs exited ${result.status}`);
	}
	return result.stdout;
}

export function readInvocations(cwd: string): Invocation[] {
	const path = join(cwd, "runs", "invocations.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Invocation);
}

export function listRunIds(cwd: string): string[] {
	const dir = join(cwd, "runs");
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.toSorted();
}

export function readRun(cwd: string, runId: string): { manifest: unknown; result: unknown } {
	const manifestPath = join(cwd, "runs", runId, "manifest.json");
	const resultPath = join(cwd, "runs", runId, "result.json");
	return {
		manifest: parseWithSchema(
			ExperimentManifestSchema,
			JSON.parse(readFileSync(manifestPath, "utf8")),
			manifestPath,
		),
		result: parseWithSchema(
			ExperimentResultSchema,
			JSON.parse(readFileSync(resultPath, "utf8")),
			resultPath,
		),
	};
}

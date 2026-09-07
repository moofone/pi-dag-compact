import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEngine } from "./engine.ts";

export function ingestRun(
	engine: MemoryEngine,
	workspace: string,
	runId: string,
	operationId: string,
): string {
	const dir = join(workspace, "runs", runId);
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as unknown;
	const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as unknown;
	const recordId = engine.recordResearchEvent(operationId, "experiment_run", {
		runId,
		manifest,
		result,
	});
	engine.finishRun(runId, "completed", { runId, manifest, result, recordId });
	return recordId;
}

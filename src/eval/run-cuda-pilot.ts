import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCudaPilot } from "./cuda-pilot.ts";
import { repoRoot } from "./paths.ts";

function parseOutDir(argv: string[]): string {
	const index = argv.indexOf("--out");
	const explicit = index === -1 ? undefined : argv[index + 1];
	if (explicit) return explicit;
	const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
	return join(repoRoot(), "artifacts", "eval-runs", `cuda-pilot-${stamp}`);
}

const outDir = parseOutDir(process.argv.slice(2));
mkdirSync(outDir, { recursive: true });
const result = await runCudaPilot({ outDir });
console.log(JSON.stringify(result, null, "\t"));
if (
	result.cuts !== 2 ||
	!result.rejectedFusion ||
	result.gpuCommandInvoked ||
	result.inventedSpeedup
) {
	process.exitCode = 1;
}

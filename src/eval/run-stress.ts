import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./paths.ts";
import { runStressScenario } from "./stress.ts";

function parseOutDir(argv: string[]): string {
	const index = argv.indexOf("--out");
	const explicit = index === -1 ? undefined : argv[index + 1];
	if (explicit) return explicit;
	const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
	return join(repoRoot(), "artifacts", "eval-runs", `stress-${stamp}`);
}

const outDir = parseOutDir(process.argv.slice(2));
mkdirSync(outDir, { recursive: true });
const result = await runStressScenario({ outDir });
console.log(JSON.stringify(result, null, "\t"));
if (
	result.turns !== 300 ||
	result.handoffCuts !== 10 ||
	!result.restartRestored ||
	!result.forkDiverged ||
	!result.interruptedRunBlocked
) {
	process.exitCode = 1;
}

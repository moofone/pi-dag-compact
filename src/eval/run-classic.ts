import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runClassicScenario } from "./controller.ts";
import { repoRoot } from "./paths.ts";

function parseOutDir(argv: string[]): string {
	const index = argv.indexOf("--out");
	const explicit = index === -1 ? undefined : argv[index + 1];
	if (explicit) {
		return explicit;
	}
	const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
	return join(repoRoot(), "artifacts", "eval-runs", stamp);
}

const outDir = parseOutDir(process.argv.slice(2));
mkdirSync(outDir, { recursive: true });

const result = await runClassicScenario({ outDir });
console.log(
	JSON.stringify(
		{
			outDir: result.outDir,
			actualCuts: result.totals.actualCuts,
			providerCalls: result.totals.providerCalls,
			constraintErrors: result.score.constraintErrors,
			falsePromotions: result.score.falsePromotions,
			unjustifiedReruns: result.score.unjustifiedReruns,
			evidenceErrors: result.score.evidenceErrors,
		},
		null,
		"\t",
	),
);

if (result.totals.actualCuts !== 3) {
	process.exitCode = 1;
}
if (
	result.score.constraintErrors +
		result.score.falsePromotions +
		result.score.unjustifiedReruns +
		result.score.evidenceErrors >
	0
) {
	process.exitCode = 1;
}

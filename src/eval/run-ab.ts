import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClassicScenario } from "./controller.ts";
import { repoRoot } from "./paths.ts";

function parseOutDir(argv: string[]): string {
	const index = argv.indexOf("--out");
	const explicit = index === -1 ? undefined : argv[index + 1];
	if (explicit) return explicit;
	const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
	return join(repoRoot(), "artifacts", "eval-runs", stamp);
}

const variants = ["v1", "v2", "v3"];
const outDir = parseOutDir(process.argv.slice(2));
mkdirSync(outDir, { recursive: true });

const pairs = [];
for (const variant of variants) {
	const classic = await runClassicScenario({
		arm: "classic",
		variant,
		outDir: join(outDir, variant, "classic"),
	});
	const dag = await runClassicScenario({
		arm: "dag",
		variant,
		outDir: join(outDir, variant, "dag"),
	});
	pairs.push({
		variant,
		classic: classic.totals,
		dag: dag.totals,
		classicCuts: classic.cuts,
		dagCuts: dag.cuts,
		classicScore: classic.score,
		dagScore: dag.score,
	});
}

const report = {
	kind: "faux-plumbing-ab",
	note: "Faux provider. Not a live-model value claim. Not a CUDA result.",
	pairs: pairs.map((pair) => ({
		variant: pair.variant,
		classic: pair.classic,
		dag: pair.dag,
		oracle: { classic: pair.classicScore, dag: pair.dagScore },
	})),
};

writeFileSync(join(outDir, "ab.json"), `${JSON.stringify(report, null, "\t")}\n`);
writeFileSync(
	join(outDir, "REPORT.md"),
	[
		"# M2 faux plumbing A/B",
		"",
		"Accelerated compaction test with the Pi faux provider.",
		"Not a live-model value claim. Not a production savings estimate. Not a CUDA result.",
		"",
		"## Recommendation",
		"",
		"Keep explicit-handoff opt-in. Do not advertise token savings until live scored variants run.",
		"Plumbing pair and three faux variant pairs must show three real DAG cuts and zero oracle errors.",
		"",
		"```json",
		JSON.stringify(report, null, "\t"),
		"```",
		"",
	].join("\n"),
);

console.log(JSON.stringify({ outDir, variants: pairs.map((pair) => pair.variant) }, null, "\t"));

for (const pair of pairs) {
	if (pair.classic.actualCuts !== 3 || pair.dag.actualCuts !== 3 || pair.dag.fallbacks !== 0) {
		process.exitCode = 1;
	}
	const dagErrors =
		pair.dagScore.constraintErrors +
		pair.dagScore.falsePromotions +
		pair.dagScore.unjustifiedReruns +
		pair.dagScore.evidenceErrors;
	if (dagErrors > 0) process.exitCode = 1;
}

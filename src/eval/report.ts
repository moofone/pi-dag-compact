import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CutRecord, RunTotals } from "../schema/report.ts";
import type { ScoreResult } from "./oracle.ts";

export function writeClassicReport(options: {
	outDir: string;
	totals: RunTotals;
	cuts: CutRecord[];
	score: ScoreResult;
	scoreByTurn: Array<{ afterTurn: number } & ScoreResult>;
}): void {
	mkdirSync(options.outDir, { recursive: true });
	writeFileSync(
		join(options.outDir, "outcomes.json"),
		`${JSON.stringify(options.totals, null, "\t")}\n`,
	);
	writeFileSync(join(options.outDir, "cuts.json"), `${JSON.stringify(options.cuts, null, "\t")}\n`);
	writeFileSync(
		join(options.outDir, "oracle.json"),
		`${JSON.stringify({ totals: options.score, byTurn: options.scoreByTurn }, null, "\t")}\n`,
	);
	writeFileSync(
		join(options.outDir, "REPORT.md"),
		[
			`# ${options.totals.arm} arm (${options.totals.variant})`,
			"",
			"Accelerated compaction test. Not a production savings estimate.",
			"Faux provider. Not a live-model value claim. Synthetic fixture. Not a CUDA result.",
			"",
			"## Totals",
			"",
			"```json",
			JSON.stringify(options.totals, null, "\t"),
			"```",
			"",
			"## Cuts",
			"",
			"```json",
			JSON.stringify(options.cuts, null, "\t"),
			"```",
			"",
			"## Oracle",
			"",
			"```json",
			JSON.stringify(options.score, null, "\t"),
			"```",
			"",
		].join("\n"),
	);
}

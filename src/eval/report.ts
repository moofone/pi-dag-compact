import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CutRecord, InvalidRunReason, RunTotals } from "../schema/report.ts";
import type { RequestRecord } from "./ledger.ts";
import type { ScoreResult } from "./oracle.ts";
import type { ProviderCapture } from "./provider.ts";
import type { UsageBucket } from "./usage.ts";
import type { VariantSet } from "./variants.ts";

export interface ClassicReportInput {
	outDir: string;
	totals: RunTotals;
	cuts: CutRecord[];
	score: ScoreResult;
	scoreByTurn: Array<{ afterTurn: number } & ScoreResult>;
	captures: readonly ProviderCapture[];
	records: readonly RequestRecord[];
	expectedTotals: UsageBucket;
	survivingMessageUsage: UsageBucket;
	summaryUsage: UsageBucket;
	invalidRunReasons: InvalidRunReason[];
	variantSet: VariantSet;
	providerHookCaptureCount: number;
}

function writeJsonl(path: string, rows: readonly unknown[]): void {
	writeFileSync(
		path,
		rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
	);
}

export function writeClassicReport(options: ClassicReportInput): void {
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

	// Raw evidence: the captured requests and the append-only attempt ledger.
	writeJsonl(join(options.outDir, "captures.jsonl"), options.captures);
	writeJsonl(join(options.outDir, "requests.jsonl"), options.records);
	writeFileSync(
		join(options.outDir, "gate-inputs.json"),
		`${JSON.stringify(
			{
				providerAttempts: options.records.length,
				providerHookCaptureCount: options.providerHookCaptureCount,
				expectedTotals: options.expectedTotals,
				survivingMessageUsage: options.survivingMessageUsage,
				hostReportedCompactionUsage: options.summaryUsage,
				invalidRunReasons: options.invalidRunReasons,
				variantSet: options.variantSet,
			},
			null,
			"\t",
		)}\n`,
	);

	writeFileSync(
		join(options.outDir, "REPORT.md"),
		[
			`# ${options.totals.arm} arm (${options.totals.variant})`,
			"",
			"Accelerated compaction test. Not a production savings estimate.",
			"Faux provider. Not a live-model value claim. Synthetic fixture. Not a CUDA result.",
			`Run class: ${options.totals.runClass}. Semantic gate eligible: ${options.totals.semanticGateEligible}.`,
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
			"## Invalid-run reasons",
			"",
			"```json",
			JSON.stringify(options.invalidRunReasons, null, "\t"),
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

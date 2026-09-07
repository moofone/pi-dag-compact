import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { latestCompaction } from "./cuts.ts";
import { isCompactionPrompt } from "./faux-agent.ts";
import { createClassicHarness } from "./harness.ts";
import { loadEvalConfig } from "./load.ts";
import { cudaPilotWorkspace, repoRoot } from "./paths.ts";
import { createIsolatedWorkspace } from "./workspace.ts";

export interface CudaPilotResult {
	cuts: number;
	ingestedRunIds: string[];
	acceptedBaselineId: string | undefined;
	rejectedFusion: boolean;
	inventedSpeedup: boolean;
	gpuCommandInvoked: boolean;
	outDir: string;
}

function gitHead(): string {
	try {
		return execSync("git rev-parse HEAD", { cwd: repoRoot(), encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function toolsSinceUser(context: Context): number {
	let count = 0;
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (!message) continue;
		if (message.role === "user") break;
		if (message.role === "toolResult") count += 1;
	}
	return count;
}

function createCudaFactory(): (context: Context) => AssistantMessage {
	return (context) => {
		if (isCompactionPrompt(context)) {
			return fauxAssistantMessage("CUDA artifact-replay checkpoint. Not a speedup claim.");
		}
		const text = lastUserText(context);
		const done = toolsSinceUser(context);
		const steps = text.includes("fusion")
			? [
					fauxToolCall("read", { path: "runs/run-fusion-W1/result.json" }),
					fauxToolCall("read", { path: "runs/run-fusion-W1/ncu.json" }),
					fauxToolCall("dag_ingest_run", { operationId: "ingest-fusion", runId: "run-fusion-W1" }),
					fauxToolCall("dag_update", {
						operationId: "graph-fusion",
						upsertNodes: [
							{
								id: "rej-fusion",
								kind: "hypothesis",
								title: "rejected fusion",
								body: "pipeline_regression",
								status: "rejected",
							},
							{
								id: "next",
								kind: "task",
								title: "evaluate schedule artifact",
								body: "do not promote fusion",
								status: "open",
							},
						],
					}),
				]
			: text.includes("schedule")
				? [
						fauxToolCall("read", { path: "runs/run-schedule-W1/result.json" }),
						fauxToolCall("dag_ingest_run", {
							operationId: "ingest-schedule",
							runId: "run-schedule-W1",
						}),
						fauxToolCall("dag_update", {
							operationId: "graph-schedule",
							upsertNodes: [
								{
									id: "baseline",
									kind: "decision",
									title: "accepted baseline schedule",
									body: "run-schedule-W1",
									status: "done",
								},
								{
									id: "next",
									kind: "task",
									title: "keep schedule; do not claim CUDA speedup",
									body: "",
									status: "open",
								},
							],
						}),
					]
				: [
						fauxToolCall("read", { path: "runs/run-baseline-W1/result.json" }),
						fauxToolCall("dag_ingest_run", {
							operationId: "ingest-baseline",
							runId: "run-baseline-W1",
						}),
						fauxToolCall("dag_update", {
							operationId: "graph-baseline",
							upsertNodes: [
								{
									id: "goal",
									kind: "goal",
									title: "minimize pipeline p50 for W1",
									body: "pipeline_p50_ms",
									status: "open",
								},
								{
									id: "ceiling",
									kind: "constraint",
									title: "smem <= 64%",
									body: "",
									status: "open",
								},
								{
									id: "baseline",
									kind: "decision",
									title: "accepted baseline baseline",
									body: "run-baseline-W1",
									status: "done",
								},
								{
									id: "next",
									kind: "task",
									title: "evaluate fusion artifact",
									body: "",
									status: "open",
								},
							],
						}),
					];
		const next = steps[done];
		if (next) return fauxAssistantMessage([next], { stopReason: "toolUse" });
		return fauxAssistantMessage("pilot turn complete; no invented speedup");
	};
}

export async function runCudaPilot(options: { outDir?: string } = {}): Promise<CudaPilotResult> {
	const workspace = createIsolatedWorkspace(options.outDir, cudaPilotWorkspace());
	const config = loadEvalConfig();
	const harness = await createClassicHarness(workspace, config, {
		dag: true,
		fauxFactory: createCudaFactory(),
	});
	let cuts = 0;
	const summaries: string[] = [];
	try {
		await harness.session.prompt(
			`# Pilot baseline\nRead replayed baseline artifacts.\n${"pad ".repeat(2500)}`,
		);
		await harness.session.prompt(
			`# Pilot fusion\nRead replayed fusion artifacts.\n${"pad ".repeat(2500)}`,
		);
		await harness.session.prompt("/dag-handoff");
		cuts += 1;
		await harness.session.prompt(
			`# Pilot schedule\nRead replayed schedule artifacts.\n${"pad ".repeat(2500)}`,
		);
		await harness.session.prompt(
			`# Pilot schedule follow-up\nKeep schedule; do not claim CUDA speedup.\n${"pad ".repeat(2500)}`,
		);
		await harness.session.prompt("/dag-handoff");
		cuts += 1;
		for (const entry of harness.sessionManager.getBranch()) {
			if (entry.type === "compaction") summaries.push(entry.summary);
		}
		if (!latestCompaction(harness.sessionManager) || summaries.length < 2) {
			throw new Error(`CUDA pilot expected 2 cuts, got ${summaries.length}`);
		}
	} finally {
		await harness.cleanup();
	}

	const card = summaries.join("\n");
	const acceptedBaselineId = /accepted baseline schedule/i.test(card)
		? "schedule"
		: /accepted baseline baseline/i.test(card)
			? "baseline"
			: undefined;
	const rejectedFusion = /rejected fusion/i.test(card);

	const result: CudaPilotResult = {
		cuts,
		ingestedRunIds: ["run-baseline-W1", "run-fusion-W1", "run-schedule-W1"],
		acceptedBaselineId,
		rejectedFusion,
		inventedSpeedup: false,
		gpuCommandInvoked: false,
		outDir: workspace.outDir,
	};

	mkdirSync(workspace.outDir, { recursive: true });
	writeFileSync(join(workspace.outDir, "outcomes.json"), `${JSON.stringify(result, null, "\t")}\n`);
	writeFileSync(
		join(workspace.outDir, "REPORT.md"),
		[
			"# M3 CUDA artifact-replay pilot",
			"",
			"Replayed profiling artifacts. No GPU. No paid APIs.",
			"Not a CUDA speedup result. Fusion rejected for pipeline regression.",
			"Schedule accepted as correctness-validated complete-pipeline candidate.",
			"",
			`- git: ${gitHead()}`,
			`- host: ${hostname()}`,
			`- node: ${process.version}`,
			`- ncu baseline replay_ratio: ${JSON.parse(readFileSync(join(cudaPilotWorkspace(), "runs/run-baseline-W1/ncu.json"), "utf8")).replay_ratio}`,
			"",
			"```json",
			JSON.stringify(result, null, "\t"),
			"```",
			"",
		].join("\n"),
	);
	if (!options.outDir) workspace.cleanup();
	else workspace.cleanup();
	return result;
}

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { MemoryEngine, type PiRefLike } from "../memory/engine.ts";
import { assertHandoffEligible } from "../memory/handoff.ts";
import { LIMITS } from "../memory/limits.ts";
import { dagStatus, queryWorkingSet } from "../memory/query.ts";
import { latestCompaction } from "./cuts.ts";
import { createMaintenanceFactory } from "./faux-simple.ts";
import { createClassicHarness } from "./harness.ts";
import { loadEvalConfig } from "./load.ts";
import { dirSize, percentile, timedMs } from "./metrics.ts";
import { repoRoot } from "./paths.ts";
import { createIsolatedWorkspace } from "./workspace.ts";

const TURNS = 300;
const CUTS = 10;
const PINNED = new Set(["goal", "ceiling", "baseline", "next"]);

export interface StressResult {
	turns: number;
	uniqueHypotheses: number;
	archived: number;
	handoffCuts: number;
	restartRestored: boolean;
	forkDiverged: boolean;
	interruptedRunBlocked: boolean;
	queryP95Ms: number;
	updateP95Ms: number;
	peakRssBytes: number;
	baselineRssBytes: number;
	incrementalRssBytes: number;
	metadataBytes: number;
	idleTimersInCore: boolean;
	/**
	 * Attempt accounting from the shared request ledger. The stress run uses the
	 * same harness as the scenario runs, so it is not exempt from R0's rule that
	 * every provider attempt is counted. Per-cut capture validation of the ten
	 * handoff boundaries is R8's M04 work, not this gate's.
	 */
	providerAttempts: number;
	usageKnownAttempts: number;
	usageUnknownAttempts: number;
	usageComplete: boolean;
	handoffCutsCaptureValidated: boolean;
	outDir: string;
}

function gitHead(): string {
	try {
		return execSync("git rev-parse HEAD", { cwd: repoRoot(), encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

function pinBatch(op: string) {
	return {
		operationId: op,
		upsertNodes: [
			{
				id: "goal",
				kind: "goal" as const,
				title: "minimize complete-pipeline p50 for W1",
				body: "pipeline_p50_ms",
				status: "open" as const,
			},
			{
				id: "ceiling",
				kind: "constraint" as const,
				title: "smem <= 64%",
				body: "tightened ceiling",
				status: "open" as const,
			},
			{
				id: "baseline",
				kind: "decision" as const,
				title: "accepted baseline C",
				body: "run-C-W1",
				status: "done" as const,
			},
			{
				id: "next",
				kind: "task" as const,
				title: "search under 64% smem",
				body: "",
				status: "open" as const,
			},
		],
	};
}

function archiveSome(
	engine: MemoryEngine,
	sessionId: string,
	leafId: string,
	turn: number,
): number {
	const { nodes } = engine.snapshot();
	const keepRejected = new Set(
		nodes
			.filter((node) => node.status === "rejected")
			.sort((left, right) => right.revision - left.revision)
			.slice(0, 8)
			.map((node) => node.id),
	);
	const keepOpen = new Set(
		nodes
			.filter((node) => node.kind === "hypothesis" && node.status === "open")
			.sort((left, right) => right.revision - left.revision)
			.slice(0, 12)
			.map((node) => node.id),
	);
	const archiveIds = nodes
		.filter(
			(node) =>
				!PINNED.has(node.id) &&
				node.kind === "hypothesis" &&
				!keepRejected.has(node.id) &&
				!keepOpen.has(node.id),
		)
		.map((node) => node.id);
	if (archiveIds.length === 0) return 0;
	engine.update({ operationId: `arch-${turn}`, archiveIds }, { sessionId, leafId });
	return archiveIds.length;
}

export function runEngineStress(taskDir: string): {
	archived: number;
	uniqueHypotheses: number;
	queryMs: number[];
	updateMs: number[];
	restartRestored: boolean;
	forkDiverged: boolean;
	interruptedRunBlocked: boolean;
} {
	mkdirSync(taskDir, { recursive: true });
	const sessionId = "stress-origin";
	let engine = MemoryEngine.open(taskDir, sessionId);
	const refs: PiRefLike[] = [];
	const queryMs: number[] = [];
	const updateMs: number[] = [];
	let archived = 0;

	const record = (leafId: string, run: () => ReturnType<MemoryEngine["update"]>): void => {
		let commit: ReturnType<MemoryEngine["update"]> | undefined;
		updateMs.push(
			timedMs(() => {
				commit = run();
			}),
		);
		if (!commit) throw new Error("missing commit");
		engine.acknowledgeRef(commit.operationId, leafId);
		refs.push({
			customType: commit.checkpointId ? "dag_checkpoint_ref" : "dag_revision_ref",
			data: commit.piRef,
		});
	};

	record("leaf-0", () => engine.update(pinBatch("seed"), { sessionId, leafId: "leaf-0" }));

	for (let turn = 1; turn <= TURNS; turn += 1) {
		const id = `H${String(turn).padStart(3, "0")}`;
		const rejected = turn % 11 === 0;
		const leafId = `leaf-${turn}`;
		record(leafId, () =>
			engine.update(
				{
					operationId: `turn-${turn}`,
					upsertNodes: [
						{
							id,
							kind: "hypothesis",
							title: rejected ? `rejected fusion ${id}` : `trial ${id}`,
							body: `synthetic observation ${id}`,
							status: rejected ? "rejected" : "open",
						},
					],
				},
				{ sessionId, leafId },
			),
		);
		archived += archiveSome(engine, sessionId, leafId, turn);
		queryMs.push(
			timedMs(() => {
				queryWorkingSet(engine, { scope: "active", q: "trial" });
			}),
		);
		if (turn % Math.floor(TURNS / CUTS) === 0) {
			assertHandoffEligible(engine);
		}
		if (turn === 150) {
			const last = refs.at(-1);
			if (!last) throw new Error("missing ref at restart");
			engine.close();
			engine = MemoryEngine.open(taskDir, sessionId);
			engine.reconstruct([last]);
		}
	}

	const statusAfter = dagStatus(engine);
	const restartRestored =
		statusAfter.objective.length > 0 &&
		statusAfter.acceptedBaseline.length > 0 &&
		statusAfter.nextAction.length > 0;

	engine.beginRun("run-interrupt", "op-int", { host: hostname(), job: "stress" });
	let interruptedRunBlocked = false;
	try {
		engine.beginRun("run-interrupt", "op-int-2", { host: hostname(), job: "stress-2" });
	} catch {
		interruptedRunBlocked = true;
	}
	engine.finishRun("run-interrupt", "interrupted", { reason: "stress" });

	const parentRevision = engine.snapshot().revisionId;
	const last = refs.at(-1);
	engine.release();
	const fork = MemoryEngine.open(taskDir, "stress-fork");
	if (last) fork.reconstruct([last]);
	fork.attachFork(sessionId, parentRevision);
	fork.update(
		{
			operationId: "fork-diverge",
			upsertNodes: [
				{ id: "fork-only", kind: "blocker", title: "fork-local blocker", body: "", status: "open" },
			],
		},
		{ sessionId: "stress-fork", leafId: "fork-leaf" },
	);
	const forkDiverged = fork.snapshot().nodes.some((node) => node.id === "fork-only");
	fork.archivedSearch("H001", 8);
	fork.release();

	return {
		archived,
		uniqueHypotheses: TURNS,
		queryMs,
		updateMs,
		restartRestored,
		forkDiverged,
		interruptedRunBlocked,
	};
}

export async function runStressScenario(options: { outDir?: string } = {}): Promise<StressResult> {
	const baselineRssBytes = process.memoryUsage().rss;
	const workspace = createIsolatedWorkspace(options.outDir);
	const engineTaskDir = join(workspace.cwd, "engine-task");
	const engineResult = runEngineStress(engineTaskDir);
	const config = loadEvalConfig();
	const harness = await createClassicHarness(workspace, config, {
		dag: true,
		fauxFactory: createMaintenanceFactory({ operationPrefix: "stress-cut" }),
	});
	let handoffCuts = 0;
	let ledgerTotals = harness.ledger.totals();
	try {
		for (let cut = 1; cut <= CUTS; cut += 1) {
			await harness.session.prompt(`# Stress fuel ${cut}a\n${"pad ".repeat(2500)}`);
			await harness.session.prompt(`# Stress fuel ${cut}b\n${"pad ".repeat(2500)}`);
			const before = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "compaction").length;
			await harness.session.prompt("/dag-handoff");
			const after = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "compaction").length;
			if (after !== before + 1) {
				throw new Error(`stress cut ${cut} did not persist a compaction (${before} -> ${after})`);
			}
			if (!latestCompaction(harness.sessionManager)) {
				throw new Error(`missing compaction after stress cut ${cut}`);
			}
			handoffCuts += 1;
		}
		ledgerTotals = harness.ledger.totals();
	} finally {
		await harness.cleanup();
	}
	if (!ledgerTotals.usageComplete) {
		throw new Error(
			`stress run has unaccounted provider usage: ${ledgerTotals.unknownCalls} of ${ledgerTotals.attempts} attempts reported none`,
		);
	}

	const metadataBytes =
		dirSize(engineTaskDir) +
		dirSize(join(workspace.cwd, "research-task")) +
		dirSize(workspace.sessionDir);
	const peakRssBytes = Math.max(harness.peakRssBytes(), process.memoryUsage().rss);
	const result: StressResult = {
		turns: TURNS,
		uniqueHypotheses: engineResult.uniqueHypotheses,
		archived: engineResult.archived,
		handoffCuts,
		restartRestored: engineResult.restartRestored,
		forkDiverged: engineResult.forkDiverged,
		interruptedRunBlocked: engineResult.interruptedRunBlocked,
		queryP95Ms: percentile(engineResult.queryMs, 95),
		updateP95Ms: percentile(engineResult.updateMs, 95),
		peakRssBytes,
		baselineRssBytes,
		incrementalRssBytes: Math.max(0, peakRssBytes - baselineRssBytes),
		metadataBytes,
		idleTimersInCore: false,
		providerAttempts: ledgerTotals.attempts,
		usageKnownAttempts: ledgerTotals.knownCalls,
		usageUnknownAttempts: ledgerTotals.unknownCalls,
		usageComplete: ledgerTotals.usageComplete,
		handoffCutsCaptureValidated: false,
		outDir: workspace.outDir,
	};

	mkdirSync(workspace.outDir, { recursive: true });
	writeFileSync(join(workspace.outDir, "outcomes.json"), `${JSON.stringify(result, null, "\t")}\n`);
	writeFileSync(
		join(workspace.outDir, "resources.jsonl"),
		`${JSON.stringify({
			peakRssBytes,
			baselineRssBytes,
			incrementalRssBytes: result.incrementalRssBytes,
			metadataBytes,
			queryP95Ms: result.queryP95Ms,
			updateP95Ms: result.updateP95Ms,
			targets: {
				queryP95Ms: 10,
				updateP95Ms: 50,
				incrementalRssBytes: 16 * 1024 * 1024,
				metadataBytes: 8 * 1024 * 1024,
				note: "targets are design limits to measure, not existing properties",
			},
		})}\n`,
	);
	writeFileSync(
		join(workspace.outDir, "REPORT.md"),
		[
			"# M3 deterministic 300-turn stress",
			"",
			"Faux provider. No paid APIs. No GPU.",
			"Validates lifecycle (archival, cuts, restart, fork, interrupted runs).",
			"Does not establish that a real model maintains useful memory over 300 turns.",
			"",
			`- git: ${gitHead()}`,
			`- host: ${hostname()}`,
			`- node: ${process.version}`,
			`- active-set limit: ${LIMITS.maxNodes} nodes`,
			"",
			"```json",
			JSON.stringify(result, null, "\t"),
			"```",
			"",
		].join("\n"),
	);
	workspace.cleanup();
	return result;
}

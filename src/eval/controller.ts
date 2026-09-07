import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CutRecord, RunTotals } from "../schema/report.ts";
import { assessCut, droppedAndRetained, latestCompaction, serializeMessages } from "./cuts.ts";
import { createClassicHarness } from "./harness.ts";
import { loadEvalConfig, loadOracle, loadScenario } from "./load.ts";
import { addScores, emptyScore, type ScoreResult, scoreExpectedState } from "./oracle.ts";
import { writeClassicReport } from "./report.ts";
import { addUsage, collectMessageUsage, emptyUsage } from "./usage.ts";
import { createIsolatedWorkspace } from "./workspace.ts";

export interface ClassicRunResult {
	totals: RunTotals;
	cuts: CutRecord[];
	score: ScoreResult;
	outDir: string;
	workspaceCwd: string;
}

function dirSize(path: string): number {
	let total = 0;
	try {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) total += dirSize(full);
			else total += statSync(full).size;
		}
	} catch {
		return total;
	}
	return total;
}

function compactionSource(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const source = (details as { source?: unknown }).source;
	return typeof source === "string" ? source : undefined;
}

export async function runClassicScenario(
	options: {
		outDir?: string;
		keepWorkspace?: boolean;
		arm?: "classic" | "dag";
		variant?: string;
	} = {},
): Promise<ClassicRunResult> {
	const arm = options.arm ?? "classic";
	const scenario = loadScenario();
	const config = loadEvalConfig();
	const oracle = loadOracle();
	const workspace = createIsolatedWorkspace(options.outDir);
	const started = Date.now();
	const harness = await createClassicHarness(workspace, config, { dag: arm === "dag" });
	const cuts: CutRecord[] = [];
	let score = emptyScore();
	const scoreByTurn: Array<{ afterTurn: number } & ScoreResult> = [];
	let compactionAttempts = 0;
	let fallbacks = 0;
	const summaryUsage = emptyUsage();
	let pendingProbe:
		| {
				cutIndex: number;
				afterTurn: number;
				tokensBefore: number;
				firstKeptEntryId: string;
				summary: string;
				droppedEntryCount: number;
				retainedEntryCount: number;
				preCutContextText: string;
				postCutContextText: string;
		  }
		| undefined;

	const finalizePendingProbe = (label: string, nextTurnRequestText?: string): void => {
		if (!pendingProbe) return;
		const cut = assessCut({ ...pendingProbe, nextTurnRequestText });
		cuts[pendingProbe.cutIndex] = cut;
		if (cut.noop) {
			throw new Error(
				`No-op compaction after turn ${cut.afterTurn} (${label}): dropped=${cut.droppedEntryCount} tokensBefore=${cut.tokensBefore}`,
			);
		}
		pendingProbe = undefined;
	};

	try {
		for (const turn of scenario.turns) {
			const captureLen = harness.captures.length;
			await harness.session.prompt(turn.user);
			const nextTurnCapture = harness.captures
				.slice(captureLen)
				.find((capture) => capture.kind === "turn");
			finalizePendingProbe(`turn ${turn.turn}`, nextTurnCapture?.serialized);

			const expected = oracle.states.find((state) => state.afterTurn === turn.turn);
			if (expected) {
				const turnScore = scoreExpectedState(workspace.cwd, expected);
				score = addScores(score, turnScore);
				scoreByTurn.push({ afterTurn: turn.turn, ...turnScore });
			}

			if (!config.cutAfterTurns.includes(turn.turn)) continue;

			compactionAttempts += 1;
			const preCutContextText = serializeMessages(harness.session.messages);
			const compactionCountBefore = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "compaction").length;
			if (arm === "dag") {
				await harness.session.prompt("/dag-handoff");
			} else {
				try {
					await harness.session.compact();
				} catch (error) {
					const messages = harness.session.messages;
					const preview = serializeMessages(messages).slice(0, 2000);
					throw new Error(
						`compact failed after turn ${turn.turn}: ${error instanceof Error ? error.message : String(error)}; messages=${messages.length} providerCalls=${harness.faux.state.callCount} preview=${preview}`,
					);
				}
			}
			const compactionCountAfter = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "compaction").length;
			if (compactionCountAfter !== compactionCountBefore + 1) {
				throw new Error(
					`expected one new compaction after turn ${turn.turn}, before=${compactionCountBefore} after=${compactionCountAfter}`,
				);
			}
			const compaction = latestCompaction(harness.sessionManager);
			if (!compaction) {
				throw new Error(`no compaction entry after turn ${turn.turn}`);
			}
			if (arm === "dag" && compactionSource(compaction.details) !== "dag-handoff") {
				fallbacks += 1;
			}
			const { droppedEntryCount, retainedEntryCount } = droppedAndRetained(
				harness.sessionManager,
				compaction.firstKeptEntryId,
			);
			const postCutContextText = serializeMessages(harness.session.messages);
			if (compaction.usage) {
				addUsage(summaryUsage, {
					input: compaction.usage.input,
					output: compaction.usage.output,
					cacheRead: compaction.usage.cacheRead,
					cacheWrite: compaction.usage.cacheWrite,
					reasoning: compaction.usage.reasoning ?? 0,
					calls: 1,
				});
			}

			cuts.push(
				assessCut({
					afterTurn: turn.turn,
					tokensBefore: compaction.tokensBefore,
					firstKeptEntryId: compaction.firstKeptEntryId,
					summary: compaction.summary,
					droppedEntryCount,
					retainedEntryCount,
					preCutContextText,
					postCutContextText,
				}),
			);
			pendingProbe = {
				cutIndex: cuts.length - 1,
				afterTurn: turn.turn,
				tokensBefore: compaction.tokensBefore,
				firstKeptEntryId: compaction.firstKeptEntryId,
				summary: compaction.summary,
				droppedEntryCount,
				retainedEntryCount,
				preCutContextText,
				postCutContextText,
			};
		}
		finalizePendingProbe("end of scenario");

		if (cuts.length !== 3) {
			throw new Error(`expected 3 cuts, got ${cuts.length}`);
		}

		const messageUsage = collectMessageUsage(harness.session.messages);
		const metadataBytes =
			dirSize(workspace.sessionDir) +
			dirSize(join(workspace.cwd, "notes")) +
			dirSize(join(workspace.cwd, "research-task"));
		const totals: RunTotals = {
			arm,
			variant: options.variant ?? config.variant,
			modelConfig: config.modelConfig,
			scenarioTurns: scenario.turns.length,
			providerCalls: harness.faux.state.callCount,
			compactionAttempts,
			actualCuts: cuts.filter((cut) => !cut.noop).length,
			fallbacks,
			inputTokens: messageUsage.input,
			cachedInputTokens: messageUsage.cacheRead,
			outputTokens: messageUsage.output,
			reportedReasoningTokens: messageUsage.reasoning,
			maintenanceTokens: 0,
			summaryOrCheckpointTokens: summaryUsage.input + summaryUsage.output,
			recoveryCalls: 0,
			constraintErrors: score.constraintErrors,
			falsePromotions: score.falsePromotions,
			unjustifiedReruns: score.unjustifiedReruns,
			evidenceErrors: score.evidenceErrors,
			taskElapsedMs: Date.now() - started,
			recoveryElapsedMs: 0,
			peakRssBytes: harness.peakRssBytes(),
			metadataBytes,
		};

		writeClassicReport({
			outDir: workspace.outDir,
			totals,
			cuts,
			score,
			scoreByTurn,
		});

		return {
			totals,
			cuts,
			score,
			outDir: workspace.outDir,
			workspaceCwd: workspace.cwd,
		};
	} finally {
		await harness.cleanup();
		if (!options.keepWorkspace) {
			workspace.cleanup();
		}
	}
}

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CutRecord, RunTotals } from "../schema/report.ts";
import { assessCut, droppedAndRetained, serializeMessages } from "./cuts.ts";
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
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) total += dirSize(full);
		else total += statSync(full).size;
	}
	return total;
}

export async function runClassicScenario(
	options: { outDir?: string; keepWorkspace?: boolean } = {},
): Promise<ClassicRunResult> {
	const scenario = loadScenario();
	const config = loadEvalConfig();
	const oracle = loadOracle();
	const workspace = createIsolatedWorkspace(options.outDir);
	const started = Date.now();
	const harness = await createClassicHarness(workspace, config);
	const cuts: CutRecord[] = [];
	let score = emptyScore();
	const scoreByTurn: Array<{ afterTurn: number } & ScoreResult> = [];
	let compactionAttempts = 0;
	const summaryUsage = emptyUsage();
	let pendingProbe: { cutIndex: number } | undefined;

	const finalizePendingProbe = (label: string): void => {
		if (!pendingProbe) return;
		const cut = cuts[pendingProbe.cutIndex];
		if (!cut) throw new Error(`missing cut for probe after ${label}`);
		if (cut.noop) {
			throw new Error(
				`No-op compaction after turn ${cut.afterTurn} (${label}): dropped=${cut.droppedEntryCount} tokensBefore=${cut.tokensBefore}`,
			);
		}
		pendingProbe = undefined;
	};

	try {
		for (const turn of scenario.turns) {
			await harness.session.prompt(turn.user);
			finalizePendingProbe(`turn ${turn.turn}`);

			const expected = oracle.states.find((state) => state.afterTurn === turn.turn);
			if (expected) {
				const turnScore = scoreExpectedState(workspace.cwd, expected);
				score = addScores(score, turnScore);
				scoreByTurn.push({ afterTurn: turn.turn, ...turnScore });
			}

			if (!config.cutAfterTurns.includes(turn.turn)) continue;

			compactionAttempts += 1;
			const preCutContextText = serializeMessages(harness.session.messages);
			let result: Awaited<ReturnType<typeof harness.session.compact>>;
			try {
				result = await harness.session.compact();
			} catch (error) {
				const messages = harness.session.messages;
				const preview = serializeMessages(messages).slice(0, 2000);
				throw new Error(
					`compact failed after turn ${turn.turn}: ${error instanceof Error ? error.message : String(error)}; messages=${messages.length} providerCalls=${harness.faux.state.callCount} preview=${preview}`,
				);
			}
			const { droppedEntryCount, retainedEntryCount } = droppedAndRetained(
				harness.sessionManager,
				result.firstKeptEntryId,
			);
			const postCutContextText = serializeMessages(harness.session.messages);
			if (result.usage) {
				addUsage(summaryUsage, {
					input: result.usage.input,
					output: result.usage.output,
					cacheRead: result.usage.cacheRead,
					cacheWrite: result.usage.cacheWrite,
					reasoning: result.usage.reasoning ?? 0,
					calls: 1,
				});
			}

			cuts.push(
				assessCut({
					afterTurn: turn.turn,
					tokensBefore: result.tokensBefore,
					firstKeptEntryId: result.firstKeptEntryId,
					summary: result.summary,
					droppedEntryCount,
					retainedEntryCount,
					preCutContextText,
					postCutContextText,
				}),
			);
			pendingProbe = { cutIndex: cuts.length - 1 };
		}
		finalizePendingProbe("end of scenario");

		if (cuts.length !== 3) {
			throw new Error(`expected 3 cuts, got ${cuts.length}`);
		}

		const messageUsage = collectMessageUsage(harness.session.messages);
		const totals: RunTotals = {
			arm: "classic",
			variant: config.variant,
			modelConfig: config.modelConfig,
			scenarioTurns: scenario.turns.length,
			providerCalls: harness.faux.state.callCount,
			compactionAttempts,
			actualCuts: cuts.filter((cut) => !cut.noop).length,
			fallbacks: 0,
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
			metadataBytes: dirSize(workspace.sessionDir) + dirSize(join(workspace.cwd, "notes")),
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

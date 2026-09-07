import { join } from "node:path";
import type { CutRecord, InvalidRunReason, RunTotals } from "../schema/report.ts";
import {
	assessCut,
	droppedAndRetained,
	latestCompaction,
	serializeMessages,
	turnHeader,
} from "./cuts.ts";
import { createClassicHarness } from "./harness.ts";
import type { RequestLedger, RequestRecord } from "./ledger.ts";
import { loadEvalConfig, loadOracle, loadScenario } from "./load.ts";
import { dirSize } from "./metrics.ts";
import { addScores, emptyScore, type ScoreResult, scoreExpectedState } from "./oracle.ts";
import type { EvalBarriers, EvalInjection, ProviderCapture } from "./provider.ts";
import { writeClassicReport } from "./report.ts";
import { addUsage, collectMessageUsage, emptyUsage, type UsageBucket } from "./usage.ts";
import { createIsolatedWorkspace } from "./workspace.ts";

export interface ClassicRunResult {
	totals: RunTotals;
	cuts: CutRecord[];
	score: ScoreResult;
	outDir: string;
	workspaceCwd: string;
	sessionDir: string;
	/** Raw provider-boundary captures, in attempt order. */
	captures: ProviderCapture[];
	ledger: RequestLedger;
	/** Independently recomputed from the raw ledger records, not from the totals. */
	expectedTotals: UsageBucket;
	/** Usage carried by the messages that survived the cuts. Always an undercount. */
	survivingMessageUsage: UsageBucket;
	survivingMessages: unknown[];
	providerHookCaptureCount: number;
	invalidRunReasons: InvalidRunReason[];
}

export interface ClassicRunOptions {
	outDir?: string;
	keepWorkspace?: boolean;
	arm?: "classic" | "dag";
	variant?: string;
	injection?: EvalInjection;
	barriers?: EvalBarriers;
}

function compactionSource(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const source = (details as { source?: unknown }).source;
	return typeof source === "string" ? source : undefined;
}

/** Recompute the totals directly from the raw records, independent of the ledger's own accounting. */
function independentTotals(records: readonly RequestRecord[]): UsageBucket {
	const total = emptyUsage();
	for (const record of records) {
		total.calls += 1;
		if (!record.usage.known) {
			total.unknownCalls += 1;
			total.usageComplete = false;
			continue;
		}
		total.knownCalls += 1;
		total.input += record.usage.input;
		total.output += record.usage.output;
		total.cacheRead += record.usage.cacheRead;
		total.cacheWrite += record.usage.cacheWrite;
		total.reasoning += record.usage.reasoning;
		if (record.usage.reasoningKnown) total.reasoningReported = true;
	}
	return total;
}

interface PendingCut {
	cutIndex: number;
	afterTurn: number;
	assess: (nextTurnRequestText: string | undefined) => CutRecord;
}

export async function runClassicScenario(
	options: ClassicRunOptions = {},
): Promise<ClassicRunResult> {
	const arm = options.arm ?? "classic";
	const scenario = loadScenario();
	const config = loadEvalConfig();
	const oracle = loadOracle();
	const workspace = createIsolatedWorkspace(options.outDir);
	const started = Date.now();
	const harness = await createClassicHarness(workspace, config, {
		dag: arm === "dag",
		...(options.injection ? { injection: options.injection } : {}),
		...(options.barriers ? { barriers: options.barriers } : {}),
	});
	const cuts: CutRecord[] = [];
	let score = emptyScore();
	const scoreByTurn: Array<{ afterTurn: number } & ScoreResult> = [];
	let compactionAttempts = 0;
	let fallbacks = 0;
	let retriedTurns = 0;
	const summaryUsage = emptyUsage();
	let pending: PendingCut | undefined;

	/**
	 * Close a cut boundary against the request that actually reached the
	 * provider afterwards. A withheld capture is missing evidence, not a pass.
	 */
	const closePendingCut = (nextTurnRequestText: string | undefined): void => {
		if (!pending) return;
		const injection = options.injection;
		let nextText = nextTurnRequestText;
		if (injection?.dropNextRequestCaptureAfterCut === pending.cutIndex) {
			nextText = undefined;
		} else if (
			injection?.retainDroppedTurnInCaptureAfterCut === pending.cutIndex &&
			nextText !== undefined
		) {
			nextText = `${nextText}${turnHeader(1)} leaked back into the next request`;
		}
		cuts[pending.cutIndex] = pending.assess(nextText);
		pending = undefined;
	};

	const lastAssistantFailed = (): boolean => {
		const messages = harness.session.messages;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index] as { role?: string; stopReason?: string } | undefined;
			if (message?.role !== "assistant") continue;
			return message.stopReason === "error";
		}
		return false;
	};

	try {
		for (const turn of scenario.turns) {
			const captureLen = harness.captures.length;
			await harness.session.prompt(turn.user);
			if (lastAssistantFailed()) {
				// One failed attempt, then one retry of the same scenario turn.
				retriedTurns += 1;
				await harness.session.prompt(turn.user);
			}
			const nextTurnCapture = harness.captures
				.slice(captureLen)
				.find((capture) => capture.kind === "turn");
			closePendingCut(nextTurnCapture?.serializedContext);

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
						`compact failed after turn ${turn.turn}: ${error instanceof Error ? error.message : String(error)}; messages=${messages.length} providerAttempts=${harness.faux.attemptCount()} preview=${preview}`,
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

			const cutIndex = cuts.length;
			const assess = (nextTurnRequestText: string | undefined): CutRecord =>
				assessCut({
					afterTurn: turn.turn,
					tokensBefore: compaction.tokensBefore,
					firstKeptEntryId: compaction.firstKeptEntryId,
					summary: compaction.summary,
					droppedEntryCount,
					retainedEntryCount,
					preCutContextText,
					postCutContextText,
					...(nextTurnRequestText === undefined ? {} : { nextTurnRequestText }),
				});
			cuts.push(assess(undefined));
			pending = { cutIndex, afterTurn: turn.turn, assess };
		}
		closePendingCut(undefined);

		if (cuts.length !== 3) {
			throw new Error(`expected 3 cuts, got ${cuts.length}`);
		}

		const survivingMessages = [...harness.session.messages];
		const survivingMessageUsage = collectMessageUsage(survivingMessages);
		const ledgerTotals = harness.ledger.totals();
		const expectedTotals = independentTotals(harness.ledger.records);
		const invalidRunReasons = cuts.flatMap((cut) => cut.invalidReasons);
		if (ledgerTotals.unknownCalls > 0) {
			invalidRunReasons.push({
				code: "unknown_request_usage",
				detail: `${ledgerTotals.unknownCalls} of ${ledgerTotals.attempts} attempts reported no usage`,
			});
		}

		const metadataBytes =
			dirSize(workspace.sessionDir) +
			dirSize(join(workspace.cwd, "notes")) +
			dirSize(join(workspace.cwd, "research-task"));
		const totals: RunTotals = {
			arm,
			variant: options.variant ?? config.variant,
			modelConfig: config.modelConfig,
			runClass: config.runClass,
			answerSource: config.answerSource,
			semanticGateEligible: config.semanticGateEligible,
			scenarioTurns: scenario.turns.length,
			providerCalls: ledgerTotals.attempts,
			providerAttempts: ledgerTotals.attempts,
			usageKnownAttempts: ledgerTotals.knownCalls,
			usageUnknownAttempts: ledgerTotals.unknownCalls,
			usageComplete: ledgerTotals.usageComplete,
			duplicateUsageDeliveries: ledgerTotals.duplicateDeliveries,
			failedAttempts: ledgerTotals.failedAttempts,
			retriedTurns,
			compactionAttempts,
			actualCuts: cuts.filter((cut) => !cut.noop).length,
			fallbacks,
			inputTokens: ledgerTotals.input,
			cachedInputTokens: ledgerTotals.cacheRead,
			cacheWriteTokens: ledgerTotals.cacheWrite,
			outputTokens: ledgerTotals.output,
			reportedReasoningTokens: ledgerTotals.reasoning,
			reasoningReported: ledgerTotals.reasoningReported,
			maintenanceCalls: ledgerTotals.maintenanceCalls,
			maintenanceTokens: ledgerTotals.maintenanceTokens,
			summaryOrCheckpointTokens: ledgerTotals.summaryTokens,
			recoveryCalls: ledgerTotals.recoveryCalls,
			recoveryTokens: ledgerTotals.recoveryTokens,
			sharedPromptOverheadTokens: ledgerTotals.sharedPromptOverheadTokens,
			sharedPromptDistinctPrompts: ledgerTotals.sharedPromptDistinctPrompts,
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
			captures: harness.captures,
			records: harness.ledger.records,
			expectedTotals,
			survivingMessageUsage,
			summaryUsage,
			invalidRunReasons,
			variantSet: config.variantSet,
			providerHookCaptureCount: harness.providerHookCaptureCount,
		});

		return {
			totals,
			cuts,
			score,
			outDir: workspace.outDir,
			workspaceCwd: workspace.cwd,
			sessionDir: workspace.sessionDir,
			captures: harness.captures,
			ledger: harness.ledger,
			expectedTotals,
			survivingMessageUsage,
			survivingMessages,
			providerHookCaptureCount: harness.providerHookCaptureCount,
			invalidRunReasons,
		};
	} finally {
		await harness.cleanup();
		if (!options.keepWorkspace) {
			workspace.cleanup();
		}
	}
}

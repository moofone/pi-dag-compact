import { type Static, Type } from "typebox";

/**
 * Machine-readable reasons a run or a cut boundary is not usable as evidence.
 * Every reason is emitted by code, never by a human reading a log.
 */
export const InvalidRunReasonCodeSchema = Type.Union([
	Type.Literal("missing_next_request_capture"),
	Type.Literal("dropped_entry_present_in_next_request"),
	Type.Literal("noop_compaction"),
	Type.Literal("unknown_request_usage"),
	Type.Literal("duplicate_variant_fixture_hash"),
	Type.Literal("identical_variant_arm_order"),
	Type.Literal("insufficient_variants"),
	Type.Literal("plumbing_run_cannot_satisfy_semantic_gate"),
]);

export const InvalidRunReasonSchema = Type.Object({
	code: InvalidRunReasonCodeSchema,
	detail: Type.String({ minLength: 1 }),
	afterTurn: Type.Optional(Type.Integer()),
});

export const CutRecordSchema = Type.Object({
	afterTurn: Type.Integer(),
	reason: Type.Literal("manual"),
	tokensBefore: Type.Number(),
	firstKeptEntryId: Type.String(),
	summaryChars: Type.Integer(),
	droppedEntryCount: Type.Integer(),
	retainedEntryCount: Type.Integer(),
	/** Whether the request that followed the cut was actually captured. */
	nextRequestEvidence: Type.Union([Type.Literal("present"), Type.Literal("missing")]),
	rawDroppedTurnHeadersAbsentFromNextRequest: Type.Boolean(),
	noop: Type.Boolean(),
	invalidReasons: Type.Array(InvalidRunReasonSchema),
});

export const RunTotalsSchema = Type.Object({
	arm: Type.Union([Type.Literal("classic"), Type.Literal("dag")]),
	variant: Type.String(),
	modelConfig: Type.String(),
	runClass: Type.Union([Type.Literal("plumbing"), Type.Literal("semantic")]),
	answerSource: Type.Union([Type.Literal("script"), Type.Literal("model")]),
	semanticGateEligible: Type.Boolean(),
	scenarioTurns: Type.Integer(),
	providerCalls: Type.Integer(),
	providerAttempts: Type.Integer(),
	usageKnownAttempts: Type.Integer(),
	usageUnknownAttempts: Type.Integer(),
	usageComplete: Type.Boolean(),
	duplicateUsageDeliveries: Type.Integer(),
	failedAttempts: Type.Integer(),
	retriedTurns: Type.Integer(),
	compactionAttempts: Type.Integer(),
	actualCuts: Type.Integer(),
	fallbacks: Type.Integer(),
	inputTokens: Type.Number(),
	cachedInputTokens: Type.Number(),
	cacheWriteTokens: Type.Number(),
	outputTokens: Type.Number(),
	reportedReasoningTokens: Type.Number(),
	reasoningReported: Type.Boolean(),
	maintenanceCalls: Type.Integer(),
	maintenanceTokens: Type.Number(),
	summaryOrCheckpointTokens: Type.Number(),
	recoveryCalls: Type.Integer(),
	recoveryTokens: Type.Number(),
	sharedPromptOverheadTokens: Type.Number(),
	sharedPromptDistinctPrompts: Type.Integer(),
	constraintErrors: Type.Integer(),
	falsePromotions: Type.Integer(),
	unjustifiedReruns: Type.Integer(),
	evidenceErrors: Type.Integer(),
	taskElapsedMs: Type.Number(),
	recoveryElapsedMs: Type.Number(),
	peakRssBytes: Type.Number(),
	metadataBytes: Type.Number(),
});

export type InvalidRunReasonCode = Static<typeof InvalidRunReasonCodeSchema>;
export type InvalidRunReason = Static<typeof InvalidRunReasonSchema>;
export type CutRecord = Static<typeof CutRecordSchema>;
export type RunTotals = Static<typeof RunTotalsSchema>;

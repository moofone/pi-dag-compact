import { type Static, Type } from "typebox";

export const CutRecordSchema = Type.Object({
	afterTurn: Type.Integer(),
	reason: Type.Literal("manual"),
	tokensBefore: Type.Number(),
	firstKeptEntryId: Type.String(),
	summaryChars: Type.Integer(),
	droppedEntryCount: Type.Integer(),
	retainedEntryCount: Type.Integer(),
	rawDroppedTurnHeadersAbsentFromNextRequest: Type.Boolean(),
	noop: Type.Boolean(),
});

export const RunTotalsSchema = Type.Object({
	arm: Type.Literal("classic"),
	variant: Type.String(),
	modelConfig: Type.String(),
	scenarioTurns: Type.Integer(),
	providerCalls: Type.Integer(),
	compactionAttempts: Type.Integer(),
	actualCuts: Type.Integer(),
	fallbacks: Type.Integer(),
	inputTokens: Type.Number(),
	cachedInputTokens: Type.Number(),
	outputTokens: Type.Number(),
	reportedReasoningTokens: Type.Number(),
	maintenanceTokens: Type.Number(),
	summaryOrCheckpointTokens: Type.Number(),
	recoveryCalls: Type.Integer(),
	constraintErrors: Type.Integer(),
	falsePromotions: Type.Integer(),
	unjustifiedReruns: Type.Integer(),
	evidenceErrors: Type.Integer(),
	taskElapsedMs: Type.Number(),
	recoveryElapsedMs: Type.Number(),
	peakRssBytes: Type.Number(),
	metadataBytes: Type.Number(),
});

export type CutRecord = Static<typeof CutRecordSchema>;
export type RunTotals = Static<typeof RunTotalsSchema>;

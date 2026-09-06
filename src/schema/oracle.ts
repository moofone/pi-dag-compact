import { type Static, Type } from "typebox";

export const RejectionSchema = Type.Object({
	candidateId: Type.String({ minLength: 1 }),
	reasonCode: Type.String({ minLength: 1 }),
});

export const ExpectedStateSchema = Type.Object({
	afterTurn: Type.Integer({ minimum: 1, maximum: 16 }),
	resourceCeilingSmemPct: Type.Integer(),
	acceptedBaselineId: Type.String({ minLength: 1 }),
	rejected: Type.Array(RejectionSchema),
	inconclusive: Type.Array(Type.String()),
	forbiddenPromotions: Type.Array(Type.String()),
	requiredRunIds: Type.Array(Type.String()),
	unjustifiedRerunCandidateIds: Type.Array(Type.String()),
	forbidCompletionClaim: Type.Boolean(),
	notes: Type.Optional(Type.String()),
});

export const WorkingNotesSchema = Type.Object({
	objective: Type.String(),
	metric: Type.Literal("pipeline_p50_ms"),
	resourceCeilingSmemPct: Type.Integer(),
	correctnessRequired: Type.Boolean(),
	acceptedBaselineId: Type.String(),
	acceptedBaselineRunId: Type.String(),
	rejected: Type.Array(RejectionSchema),
	inconclusive: Type.Array(Type.String()),
	nextAction: Type.String(),
	completionClaim: Type.Optional(Type.Boolean()),
});

export const OracleFileSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	variant: Type.String({ minLength: 1 }),
	states: Type.Array(ExpectedStateSchema, { minItems: 1 }),
});

export type Rejection = Static<typeof RejectionSchema>;
export type ExpectedState = Static<typeof ExpectedStateSchema>;
export type WorkingNotes = Static<typeof WorkingNotesSchema>;
export type OracleFile = Static<typeof OracleFileSchema>;

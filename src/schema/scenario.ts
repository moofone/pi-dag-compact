import { type Static, Type } from "typebox";

export const ScenarioTurnSchema = Type.Object({
	turn: Type.Integer({ minimum: 1, maximum: 16 }),
	title: Type.String({ minLength: 1 }),
	user: Type.String({ minLength: 1 }),
	marker: Type.String({ minLength: 1 }),
	expectedCandidateRun: Type.Optional(
		Type.Object({
			candidateId: Type.String({ minLength: 1 }),
			workloadId: Type.String({ minLength: 1 }),
		}),
	),
});

export const EvalConfigSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	variant: Type.String({ minLength: 1 }),
	arm: Type.Literal("classic"),
	label: Type.String({ minLength: 1 }),
	keepRecentTokens: Type.Integer({ minimum: 1024, maximum: 2048 }),
	reserveTokens: Type.Integer({ minimum: 1 }),
	cutAfterTurns: Type.Array(Type.Integer({ minimum: 1, maximum: 16 }), {
		minItems: 3,
		maxItems: 3,
	}),
	modelConfig: Type.String({ minLength: 1 }),
});

export const ScenarioFileSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	id: Type.String({ minLength: 1 }),
	objective: Type.String({ minLength: 1 }),
	metric: Type.Literal("pipeline_p50_ms"),
	initialResourceCeilingSmemPct: Type.Integer(),
	tightenedResourceCeilingSmemPct: Type.Integer(),
	correctnessRule: Type.String({ minLength: 1 }),
	workloadId: Type.String({ minLength: 1 }),
	turns: Type.Array(ScenarioTurnSchema, { minItems: 16, maxItems: 16 }),
});

export type ScenarioTurn = Static<typeof ScenarioTurnSchema>;
export type EvalConfig = Static<typeof EvalConfigSchema>;
export type ScenarioFile = Static<typeof ScenarioFileSchema>;

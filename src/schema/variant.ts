import { type Static, Type } from "typebox";

export const VariantCandidateSchema = Type.Object({
	pipelineP50Ms: Type.Number(),
	kernelP50Ms: Type.Number(),
	smemPct: Type.Number(),
	correctness: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unknown")]),
});

export const VariantFixtureSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	label: Type.String({ minLength: 1 }),
	seed: Type.String({ minLength: 1 }),
	answerSource: Type.Union([Type.Literal("script"), Type.Literal("model")]),
	workloadId: Type.String({ minLength: 1 }),
	candidateOrder: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	candidates: Type.Record(Type.String(), VariantCandidateSchema),
});

export type VariantCandidate = Static<typeof VariantCandidateSchema>;
export type VariantFixture = Static<typeof VariantFixtureSchema>;

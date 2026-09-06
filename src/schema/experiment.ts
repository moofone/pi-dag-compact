import { type Static, Type } from "typebox";

export const CorrectnessOutcomeSchema = Type.Union([
	Type.Literal("pass"),
	Type.Literal("fail"),
	Type.Literal("untested"),
]);

export const ExecutionStatusSchema = Type.Union([
	Type.Literal("planned"),
	Type.Literal("running"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("interrupted"),
]);

export const ExperimentManifestSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	runId: Type.String({ minLength: 1 }),
	candidateId: Type.String({ minLength: 1 }),
	workloadId: Type.String({ minLength: 1 }),
	question: Type.String({ minLength: 1 }),
	source: Type.Object({
		commit: Type.String({ minLength: 1 }),
		patchPath: Type.String({ minLength: 1 }),
		sha256: Type.Optional(Type.String({ minLength: 1 })),
	}),
	command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	environment: Type.Object({
		gpu: Type.String(),
		driver: Type.String(),
		host: Type.String(),
		clocksLocked: Type.Boolean(),
	}),
	inputs: Type.Object({
		workloadPath: Type.String(),
		dimensions: Type.String(),
		seed: Type.Integer(),
	}),
});

export const ExperimentResultSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	runId: Type.String({ minLength: 1 }),
	status: ExecutionStatusSchema,
	measurements: Type.Object({
		pipelineP50Ms: Type.Number(),
		kernelP50Ms: Type.Number(),
		smemPct: Type.Number(),
		unit: Type.Literal("ms"),
		warmupIters: Type.Integer(),
		sampleIters: Type.Integer(),
	}),
	correctness: Type.Object({
		check: Type.String(),
		outcome: CorrectnessOutcomeSchema,
		evidence: Type.String(),
	}),
	confound: Type.Optional(Type.String()),
});

export type ExperimentManifest = Static<typeof ExperimentManifestSchema>;
export type ExperimentResult = Static<typeof ExperimentResultSchema>;

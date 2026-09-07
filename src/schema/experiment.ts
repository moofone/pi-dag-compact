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
	schemaVersion: Type.Union([Type.Literal(1), Type.Literal(2)]),
	runId: Type.String({ minLength: 1 }),
	candidateId: Type.String({ minLength: 1 }),
	workloadId: Type.String({ minLength: 1 }),
	/** Declared identity of the workload contents; runs are comparable only within one. */
	workloadVersion: Type.Optional(Type.String({ minLength: 1 })),
	/** Declared identity of the measurement definition behind `measurements`. */
	metricVersion: Type.Optional(Type.String({ minLength: 1 })),
	question: Type.String({ minLength: 1 }),
	source: Type.Object({
		commit: Type.String({ minLength: 1 }),
		patchPath: Type.String({ minLength: 1 }),
		sha256: Type.Optional(Type.String({ minLength: 1 })),
		/** True when the run was built from uncommitted changes. */
		dirty: Type.Optional(Type.Boolean()),
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

export const ObjectiveMetricSchema = Type.Union([
	Type.Literal("pipelineP50Ms"),
	Type.Literal("kernelP50Ms"),
]);

export const ExperimentResultSchema = Type.Object({
	schemaVersion: Type.Union([Type.Literal(1), Type.Literal(2)]),
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

/**
 * The evidence profile a caller declares for one comparison. The generic
 * protocol validates identity, comparability, and correctness; which metric
 * the objective is measured on stays a declaration, not a built-in rule.
 */
export const EvidenceProfileSchema = Type.Object({
	objectiveMetric: Type.Optional(ObjectiveMetricSchema),
	baselineRunId: Type.Optional(Type.String({ minLength: 1 })),
	replicationReason: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

export type CorrectnessOutcome = Static<typeof CorrectnessOutcomeSchema>;
export type ExecutionStatus = Static<typeof ExecutionStatusSchema>;
export type ObjectiveMetric = Static<typeof ObjectiveMetricSchema>;
export type EvidenceProfile = Static<typeof EvidenceProfileSchema>;
export type ExperimentManifest = Static<typeof ExperimentManifestSchema>;
export type ExperimentResult = Static<typeof ExperimentResultSchema>;

import { type Static, Type } from "typebox";

export const NodeKindSchema = Type.Union([
	Type.Literal("goal"),
	Type.Literal("constraint"),
	Type.Literal("task"),
	Type.Literal("hypothesis"),
	Type.Literal("decision"),
	Type.Literal("blocker"),
]);

export const NodeStatusSchema = Type.Union([
	Type.Literal("open"),
	Type.Literal("blocked"),
	Type.Literal("done"),
	Type.Literal("rejected"),
	Type.Literal("stale"),
]);

export const EdgeKindSchema = Type.Union([
	Type.Literal("depends_on"),
	Type.Literal("supports"),
	Type.Literal("supersedes"),
	Type.Literal("alternative_to"),
]);

export const EvidenceRefSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("session"),
		sessionId: Type.String({ minLength: 1 }),
		entryId: Type.String({ minLength: 1 }),
	}),
	Type.Object({
		kind: Type.Literal("research"),
		taskId: Type.String({ minLength: 1 }),
		recordId: Type.String({ minLength: 1 }),
	}),
	Type.Object({
		kind: Type.Literal("artifact"),
		path: Type.String({ minLength: 1 }),
		sha256: Type.Optional(Type.String({ minLength: 1 })),
	}),
]);

export const WorkingNodeSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	kind: NodeKindSchema,
	title: Type.String({ minLength: 1, maxLength: 120 }),
	body: Type.String({ maxLength: 1000 }),
	status: NodeStatusSchema,
	evidence: Type.Array(EvidenceRefSchema, { maxItems: 16 }),
	paths: Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 }),
	revision: Type.Integer({ minimum: 1 }),
});

export const WorkingNodeDraftSchema = Type.Object({
	id: Type.Optional(Type.String({ minLength: 1 })),
	kind: NodeKindSchema,
	title: Type.String({ minLength: 1, maxLength: 120 }),
	body: Type.String({ maxLength: 1000 }),
	status: NodeStatusSchema,
	evidence: Type.Optional(Type.Array(EvidenceRefSchema, { maxItems: 16 })),
	paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })),
});

export const WorkingEdgeSchema = Type.Object({
	from: Type.String({ minLength: 1 }),
	to: Type.String({ minLength: 1 }),
	kind: EdgeKindSchema,
});

export const MutationBatchSchema = Type.Object({
	operationId: Type.String({ minLength: 1 }),
	upsertNodes: Type.Optional(Type.Array(WorkingNodeDraftSchema)),
	setStatus: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({ minLength: 1 }),
				status: NodeStatusSchema,
			}),
		),
	),
	addEdges: Type.Optional(Type.Array(WorkingEdgeSchema)),
	removeEdges: Type.Optional(Type.Array(WorkingEdgeSchema)),
	archiveIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

export const QueryRequestSchema = Type.Object({
	scope: Type.Union([Type.Literal("active"), Type.Literal("history")]),
	q: Type.Optional(Type.String()),
	ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })),
	cursor: Type.Optional(Type.String()),
});

export const PiRefDataSchema = Type.Object({
	v: Type.Literal(1),
	taskId: Type.String({ minLength: 1 }),
	operationId: Type.String({ minLength: 1 }),
	revisionId: Type.String({ minLength: 1 }),
	payloadHash: Type.String({ minLength: 1 }),
	checkpointId: Type.Optional(Type.String({ minLength: 1 })),
});

export type NodeKind = Static<typeof NodeKindSchema>;
export type NodeStatus = Static<typeof NodeStatusSchema>;
export type EdgeKind = Static<typeof EdgeKindSchema>;
export type EvidenceRef = Static<typeof EvidenceRefSchema>;
export type WorkingNode = Static<typeof WorkingNodeSchema>;
export type WorkingNodeDraft = Static<typeof WorkingNodeDraftSchema>;
export type WorkingEdge = Static<typeof WorkingEdgeSchema>;
export type MutationBatch = Static<typeof MutationBatchSchema>;
export type QueryRequest = Static<typeof QueryRequestSchema>;
export type PiRefData = Static<typeof PiRefDataSchema>;

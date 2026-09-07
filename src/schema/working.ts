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

export const GoalBindingSchema = Type.Object({
	goalId: Type.String({ minLength: 1 }),
	stageId: Type.String({ minLength: 1 }),
	generation: Type.Integer({ minimum: 0 }),
	contractRevision: Type.String({ minLength: 1 }),
});

const idList = () => Type.Array(Type.String({ minLength: 1 }), { maxItems: 200 });
const nullableId = () => Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

/**
 * Schema-v2 typed selection. Every field is an explicit record ID: selection
 * names never determine scientific validity. `null` means deliberate absence.
 */
export const SelectionDraftSchema = Type.Object({
	goalBinding: Type.Union([GoalBindingSchema, Type.Null()]),
	objectiveId: Type.String(),
	constraintIds: idList(),
	acceptedBaselineRecordId: nullableId(),
	bestObservedRecordId: nullableId(),
	bestValidatedRecordId: nullableId(),
	currentWorkIds: idList(),
	unresolvedIds: idList(),
	nextActionIds: idList(),
	rejectedApproachIds: idList(),
	pinnedIds: idList(),
	absenceReason: Type.Optional(Type.String({ maxLength: 200 })),
});

/** A committed selection additionally carries its engine-issued identity. */
export const ActiveSelectionSchema = Type.Object({
	...SelectionDraftSchema.properties,
	selectionRevision: Type.String({ minLength: 1 }),
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
	setSelection: Type.Optional(SelectionDraftSchema),
});

/**
 * `ids` is a bounded batched read; `cursor` continues a page and is bound to
 * the scope, query and revision that issued it; `chunkOf` reads one record too
 * large for a single response, `chunkOffset` bytes in.
 */
export const QueryRequestSchema = Type.Object({
	scope: Type.Union([Type.Literal("active"), Type.Literal("history")]),
	q: Type.Optional(Type.String()),
	ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })),
	/**
	 * Where the requested IDs came from. A reference from another research task
	 * or another session is answered by that origin or reported unavailable; it
	 * is never satisfied by a local record that happens to share the ID.
	 */
	origin: Type.Optional(
		Type.Object({
			taskId: Type.Optional(Type.String({ minLength: 1 })),
			sessionId: Type.Optional(Type.String({ minLength: 1 })),
		}),
	),
	cursor: Type.Optional(Type.String()),
	chunkOf: Type.Optional(Type.String({ minLength: 1 })),
	chunkOffset: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const PiRefDataSchema = Type.Object({
	v: Type.Literal(1),
	taskId: Type.String({ minLength: 1 }),
	operationId: Type.String({ minLength: 1 }),
	revisionId: Type.String({ minLength: 1 }),
	payloadHash: Type.String({ minLength: 1 }),
	checkpointId: Type.Optional(Type.String({ minLength: 1 })),
});

export const HandoffMarkerSchema = Type.Object({
	v: Type.Literal(1),
	sessionId: Type.String({ minLength: 1 }),
	leafId: Type.String({ minLength: 1 }),
	revisionId: Type.String({ minLength: 1 }),
	checkpointId: Type.String({ minLength: 1 }),
	coveredThroughEntryId: Type.String({ minLength: 1 }),
});

export const CheckpointSchema = Type.Object({
	schemaVersion: Type.Literal(2),
	checkpointId: Type.String({ minLength: 1 }),
	sessionId: Type.String({ minLength: 1 }),
	branchAnchorId: Type.String({ minLength: 1 }),
	coveredThroughEntryId: Type.String({ minLength: 1 }),
	workingRevision: Type.Integer({ minimum: 1 }),
	workingRevisionId: Type.String({ minLength: 1 }),
	researchTaskId: Type.String({ minLength: 1 }),
	researchRevision: Type.Optional(Type.String({ minLength: 1 })),
	selection: ActiveSelectionSchema,
	requiredUserEntryIds: Type.Array(Type.String({ minLength: 1 })),
	requiredEvidence: Type.Array(EvidenceRefSchema),
	nodes: Type.Array(WorkingNodeSchema),
	edges: Type.Array(WorkingEdgeSchema),
});

export type NodeKind = Static<typeof NodeKindSchema>;
export type NodeStatus = Static<typeof NodeStatusSchema>;
export type EdgeKind = Static<typeof EdgeKindSchema>;
export type EvidenceRef = Static<typeof EvidenceRefSchema>;
export type WorkingNode = Static<typeof WorkingNodeSchema>;
export type WorkingNodeDraft = Static<typeof WorkingNodeDraftSchema>;
export type WorkingEdge = Static<typeof WorkingEdgeSchema>;
export type GoalBinding = Static<typeof GoalBindingSchema>;
export type SelectionDraft = Static<typeof SelectionDraftSchema>;
export type ActiveSelection = Static<typeof ActiveSelectionSchema>;
export type Checkpoint = Static<typeof CheckpointSchema>;
export type MutationBatch = Static<typeof MutationBatchSchema>;
export type QueryRequest = Static<typeof QueryRequestSchema>;
export type PiRefData = Static<typeof PiRefDataSchema>;
export type HandoffMarker = Static<typeof HandoffMarkerSchema>;

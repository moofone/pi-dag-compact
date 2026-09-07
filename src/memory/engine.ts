import { join } from "node:path";
import { parseWithSchema } from "../schema/validate.ts";
import type {
	ActiveSelection,
	MutationBatch,
	PiRefData,
	WorkingEdge,
	WorkingNode,
} from "../schema/working.ts";
import { MutationBatchSchema, WorkingNodeDraftSchema } from "../schema/working.ts";
import { canonicalBatch, canonicalSnapshot, edgeKey, newId, sha256 } from "./canonical.ts";
import { DagError } from "./errors.ts";
import { cloneEdges, cloneNodes, validateActiveSet } from "./graph.ts";
import { LIMITS, utf8Bytes } from "./limits.ts";
import {
	issueSelectionRevision,
	isTerminal,
	pinnedIds,
	type ResolvedSelection,
	resolveSelection,
	validateSelectionDraft,
} from "./selection.ts";
import { parseGraph, type RevisionRow, SqliteStore } from "./store.ts";

export interface BranchContext {
	sessionId: string;
	leafId: string;
}

export interface WorkingSnapshot {
	taskId: string;
	revisionId: string | null;
	revision: number;
	checkpointId: string | null;
	nodes: WorkingNode[];
	edges: WorkingEdge[];
	/** The committed explicit selection, or null when none was ever set. */
	explicitSelection: ActiveSelection | null;
	/** Explicit selection merged with structural derivation for this revision. */
	selection: ActiveSelection;
	/** Selection slots the structure could not decide without an explicit ID. */
	ambiguousSelections: string[];
}

export interface CommitResult {
	revisionId: string;
	revision: number;
	operationId: string;
	payloadHash: string;
	snapshotHash: string;
	checkpointId: string | null;
	status: "pending_ref" | "selected" | "unselected";
	nodes: WorkingNode[];
	edges: WorkingEdge[];
	/** IDs the engine issued for drafts that arrived without one. */
	assignedIds: string[];
	selection: ActiveSelection;
	piRef: PiRefData;
}

export interface ResearchIngestInput {
	operationId: string;
	kind: string;
	payload: unknown;
	runId?: string;
	runStatus?: "planned" | "running" | "completed" | "failed" | "interrupted";
}

export interface ResearchIngestResult {
	recordId: string;
	/** True when an identical operation had already been committed. */
	replayed: boolean;
}

export interface PiRefLike {
	customType: string;
	data: unknown;
}

const REF_TYPES = new Set(["dag_revision_ref", "dag_checkpoint_ref"]);

export class MemoryEngine {
	readonly taskId: string;
	readonly sessionId: string;
	private readonly store: SqliteStore;
	private nodes: WorkingNode[] = [];
	private edges: WorkingEdge[] = [];
	private revisionId: string | null = null;
	private revision = 0;
	private checkpointId: string | null = null;
	private explicitSelection: ActiveSelection | null = null;

	private constructor(taskId: string, sessionId: string, store: SqliteStore) {
		this.taskId = taskId;
		this.sessionId = sessionId;
		this.store = store;
	}

	static open(taskDir: string, sessionId: string, taskId = "default"): MemoryEngine {
		const store = new SqliteStore(join(taskDir, "memory.sqlite"));
		const writer = store.getWriter(taskId);
		if (writer && writer !== sessionId) {
			store.close();
			throw new DagError("competing_writer", `task is owned by session ${writer}`);
		}
		store.ensureTask(taskId, sessionId);
		return new MemoryEngine(taskId, sessionId, store);
	}

	close(): void {
		this.store.close();
	}

	release(): void {
		this.store.releaseWriter(this.taskId);
		this.close();
	}

	snapshot(): WorkingSnapshot {
		const resolved = resolveSelection(
			this.nodes,
			this.edges,
			this.explicitSelection,
			Math.max(this.revision, 1),
		);
		return {
			taskId: this.taskId,
			revisionId: this.revisionId,
			revision: this.revision,
			checkpointId: this.checkpointId,
			nodes: cloneNodes(this.nodes),
			edges: cloneEdges(this.edges),
			explicitSelection: this.explicitSelection,
			selection: resolved.selection,
			ambiguousSelections: resolved.ambiguous,
		};
	}

	update(batchInput: MutationBatch, branch: BranchContext): CommitResult {
		const batch = parseWithSchema(MutationBatchSchema, batchInput, "dag_update");
		const batchJson = canonicalBatch(batch);
		if (utf8Bytes(batchJson) > LIMITS.maxBatchBytes) {
			throw new DagError("limit", `mutation batch exceeds ${LIMITS.maxBatchBytes} bytes`);
		}
		const batchHash = sha256(batchJson);

		const existingOp = this.store.getOperation(batch.operationId);
		if (existingOp) {
			if (existingOp.payloadHash !== batchHash) {
				throw new DagError(
					"op_conflict",
					`operation ${batch.operationId} was reused with different content`,
				);
			}
			const existingRev = this.store.getRevisionByOperation(batch.operationId);
			if (!existingRev) {
				throw new DagError("op_conflict", `operation ${batch.operationId} is missing its revision`);
			}
			return this.commitResultFromRow(existingRev);
		}

		const nextRevision = this.revision + 1;
		const next = applyBatch(this.nodes, this.edges, batch, nextRevision, this.explicitSelection);
		validateActiveSet(next.nodes, next.edges);
		const explicitSelection = nextExplicitSelection(
			batch,
			this.explicitSelection,
			next.nodes,
			nextRevision,
		);
		const resolved = resolveSelection(next.nodes, next.edges, explicitSelection, nextRevision);
		const snapshotJson = canonicalSnapshot(next.nodes, next.edges);
		const snapshotHash = sha256(snapshotJson);
		const revisionId = newId("rev");
		const mutations = this.store.mutationsSinceCheckpoint(this.revisionId);
		let checkpointId: string | null = this.checkpointId;
		const needsCheckpoint = mutations >= LIMITS.maxReplayMutations || this.revisionId === null;

		const row: RevisionRow = {
			revisionId,
			revision: nextRevision,
			parentRevisionId: this.revisionId,
			operationId: batch.operationId,
			payloadHash: snapshotHash,
			checkpointId: null,
			nodesJson: JSON.stringify(next.nodes),
			edgesJson: JSON.stringify(next.edges),
			selectionJson: explicitSelection ? JSON.stringify(explicitSelection) : null,
			status: "pending_ref",
			expectedSessionId: branch.sessionId,
			expectedBranchLeafId: branch.leafId,
			piEntryId: null,
			createdAt: Date.now(),
		};

		this.store.transaction(() => {
			this.store.putOperation(batch.operationId, batchHash, batchJson);
			if (needsCheckpoint) {
				checkpointId = newId("ckpt");
				row.checkpointId = checkpointId;
				this.store.insertCheckpoint(
					checkpointId,
					revisionId,
					JSON.stringify({
						schemaVersion: 2,
						checkpointId,
						sessionId: branch.sessionId,
						branchAnchorId: branch.leafId,
						coveredThroughEntryId: branch.leafId,
						workingRevision: row.revision,
						workingRevisionId: revisionId,
						researchTaskId: this.taskId,
						selection: resolved.selection,
						requiredUserEntryIds: [],
						requiredEvidence: next.nodes.flatMap((node) => node.evidence),
						nodes: next.nodes,
						edges: next.edges,
					}),
					snapshotHash,
				);
			}
			this.store.insertRevision(row);
			for (const id of batch.archiveIds ?? []) {
				const archived = this.nodes.find((node) => node.id === id);
				if (archived) this.store.archiveNode(id, revisionId, JSON.stringify(archived));
			}
		});

		this.nodes = next.nodes;
		this.edges = next.edges;
		this.revisionId = revisionId;
		this.revision = row.revision;
		this.checkpointId = checkpointId;
		this.explicitSelection = explicitSelection;

		return {
			revisionId,
			revision: row.revision,
			operationId: batch.operationId,
			payloadHash: batchHash,
			snapshotHash,
			checkpointId,
			status: "pending_ref",
			nodes: cloneNodes(next.nodes),
			edges: cloneEdges(next.edges),
			assignedIds: next.assignedIds,
			selection: resolved.selection,
			piRef: {
				v: 1,
				taskId: this.taskId,
				operationId: batch.operationId,
				revisionId,
				payloadHash: snapshotHash,
				...(checkpointId ? { checkpointId } : {}),
			},
		};
	}

	acknowledgeRef(operationId: string, entryId: string): void {
		const row = this.store.getRevisionByOperation(operationId);
		if (!row) throw new DagError("unknown_revision", `no revision for operation ${operationId}`);
		if (row.status === "unselected") return;
		this.store.setRevisionStatus(row.revisionId, "selected", entryId);
	}

	markUnselected(operationId: string): void {
		const row = this.store.getRevisionByOperation(operationId);
		if (!row) return;
		this.store.setRevisionStatus(row.revisionId, "unselected", row.piEntryId);
		if (this.revisionId === row.revisionId) {
			this.reconstructFromRow(
				row.parentRevisionId ? this.store.getRevision(row.parentRevisionId) : undefined,
			);
		}
	}

	reconstruct(branchRefs: PiRefLike[]): WorkingSnapshot {
		const refs = branchRefs
			.filter((entry) => REF_TYPES.has(entry.customType))
			.map((entry) => entry.data as PiRefData);
		const latest = refs.at(-1);
		if (!latest) {
			this.nodes = [];
			this.edges = [];
			this.revisionId = null;
			this.revision = 0;
			this.checkpointId = null;
			return this.snapshot();
		}
		const row = this.store.getRevision(latest.revisionId);
		if (!row || row.payloadHash !== latest.payloadHash) {
			throw new DagError("corrupt_ref", "branch reference does not match durable revision");
		}
		if (row.status === "unselected") {
			throw new DagError("unselected", "branch reference points at an unselected revision");
		}
		this.reconstructFromRow(row);
		return this.snapshot();
	}

	reconcilePending(
		branch: BranchContext,
		appendRef: (ref: PiRefData, checkpoint: boolean) => string | undefined,
	): void {
		for (const row of this.store.listPendingForSession(branch.sessionId)) {
			if (row.expectedBranchLeafId !== branch.leafId) continue;
			const entryId = appendRef(this.commitResultFromRow(row).piRef, Boolean(row.checkpointId));
			if (entryId) {
				this.acknowledgeRef(row.operationId, entryId);
				this.reconstructFromRow(row);
			}
		}
	}

	/**
	 * One idempotency transaction for research ingestion.
	 *
	 * The event write and the run publication commit together, so an
	 * interruption between them leaves neither behind and the retry produces
	 * exactly one record. Size is checked before any write, so an oversized
	 * event is rejected atomically. A reused operation ID with different
	 * content is a conflict, never a silent second record.
	 */
	ingestResearchRecord(input: ResearchIngestInput): ResearchIngestResult {
		const payloadJson = JSON.stringify(input.payload);
		if (utf8Bytes(payloadJson) > LIMITS.maxEventBytes) {
			throw new DagError(
				"limit",
				`research event exceeds ${LIMITS.maxEventBytes} bytes; store large results as artifacts`,
			);
		}
		const payloadHash = sha256(`${input.kind}\n${payloadJson}`);
		const existing = this.store.getResearchEventByOperation(input.operationId);
		if (existing) {
			if (existing.payloadHash !== payloadHash) {
				throw new DagError(
					"op_conflict",
					`operation ${input.operationId} was reused with different research content`,
				);
			}
			return { recordId: existing.recordId, replayed: true };
		}

		const runId = input.runId;
		if (runId && input.runStatus) {
			this.assertRunTransition(runId, input.runStatus);
		}
		const recordId = newId("evt");
		this.store.transaction(() => {
			this.store.insertResearchEvent(
				recordId,
				input.operationId,
				input.kind,
				payloadJson,
				payloadHash,
			);
			if (runId && input.runStatus) {
				this.store.putRun(runId, input.operationId, input.runStatus, payloadJson);
			}
		});
		return { recordId, replayed: false };
	}

	recordResearchEvent(operationId: string, kind: string, payload: unknown): string {
		return this.ingestResearchRecord({ operationId, kind, payload }).recordId;
	}

	listResearchRecords(kind: string): Array<{ recordId: string; payload: unknown }> {
		return this.store.listResearchEventsByKind(kind).map((row) => ({
			recordId: row.recordId,
			payload: JSON.parse(row.payloadJson) as unknown,
		}));
	}

	attachFork(originSessionId: string, inheritedRevisionId: string | null): void {
		this.store.insertAttachment(newId("att"), this.sessionId, originSessionId, inheritedRevisionId);
	}

	beginRun(runId: string, operationId: string, payload: unknown): void {
		const existing = this.store.getRun(runId);
		if (existing && (existing.status === "planned" || existing.status === "running")) {
			throw new DagError(
				"unreconciled_run",
				`run ${runId} is ${existing.status}; reconcile before relaunch`,
			);
		}
		this.store.putRun(runId, operationId, "running", JSON.stringify(payload));
	}

	finishRun(runId: string, status: "completed" | "failed" | "interrupted", payload: unknown): void {
		this.assertRunTransition(runId, status);
		const existing = this.store.getRun(runId);
		this.store.putRun(runId, existing?.operationId ?? "reconcile", status, JSON.stringify(payload));
	}

	/**
	 * A failed or interrupted result is terminal. Reaching `completed` requires
	 * a new `beginRun`, so a later write can never relabel a lost run as a
	 * successful one.
	 */
	private assertRunTransition(runId: string, status: string): void {
		if (status !== "completed") return;
		const existing = this.store.getRun(runId);
		if (!existing) return;
		if (existing.status === "failed" || existing.status === "interrupted") {
			throw new DagError(
				"run_status_conflict",
				`run ${runId} is ${existing.status}; relaunch it before recording a completed result`,
			);
		}
	}

	getRun(
		runId: string,
	): { runId: string; operationId: string; status: string; payloadJson: string } | undefined {
		return this.store.getRun(runId);
	}

	archivedSearch(query: string, limit: number, cursor?: string): WorkingNode[] {
		return this.store.searchArchived(query, limit, cursor);
	}

	private reconstructFromRow(row: RevisionRow | undefined): void {
		if (!row) {
			this.nodes = [];
			this.edges = [];
			this.revisionId = null;
			this.revision = 0;
			this.checkpointId = null;
			this.explicitSelection = null;
			return;
		}
		const graph = parseGraph(row.nodesJson, row.edgesJson);
		this.nodes = graph.nodes;
		this.edges = graph.edges;
		this.revisionId = row.revisionId;
		this.revision = row.revision;
		this.checkpointId = row.checkpointId;
		this.explicitSelection = row.selectionJson
			? (JSON.parse(row.selectionJson) as ActiveSelection)
			: null;
	}

	private commitResultFromRow(row: RevisionRow): CommitResult {
		const graph = parseGraph(row.nodesJson, row.edgesJson);
		const explicit = row.selectionJson ? (JSON.parse(row.selectionJson) as ActiveSelection) : null;
		const resolved = resolveSelection(graph.nodes, graph.edges, explicit, row.revision);
		return {
			revisionId: row.revisionId,
			revision: row.revision,
			operationId: row.operationId,
			payloadHash: this.store.getOperation(row.operationId)?.payloadHash ?? row.payloadHash,
			snapshotHash: row.payloadHash,
			checkpointId: row.checkpointId,
			status: row.status,
			nodes: graph.nodes,
			edges: graph.edges,
			assignedIds: [],
			selection: resolved.selection,
			piRef: {
				v: 1,
				taskId: this.taskId,
				operationId: row.operationId,
				revisionId: row.revisionId,
				payloadHash: row.payloadHash,
				...(row.checkpointId ? { checkpointId: row.checkpointId } : {}),
			},
		};
	}
}

/**
 * Apply a batch to prospective state.
 *
 * Order matters: upserts, then mutable status deltas, then edges, then
 * archival. Archiving last means one batch can resolve a record and retire it
 * together, while every archival decision is judged against the state the
 * batch actually produces.
 */
export function applyBatch(
	nodes: WorkingNode[],
	edges: WorkingEdge[],
	batch: MutationBatch,
	revision: number,
	explicitSelection: ActiveSelection | null = null,
): { nodes: WorkingNode[]; edges: WorkingEdge[]; assignedIds: string[] } {
	const nodeMap = new Map(cloneNodes(nodes).map((node) => [node.id, node]));
	const edgeMap = new Map(cloneEdges(edges).map((edge) => [edgeKey(edge), edge]));
	const assignedIds: string[] = [];

	for (const draft of batch.upsertNodes ?? []) {
		parseWithSchema(WorkingNodeDraftSchema, draft, "upsert node");
		let id = draft.id;
		if (!id) {
			id = newId("n");
			assignedIds.push(id);
		}
		const previous = nodeMap.get(id);
		nodeMap.set(id, {
			id,
			kind: draft.kind,
			title: draft.title,
			body: draft.body,
			status: draft.status,
			evidence: draft.evidence ? [...draft.evidence] : (previous?.evidence ?? []),
			paths: draft.paths ? [...draft.paths] : (previous?.paths ?? []),
			revision,
		});
	}

	for (const change of batch.setStatus ?? []) {
		const node = nodeMap.get(change.id);
		if (!node) throw new DagError("unknown_node", `cannot set status of missing node ${change.id}`);
		node.status = change.status;
		node.revision = revision;
	}

	for (const edge of batch.removeEdges ?? []) {
		edgeMap.delete(edgeKey(edge));
	}

	for (const edge of batch.addEdges ?? []) {
		if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) {
			throw new DagError("unknown_node", `edge ${edgeKey(edge)} references a missing node`);
		}
		edgeMap.set(edgeKey(edge), { ...edge });
	}

	const archiveIds = batch.archiveIds ?? [];
	if (archiveIds.length > 0) {
		assertArchivable(
			archiveIds,
			[...nodeMap.values()],
			[...edgeMap.values()],
			explicitSelection,
			revision,
		);
		for (const id of archiveIds) {
			nodeMap.delete(id);
			for (const key of [...edgeMap.keys()]) {
				const edge = edgeMap.get(key);
				if (edge && (edge.from === id || edge.to === id)) edgeMap.delete(key);
			}
		}
	}

	const next = { nodes: [...nodeMap.values()], edges: [...edgeMap.values()], assignedIds };
	validateActiveSet(next.nodes, next.edges);
	return next;
}

/**
 * Deliberate archival. The engine, not the caller, decides what may leave the
 * active set: never a pinned selection member, never nonterminal work, and
 * never a prerequisite that active work still depends on.
 */
function assertArchivable(
	archiveIds: string[],
	nodes: WorkingNode[],
	edges: WorkingEdge[],
	explicitSelection: ActiveSelection | null,
	revision: number,
): void {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const resolved: ResolvedSelection = resolveSelection(nodes, edges, explicitSelection, revision);
	const pins = pinnedIds(resolved, explicitSelection);
	const leaving = new Set(archiveIds);

	for (const id of archiveIds) {
		const node = byId.get(id);
		if (!node) continue;
		if (pins.has(id)) {
			throw new DagError(
				"pinned_node",
				`${id} is a selected record and cannot be archived; deselect it first`,
			);
		}
		if (!isTerminal(node)) {
			throw new DagError(
				"nonterminal_node",
				`${id} is ${node.status}; resolve it before archiving`,
			);
		}
	}

	for (const edge of edges) {
		if (edge.kind !== "depends_on") continue;
		if (!leaving.has(edge.to) || leaving.has(edge.from)) continue;
		const dependent = byId.get(edge.from);
		if (!dependent || isTerminal(dependent)) continue;
		throw new DagError(
			"unresolved_dependency",
			`${edge.from} still depends on ${edge.to}; record an explicit resolution instead of dropping the edge`,
		);
	}
}

/**
 * Carry the committed selection forward, or replace it wholesale when the
 * batch sets one. Selections are validated against the prospective state, so a
 * selection naming a record that will not exist never reaches disk.
 */
function nextExplicitSelection(
	batch: MutationBatch,
	previous: ActiveSelection | null,
	nodes: WorkingNode[],
	revision: number,
): ActiveSelection | null {
	if (!batch.setSelection) return previous;
	validateSelectionDraft(batch.setSelection, nodes);
	return {
		...batch.setSelection,
		selectionRevision: issueSelectionRevision(batch.setSelection, revision),
	};
}

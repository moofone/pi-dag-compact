import { join } from "node:path";
import { parseWithSchema } from "../schema/validate.ts";
import type { MutationBatch, PiRefData, WorkingEdge, WorkingNode } from "../schema/working.ts";
import { MutationBatchSchema, WorkingNodeDraftSchema } from "../schema/working.ts";
import { canonicalBatch, canonicalSnapshot, edgeKey, newId, sha256 } from "./canonical.ts";
import { DagError } from "./errors.ts";
import { cloneEdges, cloneNodes, validateActiveSet } from "./graph.ts";
import { LIMITS, utf8Bytes } from "./limits.ts";
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
	piRef: PiRefData;
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
		return {
			taskId: this.taskId,
			revisionId: this.revisionId,
			revision: this.revision,
			checkpointId: this.checkpointId,
			nodes: cloneNodes(this.nodes),
			edges: cloneEdges(this.edges),
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

		const next = applyBatch(this.nodes, this.edges, batch, this.revision + 1);
		validateActiveSet(next.nodes, next.edges);
		const snapshotJson = canonicalSnapshot(next.nodes, next.edges);
		const snapshotHash = sha256(snapshotJson);
		const revisionId = newId("rev");
		const mutations = this.store.mutationsSinceCheckpoint(this.revisionId);
		let checkpointId: string | null = this.checkpointId;
		const needsCheckpoint = mutations >= LIMITS.maxReplayMutations || this.revisionId === null;

		const row: RevisionRow = {
			revisionId,
			revision: this.revision + 1,
			parentRevisionId: this.revisionId,
			operationId: batch.operationId,
			payloadHash: snapshotHash,
			checkpointId: null,
			nodesJson: JSON.stringify(next.nodes),
			edgesJson: JSON.stringify(next.edges),
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
						schemaVersion: 1,
						checkpointId,
						sessionId: branch.sessionId,
						branchAnchorId: branch.leafId,
						coveredThroughEntryId: branch.leafId,
						workingRevision: row.revision,
						workingRevisionId: revisionId,
						researchTaskId: this.taskId,
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

	recordResearchEvent(operationId: string, kind: string, payload: unknown): string {
		const recordId = newId("evt");
		this.store.insertResearchEvent(recordId, operationId, kind, JSON.stringify(payload));
		return recordId;
	}

	attachFork(originSessionId: string, inheritedRevisionId: string | null): void {
		this.store.insertAttachment(newId("att"), this.sessionId, originSessionId, inheritedRevisionId);
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
			return;
		}
		const graph = parseGraph(row.nodesJson, row.edgesJson);
		this.nodes = graph.nodes;
		this.edges = graph.edges;
		this.revisionId = row.revisionId;
		this.revision = row.revision;
		this.checkpointId = row.checkpointId;
	}

	private commitResultFromRow(row: RevisionRow): CommitResult {
		const graph = parseGraph(row.nodesJson, row.edgesJson);
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

export function applyBatch(
	nodes: WorkingNode[],
	edges: WorkingEdge[],
	batch: MutationBatch,
	revision: number,
): { nodes: WorkingNode[]; edges: WorkingEdge[] } {
	const nodeMap = new Map(cloneNodes(nodes).map((node) => [node.id, node]));
	const edgeMap = new Map(cloneEdges(edges).map((edge) => [edgeKey(edge), edge]));

	for (const id of batch.archiveIds ?? []) {
		nodeMap.delete(id);
		for (const key of [...edgeMap.keys()]) {
			const edge = edgeMap.get(key);
			if (edge && (edge.from === id || edge.to === id)) edgeMap.delete(key);
		}
	}

	for (const draft of batch.upsertNodes ?? []) {
		parseWithSchema(WorkingNodeDraftSchema, draft, "upsert node");
		const id = draft.id ?? newId("n");
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

	const next = { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
	validateActiveSet(next.nodes, next.edges);
	return next;
}

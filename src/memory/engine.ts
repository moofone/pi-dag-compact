import { join } from "node:path";
import { parseWithSchema } from "../schema/validate.ts";
import type {
	ActiveSelection,
	MutationBatch,
	PiRefData,
	WorkingEdge,
	WorkingNode,
} from "../schema/working.ts";
import {
	MutationBatchSchema,
	PiRefDataSchema,
	WorkingEdgeSchema,
	WorkingNodeDraftSchema,
	WorkingNodeSchema,
} from "../schema/working.ts";
import { canonicalBatch, canonicalSnapshot, edgeKey, newId, sha256 } from "./canonical.ts";
import { DagError } from "./errors.ts";
import { cloneEdges, cloneNodes, validateActiveSet } from "./graph.ts";
import { LIMITS, utf8Bytes } from "./limits.ts";
import { scanHistory } from "./retrieval.ts";
import {
	issueSelectionRevision,
	isTerminal,
	pinnedIds,
	type ResolvedSelection,
	resolveSelection,
	selectionStateHash,
	validateSelectionDraft,
} from "./selection.ts";
import {
	type ArchivedRow,
	type ArchiveKey,
	parseGraph,
	type RevisionRow,
	type RevisionStatus,
	SqliteStore,
} from "./store.ts";

export interface BranchContext {
	sessionId: string;
	leafId: string;
}

export interface WorkingSnapshot {
	taskId: string;
	revisionId: string | null;
	revision: number;
	/** D1: checkpoint identity equals revision identity. */
	checkpointId: string | null;
	nodes: WorkingNode[];
	edges: WorkingEdge[];
	/** The committed explicit selection, or null when none was ever set. */
	explicitSelection: ActiveSelection | null;
	/** Explicit selection merged with structural derivation for this revision. */
	selection: ActiveSelection;
	/** Selection slots the structure could not decide without an explicit ID. */
	ambiguousSelections: string[];
	/**
	 * A committed operation with no acknowledged reference. It is durable and it
	 * is selected by nothing; it never appears in the published view above.
	 */
	pending: { operationId: string; revisionId: string } | null;
	/** Set when the last load could not account for the selected revision. */
	fault: ReconstructionFault | null;
}

/**
 * What a load refused to accept, and why.
 *
 * A fault means the engine published nothing. It never means "we fell back to
 * something older": an older revision cannot stand in for a selected one whose
 * content could not be verified.
 */
export interface ReconstructionFault {
	code: string;
	detail: string;
	revisionId: string | null;
}

export interface CommitResult {
	revisionId: string;
	revision: number;
	operationId: string;
	payloadHash: string;
	snapshotHash: string;
	/** D1: identical to `revisionId`. */
	checkpointId: string;
	status: RevisionStatus;
	/** True when this receipt already existed and nothing new was committed. */
	replayed: boolean;
	/** The acknowledged reference entry, when this revision already has one. */
	piEntryId: string | null;
	nodes: WorkingNode[];
	edges: WorkingEdge[];
	/** IDs the engine issued for drafts that arrived without one. */
	assignedIds: string[];
	selection: ActiveSelection;
	selectionHash: string;
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
	/** The session entry carrying the reference, when the caller knows it. */
	entryId?: string;
}

/** The published revision, as it was loaded and verified from one row. */
interface LoadedRevision {
	row: RevisionRow;
	nodes: WorkingNode[];
	edges: WorkingEdge[];
	explicitSelection: ActiveSelection | null;
}

const REF_TYPES = new Set(["dag_revision_ref", "dag_checkpoint_ref"]);

export class MemoryEngine {
	readonly taskId: string;
	readonly sessionId: string;
	private readonly store: SqliteStore;
	/**
	 * The published revision: the one the branch pointer selects and the only one
	 * any public surface may show. A SQLite commit does not put anything here.
	 */
	private published: LoadedRevision | null = null;
	/** The prepared, unacknowledged operation on this scope, if any. */
	private candidate: RevisionRow | null = null;
	private fault: ReconstructionFault | null = null;

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

	/**
	 * The published view.
	 *
	 * Never the candidate, never "the latest row in SQLite". Between a commit and
	 * its acknowledgement this keeps returning the previous selection, which is
	 * the whole point of the two-store protocol.
	 */
	snapshot(): WorkingSnapshot {
		const nodes = this.published ? this.published.nodes : [];
		const edges = this.published ? this.published.edges : [];
		const explicit = this.published?.explicitSelection ?? null;
		const revision = this.published?.row.revision ?? 0;
		const resolved = resolveSelection(nodes, edges, explicit, Math.max(revision, 1));
		return {
			taskId: this.taskId,
			revisionId: this.published?.row.revisionId ?? null,
			revision,
			checkpointId: this.published?.row.revisionId ?? null,
			nodes: cloneNodes(nodes),
			edges: cloneEdges(edges),
			explicitSelection: explicit,
			selection: resolved.selection,
			ambiguousSelections: resolved.ambiguous,
			pending: this.candidate
				? { operationId: this.candidate.operationId, revisionId: this.candidate.revisionId }
				: null,
			fault: this.fault,
		};
	}

	/** The last load's refusal, if it refused. */
	get reconstructionFault(): ReconstructionFault | null {
		return this.fault;
	}

	/**
	 * The snapshot hash recomputed from the state that was actually loaded.
	 *
	 * D1/D04: a review binds to this, never to the stored `payload_hash` column.
	 * The column is checked against this value at load time, so by the time a
	 * revision is published the two have already been made to agree.
	 */
	selectedSnapshotHash(): string | null {
		if (!this.published) return null;
		return sha256(canonicalSnapshot(this.published.nodes, this.published.edges));
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
			if (existingRev.expectedSessionId !== branch.sessionId) {
				throw new DagError(
					"scope_conflict",
					`operation ${batch.operationId} belongs to session ${existingRev.expectedSessionId}, not ${branch.sessionId}`,
				);
			}
			// The receipt, and nothing else: no new revision, no branch movement,
			// and the caller must not append a second reference for it.
			return this.commitResultFromRow(existingRev, true);
		}

		if (this.fault) {
			throw new DagError(
				"corrupt_state",
				`cannot commit onto unverified state: ${this.fault.code}: ${this.fault.detail}`,
			);
		}

		const competing = this.pendingAtPublishedPosition(branch.sessionId);
		if (competing) {
			throw new DagError(
				"pending_operation",
				`operation ${competing.operationId} is prepared and unacknowledged on this scope; acknowledge or quarantine it before another update`,
			);
		}

		const baseNodes = this.published?.nodes ?? [];
		const baseEdges = this.published?.edges ?? [];
		const baseSelection = this.published?.explicitSelection ?? null;
		const parentRevisionId = this.published?.row.revisionId ?? null;
		const nextRevision = (this.published?.row.revision ?? 0) + 1;
		const next = applyBatch(baseNodes, baseEdges, batch, nextRevision, baseSelection);
		validateActiveSet(next.nodes, next.edges);
		const explicitSelection = nextExplicitSelection(batch, baseSelection, next.nodes, nextRevision);
		const resolved = resolveSelection(next.nodes, next.edges, explicitSelection, nextRevision);
		const snapshotHash = sha256(canonicalSnapshot(next.nodes, next.edges));
		const revisionId = newId("rev");

		const row: RevisionRow = {
			revisionId,
			revision: nextRevision,
			parentRevisionId,
			operationId: batch.operationId,
			payloadHash: snapshotHash,
			// D1: the revision is its own checkpoint. No second table, no replay bound.
			checkpointId: revisionId,
			nodesJson: JSON.stringify(next.nodes),
			edgesJson: JSON.stringify(next.edges),
			selectionJson: explicitSelection ? JSON.stringify(explicitSelection) : null,
			selectionHash: selectionStateHash(explicitSelection),
			status: "prepared",
			ackDurability: null,
			expectedSessionId: branch.sessionId,
			expectedBranchLeafId: branch.leafId,
			piEntryId: null,
			createdAt: Date.now(),
		};

		this.store.transaction(() => {
			this.store.putOperation(batch.operationId, batchHash, batchJson);
			this.store.insertRevision(row);
			for (const id of batch.archiveIds ?? []) {
				const archived = baseNodes.find((node) => node.id === id);
				if (archived) this.store.archiveNode(id, revisionId, JSON.stringify(archived));
			}
		});

		this.candidate = row;

		return {
			revisionId,
			revision: row.revision,
			operationId: batch.operationId,
			payloadHash: batchHash,
			snapshotHash,
			checkpointId: revisionId,
			status: "prepared",
			replayed: false,
			piEntryId: null,
			nodes: cloneNodes(next.nodes),
			edges: cloneEdges(next.edges),
			assignedIds: next.assignedIds,
			selection: resolved.selection,
			selectionHash: row.selectionHash,
			piRef: {
				v: 1,
				taskId: this.taskId,
				operationId: batch.operationId,
				revisionId,
				payloadHash: snapshotHash,
				checkpointId: revisionId,
			},
		};
	}

	/**
	 * Publish an operation whose reference the host has taken.
	 *
	 * The expected parent is compared here, not assumed: a revision may only be
	 * published onto the position it was prepared against.
	 */
	acknowledgeRef(operationId: string, entryId: string, durability?: string): void {
		const row = this.store.getRevisionByOperation(operationId);
		if (!row) throw new DagError("unknown_revision", `no revision for operation ${operationId}`);
		if (row.status === "unselected") return;
		if (row.status === "selected") {
			// Reconcile once. A second acknowledgement of the same revision is a
			// no-op, not a second publication.
			if (this.published?.row.revisionId !== row.revisionId) this.publishRow(row);
			return;
		}
		const publishedId = this.published?.row.revisionId ?? null;
		if (row.parentRevisionId !== publishedId) {
			throw new DagError(
				"expected_parent_mismatch",
				`revision ${row.revisionId} expects parent ${row.parentRevisionId ?? "(none)"}, but ${publishedId ?? "(none)"} is published`,
			);
		}
		this.store.setRevisionStatus(row.revisionId, "selected", entryId, durability ?? null);
		const selected = this.store.getRevision(row.revisionId);
		if (selected) this.publishRow(selected);
		if (this.candidate?.revisionId === row.revisionId) this.candidate = null;
	}

	/**
	 * Quarantine an operation.
	 *
	 * It stays in the store for audit and never becomes selectable. This is the
	 * resolution a failed Pi append gets: the work is durable, and it is not
	 * allowed to leak into whatever is published next.
	 */
	markUnselected(operationId: string): void {
		const row = this.store.getRevisionByOperation(operationId);
		if (!row) return;
		this.store.setRevisionStatus(row.revisionId, "unselected", row.piEntryId);
		if (this.candidate?.revisionId === row.revisionId) this.candidate = null;
		if (this.published?.row.revisionId === row.revisionId) {
			const parent = row.parentRevisionId
				? this.store.getRevision(row.parentRevisionId)
				: undefined;
			if (parent) this.publishRow(parent);
			else this.clearPublished();
		}
	}

	/**
	 * Rebuild from the branch, which is the only selection authority.
	 *
	 * Every reference on the branch must be readable; the last one names the
	 * selected revision; that revision is loaded from its own single row and
	 * re-verified — snapshot hash, selection hash, schema, dependency subgraph and
	 * parent linkage — before anything is published. A refusal publishes nothing.
	 */
	reconstruct(branchRefs: PiRefLike[]): WorkingSnapshot {
		this.fault = null;
		this.candidate = null;
		const entries = branchRefs.filter((entry) => REF_TYPES.has(entry.customType));
		const refs: PiRefData[] = [];
		for (const entry of entries) {
			try {
				refs.push(parseWithSchema(PiRefDataSchema, entry.data, "pi ref"));
			} catch (error) {
				// An unreadable reference is a lost reference, not an absent one. An
				// older readable reference must not quietly take its place.
				return this.failLoad({
					code: "corrupt_ref",
					detail: `a ${entry.customType} entry on the branch could not be read: ${
						error instanceof Error ? error.message : String(error)
					}`,
					revisionId: null,
				});
			}
		}
		const latest = refs.at(-1);
		if (!latest) {
			this.clearPublished();
			return this.snapshot();
		}
		const row = this.store.getRevision(latest.revisionId);
		if (!row) {
			return this.failLoad({
				code: "corrupt_ref",
				detail: `the branch selects revision ${latest.revisionId}, which is not in the store`,
				revisionId: latest.revisionId,
			});
		}
		if (row.status === "unselected") {
			return this.failLoad({
				code: "unselected",
				detail: `the branch selects quarantined revision ${row.revisionId}`,
				revisionId: row.revisionId,
			});
		}
		if (row.payloadHash !== latest.payloadHash) {
			return this.failLoad({
				code: "corrupt_ref",
				detail: `revision ${row.revisionId} does not match the payload hash its reference carries`,
				revisionId: row.revisionId,
			});
		}
		let loaded: LoadedRevision;
		try {
			loaded = this.loadRevision(row);
		} catch (error) {
			return this.failLoad({
				code: error instanceof DagError ? error.code : "corrupt_state",
				detail: error instanceof Error ? error.message : String(error),
				revisionId: row.revisionId,
			});
		}
		if (row.status === "prepared") {
			// The pointer is on the branch and the acknowledgement is missing. The
			// pointer is the authority, so it reconciles here — once.
			const entryId = entries.at(-1)?.entryId ?? row.piEntryId ?? `reconciled:${row.revisionId}`;
			this.store.setRevisionStatus(row.revisionId, "selected", entryId);
			const reloaded = this.store.getRevision(row.revisionId);
			if (reloaded) loaded.row = reloaded;
		}
		this.published = loaded;
		return this.snapshot();
	}

	/**
	 * Offer references the host never took.
	 *
	 * Appended only when the expected branch and the expected parent both still
	 * match. On the expected branch with a parent that is no longer published,
	 * the record is quarantined rather than applied to a different ancestry.
	 */
	reconcilePending(
		branch: BranchContext,
		appendRef: (ref: PiRefData, checkpoint: boolean) => string | undefined,
	): void {
		for (const row of this.store.listPendingForSession(branch.sessionId)) {
			if (row.expectedBranchLeafId !== branch.leafId) continue;
			const publishedId = this.published?.row.revisionId ?? null;
			if (row.parentRevisionId !== publishedId) {
				this.store.setRevisionStatus(row.revisionId, "unselected", row.piEntryId);
				if (this.candidate?.revisionId === row.revisionId) this.candidate = null;
				continue;
			}
			const entryId = appendRef(this.commitResultFromRow(row, false).piRef, true);
			if (!entryId) continue;
			this.acknowledgeRef(row.operationId, entryId);
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

	/**
	 * Bounded literal search of archived history.
	 *
	 * Matching happens in process over record fields, so `%` and `_` are
	 * ordinary characters rather than SQL wildcards.
	 */
	archivedSearch(query: string, limit: number): WorkingNode[] {
		return scanHistory(this, {
			needle: query,
			highWater: this.archivedHighWater(),
			after: null,
			scanBudgetBytes: LIMITS.historyScanBytes,
			maxMatches: limit,
		}).matches.map((match) => match.node);
	}

	// --- bounded durable reads (RetrievalSource) ---------------------------

	snapshotNodes(): WorkingNode[] {
		return cloneNodes(this.published?.nodes ?? []);
	}

	snapshotRevisionId(): string | null {
		return this.published?.row.revisionId ?? null;
	}

	archivedHighWater(): number {
		return this.store.archivedHighWater();
	}

	archivedPage(highWater: number, after: ArchiveKey | null, limit: number): ArchivedRow[] {
		return this.store.archivedPage(highWater, after, limit);
	}

	archivedVersions(id: string): ArchivedRow[] {
		return this.store.archivedVersions(id);
	}

	revisionStatus(revisionId: string): string | undefined {
		return this.store.getRevision(revisionId)?.status;
	}

	/** Revision identity and shape, never the whole snapshot payload. */
	revisionMeta(revisionId: string): Record<string, unknown> | undefined {
		const row = this.store.getRevision(revisionId);
		if (!row) return undefined;
		const graph = parseGraph(row.nodesJson, row.edgesJson);
		return {
			revisionId: row.revisionId,
			revision: row.revision,
			parentRevisionId: row.parentRevisionId,
			operationId: row.operationId,
			payloadHash: row.payloadHash,
			checkpointId: row.checkpointId,
			status: row.status,
			createdAt: row.createdAt,
			nodeCount: graph.nodes.length,
			edgeCount: graph.edges.length,
		};
	}

	checkpointMeta(checkpointId: string): Record<string, unknown> | undefined {
		const row = this.store.getCheckpoint(checkpointId, this.taskId);
		if (!row) return undefined;
		let schemaVersion: unknown;
		let workingRevisionId: unknown;
		let nodeCount = 0;
		try {
			const payload = JSON.parse(row.payloadJson) as {
				schemaVersion?: unknown;
				workingRevisionId?: unknown;
				nodes?: unknown[];
			};
			schemaVersion = payload.schemaVersion;
			workingRevisionId = payload.workingRevisionId;
			nodeCount = Array.isArray(payload.nodes) ? payload.nodes.length : 0;
		} catch {
			// A checkpoint whose payload will not parse still has an identity.
		}
		return {
			checkpointId: row.checkpointId,
			revisionId: row.revisionId,
			payloadHash: row.payloadHash,
			createdAt: row.createdAt,
			schemaVersion,
			workingRevisionId,
			nodeCount,
		};
	}

	researchRecord(recordId: string): Record<string, unknown> | undefined {
		const row = this.store.getResearchEvent(recordId);
		if (!row) return undefined;
		let payload: unknown;
		try {
			payload = JSON.parse(row.payloadJson) as unknown;
		} catch {
			payload = null;
		}
		return {
			recordId: row.recordId,
			operationId: row.operationId,
			kind: row.kind,
			payloadHash: row.payloadHash,
			payload,
		};
	}

	private clearPublished(): void {
		this.published = null;
	}

	private publishRow(row: RevisionRow): void {
		this.published = this.loadRevision(row);
	}

	private failLoad(fault: ReconstructionFault): never {
		this.fault = fault;
		this.published = null;
		this.candidate = null;
		throw new DagError(fault.code, fault.detail);
	}

	/**
	 * Load and re-verify one revision from its own row.
	 *
	 * Reconstruction is one row read plus verification (D1). The stored hash
	 * columns are treated as claims about the JSON beside them, never as
	 * evidence: both are recomputed from what was actually parsed, the records
	 * are revalidated against the schema, the whole dependency subgraph is
	 * rechecked, and the parent link must resolve.
	 */
	private loadRevision(row: RevisionRow): LoadedRevision {
		let graph: { nodes: WorkingNode[]; edges: WorkingEdge[] };
		try {
			graph = parseGraph(row.nodesJson, row.edgesJson);
		} catch (error) {
			throw new DagError(
				"corrupt_snapshot",
				`revision ${row.revisionId} does not hold readable state: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
			throw new DagError("corrupt_snapshot", `revision ${row.revisionId} does not hold a graph`);
		}
		const recomputed = sha256(canonicalSnapshot(graph.nodes, graph.edges));
		if (recomputed !== row.payloadHash) {
			throw new DagError(
				"corrupt_snapshot",
				`revision ${row.revisionId} does not hash to its stored payload hash`,
			);
		}
		for (const node of graph.nodes) {
			parseWithSchema(WorkingNodeSchema, node, `revision ${row.revisionId} node`);
		}
		for (const edge of graph.edges) {
			parseWithSchema(WorkingEdgeSchema, edge, `revision ${row.revisionId} edge`);
		}
		validateActiveSet(graph.nodes, graph.edges);

		let explicitSelection: ActiveSelection | null = null;
		if (row.selectionJson) {
			try {
				explicitSelection = JSON.parse(row.selectionJson) as ActiveSelection;
			} catch (error) {
				throw new DagError(
					"corrupt_selection",
					`revision ${row.revisionId} does not hold a readable selection: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		// A store written before R2 has no selection hash to compare against.
		if (row.selectionHash && selectionStateHash(explicitSelection) !== row.selectionHash) {
			throw new DagError(
				"corrupt_selection",
				`revision ${row.revisionId} does not hash to its stored selection hash`,
			);
		}
		if (row.parentRevisionId && !this.store.getRevision(row.parentRevisionId)) {
			throw new DagError(
				"corrupt_parent",
				`revision ${row.revisionId} names parent ${row.parentRevisionId}, which is not in the store`,
			);
		}
		return { row, nodes: graph.nodes, edges: graph.edges, explicitSelection };
	}

	/**
	 * A prepared operation competing for the position the published revision
	 * occupies. Work prepared against some other ancestry is not competing for
	 * this one and does not block it.
	 */
	private pendingAtPublishedPosition(sessionId: string): RevisionRow | undefined {
		const publishedId = this.published?.row.revisionId ?? null;
		return this.store
			.listPendingForSession(sessionId)
			.find((row) => row.parentRevisionId === publishedId);
	}

	private commitResultFromRow(row: RevisionRow, replayed: boolean): CommitResult {
		const graph = parseGraph(row.nodesJson, row.edgesJson);
		const explicit = row.selectionJson ? (JSON.parse(row.selectionJson) as ActiveSelection) : null;
		const resolved = resolveSelection(graph.nodes, graph.edges, explicit, row.revision);
		return {
			revisionId: row.revisionId,
			revision: row.revision,
			operationId: row.operationId,
			payloadHash: this.store.getOperation(row.operationId)?.payloadHash ?? row.payloadHash,
			snapshotHash: row.payloadHash,
			checkpointId: row.revisionId,
			status: row.status,
			replayed,
			piEntryId: row.piEntryId,
			nodes: graph.nodes,
			edges: graph.edges,
			assignedIds: [],
			selection: resolved.selection,
			selectionHash: row.selectionHash,
			piRef: {
				v: 1,
				taskId: this.taskId,
				operationId: row.operationId,
				revisionId: row.revisionId,
				payloadHash: row.payloadHash,
				checkpointId: row.revisionId,
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

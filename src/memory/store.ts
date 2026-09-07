import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkingEdge, WorkingNode } from "../schema/working.ts";

/**
 * Explicit operation states.
 *
 * `prepared` — committed to SQLite, offered to nothing. Durable, and selected
 * by nothing: the branch pointer is the selection authority, and a SQLite row
 * is not a branch pointer.
 * `selected` — its reference is on the branch and the selection was
 * acknowledged here.
 * `unselected` — quarantined. It stays for audit and is never published.
 *
 * Stores written before R2 use `pending_ref`; it is read back as `prepared`.
 */
export type RevisionStatus = "prepared" | "selected" | "unselected";

const LEGACY_STATUS: Record<string, RevisionStatus> = { pending_ref: "prepared" };

export interface RevisionRow {
	revisionId: string;
	revision: number;
	parentRevisionId: string | null;
	operationId: string;
	payloadHash: string;
	checkpointId: string | null;
	nodesJson: string;
	edgesJson: string;
	selectionJson: string | null;
	/** sha256 of the canonical committed selection, or of its deliberate absence. */
	selectionHash: string;
	status: RevisionStatus;
	/** What the host was observed to do with the reference append (R1 vocabulary). */
	ackDurability: string | null;
	expectedSessionId: string;
	expectedBranchLeafId: string;
	piEntryId: string | null;
	createdAt: number;
}

export interface OperationRow {
	operationId: string;
	payloadHash: string;
	payload: string;
}

export interface ResearchEventRow {
	recordId: string;
	operationId: string;
	kind: string;
	payloadHash: string;
	payloadJson: string;
}

/**
 * A checkpoint row, derived from its revision.
 *
 * D1: one full immutable snapshot per revision, and checkpoint identity equals
 * revision identity. There is no second copy of the graph; `checkpoints` is a
 * view over `revisions`, and this row is materialized from one revision row.
 */
export interface CheckpointRow {
	checkpointId: string;
	revisionId: string;
	payloadJson: string;
	payloadHash: string;
	createdAt: number;
}

/** One archived node version, addressed by the composite `(id, revisionId)`. */
export interface ArchivedRow {
	/** Monotonic archive position, used as the scan high-water mark. */
	seq: number;
	id: string;
	revisionId: string;
	payloadJson: string;
}

export type ArchiveKey = [string, string];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS task_meta (
  task_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  writer_session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  revision_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  parent_revision_id TEXT,
  operation_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  checkpoint_id TEXT,
  nodes_json TEXT NOT NULL,
  edges_json TEXT NOT NULL,
  selection_json TEXT,
  selection_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  ack_durability TEXT,
  expected_session_id TEXT NOT NULL,
  expected_branch_leaf_id TEXT NOT NULL,
  pi_entry_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_parent ON revisions (parent_revision_id);
CREATE TABLE IF NOT EXISTS archived_nodes (
  id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, revision_id)
);
CREATE TABLE IF NOT EXISTS research_events (
  record_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  origin_session_id TEXT,
  inherited_revision_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS experiment_runs (
  run_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class SqliteStore {
	readonly db: DatabaseSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec(SCHEMA);
		this.addMissingColumns();
		this.reduceCheckpointsToView();
	}

	/**
	 * Additive column repair for stores created before schema v2. Full migration
	 * with mode/version gating belongs to R8; this only prevents a v1 store from
	 * failing at first read.
	 */
	private addMissingColumns(): void {
		const wanted: Array<[string, string, string]> = [
			["revisions", "selection_json", "TEXT"],
			["revisions", "selection_hash", "TEXT NOT NULL DEFAULT ''"],
			["revisions", "ack_durability", "TEXT"],
			["research_events", "payload_hash", "TEXT NOT NULL DEFAULT ''"],
		];
		for (const [table, column, definition] of wanted) {
			const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
				name: string;
			}>;
			if (columns.some((row) => row.name === column)) continue;
			this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
		}
	}

	/**
	 * D1: `checkpoints` is a view over `revisions`, never a second table.
	 *
	 * A store written before R2 still has the old table; converting it belongs to
	 * R8's migration, so here the view is only created when nothing occupies the
	 * name. Either way nothing writes a second copy of the graph again.
	 */
	private reduceCheckpointsToView(): void {
		const existing = this.db
			.prepare("SELECT type FROM sqlite_master WHERE name = 'checkpoints'")
			.get() as { type?: string } | undefined;
		if (existing?.type === "table") return;
		this.db.exec(
			`CREATE VIEW IF NOT EXISTS checkpoints AS
         SELECT revision_id AS checkpoint_id, revision_id, payload_hash, created_at
         FROM revisions WHERE status != 'unselected'`,
		);
	}

	close(): void {
		this.db.close();
	}

	transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// keep original error
			}
			throw error;
		}
	}

	getWriter(taskId: string): string | null {
		const row = this.db
			.prepare("SELECT writer_session_id FROM task_meta WHERE task_id = ?")
			.get(taskId) as { writer_session_id: string | null } | undefined;
		return row?.writer_session_id ?? null;
	}

	ensureTask(taskId: string, sessionId: string): void {
		const existing = this.db
			.prepare("SELECT task_id, writer_session_id FROM task_meta WHERE task_id = ?")
			.get(taskId) as { task_id: string; writer_session_id: string | null } | undefined;
		if (!existing) {
			this.db
				.prepare(
					"INSERT INTO task_meta (task_id, schema_version, writer_session_id, created_at) VALUES (?, 1, ?, ?)",
				)
				.run(taskId, sessionId, Date.now());
			return;
		}
		this.db
			.prepare("UPDATE task_meta SET writer_session_id = ? WHERE task_id = ?")
			.run(sessionId, taskId);
	}

	releaseWriter(taskId: string): void {
		this.db.prepare("UPDATE task_meta SET writer_session_id = NULL WHERE task_id = ?").run(taskId);
	}

	getOperation(operationId: string): OperationRow | undefined {
		const row = this.db
			.prepare("SELECT operation_id, payload_hash, payload FROM operations WHERE operation_id = ?")
			.get(operationId) as
			| { operation_id: string; payload_hash: string; payload: string }
			| undefined;
		if (!row) return undefined;
		return { operationId: row.operation_id, payloadHash: row.payload_hash, payload: row.payload };
	}

	putOperation(operationId: string, payloadHash: string, payload: string): void {
		this.db
			.prepare(
				"INSERT INTO operations (operation_id, payload_hash, payload, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(operationId, payloadHash, payload, Date.now());
	}

	getRevision(revisionId: string): RevisionRow | undefined {
		return this.mapRevision(
			this.db.prepare("SELECT * FROM revisions WHERE revision_id = ?").get(revisionId) as
				| Record<string, unknown>
				| undefined,
		);
	}

	listPending(sessionId: string, leafId: string): RevisionRow[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM revisions WHERE status IN ('prepared', 'pending_ref') AND expected_session_id = ? AND expected_branch_leaf_id = ?",
			)
			.all(sessionId, leafId) as Array<Record<string, unknown>>;
		return rows
			.map((row) => this.mapRevision(row))
			.filter((row): row is RevisionRow => row !== undefined);
	}

	listPendingForSession(sessionId: string): RevisionRow[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM revisions WHERE status IN ('prepared', 'pending_ref') AND expected_session_id = ? ORDER BY revision",
			)
			.all(sessionId) as Array<Record<string, unknown>>;
		return rows
			.map((row) => this.mapRevision(row))
			.filter((row): row is RevisionRow => row !== undefined);
	}

	getRevisionByOperation(operationId: string): RevisionRow | undefined {
		return this.mapRevision(
			this.db.prepare("SELECT * FROM revisions WHERE operation_id = ?").get(operationId) as
				| Record<string, unknown>
				| undefined,
		);
	}

	insertRevision(row: RevisionRow): void {
		this.db
			.prepare(
				`INSERT INTO revisions (
          revision_id, revision, parent_revision_id, operation_id, payload_hash, checkpoint_id,
          nodes_json, edges_json, selection_json, selection_hash, status, ack_durability,
          expected_session_id, expected_branch_leaf_id, pi_entry_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.revisionId,
				row.revision,
				row.parentRevisionId,
				row.operationId,
				row.payloadHash,
				row.checkpointId,
				row.nodesJson,
				row.edgesJson,
				row.selectionJson,
				row.selectionHash,
				row.status,
				row.ackDurability,
				row.expectedSessionId,
				row.expectedBranchLeafId,
				row.piEntryId,
				row.createdAt,
			);
	}

	setRevisionStatus(
		revisionId: string,
		status: RevisionStatus,
		piEntryId: string | null,
		ackDurability: string | null = null,
	): void {
		this.db
			.prepare(
				"UPDATE revisions SET status = ?, pi_entry_id = ?, ack_durability = COALESCE(?, ack_durability) WHERE revision_id = ?",
			)
			.run(status, piEntryId, ackDurability, revisionId);
	}

	/** Revisions whose parent is this one, whatever their status. */
	childRevisions(parentRevisionId: string): RevisionRow[] {
		const rows = this.db
			.prepare("SELECT * FROM revisions WHERE parent_revision_id = ?")
			.all(parentRevisionId) as Array<Record<string, unknown>>;
		return rows
			.map((row) => this.mapRevision(row))
			.filter((row): row is RevisionRow => row !== undefined);
	}

	archiveNode(id: string, revisionId: string, payloadJson: string): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO archived_nodes (id, revision_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(id, revisionId, payloadJson, Date.now());
	}

	/**
	 * Highest archive row identity currently stored.
	 *
	 * A bounded scan freezes this value and answers only about rows at or below
	 * it, so history appended while the caller pages cannot appear halfway
	 * through a paged answer or make coverage claims dishonest.
	 */
	archivedHighWater(): number {
		const row = this.db.prepare("SELECT MAX(rowid) AS hw FROM archived_nodes").get() as
			| { hw: number | null }
			| undefined;
		return Number(row?.hw ?? 0);
	}

	/**
	 * One keyset page of archived rows ordered by the composite `(id,
	 * revision_id)`. Ordering by ID alone would let a page boundary step over a
	 * second archived version of the same record.
	 */
	archivedPage(highWater: number, after: ArchiveKey | null, limit: number): ArchivedRow[] {
		const rows = after
			? (this.db
					.prepare(
						`SELECT rowid AS seq, id, revision_id, payload_json FROM archived_nodes
             WHERE rowid <= ? AND (id > ? OR (id = ? AND revision_id > ?))
             ORDER BY id, revision_id
             LIMIT ?`,
					)
					.all(highWater, after[0], after[0], after[1], limit) as Array<Record<string, unknown>>)
			: (this.db
					.prepare(
						`SELECT rowid AS seq, id, revision_id, payload_json FROM archived_nodes
             WHERE rowid <= ?
             ORDER BY id, revision_id
             LIMIT ?`,
					)
					.all(highWater, limit) as Array<Record<string, unknown>>);
		return rows.map((row) => ({
			seq: Number(row.seq),
			id: String(row.id),
			revisionId: String(row.revision_id),
			payloadJson: String(row.payload_json),
		}));
	}

	/** Every archived version of one record ID, oldest first. */
	archivedVersions(id: string): ArchivedRow[] {
		const rows = this.db
			.prepare(
				"SELECT rowid AS seq, id, revision_id, payload_json FROM archived_nodes WHERE id = ? ORDER BY rowid",
			)
			.all(id) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			seq: Number(row.seq),
			id: String(row.id),
			revisionId: String(row.revision_id),
			payloadJson: String(row.payload_json),
		}));
	}

	/**
	 * The checkpoint for a revision, materialized from that revision's own row.
	 *
	 * Under D1 there is nothing else to read: the revision is the checkpoint, so
	 * a checkpoint id is a revision id and the payload is built here rather than
	 * stored a second time.
	 */
	getCheckpoint(checkpointId: string, taskId: string): CheckpointRow | undefined {
		const row = this.getRevision(checkpointId);
		if (!row || row.status === "unselected") return undefined;
		const graph = parseGraph(row.nodesJson, row.edgesJson);
		const payload = {
			schemaVersion: 2,
			checkpointId: row.revisionId,
			sessionId: row.expectedSessionId,
			branchAnchorId: row.expectedBranchLeafId,
			coveredThroughEntryId: row.piEntryId ?? row.expectedBranchLeafId,
			workingRevision: row.revision,
			workingRevisionId: row.revisionId,
			researchTaskId: taskId,
			selection: row.selectionJson ? JSON.parse(row.selectionJson) : null,
			requiredUserEntryIds: [],
			requiredEvidence: graph.nodes.flatMap((node) => node.evidence),
			nodes: graph.nodes,
			edges: graph.edges,
		};
		return {
			checkpointId: row.revisionId,
			revisionId: row.revisionId,
			payloadJson: JSON.stringify(payload),
			payloadHash: row.payloadHash,
			createdAt: row.createdAt,
		};
	}

	getResearchEvent(recordId: string): ResearchEventRow | undefined {
		const row = this.db
			.prepare(
				"SELECT record_id, operation_id, kind, payload_hash, payload_json FROM research_events WHERE record_id = ?",
			)
			.get(recordId) as Record<string, unknown> | undefined;
		if (!row) return undefined;
		return {
			recordId: String(row.record_id),
			operationId: String(row.operation_id),
			kind: String(row.kind),
			payloadHash: String(row.payload_hash),
			payloadJson: String(row.payload_json),
		};
	}

	insertResearchEvent(
		recordId: string,
		operationId: string,
		kind: string,
		payloadJson: string,
		payloadHash: string,
	): void {
		this.db
			.prepare(
				"INSERT INTO research_events (record_id, operation_id, kind, payload_hash, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(recordId, operationId, kind, payloadHash, payloadJson, Date.now());
	}

	getResearchEventByOperation(operationId: string): ResearchEventRow | undefined {
		const row = this.db
			.prepare(
				"SELECT record_id, operation_id, kind, payload_hash, payload_json FROM research_events WHERE operation_id = ?",
			)
			.get(operationId) as
			| {
					record_id: string;
					operation_id: string;
					kind: string;
					payload_hash: string;
					payload_json: string;
			  }
			| undefined;
		if (!row) return undefined;
		return {
			recordId: row.record_id,
			operationId: row.operation_id,
			kind: row.kind,
			payloadHash: row.payload_hash,
			payloadJson: row.payload_json,
		};
	}

	listResearchEventsByKind(kind: string): ResearchEventRow[] {
		const rows = this.db
			.prepare(
				"SELECT record_id, operation_id, kind, payload_hash, payload_json FROM research_events WHERE kind = ? ORDER BY created_at",
			)
			.all(kind) as Array<{
			record_id: string;
			operation_id: string;
			kind: string;
			payload_hash: string;
			payload_json: string;
		}>;
		return rows.map((row) => ({
			recordId: row.record_id,
			operationId: row.operation_id,
			kind: row.kind,
			payloadHash: row.payload_hash,
			payloadJson: row.payload_json,
		}));
	}

	insertAttachment(
		attachmentId: string,
		sessionId: string,
		originSessionId: string | null,
		inheritedRevisionId: string | null,
	): void {
		this.db
			.prepare(
				"INSERT INTO attachments (attachment_id, session_id, origin_session_id, inherited_revision_id, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(attachmentId, sessionId, originSessionId, inheritedRevisionId, Date.now());
	}

	getRun(
		runId: string,
	): { runId: string; operationId: string; status: string; payloadJson: string } | undefined {
		const row = this.db
			.prepare(
				"SELECT run_id, operation_id, status, payload_json FROM experiment_runs WHERE run_id = ?",
			)
			.get(runId) as
			| { run_id: string; operation_id: string; status: string; payload_json: string }
			| undefined;
		if (!row) return undefined;
		return {
			runId: row.run_id,
			operationId: row.operation_id,
			status: row.status,
			payloadJson: row.payload_json,
		};
	}

	putRun(runId: string, operationId: string, status: string, payloadJson: string): void {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO experiment_runs (run_id, operation_id, status, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           operation_id = excluded.operation_id,
           status = excluded.status,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
			)
			.run(runId, operationId, status, payloadJson, now, now);
	}

	private mapRevision(row: Record<string, unknown> | undefined): RevisionRow | undefined {
		if (!row) return undefined;
		return {
			revisionId: String(row.revision_id),
			revision: Number(row.revision),
			parentRevisionId: (row.parent_revision_id as string | null) ?? null,
			operationId: String(row.operation_id),
			payloadHash: String(row.payload_hash),
			checkpointId: (row.checkpoint_id as string | null) ?? null,
			nodesJson: String(row.nodes_json),
			edgesJson: String(row.edges_json),
			selectionJson: (row.selection_json as string | null) ?? null,
			selectionHash: String(row.selection_hash ?? ""),
			status: LEGACY_STATUS[String(row.status)] ?? (row.status as RevisionStatus),
			ackDurability: (row.ack_durability as string | null) ?? null,
			expectedSessionId: String(row.expected_session_id),
			expectedBranchLeafId: String(row.expected_branch_leaf_id),
			piEntryId: (row.pi_entry_id as string | null) ?? null,
			createdAt: Number(row.created_at),
		};
	}
}

export function parseGraph(
	nodesJson: string,
	edgesJson: string,
): { nodes: WorkingNode[]; edges: WorkingEdge[] } {
	return {
		nodes: JSON.parse(nodesJson) as WorkingNode[],
		edges: JSON.parse(edgesJson) as WorkingEdge[],
	};
}

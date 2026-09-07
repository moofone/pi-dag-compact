import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine } from "../memory/engine.ts";
import { LIMITS, utf8Bytes } from "../memory/limits.ts";
import type { MutationBatch, WorkingNodeDraft } from "../schema/working.ts";

/**
 * Storage growth for D1, measured at near-cap active state.
 *
 * D1 stores one full immutable snapshot per revision, so the disk cost of the
 * design is exactly this number and there is no point measuring it on a small
 * fixture. Each revision here carries a 200-node active set close to the
 * 128 KiB serialized cap, and every revision is committed, referenced and
 * acknowledged through the production path.
 *
 * §11 sets a 48 MiB target for 300 near-cap revisions including WAL. The
 * numbers are reported, never relabeled: a miss is a miss.
 */

export interface RevisionGrowthResult {
	revisions: number;
	nodesPerRevision: number;
	/** Serialized active-set bytes of the last revision; the cap is 128 KiB. */
	activeSetBytes: number;
	/** Sizes while the store is still open: the live WAL is at its peak here. */
	live: { databaseBytes: number; walBytes: number; shmBytes: number; storageBytes: number };
	databaseBytes: number;
	walBytes: number;
	shmBytes: number;
	/** Database + WAL + shm after close, which is what survives the process. */
	storageBytes: number;
	/** The larger of the live and settled totals; the §11 target is judged on this. */
	peakStorageBytes: number;
	sessionBytes: number;
	totalBytes: number;
	targetBytes: number;
	withinTarget: boolean;
	/**
	 * Process RSS growth across the run. Not the M05 incremental-RSS measurement,
	 * which R8 owns: this includes uncollected garbage from 500 commits.
	 */
	rssDeltaBytes: number;
	heapDeltaBytes: number;
	bytesPerRevision: number;
	/** Wall time for the whole run, so the cost is not reported without it. */
	elapsedMs: number;
}

const REVISIONS = 300;
const NODES = LIMITS.maxNodes;
/** Padding chosen so 200 nodes land just under the 128 KiB serialized cap. */
const BODY_BYTES = 435;

function sizeOf(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function nodeDraft(index: number, revision: number): WorkingNodeDraft {
	const marker = `r${revision}n${index}`;
	return {
		id: `n-${String(index).padStart(3, "0")}`,
		kind: index === 0 ? "goal" : index === 1 ? "constraint" : "hypothesis",
		title: `near-cap record ${index} at revision ${revision}`.slice(0, LIMITS.maxTitle),
		// Distinct content per revision: a snapshot store must not be measured on
		// text that a page cache or a compressor would make free.
		body: `${marker} ${marker.repeat(Math.ceil(BODY_BYTES / (marker.length + 1)))}`.slice(
			0,
			BODY_BYTES,
		),
		status: index % 7 === 0 ? "rejected" : "open",
		evidence: [{ kind: "artifact", path: `runs/run-${index}/result.json`, sha256: marker }],
		paths: [`src/candidate-${index}.cu`],
	};
}

function batchFor(revision: number): MutationBatch {
	const upsertNodes: WorkingNodeDraft[] = [];
	// One batch may not exceed 16 KiB, so a revision changes a slice of the
	// active set rather than rewriting all 200 records at once. The stored
	// snapshot is still the whole set — that is the cost being measured.
	const first = ((revision * 8) % NODES) + 0;
	for (let offset = 0; offset < 8; offset += 1) {
		upsertNodes.push(nodeDraft((first + offset) % NODES, revision));
	}
	return { operationId: `growth-${revision}`, upsertNodes };
}

export function measureRevisionGrowth(): RevisionGrowthResult {
	const started = Date.now();
	const root = mkdtempSync(join(tmpdir(), "pi-dag-growth-"));
	const taskDir = join(root, "task");
	const sessionPath = join(root, "session.jsonl");
	const rssBefore = process.memoryUsage().rss;
	const heapBefore = process.memoryUsage().heapUsed;
	try {
		const engine = MemoryEngine.open(taskDir, "growth-session");
		// A minimal stand-in for the Pi session file: one JSONL line per
		// reference, which is what the host writes for a custom entry. The session
		// growth being measured is the reference count, not a transcript.
		const session = createLineSession(sessionPath);

		// Fill to the cap first, in batches that respect the 16 KiB batch limit.
		let revision = 0;
		for (let start = 0; start < NODES; start += 8) {
			revision += 1;
			const upsertNodes: WorkingNodeDraft[] = [];
			for (let offset = 0; offset < 8 && start + offset < NODES; offset += 1) {
				upsertNodes.push(nodeDraft(start + offset, revision));
			}
			publish(engine, session, { operationId: `fill-${start}`, upsertNodes });
		}

		for (let index = 1; index <= REVISIONS; index += 1) {
			publish(engine, session, batchFor(index));
		}

		const snapshot = engine.snapshot();
		const activeSetBytes = utf8Bytes(
			JSON.stringify({ nodes: snapshot.nodes, edges: snapshot.edges }),
		);
		const liveDatabase = sizeOf(join(taskDir, "memory.sqlite"));
		const liveWal = sizeOf(join(taskDir, "memory.sqlite-wal"));
		const liveShm = sizeOf(join(taskDir, "memory.sqlite-shm"));
		const rssAtPeak = process.memoryUsage().rss;
		const heapAtPeak = process.memoryUsage().heapUsed;
		engine.close();
		session.close();

		const databaseBytes = sizeOf(join(taskDir, "memory.sqlite"));
		const walBytes = sizeOf(join(taskDir, "memory.sqlite-wal"));
		const shmBytes = sizeOf(join(taskDir, "memory.sqlite-shm"));
		const sessionBytes = sizeOf(sessionPath);
		const storageBytes = databaseBytes + walBytes + shmBytes;
		const liveStorageBytes = liveDatabase + liveWal + liveShm;
		const peakStorageBytes = Math.max(storageBytes, liveStorageBytes);
		const targetBytes = 48 * 1024 * 1024;
		return {
			revisions: REVISIONS,
			nodesPerRevision: snapshot.nodes.length,
			activeSetBytes,
			live: {
				databaseBytes: liveDatabase,
				walBytes: liveWal,
				shmBytes: liveShm,
				storageBytes: liveStorageBytes,
			},
			databaseBytes,
			walBytes,
			shmBytes,
			storageBytes,
			peakStorageBytes,
			sessionBytes,
			totalBytes: peakStorageBytes + sessionBytes,
			targetBytes,
			withinTarget: peakStorageBytes <= targetBytes,
			rssDeltaBytes: rssAtPeak - rssBefore,
			heapDeltaBytes: heapAtPeak - heapBefore,
			bytesPerRevision: Math.round(peakStorageBytes / REVISIONS),
			elapsedMs: Date.now() - started,
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

interface LineSession {
	append(line: unknown): string;
	close(): void;
}

function createLineSession(path: string): LineSession {
	const fd = openSync(path, "a");
	let counter = 0;
	return {
		append(line) {
			counter += 1;
			const id = `entry-${counter}`;
			writeSync(fd, `${JSON.stringify({ id, type: "custom", ...(line as object) })}\n`);
			return id;
		},
		close() {
			closeSync(fd);
		},
	};
}

function publish(engine: MemoryEngine, session: LineSession, batch: MutationBatch): void {
	const commit = engine.update(batch, { sessionId: "growth-session", leafId: "growth-leaf" });
	const entryId = session.append({ customType: "dag_checkpoint_ref", data: commit.piRef });
	engine.acknowledgeRef(commit.operationId, entryId, "present_in_file");
}

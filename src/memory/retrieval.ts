/**
 * Bounded retrieval: typed ID resolution, literal search, honest cursors and
 * chunked reads.
 *
 * Two rules govern everything here. First, no response may exceed its byte
 * budget: a record that cannot fit is delivered as a bounded chunk with a
 * forward-progressing offset, never dropped and never overflowed. Second, a
 * query reports the scope it searched and how much of it was covered, so a miss
 * inside a bounded scan is never reported as a definitive no-match. An active
 * miss says nothing about unsearched history.
 */

import type { WorkingNode } from "../schema/working.ts";
import { sha256 } from "./canonical.ts";
import { LIMITS, utf8Bytes } from "./limits.ts";
import type { ArchivedRow, ArchiveKey } from "./store.ts";

export type { ArchivedRow, ArchiveKey };

export type QueryScope = "active" | "history";

/** Terminal outcome for one requested ID. These are three different answers. */
export type IdStatus = "found" | "missing" | "unavailable_source" | "partial";

export type RecordType =
	| "node"
	| "archived_node"
	| "revision"
	| "checkpoint"
	| "research"
	| "unknown";

export type CursorRejectionReason =
	| "malformed"
	| "scope_changed"
	| "query_changed"
	| "revision_changed";

export interface ChunkView {
	id: string;
	byteOffset: number;
	bytes: number;
	totalBytes: number;
	complete: boolean;
	/** Byte offset of the next chunk, or null when the record is complete. */
	nextByteOffset: number | null;
	text: string;
}

export interface IdOutcome {
	id: string;
	type: RecordType;
	status: IdStatus;
	bytes: number;
	/** Payload for records that are not working nodes; nodes go in `records`. */
	record?: unknown;
	chunk?: ChunkView;
	reason?: string;
}

export interface QueryCoverage {
	scope: QueryScope;
	revisionId: string | null;
	scannedBytes: number;
	scanComplete: boolean;
	scanLimitBytes: number;
	/** Frozen archive position this scan is answering about. */
	highWaterMark: number | null;
	matched: number;
}

/** The narrow durable-read surface retrieval needs from the engine. */
export interface RetrievalSource {
	snapshotNodes(): WorkingNode[];
	snapshotRevisionId(): string | null;
	archivedHighWater(): number;
	archivedPage(highWater: number, after: ArchiveKey | null, limit: number): ArchivedRow[];
	archivedVersions(id: string): ArchivedRow[];
	revisionMeta(revisionId: string): Record<string, unknown> | undefined;
	revisionStatus(revisionId: string): string | undefined;
	checkpointMeta(checkpointId: string): Record<string, unknown> | undefined;
	researchRecord(recordId: string): Record<string, unknown> | undefined;
}

/** Bytes reserved inside a page for the continuation cursor and deferred list. */
const CURSOR_RESERVE = 384;
const SCAN_BATCH = 200;

export function matchesLiteral(node: WorkingNode, needle: string): boolean {
	if (!needle) return true;
	const haystack = `${node.id}\n${node.title}\n${node.body}\n${node.kind}\n${node.status}`;
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * A byte-bounded slice that never splits a UTF-8 sequence.
 *
 * `byteOffset` must be a boundary produced by a previous `nextByteOffset`;
 * the returned chunks concatenate back to the original text exactly.
 */
export function sliceUtf8(
	id: string,
	text: string,
	byteOffset: number,
	maxBytes: number,
): ChunkView {
	const buffer = Buffer.from(text, "utf8");
	const totalBytes = buffer.length;
	const start = Math.min(Math.max(0, Math.trunc(byteOffset)), totalBytes);
	let end = Math.min(start + Math.max(1, Math.trunc(maxBytes)), totalBytes);
	while (end > start && end < totalBytes && ((buffer[end] ?? 0) & 0xc0) === 0x80) {
		end -= 1;
	}
	if (end === start && start < totalBytes) {
		// One code point is wider than the budget: emit it whole rather than
		// stall, so a chunked read always makes forward progress.
		end = start + 1;
		while (end < totalBytes && ((buffer[end] ?? 0) & 0xc0) === 0x80) end += 1;
	}
	const complete = end >= totalBytes;
	return {
		id,
		byteOffset: start,
		bytes: end - start,
		totalBytes,
		complete,
		nextByteOffset: complete ? null : end,
		text: buffer.subarray(start, end).toString("utf8"),
	};
}

interface ActiveCursorState {
	v: 1;
	s: "active";
	q: string;
	r: string | null;
	a: string;
}

interface HistoryCursorState {
	v: 1;
	s: "history";
	q: string;
	hw: number;
	k: ArchiveKey | null;
}

export type CursorState = ActiveCursorState | HistoryCursorState;

export function queryFingerprint(q: string | undefined): string {
	return sha256(q ?? "").slice(0, 16);
}

export function encodeCursor(state: CursorState): string {
	return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorState | null {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorState;
		if (parsed?.v !== 1) return null;
		if (parsed.s !== "active" && parsed.s !== "history") return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Validate a cursor against the request that presents it.
 *
 * A cursor is bound to its scope, its query and — for the active set — the
 * revision it was issued against. Anything else is rejected by name, never
 * silently reinterpreted as "start again".
 */
export function rejectCursor(
	cursor: string,
	scope: QueryScope,
	q: string | undefined,
	revisionId: string | null,
): { state: CursorState } | { reason: CursorRejectionReason } {
	const state = decodeCursor(cursor);
	if (!state) return { reason: "malformed" };
	if (state.s !== scope) return { reason: "scope_changed" };
	if (state.q !== queryFingerprint(q)) return { reason: "query_changed" };
	if (state.s === "active" && state.r !== revisionId) return { reason: "revision_changed" };
	return { state };
}

export interface HistoryScanPage {
	matches: Array<{ node: WorkingNode; key: ArchiveKey }>;
	scannedBytes: number;
	scanComplete: boolean;
	lastScannedKey: ArchiveKey | null;
}

/**
 * One bounded pass over archived payloads.
 *
 * Ordering is the composite `(id, revision_id)`, so every archived version of
 * an ID is visited and resumption cannot step over a sibling version. The scan
 * is capped both by the 4 MiB payload budget and by a frozen high-water mark,
 * so history appended while the caller pages is outside this answer's scope
 * rather than silently folded into it.
 */
export function scanHistory(
	source: RetrievalSource,
	options: {
		needle: string;
		highWater: number;
		after: ArchiveKey | null;
		scanBudgetBytes: number;
		maxMatches: number;
	},
): HistoryScanPage {
	const matches: Array<{ node: WorkingNode; key: ArchiveKey }> = [];
	let scannedBytes = 0;
	let scanComplete = false;
	let position: ArchiveKey | null = options.after;
	let lastScannedKey: ArchiveKey | null = options.after;

	for (;;) {
		const rows = source.archivedPage(options.highWater, position, SCAN_BATCH);
		if (rows.length === 0) {
			scanComplete = true;
			break;
		}
		let stopped = false;
		for (const row of rows) {
			scannedBytes += utf8Bytes(row.payloadJson);
			const key: ArchiveKey = [row.id, row.revisionId];
			lastScannedKey = key;
			position = key;
			const node = parseNode(row.payloadJson);
			if (node && matchesLiteral(node, options.needle)) matches.push({ node, key });
			if (matches.length >= options.maxMatches || scannedBytes >= options.scanBudgetBytes) {
				stopped = true;
				break;
			}
		}
		if (stopped) break;
		if (rows.length < SCAN_BATCH) {
			scanComplete = true;
			break;
		}
	}

	return { matches, scannedBytes, scanComplete, lastScannedKey };
}

function parseNode(payloadJson: string): WorkingNode | null {
	try {
		return JSON.parse(payloadJson) as WorkingNode;
	} catch {
		return null;
	}
}

export function responseBytes(value: unknown): number {
	return utf8Bytes(JSON.stringify(value));
}

/** A record is oversized when it cannot fit any response on its own. */
export interface OversizedRef {
	id: string;
	type: RecordType;
	totalBytes: number;
}

export interface Resolution {
	id: string;
	type: RecordType;
	status: "found" | "missing" | "unavailable_source";
	node?: WorkingNode;
	payload?: unknown;
	reason?: string;
}

/**
 * Typed resolution of one durable ID.
 *
 * Active scope answers only about the active set: a miss there is
 * `not_in_active_set`, which is a statement about the active set and not about
 * history. History scope resolves archived nodes, revisions, checkpoints and
 * research records by indexed exact-ID lookup.
 *
 * TODO(4.3): foreign-origin evidence — an unrelated session ID whose entry ID
 * happens to match locally, and copied origin evidence that outlives the
 * originating transcript — resolves through R3's writer claims and origin/copy
 * mappings, which do not exist yet. Those sub-cases belong to task 4.3.
 */
export function resolveId(source: RetrievalSource, id: string, scope: QueryScope): Resolution {
	const active = source.snapshotNodes().find((node) => node.id === id);
	if (active) return { id, type: "node", status: "found", node: active };
	if (scope === "active") {
		return {
			id,
			type: "unknown",
			status: "missing",
			reason: "not_in_active_set",
		};
	}

	const versions = source.archivedVersions(id);
	const latest = versions.at(-1);
	if (latest) {
		const node = parseNode(latest.payloadJson);
		if (!node) {
			return {
				id,
				type: "archived_node",
				status: "unavailable_source",
				reason: "unreadable_archived_payload",
			};
		}
		return { id, type: "archived_node", status: "found", node };
	}

	const revisionStatus = source.revisionStatus(id);
	if (revisionStatus !== undefined) {
		if (revisionStatus === "unselected") {
			return {
				id,
				type: "revision",
				status: "unavailable_source",
				reason: "unselected_revision",
			};
		}
		const meta = source.revisionMeta(id);
		if (!meta) {
			return { id, type: "revision", status: "unavailable_source", reason: "missing_revision_row" };
		}
		return { id, type: "revision", status: "found", payload: meta };
	}

	const checkpoint = source.checkpointMeta(id);
	if (checkpoint) return { id, type: "checkpoint", status: "found", payload: checkpoint };

	const research = source.researchRecord(id);
	if (research) return { id, type: "research", status: "found", payload: research };

	return { id, type: "unknown", status: "missing", reason: "no_such_record" };
}

export function resolutionSize(resolution: Resolution): number {
	if (resolution.node) return responseBytes(resolution.node);
	if (resolution.payload !== undefined) return responseBytes(resolution.payload);
	return 0;
}

export function resolutionText(resolution: Resolution): string {
	return JSON.stringify(resolution.node ?? resolution.payload ?? null);
}

/**
 * Fit a chunk of `text` into whatever the response envelope leaves free.
 *
 * The chunk is embedded as a JSON string, so escaping can nearly double its
 * encoded size. Shrink until the whole serialized response fits rather than
 * trusting a raw byte count.
 */
export function fitChunk(
	id: string,
	text: string,
	byteOffset: number,
	build: (chunk: ChunkView) => unknown,
): ChunkView {
	const probe = sliceUtf8(id, text, byteOffset, 1);
	const overhead = responseBytes(build({ ...probe, text: "", bytes: 0 }));
	let budget = Math.max(1, LIMITS.maxQueryBytes - overhead - 16);
	let chunk = sliceUtf8(id, text, byteOffset, budget);
	for (let attempt = 0; attempt < 24; attempt += 1) {
		if (responseBytes(build(chunk)) <= LIMITS.maxQueryBytes) return chunk;
		if (budget <= 1) break;
		budget = Math.max(1, Math.floor(budget * 0.6));
		chunk = sliceUtf8(id, text, byteOffset, budget);
	}
	return chunk;
}

export { CURSOR_RESERVE };

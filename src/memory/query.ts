import { parseWithSchema } from "../schema/validate.ts";
import type { ActiveSelection, QueryRequest, WorkingNode } from "../schema/working.ts";
import { QueryRequestSchema } from "../schema/working.ts";
import type { MemoryEngine } from "./engine.ts";
import { prerequisiteOrder } from "./graph.ts";
import { LIMITS } from "./limits.ts";
import {
	type ArchiveKey,
	type ChunkView,
	type CursorRejectionReason,
	encodeCursor,
	fitChunk,
	type IdOutcome,
	matchesLiteral,
	type OversizedRef,
	type QueryCoverage,
	type QueryScope,
	queryFingerprint,
	type RecordType,
	type Resolution,
	rejectCursor,
	resolutionSize,
	resolutionText,
	resolveId,
	responseBytes,
	scanHistory,
} from "./retrieval.ts";

export interface QueryResult {
	scope: QueryScope;
	/** True only when every requested record was returned in full. */
	complete: boolean;
	truncated: boolean;
	cursor?: string;
	records: WorkingNode[];
	bytes: number;
	/** What was searched and how much of it was covered. */
	coverage: QueryCoverage;
	/** Per-ID outcomes for a bounded ID read. */
	ids?: IdOutcome[];
	/** Requested IDs that did not fit and must be asked for again. */
	deferredIds?: string[];
	/** Records too large for any response; read them with `chunkOf`. */
	oversized?: OversizedRef[];
	chunk?: ChunkView;
	cursorRejected?: { reason: CursorRejectionReason };
}

/** A stand-in of realistic length so budgeting accounts for the cursor. */
const CURSOR_PLACEHOLDER = "c".repeat(200);

function coverageFor(
	engine: MemoryEngine,
	scope: QueryScope,
	revisionId: string | null,
): QueryCoverage {
	return {
		scope,
		revisionId,
		scannedBytes: 0,
		scanComplete: true,
		scanLimitBytes: scope === "history" ? LIMITS.historyScanBytes : LIMITS.maxSerializedBytes,
		highWaterMark: scope === "history" ? engine.archivedHighWater() : null,
		matched: 0,
	};
}

interface Packed {
	records: WorkingNode[];
	oversized: OversizedRef[];
	bytes: number;
	truncated: boolean;
	/** Candidates taken off the front of the list, returned or oversized. */
	consumed: number;
}

/**
 * Fill one page without ever overflowing the response.
 *
 * Every trial is measured on the serialized response, envelope, separators and
 * a cursor allowance included, not on the sum of record payloads. A record that
 * cannot fit even an empty page is reported as oversized and the page continues
 * past it, so pagination always makes forward progress instead of stalling on
 * a single large entry.
 */
function packRecords(
	candidates: WorkingNode[],
	type: RecordType,
	build: (records: WorkingNode[], oversized: OversizedRef[], bytes: number) => unknown,
): Packed {
	const records: WorkingNode[] = [];
	const oversized: OversizedRef[] = [];
	let bytes = 0;
	let truncated = false;
	let consumed = 0;

	for (const node of candidates) {
		if (records.length >= LIMITS.maxQueryRecords) {
			truncated = true;
			break;
		}
		const size = responseBytes(node);
		if (responseBytes(build([...records, node], oversized, bytes + size)) <= LIMITS.maxQueryBytes) {
			records.push(node);
			bytes += size;
			consumed += 1;
			continue;
		}
		if (records.length === 0) {
			oversized.push({ id: node.id, type, totalBytes: size });
			truncated = true;
			consumed += 1;
			continue;
		}
		truncated = true;
		break;
	}

	return { records, oversized, bytes, truncated, consumed };
}

function rejectedResult(
	engine: MemoryEngine,
	scope: QueryScope,
	revisionId: string | null,
	reason: CursorRejectionReason,
): QueryResult {
	const coverage = coverageFor(engine, scope, revisionId);
	coverage.scanComplete = false;
	return {
		scope,
		complete: false,
		truncated: false,
		records: [],
		bytes: 0,
		coverage,
		cursorRejected: { reason },
	};
}

function activeSearch(
	engine: MemoryEngine,
	request: QueryRequest,
	revisionId: string | null,
	after: string | undefined,
): QueryResult {
	const snapshot = engine.snapshot();
	const order = new Map(
		prerequisiteOrder(snapshot.nodes, snapshot.edges).map((id, index) => [id, index]),
	);
	const needle = request.q ?? "";
	const matched = snapshot.nodes
		.filter((node) => matchesLiteral(node, needle))
		.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
	const scannedBytes = snapshot.nodes.reduce((sum, node) => sum + responseBytes(node), 0);

	let start = 0;
	if (after !== undefined) {
		const index = matched.findIndex((node) => node.id === after);
		// The revision is pinned by the cursor, so the ordering cannot have
		// moved; an unknown anchor means the cursor is not one we issued.
		if (index < 0) return rejectedResult(engine, "active", revisionId, "malformed");
		start = index + 1;
	}
	const candidates = matched.slice(start);

	const coverage: QueryCoverage = {
		scope: "active",
		revisionId,
		scannedBytes,
		scanComplete: true,
		scanLimitBytes: LIMITS.maxSerializedBytes,
		highWaterMark: null,
		matched: matched.length,
	};
	const build = (
		records: WorkingNode[],
		oversized: OversizedRef[],
		bytes: number,
	): Record<string, unknown> => ({
		scope: "active",
		complete: false,
		truncated: true,
		cursor: CURSOR_PLACEHOLDER,
		records,
		bytes,
		coverage,
		...(oversized.length > 0 ? { oversized } : {}),
	});

	const packed = packRecords(candidates, "node", build);
	const consumedAll = packed.consumed >= candidates.length;
	const result: QueryResult = {
		scope: "active",
		complete: consumedAll && packed.oversized.length === 0,
		truncated: packed.truncated,
		records: packed.records,
		bytes: packed.bytes,
		coverage,
		...(packed.oversized.length > 0 ? { oversized: packed.oversized } : {}),
	};
	if (!consumedAll && packed.consumed > 0) {
		const last = candidates[packed.consumed - 1];
		if (last) {
			result.cursor = encodeCursor({
				v: 1,
				s: "active",
				q: queryFingerprint(request.q),
				r: revisionId,
				a: last.id,
			});
		}
	}
	return result;
}

function historySearch(
	engine: MemoryEngine,
	request: QueryRequest,
	revisionId: string | null,
	resume: { hw: number; k: ArchiveKey | null } | undefined,
): QueryResult {
	const highWater = resume ? resume.hw : engine.archivedHighWater();
	const scan = scanHistory(engine, {
		needle: request.q ?? "",
		highWater,
		after: resume?.k ?? null,
		scanBudgetBytes: LIMITS.historyScanBytes,
		maxMatches: LIMITS.maxQueryRecords + 1,
	});

	const coverage: QueryCoverage = {
		scope: "history",
		revisionId,
		scannedBytes: scan.scannedBytes,
		scanComplete: scan.scanComplete,
		scanLimitBytes: LIMITS.historyScanBytes,
		highWaterMark: highWater,
		matched: scan.matches.length,
	};
	const build = (
		records: WorkingNode[],
		oversized: OversizedRef[],
		bytes: number,
	): Record<string, unknown> => ({
		scope: "history",
		complete: false,
		truncated: true,
		cursor: CURSOR_PLACEHOLDER,
		records,
		bytes,
		coverage,
		...(oversized.length > 0 ? { oversized } : {}),
	});

	const nodes = scan.matches.map((match) => match.node);
	const packed = packRecords(nodes, "archived_node", build);
	const consumedAll = packed.consumed >= nodes.length;
	const resumeKey: ArchiveKey | null = consumedAll
		? scan.lastScannedKey
		: (scan.matches[packed.consumed - 1]?.key ?? scan.lastScannedKey);
	const more = !scan.scanComplete || !consumedAll;

	const result: QueryResult = {
		scope: "history",
		complete: scan.scanComplete && consumedAll && packed.oversized.length === 0,
		truncated: packed.truncated,
		records: packed.records,
		bytes: packed.bytes,
		coverage,
		...(packed.oversized.length > 0 ? { oversized: packed.oversized } : {}),
	};
	if (more && resumeKey) {
		result.cursor = encodeCursor({
			v: 1,
			s: "history",
			q: queryFingerprint(request.q),
			hw: highWater,
			k: resumeKey,
		});
	}
	return result;
}

function outcomeFor(resolution: Resolution): IdOutcome {
	if (resolution.status !== "found") {
		return {
			id: resolution.id,
			type: resolution.type,
			status: resolution.status,
			bytes: 0,
			...(resolution.reason ? { reason: resolution.reason } : {}),
		};
	}
	return {
		id: resolution.id,
		type: resolution.type,
		status: "found",
		bytes: resolutionSize(resolution),
		// Working nodes travel in `records`; other durable records carry their
		// bounded payload here, so nothing is serialized twice.
		...(resolution.node ? {} : { record: resolution.payload }),
	};
}

/**
 * A bounded ID read with a per-ID outcome.
 *
 * Missing, unavailable-source and partial are three different answers and stay
 * distinct. IDs that do not fit the response are named in `deferredIds` rather
 * than dropped, and a single record too large for any response comes back as a
 * bounded chunk. Either way the caller can always make progress, and a request
 * whose records were not all returned is never reported as complete.
 */
function readIds(
	engine: MemoryEngine,
	request: QueryRequest,
	scope: QueryScope,
	revisionId: string | null,
): QueryResult {
	const coverage = coverageFor(engine, scope, revisionId);
	const outcomes: IdOutcome[] = [];
	const records: WorkingNode[] = [];
	const deferred: string[] = [];
	let bytes = 0;
	let stopped = false;

	const build = (
		ids: IdOutcome[],
		pageRecords: WorkingNode[],
		deferredIds: string[],
		pageBytes: number,
	): Record<string, unknown> => ({
		scope,
		complete: false,
		truncated: true,
		records: pageRecords,
		bytes: pageBytes,
		coverage,
		ids,
		...(deferredIds.length > 0 ? { deferredIds } : {}),
	});

	for (const id of request.ids ?? []) {
		if (stopped) {
			deferred.push(id);
			continue;
		}
		const resolution = resolveId(engine, id, scope);
		const outcome = outcomeFor(resolution);
		const nextRecords = resolution.node ? [...records, resolution.node] : records;
		const trial = build([...outcomes, outcome], nextRecords, deferred, bytes + outcome.bytes);
		if (responseBytes(trial) <= LIMITS.maxQueryBytes) {
			outcomes.push(outcome);
			if (resolution.node) records.push(resolution.node);
			bytes += outcome.bytes;
			continue;
		}
		if (outcomes.length === 0) {
			const text = resolutionText(resolution);
			const chunk = fitChunk(id, text, 0, (view) =>
				build(
					[{ id, type: resolution.type, status: "partial", bytes: view.bytes, chunk: view }],
					[],
					deferred,
					view.bytes,
				),
			);
			outcomes.push({ id, type: resolution.type, status: "partial", bytes: chunk.bytes, chunk });
			bytes += chunk.bytes;
			stopped = true;
			continue;
		}
		deferred.push(id);
		stopped = true;
	}

	coverage.scannedBytes = bytes;
	coverage.matched = outcomes.filter((outcome) => outcome.status !== "missing").length;

	return {
		scope,
		complete: deferred.length === 0 && outcomes.every((outcome) => outcome.status === "found"),
		truncated: deferred.length > 0 || outcomes.some((outcome) => outcome.status === "partial"),
		records,
		bytes,
		coverage,
		ids: outcomes,
		...(deferred.length > 0 ? { deferredIds: deferred } : {}),
	};
}

function readChunk(
	engine: MemoryEngine,
	request: QueryRequest,
	scope: QueryScope,
	revisionId: string | null,
): QueryResult {
	const id = request.chunkOf ?? "";
	const coverage = coverageFor(engine, scope, revisionId);
	const resolution = resolveId(engine, id, scope);
	if (resolution.status !== "found") {
		return {
			scope,
			complete: false,
			truncated: false,
			records: [],
			bytes: 0,
			coverage,
			ids: [outcomeFor(resolution)],
		};
	}
	const text = resolutionText(resolution);
	const build = (chunk: ChunkView): QueryResult => ({
		scope,
		complete: chunk.complete,
		truncated: !chunk.complete,
		records: [],
		bytes: chunk.bytes,
		coverage: { ...coverage, scannedBytes: chunk.bytes, matched: 1 },
		chunk,
	});
	return build(fitChunk(id, text, request.chunkOffset ?? 0, build));
}

/**
 * Search the active set or archived history, resolve typed IDs, or read one
 * record in bounded chunks. Read-only in every path: nothing here commits a
 * revision, changes a selection, or writes evidence.
 */
export function queryWorkingSet(engine: MemoryEngine, requestInput: QueryRequest): QueryResult {
	const request = parseWithSchema(QueryRequestSchema, requestInput, "dag_query");
	const scope = request.scope;
	const revisionId = engine.snapshotRevisionId();

	if (request.chunkOf) return readChunk(engine, request, scope, revisionId);

	if (request.cursor) {
		const checked = rejectCursor(request.cursor, scope, request.q, revisionId);
		if ("reason" in checked) return rejectedResult(engine, scope, revisionId, checked.reason);
		if (checked.state.s === "active") {
			return activeSearch(engine, request, revisionId, checked.state.a);
		}
		return historySearch(engine, request, revisionId, {
			hw: checked.state.hw,
			k: checked.state.k,
		});
	}

	if (request.ids && request.ids.length > 0) return readIds(engine, request, scope, revisionId);

	return scope === "active"
		? activeSearch(engine, request, revisionId, undefined)
		: historySearch(engine, request, revisionId, undefined);
}

export interface DagStatus {
	objective: WorkingNode[];
	constraints: WorkingNode[];
	acceptedBaseline: WorkingNode[];
	bestObserved: WorkingNode[];
	bestValidated: WorkingNode[];
	currentWork: WorkingNode[];
	blockers: WorkingNode[];
	unresolved: WorkingNode[];
	nextAction: WorkingNode[];
	rejected: WorkingNode[];
	selection: ActiveSelection;
	ambiguousSelections: string[];
	revisionId: string | null;
}

/**
 * Project the active set through its typed selection.
 *
 * Every list here comes from selected record IDs. Nothing is matched on title
 * text: whether a record is the accepted baseline is a decision recorded in
 * the selection, not a property of what it is called.
 */
export function dagStatus(engine: MemoryEngine): DagStatus {
	const { nodes, revisionId, selection, ambiguousSelections } = engine.snapshot();
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const pick = (ids: string[]): WorkingNode[] =>
		ids.map((id) => byId.get(id)).filter((node): node is WorkingNode => node !== undefined);
	const one = (id: string | null): WorkingNode[] => (id ? pick([id]) : []);

	// Blockers are their own kind plus anything explicitly blocked; unresolved
	// questions are a different thing and are never folded into them.
	const blockers = [
		...nodes.filter((node) => node.kind === "blocker" && node.status === "open"),
		...nodes.filter((node) => node.kind !== "blocker" && node.status === "blocked"),
	];

	return {
		objective: one(selection.objectiveId || null),
		constraints: pick(selection.constraintIds),
		acceptedBaseline: one(selection.acceptedBaselineRecordId),
		bestObserved: one(selection.bestObservedRecordId),
		bestValidated: one(selection.bestValidatedRecordId),
		currentWork: pick(selection.currentWorkIds),
		blockers,
		unresolved: pick(selection.unresolvedIds).filter((node) => node.kind !== "blocker"),
		nextAction: pick(selection.nextActionIds),
		rejected: pick(selection.rejectedApproachIds),
		selection,
		ambiguousSelections,
		revisionId,
	};
}

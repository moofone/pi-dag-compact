/**
 * The retrieval contract the R6 fixtures assert.
 *
 * Declared structurally in test support rather than imported from `src`, so the
 * RED run against the unfixed candidate is a failing assertion about a returned
 * value and never a missing-import link error.
 */

export type IdStatus = "found" | "missing" | "unavailable_source" | "partial";

export type RecordType =
	| "node"
	| "archived_node"
	| "revision"
	| "checkpoint"
	| "research"
	| "unknown";

export interface ChunkViewShape {
	id: string;
	byteOffset: number;
	bytes: number;
	totalBytes: number;
	complete: boolean;
	nextByteOffset: number | null;
	text: string;
}

export interface IdOutcomeShape {
	id: string;
	type: RecordType;
	status: IdStatus;
	bytes: number;
	record?: { id?: string; title?: string; body?: string } & Record<string, unknown>;
	chunk?: ChunkViewShape;
	reason?: string;
}

export interface CoverageShape {
	scope: "active" | "history";
	revisionId: string | null;
	scannedBytes: number;
	scanComplete: boolean;
	scanLimitBytes: number;
	highWaterMark: number | null;
	matched: number;
}

export interface RecordShape {
	id: string;
	title: string;
	body: string;
	status: string;
	revision: number;
	evidence: unknown[];
	paths: string[];
}

export interface QueryResultShape {
	scope: "active" | "history";
	complete: boolean;
	truncated: boolean;
	cursor?: string;
	records: RecordShape[];
	bytes: number;
	coverage?: CoverageShape;
	ids?: IdOutcomeShape[];
	deferredIds?: string[];
	oversized?: Array<{ id: string; type: RecordType; totalBytes: number }>;
	chunk?: ChunkViewShape;
	cursorRejected?: { reason: string };
}

export function asQueryResult(value: unknown): QueryResultShape {
	return value as QueryResultShape;
}

export interface SessionEvidenceShape {
	entry?: { id: string; type?: string; totalBytes?: number };
	chunk?: ChunkViewShape;
	unavailable?: true;
	reason?: string;
}

export function asSessionEvidence(value: unknown): SessionEvidenceShape {
	return value as SessionEvidenceShape;
}

/** Serialized size of one outcome, used to build size-tuned fixtures. */
export function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

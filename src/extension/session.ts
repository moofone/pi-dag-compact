import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

type BranchReader = { getBranch(): readonly SessionEntry[] };

import type { PiRefLike } from "../memory/engine.ts";
import { utf8Bytes } from "../memory/limits.ts";
import { type ChunkView, fitChunk } from "../memory/retrieval.ts";
import { parseWithSchema } from "../schema/validate.ts";
import type { PiRefData } from "../schema/working.ts";
import { PiRefDataSchema } from "../schema/working.ts";

export function collectPiRefs(sessionManager: BranchReader): PiRefLike[] {
	return collectPiRefsFromEntries(sessionManager.getBranch());
}

export function collectPiRefsFromEntries(entries: readonly SessionEntry[]): PiRefLike[] {
	const refs: PiRefLike[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== "dag_revision_ref" && entry.customType !== "dag_checkpoint_ref")
			continue;
		try {
			const data = parseWithSchema(PiRefDataSchema, entry.data, "pi ref");
			refs.push({ customType: entry.customType, data });
		} catch {
			// skip malformed refs
		}
	}
	return refs;
}

export function appendPiRef(
	sessionManager: SessionManager,
	ref: PiRefData,
	checkpoint: boolean,
): string {
	const customType = checkpoint ? "dag_checkpoint_ref" : "dag_revision_ref";
	return sessionManager.appendCustomEntry(customType, ref);
}

export function findCopiedEntry(
	sessionManager: SessionManager,
	entryId: string,
): SessionEntry | undefined {
	return sessionManager.getBranch().find((entry) => entry.id === entryId);
}

/**
 * Bounded header of a transcript entry. Identity and shape only: the entry's
 * content is delivered through `chunk`, never inlined whole.
 */
export interface SessionEntryHeader {
	id: string;
	type: string;
	parentId: string | null;
	timestamp: string | null;
	totalBytes: number;
}

export type SessionEvidence =
	| { entry: SessionEntryHeader; chunk: ChunkView }
	| { unavailable: true; reason: "missing_entry" | "uncopied_foreign_entry" };

export interface SessionReadOptions {
	byteOffset?: number;
}

function header(entry: SessionEntry, totalBytes: number): SessionEntryHeader {
	const record = entry as unknown as {
		id: string;
		type: string;
		parentId?: string | null;
		timestamp?: string | null;
	};
	return {
		id: record.id,
		type: record.type,
		parentId: record.parentId ?? null,
		timestamp: record.timestamp ?? null,
		totalBytes,
	};
}

/**
 * Resolve session-qualified evidence and return a bounded chunk of it.
 *
 * A transcript entry has no size limit, so `session_read` never emits one
 * whole. The caller walks `nextByteOffset` until `complete`, and the chunks
 * concatenate back to the entry exactly.
 *
 * TODO(4.3): foreign-origin resolution — telling an unrelated session ID that
 * happens to share an entry ID from genuinely copied origin evidence — needs
 * R3's origin/copy mappings. Until then a branch-local match is accepted, and
 * the L03 sub-cases stay deferred to task 4.3.
 */
export function resolveSessionEvidence(
	sessionManager: {
		getSessionId(): string;
		getBranch(): readonly SessionEntry[];
		getEntry(id: string): SessionEntry | undefined;
	},
	sessionId: string,
	entryId: string,
	options: SessionReadOptions = {},
): SessionEvidence {
	const current = sessionManager.getSessionId();
	const found =
		sessionId === current
			? (sessionManager.getEntry(entryId) ??
				sessionManager.getBranch().find((item) => item.id === entryId))
			: (sessionManager.getBranch().find((item) => item.id === entryId) ??
				sessionManager.getEntry(entryId));
	if (!found) {
		return {
			unavailable: true,
			reason: sessionId === current ? "missing_entry" : "uncopied_foreign_entry",
		};
	}

	const text = JSON.stringify(found);
	const totalBytes = utf8Bytes(text);
	const head = header(found, totalBytes);
	const build = (chunk: ChunkView): SessionEvidence => ({ entry: head, chunk });
	return build(fitChunk(entryId, text, options.byteOffset ?? 0, build));
}

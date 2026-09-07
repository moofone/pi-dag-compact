import { existsSync, readFileSync } from "node:fs";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

type BranchReader = { getBranch(): readonly SessionEntry[] };

import {
	type AppendObservation,
	classifyAppend,
	isDurabilityAcknowledged,
} from "../host/durability.ts";
import type { OriginResolver, PiRefLike } from "../memory/engine.ts";
import { LIMITS, utf8Bytes } from "../memory/limits.ts";
import { type ChunkView, fitChunk } from "../memory/retrieval.ts";
import type { PiRefData } from "../schema/working.ts";

export function collectPiRefs(sessionManager: BranchReader): PiRefLike[] {
	return collectPiRefsFromEntries(sessionManager.getBranch());
}

/**
 * Every DAG reference the branch carries, readable or not.
 *
 * An unreadable reference is deliberately not dropped here. Dropping it would
 * turn a lost pointer into an absent one and let an older readable reference
 * silently take its place; the engine has to see it and refuse.
 */
export function collectPiRefsFromEntries(entries: readonly SessionEntry[]): PiRefLike[] {
	const refs: PiRefLike[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== "dag_revision_ref" && entry.customType !== "dag_checkpoint_ref")
			continue;
		refs.push({ customType: entry.customType, data: entry.data, entryId: entry.id });
	}
	return refs;
}

/**
 * Append a Pi ref and report what the host actually did with it.
 *
 * This deliberately does not return a bare entry id. The host hands an id back
 * before it has written anything, so an id on its own is not an acknowledgement
 * of anything; the caller needs the observed durability alongside it.
 */
export function appendPiRef(
	sessionManager: SessionManager,
	ref: PiRefData,
	checkpoint: boolean,
): AppendObservation {
	const customType = checkpoint ? "dag_checkpoint_ref" : "dag_revision_ref";
	const entryId = sessionManager.appendCustomEntry(customType, ref);
	const durability = classifyAppend(sessionManager, entryId);
	return { entryId, durability, acknowledged: isDurabilityAcknowledged(durability) };
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

/**
 * Why evidence could not be delivered. These are four different answers.
 *
 * `off_branch_entry` and `missing_entry` are deliberately distinct:
 * reconstruction is branch-scoped, and "this session has the entry, but not on
 * this branch" is a different fact from "no such entry".
 */
export type SessionEvidenceReason =
	| "missing_entry"
	| "off_branch_entry"
	| "uncopied_foreign_entry"
	| "unavailable_origin_source";

export type SessionEvidence =
	| { entry: SessionEntryHeader; chunk: ChunkView }
	| { unavailable: true; reason: SessionEvidenceReason };

export interface SessionReadOptions {
	byteOffset?: number;
	/**
	 * The engine's verified origin/copy mappings. Without one, an origin-qualified
	 * request has nothing to resolve through and is reported unavailable rather
	 * than answered from a same-ID local entry.
	 */
	origin?: OriginResolver;
}

/** The origin transcript is scanned under the same 4 MiB budget as history. */
function findInTranscript(path: string, entryId: string): SessionEntry | undefined {
	if (!existsSync(path)) return undefined;
	let scanned = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		scanned += utf8Bytes(line);
		if (scanned > LIMITS.historyScanBytes) return undefined;
		try {
			const parsed = JSON.parse(line) as { id?: unknown };
			if (parsed.id === entryId) return parsed as SessionEntry;
		} catch {
			// A partial trailing line is not an entry.
		}
	}
	return undefined;
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
 * The `sessionId` is honoured, never dropped. Entry IDs are unique only inside
 * a session, and Pi's fork copies them verbatim, so "find that ID on my branch"
 * would answer confidently for every origin in existence. A foreign origin is
 * resolved through a recorded copy mapping or an explicitly attached source
 * transcript, and otherwise reported unavailable.
 *
 * Resolution is branch-scoped in every case. A transcript entry has no size
 * limit, so `session_read` never emits one whole: the caller walks
 * `nextByteOffset` until `complete`, and the chunks concatenate back exactly.
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
	const onBranch = (id: string): SessionEntry | undefined =>
		sessionManager.getBranch().find((item) => item.id === id);

	let found: SessionEntry | undefined;
	if (sessionId === current) {
		found = onBranch(entryId);
		if (!found) {
			// Present in the session but not on this branch is its own answer:
			// reconstruction follows the branch, and so does evidence.
			return {
				unavailable: true,
				reason: sessionManager.getEntry(entryId) ? "off_branch_entry" : "missing_entry",
			};
		}
	} else {
		const copied = options.origin?.copiedEntryId(sessionId, entryId);
		if (copied) {
			found = onBranch(copied);
			if (!found) return { unavailable: true, reason: "uncopied_foreign_entry" };
		} else {
			const source = options.origin?.sourceTranscript(sessionId);
			if (!source) return { unavailable: true, reason: "uncopied_foreign_entry" };
			found = findInTranscript(source, entryId);
			if (!found) return { unavailable: true, reason: "unavailable_origin_source" };
		}
	}

	const text = JSON.stringify(found);
	const totalBytes = utf8Bytes(text);
	const head = header(found, totalBytes);
	const build = (chunk: ChunkView): SessionEvidence => ({ entry: head, chunk });
	return build(fitChunk(entryId, text, options.byteOffset ?? 0, build));
}

import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

type BranchReader = { getBranch(): readonly SessionEntry[] };

import type { PiRefLike } from "../memory/engine.ts";
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

export type SessionEvidence =
	| { entry: SessionEntry }
	| { unavailable: true; reason: "missing_entry" | "uncopied_foreign_entry" };

export function resolveSessionEvidence(
	sessionManager: {
		getSessionId(): string;
		getBranch(): readonly SessionEntry[];
		getEntry(id: string): SessionEntry | undefined;
	},
	sessionId: string,
	entryId: string,
): SessionEvidence {
	const current = sessionManager.getSessionId();
	if (sessionId === current) {
		const entry =
			sessionManager.getEntry(entryId) ??
			sessionManager.getBranch().find((item) => item.id === entryId);
		if (!entry) return { unavailable: true, reason: "missing_entry" };
		return { entry };
	}
	const copied =
		sessionManager.getBranch().find((item) => item.id === entryId) ??
		sessionManager.getEntry(entryId);
	if (!copied) return { unavailable: true, reason: "uncopied_foreign_entry" };
	return { entry: copied };
}

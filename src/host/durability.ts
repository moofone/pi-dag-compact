import { existsSync, readFileSync } from "node:fs";

/**
 * Extension-side observation of what an append actually did.
 *
 * The host gives an extension no durable acknowledgement: `appendXxx()` returns
 * an entry id after the entry is already in memory and already the leaf, and
 * the write it then attempts is deferred, unsynced, and unchecked. The most an
 * extension can honestly do is read the session file back and say whether the
 * bytes are there.
 *
 * `present_in_file` therefore means "these bytes were read back out of the
 * session file", never "this append is durable". Nothing here claims fsync.
 */
export type AppendDurability =
	/** The session is in memory only. The returned id will never reach a file. */
	| "not_persisted"
	/**
	 * The host has not created the session file yet. Pi defers the first write
	 * until an assistant message exists, so the returned id is acknowledging
	 * nothing at all.
	 */
	| "deferred"
	/** The entry id was read back out of the session file. Not an fsync claim. */
	| "present_in_file"
	/**
	 * The session file exists and has been flushed, but this entry is not in it.
	 * After the first flush Pi appends every entry individually, so an absent id
	 * on an existing file is a hole, not a deferral.
	 */
	| "absent_from_file";

export interface SessionFileReader {
	getSessionFile(): string | undefined;
	/** Absent on Pi's ReadonlySessionManager; a missing session file means the same. */
	isPersisted?(): boolean;
}

/** Ids present in the session file right now. Cheap enough for a per-append check. */
export function readPersistedEntryIds(sessionFile: string | undefined): Set<string> {
	const ids = new Set<string>();
	if (!sessionFile || !existsSync(sessionFile)) return ids;
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const id = (JSON.parse(line) as { id?: unknown }).id;
			if (typeof id === "string") ids.add(id);
		} catch {
			// A partially written trailing line is itself evidence of no durability.
		}
	}
	return ids;
}

export function classifyAppend(session: SessionFileReader, entryId: string): AppendDurability {
	if (session.isPersisted?.() === false) return "not_persisted";
	const file = session.getSessionFile();
	if (!file) return "not_persisted";
	if (!existsSync(file)) return "deferred";
	return readPersistedEntryIds(file).has(entryId) ? "present_in_file" : "absent_from_file";
}

/** True only for `present_in_file`: read back, and still not an fsync guarantee. */
export function isDurabilityAcknowledged(durability: AppendDurability): boolean {
	return durability === "present_in_file";
}

export interface AppendObservation {
	entryId: string;
	durability: AppendDurability;
	/** Never true for a deferred, unpersisted, or absent entry. */
	acknowledged: boolean;
}

/**
 * What a failed append left behind in the host's own views.
 *
 * The host does not roll back, so every one of these can be true at once. The
 * fixture that records them is characterisation: it states what the host does,
 * it does not require the host to do anything.
 */
export interface LeakObservation {
	/** Present when the failed entry could be identified by comparing ids. */
	entryId: string | undefined;
	error: string;
	isLeaf: boolean;
	inBranch: boolean;
	inContextEntries: boolean;
	inFile: boolean;
}

export interface LeakProbe {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getEntries(): Array<{ id: string }>;
	getBranch(): Array<{ id: string }>;
	buildContextEntries(): Array<{ id: string }>;
}

export interface DurabilityObserver {
	readonly observations: readonly AppendObservation[];
	readonly leaks: readonly LeakObservation[];
	/** Ids this observer has read back out of the session file at least once. */
	readonly acknowledgedEntryIds: ReadonlySet<string>;
	observeAppend(entryId: string): AppendObservation;
	/** Record what a throwing append left behind. `knownIdsBefore` identifies the leak. */
	recordFailedAppend(
		error: unknown,
		probe: LeakProbe,
		knownIdsBefore: ReadonlySet<string>,
	): LeakObservation;
	isDurablyAcknowledged(entryId: string): boolean;
	/** Re-read the file; an id acknowledged earlier can stop being present. */
	recheck(entryId: string): AppendDurability;
}

export function createDurabilityObserver(session: SessionFileReader): DurabilityObserver {
	const observations: AppendObservation[] = [];
	const leaks: LeakObservation[] = [];
	const acknowledged = new Set<string>();

	return {
		get observations() {
			return observations;
		},
		get leaks() {
			return leaks;
		},
		get acknowledgedEntryIds() {
			return acknowledged;
		},
		observeAppend(entryId) {
			const durability = classifyAppend(session, entryId);
			const observation: AppendObservation = {
				entryId,
				durability,
				acknowledged: isDurabilityAcknowledged(durability),
			};
			if (observation.acknowledged) acknowledged.add(entryId);
			observations.push(observation);
			return observation;
		},
		recordFailedAppend(error, probe, knownIdsBefore) {
			const leakedEntry = probe.getEntries().find((entry) => !knownIdsBefore.has(entry.id));
			const entryId = leakedEntry?.id;
			const inFile =
				entryId === undefined ? false : readPersistedEntryIds(probe.getSessionFile()).has(entryId);
			const leak: LeakObservation = {
				entryId,
				error: error instanceof Error ? error.message : String(error),
				isLeaf: entryId !== undefined && probe.getLeafId() === entryId,
				inBranch: entryId !== undefined && probe.getBranch().some((entry) => entry.id === entryId),
				inContextEntries:
					entryId !== undefined &&
					probe.buildContextEntries().some((entry) => entry.id === entryId),
				inFile,
			};
			leaks.push(leak);
			return leak;
		},
		isDurablyAcknowledged(entryId) {
			return classifyAppend(session, entryId) === "present_in_file";
		},
		recheck(entryId) {
			const durability = classifyAppend(session, entryId);
			if (durability !== "present_in_file") acknowledged.delete(entryId);
			return durability;
		},
	};
}

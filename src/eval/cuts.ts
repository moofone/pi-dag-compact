import type { CompactionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CutRecord, InvalidRunReason } from "../schema/report.ts";

export function turnHeader(turn: number): string {
	return `# Scenario turn ${turn}`;
}

/**
 * Match a turn header on a digit boundary.
 *
 * A plain substring test reports turn 1 as present in "# Scenario turn 13",
 * which made every cut after turn 9 claim a dropped turn 1. That stayed
 * invisible while the next-request capture was always missing; with real
 * captures it becomes a false "leaked entry".
 */
export function textIncludesHeader(text: string, turn: number): boolean {
	const header = turnHeader(turn);
	for (let index = text.indexOf(header); index !== -1; index = text.indexOf(header, index + 1)) {
		const next = text[index + header.length];
		if (next === undefined || next < "0" || next > "9") return true;
	}
	return false;
}

export function serializeMessages(messages: unknown): string {
	try {
		return JSON.stringify(messages);
	} catch {
		return String(messages);
	}
}

export function presentTurnHeaders(text: string): number[] {
	const found: number[] = [];
	for (let turn = 1; turn <= 16; turn += 1) {
		if (textIncludesHeader(text, turn)) found.push(turn);
	}
	return found;
}

/**
 * Assess one cut boundary.
 *
 * `nextTurnRequestText` is the request that actually reached the provider
 * after the cut. Without it the boundary has no evidence at all, and missing
 * evidence is a failure, never a pass.
 */
export function assessCut(options: {
	afterTurn: number;
	tokensBefore: number;
	firstKeptEntryId: string;
	summary: string;
	droppedEntryCount: number;
	retainedEntryCount: number;
	preCutContextText: string;
	postCutContextText: string;
	nextTurnRequestText?: string;
}): CutRecord {
	const before = presentTurnHeaders(options.preCutContextText);
	const after = presentTurnHeaders(options.postCutContextText);
	const removed = before.filter((turn) => !after.includes(turn));
	const nextText = options.nextTurnRequestText;
	const nextRequestEvidence = nextText === undefined ? "missing" : "present";
	const leaked =
		nextText === undefined ? [] : removed.filter((turn) => textIncludesHeader(nextText, turn));
	const absentFromNext =
		nextRequestEvidence === "present" && removed.length > 0 && leaked.length === 0;
	const noop = options.droppedEntryCount <= 0 || removed.length === 0;

	const invalidReasons: InvalidRunReason[] = [];
	if (noop) {
		invalidReasons.push({
			code: "noop_compaction",
			detail: `no-op compaction after turn ${options.afterTurn}: dropped=${options.droppedEntryCount} removedTurns=${removed.length}`,
			afterTurn: options.afterTurn,
		});
	} else if (nextRequestEvidence === "missing") {
		invalidReasons.push({
			code: "missing_next_request_capture",
			detail: `no provider request was captured after the cut following turn ${options.afterTurn}`,
			afterTurn: options.afterTurn,
		});
	} else if (leaked.length > 0) {
		invalidReasons.push({
			code: "dropped_entry_present_in_next_request",
			detail: `dropped turns ${leaked.join(",")} were still present in the next provider request after turn ${options.afterTurn}`,
			afterTurn: options.afterTurn,
		});
	}

	return {
		afterTurn: options.afterTurn,
		reason: "manual",
		tokensBefore: options.tokensBefore,
		firstKeptEntryId: options.firstKeptEntryId,
		summaryChars: options.summary.length,
		droppedEntryCount: options.droppedEntryCount,
		retainedEntryCount: options.retainedEntryCount,
		nextRequestEvidence,
		rawDroppedTurnHeadersAbsentFromNextRequest: absentFromNext,
		noop,
		invalidReasons,
	};
}

export function latestCompaction(sessionManager: SessionManager): CompactionEntry | undefined {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "compaction") return entry as CompactionEntry;
	}
	return undefined;
}

export function droppedAndRetained(
	sessionManager: SessionManager,
	firstKeptEntryId: string,
): {
	droppedEntryCount: number;
	retainedEntryCount: number;
} {
	const branch = sessionManager.getBranch();
	const keptIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
	if (keptIndex < 0) {
		return { droppedEntryCount: 0, retainedEntryCount: branch.length };
	}
	return {
		droppedEntryCount: keptIndex,
		retainedEntryCount: branch.length - keptIndex,
	};
}

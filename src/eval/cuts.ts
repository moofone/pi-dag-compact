import type { CompactionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CutRecord } from "../schema/report.ts";

export function turnHeader(turn: number): string {
	return `# Scenario turn ${turn}`;
}

export function textIncludesHeader(text: string, turn: number): boolean {
	return text.includes(turnHeader(turn));
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
	const absentFromNext =
		removed.length > 0 &&
		(nextText === undefined || removed.every((turn) => !textIncludesHeader(nextText, turn)));
	const noop = options.droppedEntryCount <= 0 || removed.length === 0;
	return {
		afterTurn: options.afterTurn,
		reason: "manual",
		tokensBefore: options.tokensBefore,
		firstKeptEntryId: options.firstKeptEntryId,
		summaryChars: options.summary.length,
		droppedEntryCount: options.droppedEntryCount,
		retainedEntryCount: options.retainedEntryCount,
		rawDroppedTurnHeadersAbsentFromNextRequest: absentFromNext,
		noop,
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

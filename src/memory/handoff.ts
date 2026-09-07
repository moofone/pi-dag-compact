import type { WorkingNode } from "../schema/working.ts";
import type { MemoryEngine } from "./engine.ts";
import { DagError } from "./errors.ts";
import { LIMITS, utf8Bytes } from "./limits.ts";
import { dagStatus } from "./query.ts";

export interface HandoffReview {
	sessionId: string;
	leafId: string;
	revisionId: string;
	checkpointId: string;
	coveredThroughEntryId: string;
}

export interface HandoffCard {
	text: string;
	estimatedTokens: number;
}

export interface HandoffCurrent {
	sessionId: string;
	leafId: string;
	revisionId: string | null;
}

function section(title: string, nodes: WorkingNode[]): string {
	if (nodes.length === 0) return `## ${title}\n(none)`;
	return [
		`## ${title}`,
		...nodes.map((node) => `- ${node.title}${node.body ? `: ${node.body}` : ""}`),
	].join("\n");
}

export function estimateTokens(text: string): number {
	return Math.ceil(utf8Bytes(text) / 4);
}

export function formatHandoffCard(engine: MemoryEngine): HandoffCard {
	const status = dagStatus(engine);
	const snap = engine.snapshot();
	const text = [
		"# DAG handoff",
		section("Objective", status.objective),
		section("Constraints", status.constraints),
		section("Accepted baseline", status.acceptedBaseline),
		section("Best observed", status.bestObserved),
		section("Best correctness-validated", status.bestValidated),
		section("Current work", status.currentWork),
		section("Blockers", status.blockers),
		section("Unresolved questions", status.unresolved),
		section("Rejected approaches", status.rejected),
		section("Next action", status.nextAction),
		"## Pointers",
		`- revision: ${snap.revisionId ?? "(none)"}`,
		`- checkpoint: ${snap.checkpointId ?? "(none)"}`,
		`- selection: ${status.selection.selectionRevision}`,
	].join("\n");
	return { text, estimatedTokens: estimateTokens(text) };
}

export function assertHandoffEligible(engine: MemoryEngine): HandoffCard {
	const snap = engine.snapshot();
	if (!snap.revisionId || !snap.checkpointId) {
		throw new DagError("handoff_refused", "handoff requires a committed checkpoint");
	}
	// A selection the structure cannot decide is not a selection. Refusing here
	// is what keeps a card from silently presenting one of several candidates
	// as though it were the accepted one.
	if (snap.ambiguousSelections.length > 0) {
		throw new DagError(
			"handoff_refused",
			`selection is ambiguous for ${snap.ambiguousSelections.join(", ")}; record an explicit selection`,
		);
	}
	if (!snap.selection.objectiveId) {
		throw new DagError(
			"handoff_refused",
			"selection has no objective; an empty objective is never eligible for handoff",
		);
	}
	const card = formatHandoffCard(engine);
	if (card.estimatedTokens > LIMITS.maxHandoffTokens) {
		throw new DagError(
			"handoff_refused",
			`handoff card is ${card.estimatedTokens} tokens; limit is ${LIMITS.maxHandoffTokens}`,
		);
	}
	return card;
}

export function reviewIsFresh(review: HandoffReview, current: HandoffCurrent): boolean {
	return (
		review.sessionId === current.sessionId &&
		review.leafId === current.leafId &&
		review.revisionId === current.revisionId
	);
}

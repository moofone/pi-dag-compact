import type {
	ActiveSelection,
	SelectionDraft,
	WorkingEdge,
	WorkingNode,
} from "../schema/working.ts";
import { sha256 } from "./canonical.ts";
import { DagError } from "./errors.ts";
import { eligibleTaskIds } from "./graph.ts";

/**
 * Typed selection resolution.
 *
 * The selection is the only authority for which records are "current". Titles
 * are never inspected: a decision named "accepted baseline X" carries no more
 * weight than any other decision. Where no explicit selection exists the
 * engine derives one structurally from record kind and status, and reports
 * every place where the structure is ambiguous instead of guessing.
 */
export interface ResolvedSelection {
	selection: ActiveSelection;
	/** Selection slots the structure could not decide without an explicit ID. */
	ambiguous: string[];
	/** Explicit IDs that do not resolve to an active record. */
	dangling: string[];
}

export const EMPTY_SELECTION_DRAFT: SelectionDraft = {
	goalBinding: null,
	objectiveId: "",
	constraintIds: [],
	acceptedBaselineRecordId: null,
	bestObservedRecordId: null,
	bestValidatedRecordId: null,
	currentWorkIds: [],
	unresolvedIds: [],
	nextActionIds: [],
	rejectedApproachIds: [],
	pinnedIds: [],
};

const TERMINAL_STATUSES = new Set(["done", "rejected", "stale"]);

export function isTerminal(node: WorkingNode): boolean {
	return TERMINAL_STATUSES.has(node.status);
}

/** Canonical serialization of a selection, used for its issued identity. */
export function canonicalSelection(draft: SelectionDraft): string {
	return JSON.stringify({
		goalBinding: draft.goalBinding,
		objectiveId: draft.objectiveId,
		constraintIds: [...draft.constraintIds].sort(),
		acceptedBaselineRecordId: draft.acceptedBaselineRecordId,
		bestObservedRecordId: draft.bestObservedRecordId,
		bestValidatedRecordId: draft.bestValidatedRecordId,
		currentWorkIds: [...draft.currentWorkIds].sort(),
		unresolvedIds: [...draft.unresolvedIds].sort(),
		nextActionIds: [...draft.nextActionIds].sort(),
		rejectedApproachIds: [...draft.rejectedApproachIds].sort(),
		pinnedIds: [...draft.pinnedIds].sort(),
		absenceReason: draft.absenceReason ?? null,
	});
}

/**
 * The hash of a committed selection, or of its deliberate absence.
 *
 * Stored beside the snapshot hash so a load can check the selection it read
 * rather than trusting the column it was read from.
 */
export function selectionStateHash(selection: ActiveSelection | null): string {
	if (!selection) return sha256("selection:none");
	return sha256(`selection:${selection.selectionRevision}\n${canonicalSelection(selection)}`);
}

export function issueSelectionRevision(draft: SelectionDraft, revision: number): string {
	return `sel_${sha256(`${revision}\n${canonicalSelection(draft)}`).slice(0, 32)}`;
}

/** Every explicit ID a selection names, paired with the slot that names it. */
function explicitReferences(draft: SelectionDraft): Array<{ slot: string; id: string }> {
	const refs: Array<{ slot: string; id: string }> = [];
	const single: Array<[string, string | null]> = [
		["objectiveId", draft.objectiveId || null],
		["acceptedBaselineRecordId", draft.acceptedBaselineRecordId],
		["bestObservedRecordId", draft.bestObservedRecordId],
		["bestValidatedRecordId", draft.bestValidatedRecordId],
	];
	for (const [slot, id] of single) {
		if (id) refs.push({ slot, id });
	}
	const lists: Array<[string, string[]]> = [
		["constraintIds", draft.constraintIds],
		["currentWorkIds", draft.currentWorkIds],
		["unresolvedIds", draft.unresolvedIds],
		["nextActionIds", draft.nextActionIds],
		["rejectedApproachIds", draft.rejectedApproachIds],
		["pinnedIds", draft.pinnedIds],
	];
	for (const [slot, ids] of lists) {
		for (const id of ids) refs.push({ slot, id });
	}
	return refs;
}

/**
 * Reject a selection that names a record the active set does not contain.
 * Validation runs on the prospective state, before the revision is committed.
 */
export function validateSelectionDraft(draft: SelectionDraft, nodes: WorkingNode[]): void {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	for (const { slot, id } of explicitReferences(draft)) {
		if (!byId.has(id)) {
			throw new DagError(
				"unknown_node",
				`selection ${slot} references unknown record ${id}; selections use typed IDs`,
			);
		}
	}
	const baselineId = draft.acceptedBaselineRecordId;
	if (baselineId) {
		const node = byId.get(baselineId);
		if (node && node.kind !== "decision") {
			throw new DagError(
				"invalid_selection",
				`accepted baseline ${baselineId} is a ${node.kind}; a baseline is an accepted decision`,
			);
		}
	}
}

/** Structural baseline candidates: done decisions that nothing supersedes. */
function baselineCandidates(nodes: WorkingNode[], edges: WorkingEdge[]): WorkingNode[] {
	const superseded = new Set(
		edges.filter((edge) => edge.kind === "supersedes").map((edge) => edge.to),
	);
	return nodes.filter(
		(node) => node.kind === "decision" && node.status === "done" && !superseded.has(node.id),
	);
}

export function resolveSelection(
	nodes: WorkingNode[],
	edges: WorkingEdge[],
	explicit: ActiveSelection | null,
	revision: number,
): ResolvedSelection {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const present = (id: string): boolean => byId.has(id);
	const ambiguous: string[] = [];
	const dangling: string[] = [];
	const draft: SelectionDraft = { ...EMPTY_SELECTION_DRAFT };

	// A committed selection is authoritative and complete: every slot means
	// exactly what it says, and an empty slot is deliberate absence rather than
	// an invitation to guess. Structural derivation exists only for memory that
	// has never recorded a selection at all.
	if (explicit) {
		for (const { id } of explicitReferences(explicit)) {
			if (!present(id)) dangling.push(id);
		}
		const keep = (ids: string[]): string[] => ids.filter(present);
		const keepOne = (id: string | null): string | null => (id && present(id) ? id : null);
		return {
			selection: {
				goalBinding: explicit.goalBinding,
				objectiveId: keepOne(explicit.objectiveId || null) ?? "",
				constraintIds: keep(explicit.constraintIds),
				acceptedBaselineRecordId: keepOne(explicit.acceptedBaselineRecordId),
				bestObservedRecordId: keepOne(explicit.bestObservedRecordId),
				bestValidatedRecordId: keepOne(explicit.bestValidatedRecordId),
				currentWorkIds: keep(explicit.currentWorkIds),
				unresolvedIds: keep(explicit.unresolvedIds),
				nextActionIds: keep(explicit.nextActionIds),
				rejectedApproachIds: keep(explicit.rejectedApproachIds),
				pinnedIds: keep(explicit.pinnedIds),
				...(explicit.absenceReason !== undefined ? { absenceReason: explicit.absenceReason } : {}),
				selectionRevision: explicit.selectionRevision,
			},
			ambiguous,
			dangling,
		};
	}

	const goals = nodes.filter((node) => node.kind === "goal");
	if (goals.length === 1) {
		draft.objectiveId = goals[0]?.id ?? "";
	} else if (goals.length > 1) {
		ambiguous.push("objectiveId");
	}

	// Only current constraints; stale and rejected ones are history.
	draft.constraintIds = nodes
		.filter((node) => node.kind === "constraint" && !TERMINAL_STATUSES.has(node.status))
		.map((node) => node.id);

	const candidates = baselineCandidates(nodes, edges);
	if (candidates.length === 1) {
		draft.acceptedBaselineRecordId = candidates[0]?.id ?? null;
	} else if (candidates.length > 1) {
		ambiguous.push("acceptedBaselineRecordId");
	}

	// Best observed and best correctness-validated are never inferred: they are
	// interpretations of measured evidence, not structural facts about records.
	draft.currentWorkIds = nodes
		.filter(
			(node) => (node.kind === "task" || node.kind === "hypothesis") && node.status === "open",
		)
		.map((node) => node.id);

	// Unresolved questions are open hypotheses. Blockers are a different kind
	// with a different lifecycle and are reported separately.
	draft.unresolvedIds = nodes
		.filter((node) => node.kind === "hypothesis" && node.status === "open")
		.map((node) => node.id);

	draft.nextActionIds = eligibleTaskIds(nodes, edges);
	draft.rejectedApproachIds = nodes
		.filter((node) => node.status === "rejected")
		.map((node) => node.id);

	return {
		selection: { ...draft, selectionRevision: issueSelectionRevision(draft, revision) },
		ambiguous,
		dangling,
	};
}

/**
 * Records the engine refuses to archive. Structurally-derived rejections are
 * deliberately excluded: pinning every rejected record would make history
 * unarchivable. Rejection reasons are pinned only when a selection names them.
 */
export function pinnedIds(
	resolved: ResolvedSelection,
	explicit: ActiveSelection | null,
): Set<string> {
	const selection = resolved.selection;
	const pins = new Set<string>();
	if (selection.objectiveId) pins.add(selection.objectiveId);
	for (const id of selection.constraintIds) pins.add(id);
	if (selection.acceptedBaselineRecordId) pins.add(selection.acceptedBaselineRecordId);
	if (selection.bestObservedRecordId) pins.add(selection.bestObservedRecordId);
	if (selection.bestValidatedRecordId) pins.add(selection.bestValidatedRecordId);
	for (const id of selection.currentWorkIds) pins.add(id);
	for (const id of selection.unresolvedIds) pins.add(id);
	for (const id of selection.nextActionIds) pins.add(id);
	for (const id of selection.pinnedIds) pins.add(id);
	for (const id of explicit?.rejectedApproachIds ?? []) pins.add(id);
	return pins;
}

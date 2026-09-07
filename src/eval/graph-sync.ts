import type { WorkingNotes } from "../schema/oracle.ts";
import type { MutationBatch } from "../schema/working.ts";

export function batchFromNotes(notes: WorkingNotes, operationId: string): MutationBatch {
	const upsertNodes: NonNullable<MutationBatch["upsertNodes"]> = [
		{
			id: "goal",
			kind: "goal",
			title: notes.objective.slice(0, 120),
			body: notes.metric,
			status: "open",
		},
		{
			id: "ceiling",
			kind: "constraint",
			title: `smem <= ${notes.resourceCeilingSmemPct}%`,
			body: `resource ceiling ${notes.resourceCeilingSmemPct}`,
			status: "open",
		},
		{
			id: "next",
			kind: "task",
			title: notes.nextAction.slice(0, 120),
			body: "",
			status: "open",
		},
	];
	if (notes.acceptedBaselineId !== "unset") {
		upsertNodes.push({
			id: "baseline",
			kind: "decision",
			title: `accepted baseline ${notes.acceptedBaselineId}`.slice(0, 120),
			body: notes.acceptedBaselineRunId,
			status: "done",
		});
	}
	for (const rejection of notes.rejected) {
		upsertNodes.push({
			id: `rej-${rejection.candidateId}`,
			kind: "hypothesis",
			title: `rejected ${rejection.candidateId}`.slice(0, 120),
			body: rejection.reasonCode,
			status: "rejected",
		});
	}
	return { operationId, upsertNodes };
}

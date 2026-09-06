import type { WorkingNotes } from "../schema/oracle.ts";

export function notesAfterTurn(turn: number): WorkingNotes {
	const rejectedA = { candidateId: "A", reasonCode: "pipeline_regression" };
	const rejectedB = { candidateId: "B", reasonCode: "correctness_fail" };

	if (turn <= 1) {
		return {
			objective: "Minimize complete-pipeline p50 latency for W1",
			metric: "pipeline_p50_ms",
			resourceCeilingSmemPct: 80,
			correctnessRequired: true,
			acceptedBaselineId: "unset",
			acceptedBaselineRunId: "unset",
			rejected: [],
			inconclusive: [],
			nextAction: "run baseline for W1",
			completionClaim: false,
		};
	}
	if (turn === 2) {
		return {
			objective: "Minimize complete-pipeline p50 latency for W1",
			metric: "pipeline_p50_ms",
			resourceCeilingSmemPct: 80,
			correctnessRequired: true,
			acceptedBaselineId: "baseline",
			acceptedBaselineRunId: "run-baseline-W1",
			rejected: [],
			inconclusive: [],
			nextAction: "evaluate candidate A",
			completionClaim: false,
		};
	}
	if (turn <= 4) {
		return {
			objective: "Minimize complete-pipeline p50 latency for W1",
			metric: "pipeline_p50_ms",
			resourceCeilingSmemPct: 80,
			correctnessRequired: true,
			acceptedBaselineId: "baseline",
			acceptedBaselineRunId: "run-baseline-W1",
			rejected: [rejectedA],
			inconclusive: [],
			nextAction: "wait for user; do not retry A without a new reason",
			completionClaim: false,
		};
	}
	if (turn === 5) {
		return {
			objective: "Minimize complete-pipeline p50 latency for W1",
			metric: "pipeline_p50_ms",
			resourceCeilingSmemPct: 64,
			correctnessRequired: true,
			acceptedBaselineId: "baseline",
			acceptedBaselineRunId: "run-baseline-W1",
			rejected: [rejectedA],
			inconclusive: [],
			nextAction: "evaluate remaining candidates under 64% smem",
			completionClaim: false,
		};
	}
	if (turn === 6) {
		return {
			objective: "Minimize complete-pipeline p50 latency for W1",
			metric: "pipeline_p50_ms",
			resourceCeilingSmemPct: 64,
			correctnessRequired: true,
			acceptedBaselineId: "baseline",
			acceptedBaselineRunId: "run-baseline-W1",
			rejected: [rejectedA, rejectedB],
			inconclusive: [],
			nextAction: "evaluate candidate C",
			completionClaim: false,
		};
	}
	if (turn <= 8) {
		return {
			objective: "Minimize complete-pipeline p50 latency for W1",
			metric: "pipeline_p50_ms",
			resourceCeilingSmemPct: 64,
			correctnessRequired: true,
			acceptedBaselineId: "C",
			acceptedBaselineRunId: "run-C-W1",
			rejected: [rejectedA, rejectedB],
			inconclusive: [],
			nextAction: "continue search under 64% smem; do not promote B",
			completionClaim: false,
		};
	}
	if (turn === 9) {
		return {
			objective: "Minimize complete-pipeline p50 latency for W1",
			metric: "pipeline_p50_ms",
			resourceCeilingSmemPct: 64,
			correctnessRequired: true,
			acceptedBaselineId: "C",
			acceptedBaselineRunId: "run-C-W1",
			rejected: [rejectedA, rejectedB],
			inconclusive: ["D"],
			nextAction: "run smem-aware fusion with clocks locked (candidate E)",
			completionClaim: false,
		};
	}
	if (turn === 10) {
		return {
			objective: "Minimize complete-pipeline p50 latency for W1",
			metric: "pipeline_p50_ms",
			resourceCeilingSmemPct: 64,
			correctnessRequired: true,
			acceptedBaselineId: "C",
			acceptedBaselineRunId: "run-C-W1",
			rejected: [rejectedA, rejectedB],
			inconclusive: ["D"],
			nextAction: "run candidate E; not a repeat of A or B",
			completionClaim: false,
		};
	}
	if (turn <= 16) {
		return {
			objective: "Minimize complete-pipeline p50 latency for W1",
			metric: "pipeline_p50_ms",
			resourceCeilingSmemPct: 64,
			correctnessRequired: true,
			acceptedBaselineId: "E",
			acceptedBaselineRunId: "run-E-W1",
			rejected: [rejectedA, rejectedB],
			inconclusive: ["D"],
			nextAction:
				"keep E; retest A only if pipeline-neutral fusion stays within 64% smem and clocks stay locked",
			completionClaim: false,
		};
	}
	throw new Error(`no notes for turn ${turn}`);
}

export function formatClassicSummary(notes: WorkingNotes): string {
	return [
		"## Goal",
		notes.objective,
		"",
		"## Constraints & Preferences",
		`- metric: ${notes.metric}`,
		`- shared-memory ceiling: ${notes.resourceCeilingSmemPct}%`,
		"- correctness check must pass",
		"",
		"## Progress",
		"### Done",
		`- [x] accepted baseline ${notes.acceptedBaselineId} (${notes.acceptedBaselineRunId})`,
		...notes.rejected.map((item) => `- [x] rejected ${item.candidateId} (${item.reasonCode})`),
		...notes.inconclusive.map((id) => `- [x] ${id} inconclusive`),
		"",
		"### In Progress",
		`- [ ] ${notes.nextAction}`,
		"",
		"### Blocked",
		"- (none)",
		"",
		"## Key Decisions",
		`- **baseline=${notes.acceptedBaselineId}**: evidence in ${notes.acceptedBaselineRunId}`,
		"",
		"## Next Steps",
		`1. ${notes.nextAction}`,
		"",
		"## Critical Context",
		"- Use node bench.mjs; do not invent measurements.",
		"- Faster kernels with slower pipelines are not accepted baselines.",
	].join("\n");
}

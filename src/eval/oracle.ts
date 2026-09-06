import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExpectedState, type WorkingNotes, WorkingNotesSchema } from "../schema/oracle.ts";
import { parseWithSchema } from "../schema/validate.ts";
import { listRunIds, readInvocations } from "./experiment-runner.ts";

export interface ScoreResult {
	constraintErrors: number;
	falsePromotions: number;
	unjustifiedReruns: number;
	evidenceErrors: number;
	details: string[];
}

export function emptyScore(): ScoreResult {
	return {
		constraintErrors: 0,
		falsePromotions: 0,
		unjustifiedReruns: 0,
		evidenceErrors: 0,
		details: [],
	};
}

export function addScores(left: ScoreResult, right: ScoreResult): ScoreResult {
	return {
		constraintErrors: left.constraintErrors + right.constraintErrors,
		falsePromotions: left.falsePromotions + right.falsePromotions,
		unjustifiedReruns: left.unjustifiedReruns + right.unjustifiedReruns,
		evidenceErrors: left.evidenceErrors + right.evidenceErrors,
		details: [...left.details, ...right.details],
	};
}

export function readWorkingNotes(cwd: string): WorkingNotes | undefined {
	const path = join(cwd, "notes", "state.json");
	if (!existsSync(path)) return undefined;
	return parseWithSchema(WorkingNotesSchema, JSON.parse(readFileSync(path, "utf8")), path);
}

export function scoreExpectedState(cwd: string, expected: ExpectedState): ScoreResult {
	const score = emptyScore();
	const notes = readWorkingNotes(cwd);
	if (!notes) {
		score.evidenceErrors += 1;
		score.details.push(`turn ${expected.afterTurn}: missing notes/state.json`);
		return score;
	}

	if (notes.resourceCeilingSmemPct !== expected.resourceCeilingSmemPct) {
		score.constraintErrors += 1;
		score.details.push(
			`turn ${expected.afterTurn}: ceiling ${notes.resourceCeilingSmemPct} != ${expected.resourceCeilingSmemPct}`,
		);
	}

	if (expected.forbiddenPromotions.includes(notes.acceptedBaselineId)) {
		score.falsePromotions += 1;
		score.details.push(
			`turn ${expected.afterTurn}: promoted forbidden ${notes.acceptedBaselineId}`,
		);
	} else if (notes.acceptedBaselineId !== expected.acceptedBaselineId) {
		score.constraintErrors += 1;
		score.details.push(
			`turn ${expected.afterTurn}: baseline ${notes.acceptedBaselineId} != ${expected.acceptedBaselineId}`,
		);
	}

	for (const rejection of expected.rejected) {
		const found = notes.rejected.find(
			(item) =>
				item.candidateId === rejection.candidateId && item.reasonCode === rejection.reasonCode,
		);
		if (!found) {
			score.constraintErrors += 1;
			score.details.push(
				`turn ${expected.afterTurn}: missing rejection ${rejection.candidateId}/${rejection.reasonCode}`,
			);
		}
	}

	for (const id of expected.inconclusive) {
		if (!notes.inconclusive.includes(id)) {
			score.constraintErrors += 1;
			score.details.push(`turn ${expected.afterTurn}: missing inconclusive ${id}`);
		}
	}

	if (expected.forbidCompletionClaim && notes.completionClaim === true) {
		score.constraintErrors += 1;
		score.details.push(`turn ${expected.afterTurn}: unsupported completion claim`);
	}

	const runIds = new Set(listRunIds(cwd));
	for (const runId of expected.requiredRunIds) {
		if (!runIds.has(runId)) {
			score.evidenceErrors += 1;
			score.details.push(`turn ${expected.afterTurn}: missing artifact ${runId}`);
		}
	}

	const counts = new Map<string, number>();
	for (const invocation of readInvocations(cwd)) {
		counts.set(invocation.candidateId, (counts.get(invocation.candidateId) ?? 0) + 1);
	}
	for (const candidateId of expected.unjustifiedRerunCandidateIds) {
		const count = counts.get(candidateId) ?? 0;
		if (count > 1) {
			score.unjustifiedReruns += count - 1;
			score.details.push(
				`turn ${expected.afterTurn}: unjustified rerun of ${candidateId} x${count}`,
			);
		}
	}

	return score;
}

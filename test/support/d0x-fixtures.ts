import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EMPTY_SELECTION_DRAFT } from "../../src/memory/selection.ts";
import type { MutationBatch, SelectionDraft } from "../../src/schema/working.ts";

/** One branch position. The pair, never a bare leaf id, is the publication scope. */
export function branchAt(
	sessionId = "s1",
	leafId = "leaf-1",
): {
	sessionId: string;
	leafId: string;
} {
	return { sessionId, leafId };
}

export function selection(overrides: Partial<SelectionDraft>): SelectionDraft {
	return { ...EMPTY_SELECTION_DRAFT, ...overrides };
}

/**
 * A minimal handoff-eligible batch: one objective, one constraint, one next
 * action, and an explicit selection naming them.
 */
export function seedBatch(
	operationId: string,
	nextActionTitle = "first next action",
): MutationBatch {
	return {
		operationId,
		upsertNodes: [
			{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
			{ id: "ceiling", kind: "constraint", title: "smem <= 64%", body: "", status: "open" },
			{ id: "next-a", kind: "task", title: nextActionTitle, body: "", status: "open" },
		],
		setSelection: selection({
			objectiveId: "goal",
			constraintIds: ["ceiling"],
			nextActionIds: ["next-a"],
		}),
	};
}

/** Open the engine's own database directly, to tamper with stored state. */
export function openStoreDirect(taskDir: string): DatabaseSync {
	return new DatabaseSync(join(taskDir, "memory.sqlite"));
}

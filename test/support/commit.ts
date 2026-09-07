import type { BranchContext, CommitResult, MemoryEngine } from "../../src/memory/engine.ts";
import type { MutationBatch } from "../../src/schema/working.ts";

let sequence = 0;

/**
 * Commit a batch and publish it, the way `dag_update` does when the host takes
 * its reference.
 *
 * Under R2 a SQLite commit selects nothing on its own — the branch pointer is
 * the selection authority — so a fixture that wants published state has to
 * acknowledge the reference it is standing in for. This helper is that
 * acknowledgement and nothing more: `update` and `acknowledgeRef` are both the
 * production calls.
 */
export function commit(
	engine: MemoryEngine,
	batch: MutationBatch,
	branch: BranchContext,
	entryId?: string,
): CommitResult {
	const result = engine.update(batch, branch);
	if (!result.replayed) {
		sequence += 1;
		engine.acknowledgeRef(result.operationId, entryId ?? `entry-${sequence}`, "present_in_file");
	}
	return result;
}

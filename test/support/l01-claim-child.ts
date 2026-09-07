/**
 * One writer, in its own process, driven over IPC.
 *
 * The parent forks several of these, waits until every child reports `armed`,
 * and only then releases them all with one `go`. That is the barrier: no sleeps,
 * no stochastic timing, and no shared memory between the competitors. Each child
 * runs the real `MemoryEngine` against the real SQLite store.
 *
 * Usage: `node --experimental-strip-types l01-claim-child.ts <taskDir> <sessionId> <role> [opId]`
 */

import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { branchAt, seedBatch } from "./d0x-fixtures.ts";

export type ClaimRole =
	/** Claim, then immediately try to commit one revision. */
	| "claim_and_write"
	/** Claim and hold it until the parent says to exit. Never releases. */
	| "hold"
	/** Claim, commit, then die at the boundary with no cleanup at all. */
	| "crash_after_commit"
	/** Claim, release in an orderly way, and exit cleanly. */
	| "claim_then_release";

export const CRASH_EXIT_CODE = 17;

export interface ChildResult {
	role: string;
	sessionId: string;
	opened: boolean;
	openCode: string | null;
	openMessage: string | null;
	committed: boolean;
	commitCode: string | null;
	revisionId: string | null;
	claimToken: string | null;
	recovered: boolean;
}

function codeOf(error: unknown): string {
	if (error instanceof DagError) return error.code;
	return `unexpected:${error instanceof Error ? error.message : String(error)}`;
}

function send(message: unknown): void {
	process.send?.(message);
}

function waitFor(kind: string): Promise<void> {
	return new Promise((resolve) => {
		const handler = (message: unknown): void => {
			if ((message as { type?: string } | null)?.type !== kind) return;
			process.off("message", handler);
			resolve();
		};
		process.on("message", handler);
	});
}

async function main(): Promise<void> {
	const [taskDir, sessionId, role, opId] = process.argv.slice(2);
	if (!taskDir || !sessionId || !role) {
		throw new Error("usage: l01-claim-child <taskDir> <sessionId> <role> [opId]");
	}

	const result: ChildResult = {
		role,
		sessionId,
		opened: false,
		openCode: null,
		openMessage: null,
		committed: false,
		commitCode: null,
		revisionId: null,
		claimToken: null,
		recovered: false,
	};

	// Everything that can be done before the contended call is done here, so the
	// barrier releases every competitor into the claim itself.
	send({ type: "armed" });
	await waitFor("go");

	let engine: MemoryEngine | undefined;
	try {
		engine = MemoryEngine.open(taskDir, sessionId, "default", { recoverStaleWriter: true });
		result.opened = true;
		result.claimToken = engine.claimToken ?? null;
		result.recovered = engine.recoveredStaleClaim != null;
	} catch (error) {
		result.openCode = codeOf(error);
		result.openMessage = error instanceof Error ? error.message : String(error);
	}

	if (engine && (role === "claim_and_write" || role === "crash_after_commit")) {
		try {
			const commit = engine.update(seedBatch(opId ?? `l01-${sessionId}`), branchAt(sessionId));
			engine.acknowledgeRef(commit.operationId, `entry-${sessionId}`);
			result.committed = true;
			result.revisionId = commit.revisionId;
		} catch (error) {
			result.commitCode = codeOf(error);
		}
	}

	if (role === "crash_after_commit") {
		// No close, no release, no flush. The claim outlives the process exactly
		// the way a crash leaves it; the send callback only guarantees the parent
		// heard the report before the process stops existing.
		process.send?.({ type: "result", result }, undefined, undefined, () => {
			process.exit(CRASH_EXIT_CODE);
		});
		return;
	}

	if (engine && role === "claim_then_release") engine.release();

	send({ type: "result", result });
	await waitFor("exit");
	process.exit(0);
}

if (process.argv[1]?.endsWith("l01-claim-child.ts")) {
	await main();
}

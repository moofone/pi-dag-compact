import { hostname } from "node:os";

/**
 * Writer ownership: a claim, not a name.
 *
 * A session ID identifies a conversation, not a process. Two processes can
 * reopen the same session file, and Pi's fork copies entry IDs verbatim, so
 * "the writer is session X" cannot distinguish the live writer from a restart,
 * a crash leftover, or a second terminal. A claim therefore carries a
 * process-instance token alongside the session ID, and every mutation and every
 * release validates that token.
 *
 * Nothing here expires. There is no lease, no heartbeat and no elapsed-time
 * reclaim: for a single-writer local design a timeout can only ever steal an
 * active writer's store. Reclaim requires a verified release or a verified
 * death.
 */

export interface ProcessIdentity {
	host: string;
	pid: number;
	/** Process start time in ms, so a reused pid is not mistaken for the owner. */
	startedAt: number;
}

export interface WriterClaim extends ProcessIdentity {
	taskId: string;
	claimToken: string;
	sessionId: string;
	claimedAt: number;
}

/**
 * How sure we are that the recorded owner is gone.
 *
 * `dead` is the only value that authorizes recovery, and it is only ever
 * reached from positive evidence: the claim was made by this host, and the
 * kernel says no process holds that pid. Everything else refuses.
 */
export type OwnerLiveness =
	/** This very process made the claim. */
	| "self"
	/** A process with that pid is running. Possibly a reused pid — still refuse. */
	| "alive"
	/** Same host, and no process holds that pid. The owner cannot come back. */
	| "dead"
	/** Another host, or the kernel would not answer. Nothing can be concluded. */
	| "unverifiable";

export function currentProcess(): ProcessIdentity {
	return {
		host: hostname(),
		pid: process.pid,
		// Wall-clock start of this process. Recorded so a claim carries more than
		// a pid; a pid alone is insufficient identity.
		startedAt: Math.round(Date.now() - process.uptime() * 1000),
	};
}

/**
 * Classify the recorded owner against this process.
 *
 * The asymmetry is deliberate. Proving death needs `ESRCH` from the kernel on
 * the owning host — a claim on another host, or a pid that answers, is never
 * concluded dead. A reused pid therefore costs a refused recovery, never a
 * stolen store.
 */
export function ownerLiveness(owner: ProcessIdentity, self = currentProcess()): OwnerLiveness {
	if (owner.host !== self.host) return "unverifiable";
	if (owner.pid === self.pid && owner.startedAt === self.startedAt) return "self";
	try {
		// Signal 0 tests for existence without delivering anything.
		process.kill(owner.pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		// EPERM: the pid exists and belongs to someone else. That is still alive.
		if (code === "EPERM") return "alive";
		return "unverifiable";
	}
}

export interface RecoveryEvidence {
	recoveredToken: string;
	recoveredSessionId: string;
	owner: ProcessIdentity;
	liveness: OwnerLiveness;
	verifiedBy: "process_absent";
}

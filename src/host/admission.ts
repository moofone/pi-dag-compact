import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Owner-bound admission, scoped to what the host can actually deliver.
 *
 * The ceiling: an extension may refuse to SCHEDULE goal-owned work, may CHARGE
 * a request it observes, and may ABORT after the fact. It cannot prevent a
 * provider request the host has already issued.
 *
 * So admission here is a reservation, taken before the work is scheduled,
 * through the two channels Pi really honours — `input` -> `{action:"handled"}`
 * for a turn, and `tool_call` -> `{block:true, terminate:true}` for a
 * continuation. Transport attempts are recorded separately from logical request
 * ids: a transport-level retry of an already-reserved request is not charged
 * again, and a logical retry must reserve like anything else. There are no
 * refunds and no hidden retry allowance.
 *
 * A provider request the extension never reserved and could not deny is
 * recorded as an uncharged host-issued attempt. It does not drive the counter
 * negative and it is not quietly absorbed: it is the residual gap, and it is
 * reported.
 */

export type OwnerKind = "goal" | "peer" | "user";

export interface OwnerId {
	kind: OwnerKind;
	/** Goal id, peer id, or "user". */
	id: string;
	stage: string;
	generation: number;
}

export type ScheduleKind = "execution" | "review" | "summary" | "retry" | "recovery";

export type RefusalReason =
	| "exhausted"
	| "paused"
	| "stale_generation"
	| "fenced"
	| "unknown_owner";

export interface ScheduleAdmitted {
	admitted: true;
	requestId: string;
	kind: ScheduleKind;
	remaining: number;
}

export interface ScheduleRefused {
	admitted: false;
	reason: RefusalReason;
	detail: string;
	remaining: number;
}

export type ScheduleDecision = ScheduleAdmitted | ScheduleRefused;

export interface Reservation {
	requestId: string;
	ownerKey: string;
	generation: number;
	kind: ScheduleKind;
	/** Transport attempt ids bound to this one logical request. */
	transportAttempts: string[];
}

export type ObservationOutcome =
	| "charged"
	| "additional_transport_attempt"
	| "uncharged_host_issued"
	| "stale_generation_ignored"
	| "duplicate_transport_attempt";

export interface HostIssuedGap {
	attemptId: string;
	/** The owner that was current when the host issued it, for the record. */
	ownerKey: string | undefined;
	detail: string;
}

export interface OwnerState {
	ownerKey: string;
	kind: OwnerKind;
	id: string;
	stage: string;
	generation: number;
	allowance: number;
	scheduled: number;
	paused: boolean;
	pausedReason: string | undefined;
}

export interface AdmissionSnapshot {
	v: 1;
	owners: OwnerState[];
	reservations: Reservation[];
	unchargedHostIssued: HostIssuedGap[];
	nextRequestSequence: number;
}

export function ownerKey(owner: Pick<OwnerId, "kind" | "id" | "stage">): string {
	return `${owner.kind}:${owner.id}:${owner.stage}`;
}

export interface AdmissionStore {
	load(): AdmissionSnapshot | undefined;
	save(snapshot: AdmissionSnapshot): void;
	clear(): void;
}

function admissionFilePath(dir: string): string {
	return join(dir, "owned-admission.json");
}

export function createFileAdmissionStore(dir: string): AdmissionStore {
	const path = admissionFilePath(dir);
	return {
		load() {
			if (!existsSync(path)) return undefined;
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8")) as AdmissionSnapshot;
				return parsed.v === 1 ? parsed : undefined;
			} catch {
				return undefined;
			}
		},
		save(snapshot) {
			mkdirSync(dirname(path), { recursive: true });
			const temp = `${path}.tmp`;
			writeFileSync(temp, `${JSON.stringify(snapshot, null, "\t")}\n`);
			renameSync(temp, path);
		},
		clear() {
			rmSync(path, { force: true });
		},
	};
}

export interface AdmissionLedgerOptions {
	store?: AdmissionStore;
	/** Consulted before every schedule. A raised fence refuses goal-owned work. */
	isFenced?: () => boolean;
}

export class AdmissionLedger {
	private readonly owners = new Map<string, OwnerState>();
	private readonly reservations = new Map<string, Reservation>();
	private readonly attempts = new Map<string, string>();
	private readonly gaps: HostIssuedGap[] = [];
	private sequence = 0;
	private store: AdmissionStore | undefined;
	private readonly isFenced: () => boolean;

	constructor(options: AdmissionLedgerOptions = {}) {
		this.store = options.store;
		this.isFenced = options.isFenced ?? (() => false);
		const loaded = this.store?.load();
		if (loaded) this.load(loaded);
	}

	/**
	 * Point the ledger at persistent storage once the task directory is known.
	 *
	 * A stored snapshot wins. That is what makes exhaustion survive a reload:
	 * the budget is not handed back because the process restarted.
	 */
	rebindStore(store: AdmissionStore): void {
		this.store = store;
		const stored = store.load();
		if (stored) {
			this.load(stored);
		} else {
			this.persist();
		}
	}

	private load(snapshot: AdmissionSnapshot): void {
		this.owners.clear();
		this.reservations.clear();
		this.attempts.clear();
		this.gaps.length = 0;
		for (const owner of snapshot.owners) this.owners.set(owner.ownerKey, { ...owner });
		for (const reservation of snapshot.reservations) {
			this.reservations.set(reservation.requestId, {
				...reservation,
				transportAttempts: [...reservation.transportAttempts],
			});
			for (const attemptId of reservation.transportAttempts) {
				this.attempts.set(attemptId, reservation.requestId);
			}
		}
		this.gaps.push(...snapshot.unchargedHostIssued);
		this.sequence = snapshot.nextRequestSequence;
	}

	/** Register an owner and its finite allowance. Re-registering never refunds. */
	configure(owner: OwnerId, allowance: number): OwnerState {
		const key = ownerKey(owner);
		const existing = this.owners.get(key);
		if (existing) {
			existing.generation = Math.max(existing.generation, owner.generation);
			// No refunds: the allowance may shrink, never grow past what is left.
			existing.allowance = Math.min(existing.allowance, allowance);
			this.persist();
			return existing;
		}
		const state: OwnerState = {
			ownerKey: key,
			kind: owner.kind,
			id: owner.id,
			stage: owner.stage,
			generation: owner.generation,
			allowance,
			scheduled: 0,
			paused: false,
			pausedReason: undefined,
		};
		this.owners.set(key, state);
		this.persist();
		return state;
	}

	owner(owner: Pick<OwnerId, "kind" | "id" | "stage">): OwnerState | undefined {
		return this.owners.get(ownerKey(owner));
	}

	remaining(owner: Pick<OwnerId, "kind" | "id" | "stage">): number {
		const state = this.owners.get(ownerKey(owner));
		if (!state) return 0;
		return Math.max(0, state.allowance - state.scheduled);
	}

	get unchargedHostIssued(): readonly HostIssuedGap[] {
		return this.gaps;
	}

	scheduledFor(owner: Pick<OwnerId, "kind" | "id" | "stage">): Reservation[] {
		const key = ownerKey(owner);
		return [...this.reservations.values()].filter((item) => item.ownerKey === key);
	}

	pause(owner: Pick<OwnerId, "kind" | "id" | "stage">, reason: string): void {
		const state = this.owners.get(ownerKey(owner));
		if (!state) return;
		state.paused = true;
		state.pausedReason = reason;
		this.persist();
	}

	resume(owner: Pick<OwnerId, "kind" | "id" | "stage">): void {
		const state = this.owners.get(ownerKey(owner));
		if (!state) return;
		state.paused = false;
		state.pausedReason = undefined;
		this.persist();
	}

	/** Supersede the owner's generation. Callbacks from older generations go stale. */
	advanceGeneration(owner: Pick<OwnerId, "kind" | "id" | "stage">): number {
		const state = this.owners.get(ownerKey(owner));
		if (!state) return 0;
		state.generation += 1;
		this.persist();
		return state.generation;
	}

	/**
	 * Reserve one unit of the owner's finite budget. This is the only enforceable
	 * half of admission: refusing here means the work is never scheduled.
	 */
	schedule(owner: OwnerId, kind: ScheduleKind): ScheduleDecision {
		const key = ownerKey(owner);
		const state = this.owners.get(key);
		if (!state) {
			return {
				admitted: false,
				reason: "unknown_owner",
				detail: `no allowance configured for ${key}`,
				remaining: 0,
			};
		}
		const remaining = Math.max(0, state.allowance - state.scheduled);
		if (owner.kind === "goal" && this.isFenced()) {
			return {
				admitted: false,
				reason: "fenced",
				detail: "session persistence is uncertain; goal-owned work is not scheduled",
				remaining,
			};
		}
		if (owner.generation < state.generation) {
			return {
				admitted: false,
				reason: "stale_generation",
				detail: `generation ${owner.generation} was superseded by ${state.generation}`,
				remaining,
			};
		}
		if (state.paused) {
			return {
				admitted: false,
				reason: "paused",
				detail: state.pausedReason ?? "owner paused",
				remaining,
			};
		}
		if (remaining <= 0) {
			return {
				admitted: false,
				reason: "exhausted",
				detail: `allowance ${state.allowance} is spent; there are no refunds`,
				remaining: 0,
			};
		}
		state.scheduled += 1;
		this.sequence += 1;
		const requestId = `req-${key}-g${state.generation}-${this.sequence}`;
		this.reservations.set(requestId, {
			requestId,
			ownerKey: key,
			generation: state.generation,
			kind,
			transportAttempts: [],
		});
		this.persist();
		return {
			admitted: true,
			requestId,
			kind,
			remaining: Math.max(0, state.allowance - state.scheduled),
		};
	}

	/**
	 * Bind a transport attempt observed at the provider to a logical request.
	 *
	 * An attempt with no reservation is one the host issued and the extension
	 * could not deny. It is recorded as a gap. It never decrements a counter,
	 * so no owner is ever driven negative by a request it did not admit.
	 */
	observeTransportAttempt(
		attemptId: string,
		requestId?: string,
		context: { ownerKey?: string; detail?: string; kind?: ScheduleKind } = {},
	): ObservationOutcome {
		if (this.attempts.has(attemptId)) return "duplicate_transport_attempt";
		// Without an explicit request id, an observed attempt is matched to the
		// oldest reservation that has not yet been seen at the provider. That is
		// the honest reading of "charge a request it observes": the extension
		// admitted N requests, so the first N attempts it sees are those.
		const reservation = requestId
			? this.reservations.get(requestId)
			: [...this.reservations.values()].find(
					(candidate) =>
						candidate.transportAttempts.length === 0 &&
						(context.kind === undefined || candidate.kind === context.kind),
				);
		if (!reservation) {
			this.gaps.push({
				attemptId,
				ownerKey: context.ownerKey,
				detail:
					context.detail ??
					"provider request issued by the host with no reservation; the extension cannot deny it",
			});
			this.persist();
			return "uncharged_host_issued";
		}
		const state = this.owners.get(reservation.ownerKey);
		if (state && reservation.generation < state.generation) {
			// A callback that outlived its generation must not mutate the current one.
			this.attempts.set(attemptId, reservation.requestId);
			return "stale_generation_ignored";
		}
		this.attempts.set(attemptId, reservation.requestId);
		reservation.transportAttempts.push(attemptId);
		this.persist();
		return reservation.transportAttempts.length === 1 ? "charged" : "additional_transport_attempt";
	}

	/** Transport attempts bound to one logical request, in observation order. */
	transportAttemptsFor(requestId: string): readonly string[] {
		return this.reservations.get(requestId)?.transportAttempts ?? [];
	}

	snapshot(): AdmissionSnapshot {
		return {
			v: 1,
			owners: [...this.owners.values()].map((owner) => ({ ...owner })),
			reservations: [...this.reservations.values()].map((reservation) => ({
				...reservation,
				transportAttempts: [...reservation.transportAttempts],
			})),
			unchargedHostIssued: this.gaps.map((gap) => ({ ...gap })),
			nextRequestSequence: this.sequence,
		};
	}

	private persist(): void {
		this.store?.save(this.snapshot());
	}
}

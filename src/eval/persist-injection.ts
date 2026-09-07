/**
 * Failure injection at the host persistence boundary.
 *
 * This wraps `SessionManager._persist`, which is the last thing
 * `_appendEntry` does after it has already pushed the entry into memory,
 * indexed it, and advanced the leaf. Wrapping it intercepts the boundary and
 * nothing else: entry construction, the leaf advance, tree traversal, the
 * context builder and compaction all stay production code, which is the whole
 * point — the fixtures need to see what the real host does with a write that
 * did not happen.
 */

export interface PersistFailurePlan {
	/** Fail every append of these entry types. */
	failEntryTypes?: string[];
	/** Fail every `custom`/`custom_message` append with these customType values. */
	failCustomTypes?: string[];
	/** Fail the next N appends of any kind, counted from installation. */
	failNextAppends?: number;
	/** Stop failing after this many injected failures. Default: no limit. */
	maxFailures?: number;
	message?: string;
}

export interface PersistInjectionHandle {
	readonly failures: number;
	readonly persistedCalls: number;
	/** Entry ids the host was asked to persist, in order, failures included. */
	readonly attemptedEntryIds: readonly string[];
	arm(plan: PersistFailurePlan): void;
	disarm(): void;
	restore(): void;
}

interface PersistTarget {
	_persist(entry: unknown): void;
}

export function installPersistInjection(
	sessionManager: unknown,
	initial?: PersistFailurePlan,
): PersistInjectionHandle {
	const target = sessionManager as PersistTarget;
	const real = target._persist.bind(target);
	let plan: PersistFailurePlan | undefined = initial;
	let remaining = initial?.failNextAppends ?? 0;
	let failures = 0;
	let persistedCalls = 0;
	const attemptedEntryIds: string[] = [];

	const shouldFail = (entry: { type?: string; customType?: string }): boolean => {
		if (!plan) return false;
		if (plan.maxFailures !== undefined && failures >= plan.maxFailures) return false;
		if (plan.failEntryTypes?.includes(entry.type ?? "")) return true;
		if (entry.customType !== undefined && plan.failCustomTypes?.includes(entry.customType)) {
			return true;
		}
		if (remaining > 0) {
			remaining -= 1;
			return true;
		}
		return false;
	};

	target._persist = (entry: unknown) => {
		const record = entry as { type?: string; customType?: string; id?: string };
		if (typeof record.id === "string") attemptedEntryIds.push(record.id);
		if (shouldFail(record)) {
			failures += 1;
			throw new Error(plan?.message ?? "injected persist failure");
		}
		persistedCalls += 1;
		real(entry);
	};

	return {
		get failures() {
			return failures;
		},
		get persistedCalls() {
			return persistedCalls;
		},
		get attemptedEntryIds() {
			return attemptedEntryIds;
		},
		arm(next) {
			plan = next;
			remaining = next.failNextAppends ?? 0;
		},
		disarm() {
			plan = undefined;
			remaining = 0;
		},
		restore() {
			target._persist = real;
		},
	};
}

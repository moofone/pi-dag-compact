/**
 * Usage accounting primitives.
 *
 * Usage is never coerced: an attempt whose provider reported nothing is
 * recorded as explicitly unknown, and a field the provider did not report
 * stays flagged as unreported instead of silently becoming zero.
 */

export interface AttemptUsage {
	/** True when the provider reported input and output token counts. */
	known: boolean;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	/** False when the provider did not report reasoning tokens at all. */
	reasoningKnown: boolean;
	/** False when the provider did not report cache token counts at all. */
	cacheKnown: boolean;
}

export interface UsageDelta {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	calls: number;
}

export interface UsageBucket extends UsageDelta {
	/** Attempts whose usage the provider reported. */
	knownCalls: number;
	/** Attempts recorded with explicitly unknown usage. */
	unknownCalls: number;
	/** Re-delivered callbacks that were deduplicated by attempt identity. */
	duplicateDeliveries: number;
	/** True only when every counted attempt reported its usage. */
	usageComplete: boolean;
	/** True when at least one attempt reported reasoning tokens. */
	reasoningReported: boolean;
}

export function unknownAttemptUsage(): AttemptUsage {
	return {
		known: false,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		reasoningKnown: false,
		cacheKnown: false,
	};
}

export function emptyUsage(): UsageBucket {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		calls: 0,
		knownCalls: 0,
		unknownCalls: 0,
		duplicateDeliveries: 0,
		usageComplete: true,
		reasoningReported: false,
	};
}

export function addUsage(target: UsageBucket, extra: UsageDelta): void {
	target.input += extra.input;
	target.output += extra.output;
	target.cacheRead += extra.cacheRead;
	target.cacheWrite += extra.cacheWrite;
	target.reasoning += extra.reasoning;
	target.calls += extra.calls;
	target.knownCalls += extra.calls;
}

/** Fold one attempt into a bucket, preserving the known/unknown distinction. */
export function addAttemptUsage(target: UsageBucket, usage: AttemptUsage): void {
	target.calls += 1;
	if (!usage.known) {
		target.unknownCalls += 1;
		target.usageComplete = false;
		return;
	}
	target.knownCalls += 1;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.reasoning += usage.reasoning;
	if (usage.reasoningKnown) target.reasoningReported = true;
}

/**
 * Interpret a provider usage payload. Always returns a record: a payload that
 * reports nothing becomes explicitly unknown usage rather than disappearing.
 */
export function usageFromUnknown(value: unknown): AttemptUsage {
	if (!value || typeof value !== "object") return unknownAttemptUsage();
	const record = value as Record<string, unknown>;
	if (typeof record.input !== "number" || typeof record.output !== "number") {
		return unknownAttemptUsage();
	}
	const cacheKnown = typeof record.cacheRead === "number" && typeof record.cacheWrite === "number";
	const reasoningKnown = typeof record.reasoning === "number";
	return {
		known: true,
		input: record.input,
		output: record.output,
		cacheRead: typeof record.cacheRead === "number" ? record.cacheRead : 0,
		cacheWrite: typeof record.cacheWrite === "number" ? record.cacheWrite : 0,
		reasoning: reasoningKnown ? (record.reasoning as number) : 0,
		reasoningKnown,
		cacheKnown,
	};
}

/** Attempt identity as reported by the provider, when it reports one. */
export function attemptIdentity(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const id = (message as { responseId?: unknown }).responseId;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Usage carried by assistant messages, deduplicated by attempt identity.
 *
 * This is a view of the messages that survived the cuts, not the run total.
 * The run total comes from the append-only request ledger.
 */
export function collectMessageUsage(messages: readonly unknown[]): UsageBucket {
	const total = emptyUsage();
	const seen = new Set<string>();
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message as { role?: unknown; usage?: unknown };
		if (record.role !== undefined && record.role !== "assistant") continue;
		const identity = attemptIdentity(message);
		if (identity !== undefined) {
			if (seen.has(identity)) {
				total.duplicateDeliveries += 1;
				continue;
			}
			seen.add(identity);
		}
		addAttemptUsage(total, usageFromUnknown(record.usage));
	}
	return total;
}

export interface UsageBucket {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	calls: number;
}

export function emptyUsage(): UsageBucket {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 };
}

export function addUsage(target: UsageBucket, extra: UsageBucket): void {
	target.input += extra.input;
	target.output += extra.output;
	target.cacheRead += extra.cacheRead;
	target.cacheWrite += extra.cacheWrite;
	target.reasoning += extra.reasoning;
	target.calls += extra.calls;
}

export function usageFromUnknown(value: unknown): UsageBucket | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.input !== "number" || typeof record.output !== "number") return undefined;
	return {
		input: record.input,
		output: record.output,
		cacheRead: typeof record.cacheRead === "number" ? record.cacheRead : 0,
		cacheWrite: typeof record.cacheWrite === "number" ? record.cacheWrite : 0,
		reasoning: typeof record.reasoning === "number" ? record.reasoning : 0,
		calls: 1,
	};
}

export function collectMessageUsage(messages: unknown[]): UsageBucket {
	const total = emptyUsage();
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const usage = usageFromUnknown((message as { usage?: unknown }).usage);
		if (usage) addUsage(total, usage);
	}
	return total;
}

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function dirSize(path: string): number {
	let total = 0;
	try {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) total += dirSize(full);
			else total += statSync(full).size;
		}
	} catch {
		return total;
	}
	return total;
}

export function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index] ?? 0;
}

export function timedMs(fn: () => void): number {
	const start = process.hrtime.bigint();
	fn();
	return Number(process.hrtime.bigint() - start) / 1e6;
}

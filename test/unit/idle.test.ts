import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "../../src/eval/paths.ts";

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

test("memory and extension cores have no periodic idle timers", () => {
	const files = [
		...walk(join(repoRoot(), "src/memory")),
		...walk(join(repoRoot(), "src/extension")),
	];
	for (const file of files) {
		const body = readFileSync(file, "utf8");
		assert.equal(body.includes("setInterval"), false, file);
		assert.equal(body.includes("setTimeout"), false, file);
	}
});

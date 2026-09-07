import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createClassicHarness } from "../../src/eval/harness.ts";
import { loadEvalConfig } from "../../src/eval/load.ts";
import { createIsolatedWorkspace } from "../../src/eval/workspace.ts";
import piDagCompact from "../../src/index.ts";

test("record-only mode keeps ordinary compact classic", async () => {
	const workspace = createIsolatedWorkspace();
	const config = loadEvalConfig();
	const taskDir = join(workspace.cwd, "research-task");
	mkdirSync(join(workspace.cwd, ".pi"), { recursive: true });
	mkdirSync(taskDir, { recursive: true });
	writeFileSync(
		join(workspace.cwd, ".pi", "pi-dag-compact.json"),
		`${JSON.stringify({ mode: "record-only", taskDir }, null, "\t")}\n`,
	);
	const harness = await createClassicHarness(workspace, config, {
		extraExtensions: [piDagCompact],
	});
	try {
		await harness.session.prompt(`# Scenario turn 1\nsetup\n${"alpha ".repeat(2000)}`);
		await harness.session.prompt(`# Scenario turn 2\nmore\n${"beta ".repeat(2000)}`);
		const result = await harness.session.compact();
		assert.equal(typeof result.summary, "string");
		assert.equal(result.summary.includes("# DAG handoff"), false);
		const details = result.details as { source?: string } | undefined;
		assert.notEqual(details?.source, "dag-handoff");
	} finally {
		await harness.cleanup();
		workspace.cleanup();
	}
});

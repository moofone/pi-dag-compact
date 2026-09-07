import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { repoRoot } from "../../src/eval/paths.ts";

test("eval:live refuses paid providers without PI_DAG_COMPACT_LIVE", () => {
	const result = spawnSync("node", ["--experimental-strip-types", "src/eval/run-live.ts"], {
		cwd: repoRoot(),
		encoding: "utf8",
		env: { ...process.env, PI_DAG_COMPACT_LIVE: "" },
	});
	assert.equal(result.status, 2);
	assert.match(result.stderr, /refusing live providers/);
});

test("eval:live still does not call a provider when the flag is set", () => {
	const result = spawnSync("node", ["--experimental-strip-types", "src/eval/run-live.ts"], {
		cwd: repoRoot(),
		encoding: "utf8",
		env: { ...process.env, PI_DAG_COMPACT_LIVE: "1" },
	});
	assert.equal(result.status, 2);
	assert.match(result.stderr, /No provider was called/);
});

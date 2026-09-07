import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { makeTempDir } from "../support/tmp.ts";

test("a started run cannot relaunch until it is reconciled", () => {
	const tmp = makeTempDir("pi-dag-run-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		engine.beginRun("run-1", "op-1", { host: "local", job: "pid-1" });
		assert.throws(
			() => engine.beginRun("run-1", "op-2", { host: "local", job: "pid-2" }),
			(error: unknown) => error instanceof DagError && error.code === "unreconciled_run",
		);
		engine.finishRun("run-1", "interrupted", { reason: "crash" });
		engine.beginRun("run-1", "op-3", { host: "local", job: "pid-3" });
		engine.finishRun("run-1", "completed", { ok: true });
		assert.equal(engine.getRun("run-1")?.status, "completed");
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

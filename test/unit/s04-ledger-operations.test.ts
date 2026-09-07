import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { ingestRun } from "../../src/memory/experiment.ts";
import { makeTempDir } from "../support/tmp.ts";

interface StoreProbe {
	db: {
		prepare(sql: string): {
			get(...params: unknown[]): unknown;
			all(...params: unknown[]): unknown;
		};
	};
	putRun(runId: string, operationId: string, status: string, payloadJson: string): void;
}

function probe(engine: MemoryEngine): StoreProbe {
	return (engine as unknown as { store: StoreProbe }).store;
}

function countEvents(engine: MemoryEngine): number {
	const row = probe(engine).db.prepare("SELECT COUNT(*) AS n FROM research_events").get() as {
		n: number;
	};
	return Number(row.n);
}

function manifest(runId: string, candidateId: string) {
	return {
		schemaVersion: 1,
		runId,
		candidateId,
		workloadId: "W1",
		question: `does ${candidateId} reduce pipeline p50 for W1?`,
		source: {
			commit: "deadbeef0001",
			patchPath: `candidates/${candidateId}.patch`,
			sha256: "a".repeat(64),
		},
		command: ["replay-artifact", "--run", runId],
		environment: {
			gpu: "replay-gpu",
			driver: "replay-driver",
			host: "artifact-host",
			clocksLocked: true,
		},
		inputs: { workloadPath: "workloads/w1.json", dimensions: "M=4096", seed: 7 },
	};
}

function result(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		runId,
		status: "completed",
		measurements: {
			pipelineP50Ms: 12.4,
			kernelP50Ms: 3.1,
			smemPct: 40,
			unit: "ms",
			warmupIters: 10,
			sampleIters: 50,
		},
		correctness: { check: "ulp2", outcome: "pass", evidence: `runs/${runId}/correctness.txt` },
		...overrides,
	};
}

function writeRun(
	workspace: string,
	runId: string,
	candidateId: string,
	resultOverrides: Record<string, unknown> = {},
): void {
	const dir = join(workspace, "runs", runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(runId, candidateId)));
	writeFileSync(join(dir, "result.json"), JSON.stringify(result(runId, resultOverrides)));
}

test("S04 an identical ingest retry returns the same record id and writes one event", () => {
	const tmp = makeTempDir("pi-dag-s04-");
	try {
		const engine = MemoryEngine.open(join(tmp.path, "task"), "s");
		writeRun(tmp.path, "run-a", "schedule");
		const first = ingestRun(engine, tmp.path, "run-a", "ing-a");
		assert.equal(typeof first, "object", "ingest must report a structured outcome");
		const again = ingestRun(engine, tmp.path, "run-a", "ing-a");
		assert.equal(again.recordId, first.recordId);
		assert.equal(countEvents(engine), 1);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S04 a reused operation id with conflicting content fails", () => {
	const tmp = makeTempDir("pi-dag-s04-");
	try {
		const engine = MemoryEngine.open(join(tmp.path, "task"), "s");
		writeRun(tmp.path, "run-a", "schedule");
		writeRun(tmp.path, "run-b", "fusion");
		ingestRun(engine, tmp.path, "run-a", "ing-shared");
		assert.throws(
			() => ingestRun(engine, tmp.path, "run-b", "ing-shared"),
			(error: unknown) => error instanceof DagError && error.code === "op_conflict",
		);
		assert.equal(countEvents(engine), 1);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S04 an interruption between the event write and the run publication recovers exactly once", () => {
	const tmp = makeTempDir("pi-dag-s04-");
	try {
		const engine = MemoryEngine.open(join(tmp.path, "task"), "s");
		writeRun(tmp.path, "run-a", "schedule");
		const store = probe(engine);
		const original = store.putRun.bind(store);
		let tripped = false;
		store.putRun = (...args: Parameters<StoreProbe["putRun"]>) => {
			if (!tripped) {
				tripped = true;
				throw new Error("barrier: crash between event write and run publication");
			}
			original(...args);
		};
		assert.throws(() => ingestRun(engine, tmp.path, "run-a", "ing-a"));
		assert.equal(tripped, true);
		assert.equal(countEvents(engine), 0, "an interrupted ingest must leave no event behind");
		assert.equal(engine.getRun("run-a"), undefined);

		const recovered = ingestRun(engine, tmp.path, "run-a", "ing-a");
		assert.equal(countEvents(engine), 1);
		assert.equal(engine.getRun("run-a")?.status, "completed");
		assert.equal(typeof recovered.recordId, "string");
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S04 research events over 16 KiB are rejected atomically", () => {
	const tmp = makeTempDir("pi-dag-s04-");
	try {
		const engine = MemoryEngine.open(join(tmp.path, "task"), "s");
		writeRun(tmp.path, "run-big", "schedule", {
			correctness: { check: "ulp2", outcome: "pass", evidence: "x".repeat(20 * 1024) },
		});
		assert.throws(
			() => ingestRun(engine, tmp.path, "run-big", "ing-big"),
			(error: unknown) => error instanceof DagError && error.code === "limit",
		);
		assert.equal(countEvents(engine), 0);
		assert.equal(engine.getRun("run-big"), undefined);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S04 a failed or interrupted result is never relabelled completed", () => {
	const tmp = makeTempDir("pi-dag-s04-");
	try {
		const engine = MemoryEngine.open(join(tmp.path, "task"), "s");
		writeRun(tmp.path, "run-failed", "fusion", { status: "failed" });
		const outcome = ingestRun(engine, tmp.path, "run-failed", "ing-failed");
		assert.equal(outcome.runStatus, "failed");
		assert.equal(engine.getRun("run-failed")?.status, "failed");
		assert.throws(
			() => engine.finishRun("run-failed", "completed", { relabelled: true }),
			(error: unknown) => error instanceof DagError && error.code === "run_status_conflict",
		);
		assert.equal(engine.getRun("run-failed")?.status, "failed");
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

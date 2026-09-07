import assert from "node:assert/strict";
import { test } from "node:test";
import { HandoffController } from "../../src/extension/handoff.ts";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { assertHandoffEligible, reviewIsFresh } from "../../src/memory/handoff.ts";
import { makeTempDir } from "../support/tmp.ts";

function seed(dir: string, body = ""): MemoryEngine {
	const engine = MemoryEngine.open(dir, "s");
	engine.update(
		{
			operationId: "seed",
			upsertNodes: [
				{ id: "goal", kind: "goal", title: "pipeline p50", body, status: "open" },
				{ id: "ceiling", kind: "constraint", title: "smem 64", body, status: "open" },
				{
					id: "baseline",
					kind: "decision",
					title: "accepted baseline C",
					body: "run-C",
					status: "done",
				},
				{ id: "next", kind: "task", title: "run E", body, status: "open" },
			],
		},
		{ sessionId: "s", leafId: "leaf-1" },
	);
	return engine;
}

function compactEvent(
	reason: "manual" | "threshold" | "overflow" = "manual",
	aborted = false,
): {
	reason: "manual" | "threshold" | "overflow";
	signal: AbortSignal;
	preparation: { firstKeptEntryId: string; tokensBefore: number };
} {
	const controller = new AbortController();
	if (aborted) controller.abort();
	return {
		reason,
		signal: controller.signal,
		preparation: { firstKeptEntryId: "kept", tokensBefore: 100 },
	};
}

test("handoff is refused without a checkpoint", () => {
	const tmp = makeTempDir("pi-dag-handoff-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		assert.throws(
			() => assertHandoffEligible(engine),
			(error: unknown) => error instanceof DagError && error.code === "handoff_refused",
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("a user correction after review falls back to classic", () => {
	const tmp = makeTempDir("pi-dag-handoff-");
	try {
		const engine = seed(tmp.path);
		const handoff = new HandoffController();
		const review = handoff.prepare(engine, { sessionId: "s", leafId: "leaf-1" });
		handoff.arm(review);
		assert.equal(
			reviewIsFresh(review, { sessionId: "s", leafId: "leaf-2", revisionId: review.revisionId }),
			false,
		);
		const decision = handoff.onBeforeCompact(
			compactEvent(),
			{ sessionId: "s", leafId: "leaf-2", revisionId: review.revisionId },
			"card",
		);
		assert.equal(decision, undefined);
		assert.equal(handoff.fallbacks, 1);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("fresh review coverage is not semantic proof", () => {
	const tmp = makeTempDir("pi-dag-handoff-");
	try {
		const engine = seed(tmp.path);
		const review = new HandoffController().prepare(engine, { sessionId: "s", leafId: "leaf-1" });
		assert.equal(
			reviewIsFresh(review, { sessionId: "s", leafId: "leaf-1", revisionId: review.revisionId }),
			true,
		);
		assert.equal(
			engine.snapshot().nodes.some((node) => node.title.includes("smem 64")),
			true,
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("unarmed compact stays classic", () => {
	const handoff = new HandoffController();
	const decision = handoff.onBeforeCompact(
		compactEvent(),
		{ sessionId: "s", leafId: "leaf-1", revisionId: "rev" },
		"card",
	);
	assert.equal(decision, undefined);
});

test("threshold compaction is never a DAG handoff", () => {
	const tmp = makeTempDir("pi-dag-handoff-");
	try {
		const engine = seed(tmp.path);
		const handoff = new HandoffController();
		handoff.arm(handoff.prepare(engine, { sessionId: "s", leafId: "leaf-1" }));
		const decision = handoff.onBeforeCompact(
			compactEvent("threshold"),
			{ sessionId: "s", leafId: "leaf-1", revisionId: engine.snapshot().revisionId },
			"card",
		);
		assert.equal(decision, undefined);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("abort during an armed handoff cancels the cut", () => {
	const tmp = makeTempDir("pi-dag-handoff-");
	try {
		const engine = seed(tmp.path);
		const handoff = new HandoffController();
		handoff.arm(handoff.prepare(engine, { sessionId: "s", leafId: "leaf-1" }));
		const decision = handoff.onBeforeCompact(
			compactEvent("manual", true),
			{ sessionId: "s", leafId: "leaf-1", revisionId: engine.snapshot().revisionId },
			"card",
		);
		assert.deepEqual(decision, { cancel: true });
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("a fenced session cannot compact or re-arm", () => {
	const handoff = new HandoffController();
	handoff.block("compaction append failed; repair the session before another handoff");
	assert.deepEqual(
		handoff.onBeforeCompact(
			compactEvent(),
			{ sessionId: "s", leafId: "l", revisionId: "r" },
			"card",
		),
		{ cancel: true },
	);
	assert.throws(
		() =>
			handoff.arm({
				sessionId: "s",
				leafId: "l",
				revisionId: "r",
				checkpointId: "c",
				coveredThroughEntryId: "l",
			}),
		(error: unknown) => error instanceof DagError && error.code === "handoff_fenced",
	);
});

test("an oversized handoff card is refused", () => {
	const tmp = makeTempDir("pi-dag-handoff-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s");
		engine.update(
			{
				operationId: "big",
				upsertNodes: Array.from({ length: 12 }, (_, index) => ({
					id: `n${index}`,
					kind: "task" as const,
					title: `task ${index}`,
					body: "x".repeat(1000),
					status: "open" as const,
				})),
			},
			{ sessionId: "s", leafId: "leaf-1" },
		);
		assert.throws(
			() => assertHandoffEligible(engine),
			(error: unknown) => error instanceof DagError && error.code === "handoff_refused",
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

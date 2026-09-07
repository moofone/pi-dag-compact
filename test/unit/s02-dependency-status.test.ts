import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBatch, MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { validateDependsOn } from "../../src/memory/graph.ts";
import { dagStatus, queryWorkingSet } from "../../src/memory/query.ts";
import type { NodeStatus, WorkingEdge, WorkingNode } from "../../src/schema/working.ts";
import { makeTempDir } from "../support/tmp.ts";

const BRANCH = { sessionId: "s", leafId: "leaf-1" };

function node(id: string, kind: WorkingNode["kind"] = "task"): WorkingNode {
	return { id, kind, title: id, body: "", status: "open", evidence: [], paths: [], revision: 1 };
}

function seedPair(dir: string, prerequisiteStatus: NodeStatus): MemoryEngine {
	const engine = MemoryEngine.open(dir, "s");
	engine.update(
		{
			operationId: "seed",
			upsertNodes: [
				{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
				{ id: "B", kind: "task", title: "build the harness", body: "", status: prerequisiteStatus },
				{ id: "A", kind: "task", title: "run the sweep", body: "", status: "open" },
			],
			addEdges: [{ from: "A", to: "B", kind: "depends_on" }],
		},
		BRANCH,
	);
	return engine;
}

test("S02 a done prerequisite makes an otherwise open dependent eligible, other statuses do not", () => {
	const done = makeTempDir("pi-dag-s02-");
	try {
		const engine = seedPair(done.path, "done");
		assert.equal(
			dagStatus(engine)
				.nextAction.map((item) => item.id)
				.includes("A"),
			true,
		);
		engine.close();
	} finally {
		done.cleanup();
	}

	for (const status of ["open", "blocked", "stale", "rejected"] as const) {
		const tmp = makeTempDir("pi-dag-s02-");
		try {
			const engine = seedPair(tmp.path, status);
			assert.equal(
				dagStatus(engine)
					.nextAction.map((item) => item.id)
					.includes("A"),
				false,
				`prerequisite status ${status} must not imply eligibility`,
			);
			engine.close();
		} finally {
			tmp.cleanup();
		}
	}
});

test("S02 a blocked dependent is never a next action even with a done prerequisite", () => {
	const tmp = makeTempDir("pi-dag-s02-");
	try {
		const engine = seedPair(tmp.path, "done");
		engine.update({ operationId: "block-a", setStatus: [{ id: "A", status: "blocked" }] }, BRANCH);
		assert.equal(
			dagStatus(engine)
				.nextAction.map((item) => item.id)
				.includes("A"),
			false,
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

// Regression preservation: these depends_on validation cases are already green on the candidate.
test("S02 whole-batch cycles, self-dependency, and missing endpoints are rejected", () => {
	const nodes = [node("a"), node("b")];
	const edges: WorkingEdge[] = [{ from: "a", to: "b", kind: "depends_on" }];
	assert.doesNotThrow(() => validateDependsOn(nodes, edges));
	assert.throws(
		() =>
			applyBatch(
				nodes,
				edges,
				{
					operationId: "cycle",
					addEdges: [{ from: "b", to: "a", kind: "depends_on" }],
				},
				2,
			),
		(error: unknown) => error instanceof DagError && error.code === "cycle",
	);
	assert.throws(
		() => validateDependsOn(nodes, [{ from: "a", to: "a", kind: "depends_on" }]),
		(error: unknown) => error instanceof DagError && error.code === "cycle",
	);
	assert.throws(
		() =>
			applyBatch(
				nodes,
				edges,
				{
					operationId: "missing",
					addEdges: [{ from: "a", to: "ghost", kind: "depends_on" }],
				},
				2,
			),
		(error: unknown) => error instanceof DagError && error.code === "unknown_node",
	);
});

// Regression preservation: non-dependency cycles stay legal.
test("S02 cycles in non-depends_on relationships stay permitted", () => {
	const nodes = [node("a"), node("b")];
	assert.doesNotThrow(() =>
		validateDependsOn(nodes, [
			{ from: "a", to: "b", kind: "supports" },
			{ from: "b", to: "a", kind: "supports" },
			{ from: "a", to: "b", kind: "alternative_to" },
			{ from: "b", to: "a", kind: "alternative_to" },
		]),
	);
});

// Regression preservation: prerequisites are ordered before dependents.
test("S02 prerequisite-first ordering is preserved in active queries", () => {
	const tmp = makeTempDir("pi-dag-s02-");
	try {
		const engine = seedPair(tmp.path, "open");
		const records = queryWorkingSet(engine, { scope: "active", ids: ["A", "B"] }).records;
		assert.equal(records.length, 2);
		const order = queryWorkingSet(engine, { scope: "active", q: "the" }).records.map(
			(item) => item.id,
		);
		assert.equal(order.indexOf("B") < order.indexOf("A"), true);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

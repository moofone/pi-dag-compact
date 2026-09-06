import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBatch } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { validateDependsOn } from "../../src/memory/graph.ts";
import type { WorkingEdge, WorkingNode } from "../../src/schema/working.ts";

function node(id: string, kind: WorkingNode["kind"] = "task"): WorkingNode {
	return { id, kind, title: id, body: "", status: "open", evidence: [], paths: [], revision: 1 };
}

test("depends_on cycles are rejected, including cycles created only by a batch", () => {
	const nodes = [node("a"), node("b")];
	const edges: WorkingEdge[] = [{ from: "a", to: "b", kind: "depends_on" }];
	assert.doesNotThrow(() => validateDependsOn(nodes, edges));
	assert.throws(
		() => validateDependsOn(nodes, [...edges, { from: "b", to: "a", kind: "depends_on" }]),
		(error: unknown) => error instanceof DagError && error.code === "cycle",
	);
});

test("non-dependency cycles remain allowed", () => {
	const nodes = [node("a"), node("b")];
	validateDependsOn(nodes, [
		{ from: "a", to: "b", kind: "supports" },
		{ from: "b", to: "a", kind: "supports" },
	]);
});

test("a batch that would close a depends_on cycle is rejected before commit", () => {
	const nodes = [node("a"), node("b")];
	const edges: WorkingEdge[] = [{ from: "a", to: "b", kind: "depends_on" }];
	assert.throws(
		() =>
			applyBatch(
				nodes,
				edges,
				{
					operationId: "op-cycle",
					addEdges: [{ from: "b", to: "a", kind: "depends_on" }],
				},
				2,
			),
		(error: unknown) => error instanceof DagError && error.code === "cycle",
	);
});

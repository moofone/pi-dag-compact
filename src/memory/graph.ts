import { DirectedGraph } from "graphology";
import { hasCycle, topologicalSort } from "graphology-dag";
import type { WorkingEdge, WorkingNode } from "../schema/working.ts";
import { edgeKey } from "./canonical.ts";
import { DagError } from "./errors.ts";
import { LIMITS, utf8Bytes } from "./limits.ts";

export function cloneNodes(nodes: WorkingNode[]): WorkingNode[] {
	return nodes.map((node) => ({
		...node,
		evidence: [...node.evidence],
		paths: [...node.paths],
	}));
}

export function cloneEdges(edges: WorkingEdge[]): WorkingEdge[] {
	return edges.map((edge) => ({ ...edge }));
}

export function validateActiveSet(nodes: WorkingNode[], edges: WorkingEdge[]): void {
	if (nodes.length > LIMITS.maxNodes) {
		throw new DagError("limit", `active set exceeds ${LIMITS.maxNodes} nodes`);
	}
	if (edges.length > LIMITS.maxEdges) {
		throw new DagError("limit", `active set exceeds ${LIMITS.maxEdges} edges`);
	}
	const serialized = JSON.stringify({ nodes, edges });
	if (utf8Bytes(serialized) > LIMITS.maxSerializedBytes) {
		throw new DagError("limit", `active set exceeds ${LIMITS.maxSerializedBytes} serialized bytes`);
	}
	const ids = new Set(nodes.map((node) => node.id));
	for (const edge of edges) {
		if (!ids.has(edge.from) || !ids.has(edge.to)) {
			throw new DagError("unknown_node", `edge ${edgeKey(edge)} references a missing node`);
		}
	}
	validateDependsOn(nodes, edges);
}

export function validateDependsOn(nodes: WorkingNode[], edges: WorkingEdge[]): void {
	const graph = new DirectedGraph({ allowSelfLoops: false });
	for (const node of nodes) {
		graph.addNode(node.id);
	}
	for (const edge of edges) {
		if (edge.kind !== "depends_on") continue;
		if (edge.from === edge.to) {
			throw new DagError("cycle", "depends_on self-loop is not allowed");
		}
		if (!graph.hasEdge(edge.to, edge.from)) {
			graph.addEdge(edge.to, edge.from);
		}
	}
	if (hasCycle(graph)) {
		throw new DagError("cycle", "depends_on edges must be acyclic");
	}
}

/**
 * `A --depends_on--> B` means B is a prerequisite of A. Only status `done`
 * satisfies a prerequisite; `open`, `blocked`, `stale`, and `rejected` do not.
 */
export function prerequisiteIds(id: string, edges: WorkingEdge[]): string[] {
	return edges
		.filter((edge) => edge.kind === "depends_on" && edge.from === id)
		.map((edge) => edge.to);
}

export function unsatisfiedPrerequisites(
	id: string,
	nodes: WorkingNode[],
	edges: WorkingEdge[],
): string[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	return prerequisiteIds(id, edges).filter((target) => byId.get(target)?.status !== "done");
}

/**
 * Open tasks whose whole `depends_on` closure of direct prerequisites is done.
 * Bounded whole-graph check over the active set; no incremental maintenance.
 */
export function eligibleTaskIds(nodes: WorkingNode[], edges: WorkingEdge[]): string[] {
	return nodes
		.filter(
			(node) =>
				node.kind === "task" &&
				node.status === "open" &&
				unsatisfiedPrerequisites(node.id, nodes, edges).length === 0,
		)
		.map((node) => node.id);
}

export function prerequisiteOrder(nodes: WorkingNode[], edges: WorkingEdge[]): string[] {
	const graph = new DirectedGraph({ allowSelfLoops: false });
	for (const node of nodes) graph.addNode(node.id);
	for (const edge of edges) {
		if (edge.kind !== "depends_on") continue;
		if (!graph.hasEdge(edge.to, edge.from)) graph.addEdge(edge.to, edge.from);
	}
	return topologicalSort(graph);
}

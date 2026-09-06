import { createHash, randomUUID } from "node:crypto";
import type { MutationBatch, WorkingEdge, WorkingNode } from "../schema/working.ts";

export function newId(prefix: string): string {
	return `${prefix}_${randomUUID()}`;
}

export function edgeKey(edge: WorkingEdge): string {
	return `${edge.from}\t${edge.to}\t${edge.kind}`;
}

export function canonicalSnapshot(nodes: WorkingNode[], edges: WorkingEdge[]): string {
	const nodeRows = [...nodes]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((node) => ({
			id: node.id,
			kind: node.kind,
			title: node.title,
			body: node.body,
			status: node.status,
			evidence: node.evidence,
			paths: node.paths,
			revision: node.revision,
		}));
	const edgeRows = [...edges]
		.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))
		.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind }));
	return JSON.stringify({ nodes: nodeRows, edges: edgeRows });
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function canonicalBatch(batch: MutationBatch): string {
	return JSON.stringify({
		operationId: batch.operationId,
		upsertNodes: batch.upsertNodes ?? [],
		setStatus: batch.setStatus ?? [],
		addEdges: batch.addEdges ?? [],
		removeEdges: batch.removeEdges ?? [],
		archiveIds: batch.archiveIds ?? [],
	});
}

import { parseWithSchema } from "../schema/validate.ts";
import type { QueryRequest, WorkingNode } from "../schema/working.ts";
import { QueryRequestSchema } from "../schema/working.ts";
import type { MemoryEngine } from "./engine.ts";
import { prerequisiteOrder } from "./graph.ts";
import { LIMITS, utf8Bytes } from "./limits.ts";

export interface QueryResult {
	scope: "active" | "history";
	complete: boolean;
	truncated: boolean;
	cursor?: string;
	records: WorkingNode[];
	bytes: number;
}

function matchNode(node: WorkingNode, query?: string): boolean {
	if (!query) return true;
	const haystack =
		`${node.id}\n${node.title}\n${node.body}\n${node.kind}\n${node.status}`.toLowerCase();
	return haystack.includes(query.toLowerCase());
}

export function queryWorkingSet(engine: MemoryEngine, requestInput: QueryRequest): QueryResult {
	const request = parseWithSchema(QueryRequestSchema, requestInput, "dag_query");
	const snapshot = engine.snapshot();

	if (request.ids && request.ids.length > LIMITS.maxIdReads) {
		return {
			scope: request.scope,
			complete: false,
			truncated: true,
			records: [],
			bytes: 0,
		};
	}

	let candidates: WorkingNode[];
	if (request.scope === "history") {
		candidates = engine.archivedSearch(request.q ?? "", LIMITS.maxQueryRecords + 1, request.cursor);
	} else if (request.ids && request.ids.length > 0) {
		const wanted = new Set(request.ids);
		candidates = snapshot.nodes.filter((node) => wanted.has(node.id));
	} else {
		const order = new Map(
			prerequisiteOrder(snapshot.nodes, snapshot.edges).map((id, index) => [id, index]),
		);
		candidates = snapshot.nodes
			.filter((node) => matchNode(node, request.q))
			.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
	}

	const records: WorkingNode[] = [];
	let bytes = 0;
	let truncated = false;
	let complete = true;
	for (const node of candidates) {
		const encoded = JSON.stringify(node);
		const size = utf8Bytes(encoded);
		if (records.length >= LIMITS.maxQueryRecords || bytes + size > LIMITS.maxQueryBytes) {
			truncated = true;
			complete = false;
			break;
		}
		records.push(node);
		bytes += size;
	}

	if (request.scope === "active" && request.ids) {
		complete = request.ids.every(
			(id) =>
				records.some((node) => node.id === id) || snapshot.nodes.some((node) => node.id === id),
		);
		if (request.ids.some((id) => !snapshot.nodes.some((node) => node.id === id))) {
			complete = false;
		}
	}

	const cursor = truncated ? records.at(-1)?.id : undefined;
	return {
		scope: request.scope,
		complete,
		truncated,
		...(cursor ? { cursor } : {}),
		records,
		bytes,
	};
}

export function dagStatus(engine: MemoryEngine): {
	objective: WorkingNode[];
	constraints: WorkingNode[];
	acceptedBaseline: WorkingNode[];
	currentWork: WorkingNode[];
	blockers: WorkingNode[];
	nextAction: WorkingNode[];
	rejected: WorkingNode[];
	revisionId: string | null;
} {
	const { nodes, edges, revisionId } = engine.snapshot();
	const blocked = new Set(
		edges.filter((edge) => edge.kind === "depends_on").map((edge) => edge.from),
	);
	const open = (kind: WorkingNode["kind"]) =>
		nodes.filter((node) => node.kind === kind && node.status === "open");
	return {
		objective: nodes.filter((node) => node.kind === "goal"),
		constraints: nodes.filter((node) => node.kind === "constraint"),
		acceptedBaseline: nodes.filter(
			(node) => node.kind === "decision" && node.status === "done" && /baseline/i.test(node.title),
		),
		currentWork: [...open("task"), ...open("hypothesis")],
		blockers: open("blocker"),
		nextAction: open("task").filter((node) => !blocked.has(node.id)),
		rejected: nodes.filter((node) => node.status === "rejected"),
		revisionId,
	};
}

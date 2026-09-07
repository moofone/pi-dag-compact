import { parseWithSchema } from "../schema/validate.ts";
import type { ActiveSelection, QueryRequest, WorkingNode } from "../schema/working.ts";
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

export interface DagStatus {
	objective: WorkingNode[];
	constraints: WorkingNode[];
	acceptedBaseline: WorkingNode[];
	bestObserved: WorkingNode[];
	bestValidated: WorkingNode[];
	currentWork: WorkingNode[];
	blockers: WorkingNode[];
	unresolved: WorkingNode[];
	nextAction: WorkingNode[];
	rejected: WorkingNode[];
	selection: ActiveSelection;
	ambiguousSelections: string[];
	revisionId: string | null;
}

/**
 * Project the active set through its typed selection.
 *
 * Every list here comes from selected record IDs. Nothing is matched on title
 * text: whether a record is the accepted baseline is a decision recorded in
 * the selection, not a property of what it is called.
 */
export function dagStatus(engine: MemoryEngine): DagStatus {
	const { nodes, revisionId, selection, ambiguousSelections } = engine.snapshot();
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const pick = (ids: string[]): WorkingNode[] =>
		ids.map((id) => byId.get(id)).filter((node): node is WorkingNode => node !== undefined);
	const one = (id: string | null): WorkingNode[] => (id ? pick([id]) : []);

	// Blockers are their own kind plus anything explicitly blocked; unresolved
	// questions are a different thing and are never folded into them.
	const blockers = [
		...nodes.filter((node) => node.kind === "blocker" && node.status === "open"),
		...nodes.filter((node) => node.kind !== "blocker" && node.status === "blocked"),
	];

	return {
		objective: one(selection.objectiveId || null),
		constraints: pick(selection.constraintIds),
		acceptedBaseline: one(selection.acceptedBaselineRecordId),
		bestObserved: one(selection.bestObservedRecordId),
		bestValidated: one(selection.bestValidatedRecordId),
		currentWork: pick(selection.currentWorkIds),
		blockers,
		unresolved: pick(selection.unresolvedIds).filter((node) => node.kind !== "blocker"),
		nextAction: pick(selection.nextActionIds),
		rejected: pick(selection.rejectedApproachIds),
		selection,
		ambiguousSelections,
		revisionId,
	};
}

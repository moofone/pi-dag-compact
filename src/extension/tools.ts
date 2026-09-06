import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DagError } from "../memory/errors.ts";
import { ingestRun } from "../memory/experiment.ts";
import { queryWorkingSet } from "../memory/query.ts";
import { MutationBatchSchema, QueryRequestSchema } from "../schema/working.ts";
import type { ExtensionRuntime } from "./runtime.ts";

function errorResult(error: unknown): {
	content: [{ type: "text"; text: string }];
	details: { error: string };
} {
	const message = error instanceof DagError ? `${error.code}: ${error.message}` : String(error);
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
	};
}

export function registerRecordTools(pi: ExtensionAPI, runtime: ExtensionRuntime): void {
	pi.registerTool({
		name: "dag_update",
		label: "DAG update",
		description: "Apply a batched working-set mutation and persist one revision.",
		parameters: MutationBatchSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const engine = runtime.ensureEngine(ctx);
				const result = engine.update(params, {
					sessionId: ctx.sessionManager.getSessionId(),
					leafId: ctx.sessionManager.getLeafId() ?? "none",
				});
				pi.appendEntry(
					result.checkpointId ? "dag_checkpoint_ref" : "dag_revision_ref",
					result.piRef,
				);
				engine.acknowledgeRef(result.operationId, ctx.sessionManager.getLeafId() ?? "appended");
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								revisionId: result.revisionId,
								revision: result.revision,
								operationId: result.operationId,
								checkpointId: result.checkpointId,
							}),
						},
					],
					details: { revisionId: result.revisionId },
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "dag_query",
		label: "DAG query",
		description: "Search the active working set or archived history. Coverage is explicit.",
		parameters: QueryRequestSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const engine = runtime.ensureEngine(ctx);
				const result = queryWorkingSet(engine, params);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					details: { complete: result.complete, truncated: result.truncated },
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "session_read",
		label: "Session read",
		description:
			"Read a session-qualified evidence entry on the current branch, or report unavailable.",
		parameters: Type.Object({
			sessionId: Type.String({ minLength: 1 }),
			entryId: Type.String({ minLength: 1 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = ctx.sessionManager.getSessionId();
			if (params.sessionId !== current) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ unavailable: true, reason: "foreign_session" }),
						},
					],
					details: { unavailable: true },
				};
			}
			const entry = ctx.sessionManager.getBranch().find((item) => item.id === params.entryId);
			if (!entry) {
				return {
					content: [
						{ type: "text", text: JSON.stringify({ unavailable: true, reason: "missing_entry" }) },
					],
					details: { unavailable: true },
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(entry) }],
				details: { id: entry.id },
			};
		},
	});

	pi.registerTool({
		name: "dag_ingest_run",
		label: "Ingest experiment run",
		description: "Record manifest.json and result.json for an existing bench run id.",
		parameters: Type.Object({
			operationId: Type.String({ minLength: 1 }),
			runId: Type.String({ minLength: 1 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const engine = runtime.ensureEngine(ctx);
				const recordId = ingestRun(engine, ctx.cwd, params.runId, params.operationId);
				return {
					content: [{ type: "text", text: JSON.stringify({ recordId, runId: params.runId }) }],
					details: { recordId },
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}

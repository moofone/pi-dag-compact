import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DagError } from "../memory/errors.ts";
import { ingestRun } from "../memory/experiment.ts";
import { queryWorkingSet } from "../memory/query.ts";
import { ObjectiveMetricSchema } from "../schema/experiment.ts";
import { MutationBatchSchema, QueryRequestSchema } from "../schema/working.ts";
import { resolveConfig } from "./config.ts";
import type { ExtensionRuntime } from "./runtime.ts";
import { resolveSessionEvidence } from "./session.ts";

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
				if (resolveConfig(ctx.cwd).mode === "disabled") {
					throw new DagError("disabled", "pi-dag-compact is disabled");
				}
				if (runtime.handoff.fenced) {
					throw new DagError("handoff_fenced", runtime.handoff.fenced);
				}
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
								// Creation returns its assigned IDs, so the caller never
								// has to reread the graph to find what it just made.
								assignedIds: result.assignedIds,
								selectionRevision: result.selection.selectionRevision,
							}),
						},
					],
					details: { revisionId: result.revisionId, assignedIds: result.assignedIds },
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
			const resolved = resolveSessionEvidence(ctx.sessionManager, params.sessionId, params.entryId);
			if ("unavailable" in resolved) {
				return {
					content: [{ type: "text", text: JSON.stringify(resolved) }],
					details: { unavailable: true, reason: resolved.reason },
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(resolved.entry) }],
				details: { id: resolved.entry.id },
			};
		},
	});

	pi.registerTool({
		name: "dag_ingest_run",
		label: "Ingest experiment run",
		description:
			"Validate and record manifest.json and result.json for a bench run id. Recording an artifact is not accepting its findings: the promotion assessment is reported, never applied.",
		parameters: Type.Object({
			operationId: Type.String({ minLength: 1 }),
			runId: Type.String({ minLength: 1 }),
			baselineRunId: Type.Optional(Type.String({ minLength: 1 })),
			objectiveMetric: Type.Optional(ObjectiveMetricSchema),
			replicationReason: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const engine = runtime.ensureEngine(ctx);
				const outcome = ingestRun(engine, ctx.cwd, params.runId, params.operationId, {
					...(params.baselineRunId ? { baselineRunId: params.baselineRunId } : {}),
					...(params.objectiveMetric ? { objectiveMetric: params.objectiveMetric } : {}),
					...(params.replicationReason ? { replicationReason: params.replicationReason } : {}),
				});
				return {
					content: [{ type: "text", text: JSON.stringify(outcome) }],
					details: {
						recordId: outcome.recordId,
						runStatus: outcome.runStatus,
						promotionEligible: outcome.promotion.eligible,
					},
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}

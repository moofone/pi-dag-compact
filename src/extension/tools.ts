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
				if (runtime.boundary.fence.refuses("extension_append")) {
					throw new DagError("host_uncertain", runtime.boundary.fence.message());
				}
				const engine = runtime.ensureEngine(ctx);
				const result = engine.update(params, {
					sessionId: ctx.sessionManager.getSessionId(),
					leafId: ctx.sessionManager.getLeafId() ?? "none",
				});
				// A replay is a receipt, not a publication. Appending a second
				// reference for it would put two pointers to one revision on the
				// branch and make recovery ambiguous.
				if (!result.replayed) {
					// An extension append onto an uncertain session is refused, not
					// attempted: the host would take it into memory either way.
					let observation: { entryId: string; durability: string } | undefined;
					try {
						observation = runtime.boundary.guardedAppend(ctx.sessionManager, () =>
							pi.appendEntry("dag_checkpoint_ref", result.piRef),
						);
					} catch (error) {
						// The commit is durable and the pointer is not. Quarantine it, so
						// the previous selection stays published and the next accepted
						// update cannot inherit this one.
						engine.markUnselected(result.operationId);
						throw error;
					}
					if (observation.durability === "absent_from_file") {
						// The host says it appended and its own file disagrees. That is a
						// hole, not a deferral, and it is not an acknowledgement.
						engine.markUnselected(result.operationId);
						throw new DagError(
							"append_uncertain",
							`reference ${observation.entryId} is not in the session file; the revision was quarantined`,
						);
					}
					engine.acknowledgeRef(
						result.operationId,
						observation.entryId || "appended",
						observation.durability,
					);
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								revisionId: result.revisionId,
								revision: result.revision,
								operationId: result.operationId,
								// D1: the revision is its own checkpoint.
								checkpointId: result.checkpointId,
								replayed: result.replayed,
								// Creation returns its assigned IDs, so the caller never
								// has to reread the graph to find what it just made.
								assignedIds: result.assignedIds,
								selectionRevision: result.selection.selectionRevision,
							}),
						},
					],
					details: {
						revisionId: result.revisionId,
						assignedIds: result.assignedIds,
						replayed: result.replayed,
					},
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "dag_query",
		label: "DAG query",
		description:
			"Search the active working set or archived history, resolve typed record IDs, or read one oversized record in chunks. Coverage and per-ID status are explicit: an active miss says nothing about unsearched history.",
		parameters: QueryRequestSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const engine = runtime.ensureEngine(ctx);
				const fault = engine.reconstructionFault;
				if (fault) {
					throw new DagError(
						fault.code,
						`${fault.detail}. The working set is not published, so a query over it would be a claim about state that could not be verified`,
					);
				}
				const result = queryWorkingSet(engine, params);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					details: {
						complete: result.complete,
						truncated: result.truncated,
						scanComplete: result.coverage.scanComplete,
						scannedBytes: result.coverage.scannedBytes,
					},
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
			"Read a bounded chunk of a session-qualified evidence entry on the current branch, or report unavailable. Continue from chunk.nextByteOffset until chunk.complete.",
		parameters: Type.Object({
			sessionId: Type.String({ minLength: 1 }),
			entryId: Type.String({ minLength: 1 }),
			byteOffset: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveSessionEvidence(
				ctx.sessionManager,
				params.sessionId,
				params.entryId,
				{ byteOffset: params.byteOffset ?? 0 },
			);
			if ("unavailable" in resolved) {
				return {
					content: [{ type: "text", text: JSON.stringify(resolved) }],
					details: { unavailable: true, reason: resolved.reason },
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(resolved) }],
				details: {
					id: resolved.entry.id,
					complete: resolved.chunk.complete,
					nextByteOffset: resolved.chunk.nextByteOffset,
				},
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

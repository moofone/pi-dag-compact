import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./extension/config.ts";
import { createRuntime } from "./extension/runtime.ts";
import { registerRecordTools } from "./extension/tools.ts";
import { dagStatus } from "./memory/query.ts";

/**
 * Pi extension factory.
 *
 * disabled: no graph tools.
 * record-only / explicit-handoff: durable working set. Compaction stays classic in M1.
 * /dag-handoff remains unavailable until M2.
 */
export default function piDagCompact(pi: ExtensionAPI): void {
	const runtime = createRuntime(pi);

	pi.registerCommand("dag", {
		description: "Show DAG working-set status",
		handler: async (_args, ctx) => {
			const config = resolveConfig(ctx.cwd);
			if (config.mode === "disabled") {
				ctx.ui.notify("pi-dag-compact is disabled. Graph tools are not registered.", "info");
				return;
			}
			try {
				const engine = runtime.ensureEngine(ctx);
				const status = dagStatus(engine);
				ctx.ui.notify(
					[
						`rev ${status.revisionId ?? "(none)"}`,
						`objective: ${status.objective.map((node) => node.title).join("; ") || "(none)"}`,
						`baseline: ${status.acceptedBaseline.map((node) => node.title).join("; ") || "(none)"}`,
						`work: ${status.currentWork.map((node) => node.title).join("; ") || "(none)"}`,
						`blockers: ${status.blockers.map((node) => node.title).join("; ") || "(none)"}`,
						`next: ${status.nextAction.map((node) => node.title).join("; ") || "(none)"}`,
						`rejected: ${status.rejected.map((node) => node.title).join("; ") || "(none)"}`,
					].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.registerCommand("dag-handoff", {
		description: "Request an explicit DAG context handoff",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"/dag-handoff is unavailable until M2 safety tests pass. Classic compaction remains.",
				"warning",
			);
		},
	});

	const bootMode = resolveConfig(process.cwd()).mode;
	if (bootMode !== "disabled") {
		registerRecordTools(pi, runtime);
	}
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./extension/config.ts";
import { registerHandoffHook } from "./extension/handoff.ts";
import { createRuntime } from "./extension/runtime.ts";
import { registerRecordTools } from "./extension/tools.ts";
import { dagStatus } from "./memory/query.ts";

/**
 * Pi extension factory.
 *
 * disabled: no graph tools.
 * record-only: durable working set; compaction stays classic.
 * explicit-handoff: /dag-handoff may replace one manual compact with a working-set card.
 * Threshold and overflow compaction stay classic.
 */
export default function piDagCompact(pi: ExtensionAPI): void {
	const runtime = createRuntime(pi);
	registerHandoffHook(pi, runtime, runtime.handoff);
	registerRecordTools(pi, runtime);

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
			const config = resolveConfig(ctx.cwd);
			if (config.mode !== "explicit-handoff") {
				ctx.ui.notify(
					"/dag-handoff requires mode explicit-handoff. Classic compaction remains.",
					"warning",
				);
				return;
			}
			if (runtime.handoff.fenced) {
				ctx.ui.notify(`handoff fenced: ${runtime.handoff.fenced}`, "error");
				return;
			}
			try {
				if ("waitForIdle" in ctx && typeof ctx.waitForIdle === "function") {
					await ctx.waitForIdle();
				}
				const engine = runtime.ensureEngine(ctx);
				const review = runtime.handoff.prepare(engine, {
					sessionId: ctx.sessionManager.getSessionId(),
					leafId: ctx.sessionManager.getLeafId() ?? "none",
				});
				runtime.handoff.arm(review);
				await new Promise<void>((resolve, reject) => {
					let settled = false;
					const finish = (fn: () => void): void => {
						if (settled) return;
						settled = true;
						fn();
					};
					ctx.compact({
						onComplete: () => finish(resolve),
						onError: (error) =>
							finish(() => {
								runtime.handoff.disarm();
								runtime.handoff.fallbacks += 1;
								ctx.ui.notify(`handoff refused: ${error.message}`, "error");
								reject(error);
							}),
					});
				});
				ctx.ui.notify("DAG handoff requested.", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});
}

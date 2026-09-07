import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdmissionHooks } from "./extension/admission-hooks.ts";
import { resolveConfig } from "./extension/config.ts";
import { registerHandoffHook } from "./extension/handoff.ts";
import { createRuntime, type ExtensionRuntime } from "./extension/runtime.ts";
import { registerRecordTools } from "./extension/tools.ts";
import { dagStatus } from "./memory/query.ts";
import type { WorkingNode } from "./schema/working.ts";

function titles(nodes: WorkingNode[]): string {
	return nodes.map((node) => node.title).join("; ") || "(none)";
}

/**
 * Pi extension factory.
 *
 * disabled: no graph tools.
 * record-only: durable working set; compaction stays classic.
 * explicit-handoff: /dag-handoff may replace one manual compact with a working-set card.
 * Threshold and overflow compaction stay classic.
 */
export interface PiDagCompactOptions {
	/**
	 * Observe the runtime this factory builds, including the host boundary it
	 * owns. Fixtures use it to assert the extension-level fence and the
	 * owner-bound admission ledger through the real extension rather than a
	 * copy of them.
	 */
	onRuntime?: (runtime: ExtensionRuntime) => void;
}

export function createPiDagCompact(options: PiDagCompactOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		build(pi, options);
	};
}

export default function piDagCompact(pi: ExtensionAPI): void {
	build(pi, {});
}

function build(pi: ExtensionAPI, options: PiDagCompactOptions): void {
	const runtime = createRuntime(pi);
	options.onRuntime?.(runtime);
	registerHandoffHook(pi, runtime, runtime.handoff);
	registerAdmissionHooks(pi, runtime);
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
						`rev ${status.revisionId ?? "(none)"} · selection ${status.selection.selectionRevision}`,
						`objective: ${titles(status.objective)}`,
						`constraints: ${titles(status.constraints)}`,
						`accepted baseline: ${titles(status.acceptedBaseline)}`,
						`best observed: ${titles(status.bestObserved)}`,
						`best validated: ${titles(status.bestValidated)}`,
						`work: ${titles(status.currentWork)}`,
						`blockers: ${titles(status.blockers)}`,
						`unresolved: ${titles(status.unresolved)}`,
						`next: ${titles(status.nextAction)}`,
						`rejected: ${titles(status.rejected)}`,
						...(status.ambiguousSelections.length > 0
							? [`ambiguous selection: ${status.ambiguousSelections.join(", ")}`]
							: []),
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
			if (runtime.boundary.fence.refuses("handoff_fallback")) {
				ctx.ui.notify(runtime.boundary.fence.message(), "error");
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

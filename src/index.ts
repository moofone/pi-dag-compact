import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveExtensionMode } from "./extension/mode.ts";

/**
 * Pi extension factory.
 *
 * M0 registers no graph tools and does not intercept compaction. Classic
 * `/compact`, threshold compaction, and overflow recovery remain Pi's.
 */
export default function piDagCompact(pi: ExtensionAPI): void {
	pi.registerCommand("dag", {
		description: "Show DAG working-set status",
		handler: async (_args, ctx) => {
			const mode = resolveExtensionMode(ctx.cwd);
			if (mode === "disabled") {
				ctx.ui.notify("pi-dag-compact is disabled. Graph tools are not registered.", "info");
				return;
			}
			ctx.ui.notify(
				`pi-dag-compact mode is ${mode}, but M0 does not implement recording or handoff yet.`,
				"warning",
			);
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
}

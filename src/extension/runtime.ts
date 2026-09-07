import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryEngine } from "../memory/engine.ts";
import { DagError } from "../memory/errors.ts";
import { resolveConfig } from "./config.ts";
import { HandoffController } from "./handoff.ts";
import { collectPiRefs } from "./session.ts";

export interface ExtensionRuntime {
	engine: MemoryEngine | undefined;
	handoff: HandoffController;
	ensureEngine(ctx: ExtensionContext): MemoryEngine;
	shutdown(): void;
}

export function createRuntime(pi: ExtensionAPI): ExtensionRuntime {
	let engine: MemoryEngine | undefined;
	const handoff = new HandoffController();

	const shutdown = (): void => {
		engine?.close();
		engine = undefined;
	};

	const boot = (ctx: ExtensionContext, reason: string): void => {
		shutdown();
		const config = resolveConfig(ctx.cwd);
		if (config.mode === "disabled" || !config.taskDir) return;
		const sessionId = ctx.sessionManager.getSessionId();
		engine = MemoryEngine.open(config.taskDir, sessionId);
		engine.reconstruct(collectPiRefs(ctx.sessionManager));
		if (reason === "fork") {
			engine.attachFork("origin", engine.snapshot().revisionId);
		}
		engine.reconcilePending(
			{ sessionId, leafId: ctx.sessionManager.getLeafId() ?? "none" },
			(ref, checkpoint) => {
				pi.appendEntry(checkpoint ? "dag_checkpoint_ref" : "dag_revision_ref", ref);
				return ctx.sessionManager.getLeafId() ?? "appended";
			},
		);
	};

	pi.on("session_start", async (event, ctx) => {
		boot(ctx, event.reason);
	});
	pi.on("session_tree", async (_event, ctx) => {
		if (!engine) return;
		engine.reconstruct(collectPiRefs(ctx.sessionManager));
	});
	pi.on("session_shutdown", async () => {
		shutdown();
	});

	return {
		get engine() {
			return engine;
		},
		handoff,
		ensureEngine(ctx) {
			if (engine) return engine;
			const config = resolveConfig(ctx.cwd);
			if (config.mode === "disabled") {
				throw new DagError("disabled", "pi-dag-compact is disabled");
			}
			if (!config.taskDir) {
				throw new DagError(
					"missing_task_dir",
					"recording requires taskDir or PI_DAG_COMPACT_TASK_DIR",
				);
			}
			boot(ctx, "startup");
			if (!engine) throw new DagError("missing_task_dir", "failed to open task store");
			return engine;
		},
		shutdown,
	};
}

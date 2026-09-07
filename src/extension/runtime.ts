import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OwnerId, ScheduleDecision, ScheduleKind } from "../host/admission.ts";
import { MemoryEngine } from "../memory/engine.ts";
import { DagError } from "../memory/errors.ts";
import { HostBoundary } from "./boundary.ts";
import { resolveConfig } from "./config.ts";
import { HandoffController } from "./handoff.ts";
import { collectPiRefs } from "./session.ts";

export interface ExtensionRuntime {
	engine: MemoryEngine | undefined;
	handoff: HandoffController;
	/**
	 * The observed host boundary: durability observation, the extension-owned
	 * uncertainty fence, and the owner-bound admission ledger. None of it makes
	 * the host atomic; it makes this extension stop trusting an unfenced host.
	 */
	boundary: HostBoundary;
	/**
	 * Attach the boundary to this session and, once the task directory is
	 * resolvable, to its durable store. `session_start` is not guaranteed to have
	 * fired - an embedded `AgentSession` does not emit it - so every hook that
	 * receives a context calls this before it consults the fence or the ledger.
	 */
	observeContext(ctx: ExtensionContext): void;
	/** The goal owner this session's scheduled work is bound to, if configured. */
	owner: OwnerId | undefined;
	bindOwner(owner: OwnerId, allowance: number): void;
	/** Refuse or reserve one unit of goal-owned work. Refusal is the enforceable half. */
	requestSchedule(kind: ScheduleKind): ScheduleDecision;
	ensureEngine(ctx: ExtensionContext): MemoryEngine;
	shutdown(): void;
}

export function createRuntime(pi: ExtensionAPI): ExtensionRuntime {
	let engine: MemoryEngine | undefined;
	let owner: OwnerId | undefined;
	const handoff = new HandoffController();
	const boundary = new HostBoundary();

	const observeContext = (ctx: ExtensionContext): void => {
		boundary.attach(ctx.sessionManager);
		const config = resolveConfig(ctx.cwd);
		if (config.taskDir) boundary.bind(config.taskDir);
	};

	const shutdown = (): void => {
		engine?.close();
		engine = undefined;
	};

	const boot = (ctx: ExtensionContext, reason: string): void => {
		shutdown();
		const config = resolveConfig(ctx.cwd);
		boundary.attach(ctx.sessionManager);
		if (config.mode === "disabled" || !config.taskDir) return;
		// The fence and the ledger live beside the extension's own records, not in
		// the Pi session: the Pi session is the thing whose durability is in doubt.
		boundary.bind(config.taskDir);
		const sessionId = ctx.sessionManager.getSessionId();
		engine = MemoryEngine.open(config.taskDir, sessionId);
		try {
			engine.reconstruct(collectPiRefs(ctx.sessionManager));
		} catch {
			// A refused load is recorded on the engine as a reconstruction fault and
			// nothing is published. Rethrowing here would only be swallowed by the
			// host's event runner; the refusal has to be visible to `/dag`, to
			// `dag_update` and to the handoff, which read the fault instead.
		}
		if (engine.reconstructionFault) return;
		if (reason === "fork") {
			engine.attachFork("origin", engine.snapshot().revisionId);
		}
		// A fence loaded from the extension's own store outlives the process it was
		// raised in. Reconciling pending refs into a session whose durability is
		// still in doubt is exactly the downstream work the fence exists to stop.
		if (boundary.fence.refuses("reconcile_pending_after_restart")) return;
		engine.reconcilePending(
			{ sessionId, leafId: ctx.sessionManager.getLeafId() ?? "none" },
			(ref, checkpoint) => {
				const observation = boundary.guardedAppend(ctx.sessionManager, () =>
					pi.appendEntry(checkpoint ? "dag_checkpoint_ref" : "dag_revision_ref", ref),
				);
				return observation.entryId;
			},
		);
	};

	pi.on("session_start", async (event, ctx) => {
		boot(ctx, event.reason);
	});
	pi.on("session_tree", async (_event, ctx) => {
		if (!engine) return;
		// A rebuild reimports exactly the refs the fence exists to distrust.
		if (boundary.fence.refuses("context_rebuild")) return;
		try {
			engine.reconstruct(collectPiRefs(ctx.sessionManager));
		} catch {
			// Same as boot: the fault is on the engine, and every public surface
			// refuses on it rather than presenting whatever it happened to hold.
		}
	});
	pi.on("session_shutdown", async () => {
		shutdown();
	});

	return {
		get engine() {
			return engine;
		},
		handoff,
		boundary,
		observeContext,
		get owner() {
			return owner;
		},
		bindOwner(next, allowance) {
			owner = next;
			boundary.admission.configure(next, allowance);
		},
		requestSchedule(kind) {
			if (!owner) {
				return {
					admitted: false,
					reason: "unknown_owner",
					detail: "no goal owner is bound to this session",
					remaining: 0,
				};
			}
			return boundary.admission.schedule(owner, kind);
		},
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

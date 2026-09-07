import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { OwnerId, ScheduleDecision, ScheduleKind } from "../host/admission.ts";
import { sha256 } from "../memory/canonical.ts";
import type { CopiedOriginEntry } from "../memory/engine.ts";
import { MemoryEngine } from "../memory/engine.ts";
import { DagError } from "../memory/errors.ts";
import { HostBoundary } from "./boundary.ts";
import { resolveConfig } from "./config.ts";
import { HandoffController } from "./handoff.ts";
import { collectPiRefs } from "./session.ts";

/** What a boot could not do, kept so `/dag` can say why rather than look empty. */
export interface OwnershipStatus {
	code: string;
	detail: string;
}

interface ForkAncestry {
	originSessionId: string;
	originSessionFile: string;
	copied: CopiedOriginEntry[];
}

/**
 * Read the origin this session was forked from, out of its own header.
 *
 * Pi records the parent session's *file* in the fork's header and copies its
 * entries keeping their IDs. The origin's session ID lives in the parent file's
 * own header line, which is where the real origin identity comes from — never a
 * placeholder, and never the fork's own ID.
 */
function readForkAncestry(sessionManager: {
	getHeader?: () => { parentSession?: string } | null;
	getBranch(): readonly SessionEntry[];
}): ForkAncestry | null {
	const parentFile = sessionManager.getHeader?.()?.parentSession;
	if (!parentFile || !existsSync(parentFile)) return null;
	let originSessionId: string | undefined;
	const originEntryIds = new Set<string>();
	for (const line of readFileSync(parentFile, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as { type?: string; id?: unknown };
			if (parsed.type === "session" && typeof parsed.id === "string") {
				originSessionId = parsed.id;
				continue;
			}
			if (typeof parsed.id === "string") originEntryIds.add(parsed.id);
		} catch {
			// A partial trailing line is not an entry, and is not evidence of one.
		}
	}
	if (!originSessionId) return null;
	// A copy is recorded only for an entry this branch holds *and* the origin
	// transcript actually contained. Same-ID-on-my-branch alone is not evidence.
	const copied: CopiedOriginEntry[] = [];
	for (const entry of sessionManager.getBranch()) {
		if (!originEntryIds.has(entry.id)) continue;
		copied.push({
			originEntryId: entry.id,
			localEntryId: entry.id,
			entryHash: sha256(JSON.stringify(entry)),
		});
	}
	return { originSessionId, originSessionFile: parentFile, copied };
}

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
	/**
	 * Why this session holds no engine, when it holds none. A live owner keeps
	 * its store, and every public surface says so rather than looking empty.
	 */
	ownership: OwnershipStatus | null;
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
	let ownership: OwnershipStatus | null = null;
	const handoff = new HandoffController();
	const boundary = new HostBoundary();

	const observeContext = (ctx: ExtensionContext): void => {
		boundary.attach(ctx.sessionManager);
		const config = resolveConfig(ctx.cwd);
		if (config.taskDir) boundary.bind(config.taskDir);
	};

	/**
	 * Orderly detach. `close()` releases the claim under the handle's own token,
	 * so a shutdown hands ownership back rather than abandoning it, and a handle
	 * whose claim already moved on releases nothing.
	 */
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
		try {
			// Explicit stale-owner recovery, and only that: a claim is taken from a
			// previous owner solely when that owner is verifiably gone. A live owner
			// keeps its store and this session gets no engine at all.
			engine = MemoryEngine.open(config.taskDir, sessionId, "default", {
				recoverStaleWriter: true,
			});
			ownership = null;
		} catch (error) {
			engine = undefined;
			ownership = {
				code: error instanceof DagError ? error.code : "open_failed",
				detail: `${error instanceof Error ? error.message : String(error)} (during ${reason})`,
			};
			return;
		}
		try {
			engine.reconstruct(collectPiRefs(ctx.sessionManager));
		} catch {
			// A refused load is recorded on the engine as a reconstruction fault and
			// nothing is published. Rethrowing here would only be swallowed by the
			// host's event runner; the refusal has to be visible to `/dag`, to
			// `dag_update` and to the handoff, which read the fault instead.
		}
		if (engine.reconstructionFault) return;
		// Provenance is recorded from the fork's own header, so it survives a
		// restart and does not depend on having witnessed the fork event.
		const ancestry = readForkAncestry(ctx.sessionManager);
		if (ancestry) {
			try {
				engine.attachFork(ancestry.originSessionId, engine.snapshot().revisionId, {
					originSessionFile: ancestry.originSessionFile,
				});
				engine.recordCopiedOriginEntries(ancestry.originSessionId, ancestry.copied);
			} catch {
				// Provenance is immutable: a conflicting re-attach is refused and the
				// recorded original stands. A boot never rewrites it.
			}
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
		get ownership() {
			return ownership;
		},
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
			if (engine) return engine;
			// A refused claim is a fact about another live writer, not a missing
			// directory, and it is reported as itself.
			if (ownership) throw new DagError(ownership.code, ownership.detail);
			throw new DagError("missing_task_dir", "failed to open task store");
		},
		shutdown,
	};
}

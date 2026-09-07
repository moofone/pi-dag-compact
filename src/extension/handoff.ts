import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyAppend } from "../host/durability.ts";
import { DagError } from "../memory/errors.ts";
import {
	assertHandoffEligible,
	type HandoffCurrent,
	type HandoffReview,
	reviewIsFresh,
} from "../memory/handoff.ts";
import { resolveConfig } from "./config.ts";
import type { ExtensionRuntime } from "./runtime.ts";

export class HandoffController {
	private review: HandoffReview | undefined;
	private armed = false;
	private fence: string | undefined;
	fallbacks = 0;

	get fenced(): string | undefined {
		return this.fence;
	}

	get isArmed(): boolean {
		return this.armed;
	}

	arm(review: HandoffReview): void {
		if (this.fence) {
			throw new DagError("handoff_fenced", this.fence);
		}
		this.review = review;
		this.armed = true;
	}

	disarm(): void {
		this.armed = false;
		this.review = undefined;
	}

	block(reason: string): void {
		this.fence = reason;
		this.disarm();
	}

	prepare(
		engine: ReturnType<ExtensionRuntime["ensureEngine"]>,
		branch: { sessionId: string; leafId: string },
	): HandoffReview {
		if (this.fence) throw new DagError("handoff_fenced", this.fence);
		assertHandoffEligible(engine);
		const snap = engine.snapshot();
		const snapshotHash = engine.selectedSnapshotHash();
		if (!snap.revisionId || !snap.checkpointId || !snapshotHash) {
			throw new DagError("handoff_refused", "handoff requires a selected revision");
		}
		return {
			sessionId: branch.sessionId,
			leafId: branch.leafId,
			revisionId: snap.revisionId,
			// D1: the selected revision is the checkpoint the cut references.
			checkpointId: snap.checkpointId,
			snapshotHash,
			coveredThroughEntryId: branch.leafId,
		};
	}

	onBeforeCompact(
		event: {
			reason: "manual" | "threshold" | "overflow";
			signal: AbortSignal;
			preparation: { firstKeptEntryId: string; tokensBefore: number };
		},
		current: HandoffCurrent,
		cardText: string,
	):
		| { cancel: true }
		| {
				compaction: {
					summary: string;
					firstKeptEntryId: string;
					tokensBefore: number;
					details: {
						source: "dag-handoff";
						checkpointId: string;
						revisionId: string;
						markerId?: string;
					};
				};
		  }
		| undefined {
		if (this.fence) {
			return { cancel: true };
		}
		if (event.signal.aborted) {
			this.disarm();
			return { cancel: true };
		}
		if (event.reason !== "manual" || !this.armed || !this.review) {
			return undefined;
		}
		if (!reviewIsFresh(this.review, current)) {
			this.disarm();
			this.fallbacks += 1;
			return undefined;
		}
		const review = this.review;
		this.disarm();
		return {
			compaction: {
				summary: cardText,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {
					source: "dag-handoff",
					checkpointId: review.checkpointId,
					revisionId: review.revisionId,
				},
			},
		};
	}
}

function currentFrom(ctx: ExtensionContext, runtime: ExtensionRuntime): HandoffCurrent {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		leafId: ctx.sessionManager.getLeafId() ?? "none",
		revisionId: runtime.engine?.snapshot().revisionId ?? null,
		snapshotHash: runtime.engine?.selectedSnapshotHash() ?? null,
	};
}

export function registerHandoffHook(
	pi: ExtensionAPI,
	runtime: ExtensionRuntime,
	handoff: HandoffController,
): void {
	pi.on("input", async (_event, ctx) => {
		runtime.observeContext(ctx);
		if (runtime.boundary.fence.refuses("input")) {
			ctx.ui.notify(runtime.boundary.fence.message(), "error");
			return { action: "handled" as const };
		}
		if (!handoff.fenced) return;
		ctx.ui.notify(`session fenced: ${handoff.fenced}`, "error");
		return { action: "handled" as const };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		runtime.observeContext(ctx);
		// Covers manual, threshold and overflow alike: an uncertain session is not
		// a safe base for a cut, whoever asked for it.
		if (runtime.boundary.fence.refuses(`compaction:${event.reason}`)) {
			return { cancel: true };
		}
		if (handoff.fenced) {
			return { cancel: true };
		}
		if (event.reason !== "manual") return;
		const config = resolveConfig(ctx.cwd);
		if (config.mode !== "explicit-handoff") return;
		const engine = runtime.engine;
		if (!engine) return;
		if (!handoff.isArmed) return;
		let cardText = "";
		try {
			cardText = assertHandoffEligible(engine).text;
		} catch {
			handoff.fallbacks += 1;
			handoff.disarm();
			return;
		}
		const current = currentFrom(ctx, runtime);
		const decision = handoff.onBeforeCompact(event, current, cardText);
		if (!decision || "cancel" in decision) {
			return decision;
		}
		let markerId: string | undefined;
		try {
			// The marker is the entry the whole handoff is anchored to, so it is the
			// one append whose observed durability is worth the read-back.
			markerId = runtime.boundary.guardedAppend(ctx.sessionManager, () =>
				pi.appendEntry("dag_handoff_marker", {
					v: 1,
					sessionId: current.sessionId,
					leafId: current.leafId,
					revisionId: decision.compaction.details.revisionId,
					checkpointId: decision.compaction.details.checkpointId,
					coveredThroughEntryId: current.leafId,
				}),
			).entryId;
		} catch (error) {
			handoff.block(error instanceof Error ? error.message : String(error));
			return { cancel: true };
		}
		markerId = markerId ?? ctx.sessionManager.getLeafId() ?? undefined;
		if (markerId) {
			decision.compaction.firstKeptEntryId = markerId;
			decision.compaction.details.markerId = markerId;
		}
		return decision;
	});

	pi.on("session_compact", async (event) => {
		if (event.fromExtension && event.reason === "manual") {
			handoff.disarm();
		}
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		runtime.observeContext(ctx);
		// A compaction that failed while persisting leaves its summary entry in
		// memory and as the leaf while the session file has no trace of it. That
		// is observable without trusting the host: read the file back.
		const leafId = ctx.sessionManager.getLeafId();
		const leaf = leafId ? ctx.sessionManager.getEntry(leafId) : undefined;
		if (
			leafId &&
			leaf?.type === "compaction" &&
			classifyAppend(ctx.sessionManager, leafId) !== "present_in_file"
		) {
			runtime.boundary.fence.raise({
				reason: "compaction_append_failed",
				detail: `compaction entry ${leafId} is the leaf but is not in the session file`,
				sessionId: ctx.sessionManager.getSessionId(),
				leafId,
				entryId: leafId,
			});
		}
		if (event.fromExtension) {
			handoff.block("compaction append failed; repair the session before another handoff");
		} else if (handoff.isArmed) {
			handoff.fallbacks += 1;
			handoff.disarm();
		}
	});
}

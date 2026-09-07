import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
		if (!snap.revisionId || !snap.checkpointId) {
			throw new DagError("handoff_refused", "handoff requires a committed checkpoint");
		}
		return {
			sessionId: branch.sessionId,
			leafId: branch.leafId,
			revisionId: snap.revisionId,
			checkpointId: snap.checkpointId,
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
	};
}

export function registerHandoffHook(
	pi: ExtensionAPI,
	runtime: ExtensionRuntime,
	handoff: HandoffController,
): void {
	pi.on("input", async (_event, ctx) => {
		if (!handoff.fenced) return;
		ctx.ui.notify(`session fenced: ${handoff.fenced}`, "error");
		return { action: "handled" as const };
	});

	pi.on("session_before_compact", async (event, ctx) => {
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
		try {
			pi.appendEntry("dag_handoff_marker", {
				v: 1,
				sessionId: current.sessionId,
				leafId: current.leafId,
				revisionId: decision.compaction.details.revisionId,
				checkpointId: decision.compaction.details.checkpointId,
				coveredThroughEntryId: current.leafId,
			});
		} catch (error) {
			handoff.block(error instanceof Error ? error.message : String(error));
			return { cancel: true };
		}
		const markerId = ctx.sessionManager.getLeafId() ?? undefined;
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

	pi.on("session_compact_failed", async (event) => {
		if (event.fromExtension) {
			handoff.block("compaction append failed; repair the session before another handoff");
		} else if (handoff.isArmed) {
			handoff.fallbacks += 1;
			handoff.disarm();
		}
	});
}

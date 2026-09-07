import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntime } from "./runtime.ts";

/**
 * The two refusal channels Pi actually honours, wired to one owner budget.
 *
 * `input` -> `{action:"handled"}` means the turn is never scheduled: the host
 * returns before the agent loop starts and no provider request is issued.
 * `tool_call` -> `{block:true, terminate:true}` means the continuation is never
 * scheduled: the batch finalizes as blocked and the agent loop ends.
 *
 * Neither is a deny channel for a request the host has already issued. There is
 * no such channel: `before_provider_request` is a payload transform whose
 * handler errors are swallowed, and `before_agent_start` has no cancel field.
 * Requests the host issues on its own — summarization during compaction, most
 * obviously — reach the provider whatever this extension does. Those are
 * recorded as uncharged host-issued attempts through the admission ledger, and
 * the residual gap is reported rather than absorbed.
 */
export function registerAdmissionHooks(pi: ExtensionAPI, runtime: ExtensionRuntime): void {
	pi.on("input", async (event, ctx) => {
		runtime.observeContext(ctx);
		if (!runtime.owner) return;
		// Slash commands are user work, not goal-scheduled provider work.
		if (event.text.startsWith("/")) return;
		const decision = runtime.requestSchedule("execution");
		if (decision.admitted) return;
		ctx.ui.notify(
			`goal work not scheduled (${decision.reason}): ${decision.detail}`,
			decision.reason === "exhausted" ? "warning" : "error",
		);
		return { action: "handled" as const };
	});

	pi.on("tool_call", async (_event, ctx) => {
		runtime.observeContext(ctx);
		if (!runtime.owner) return {};
		const decision = runtime.requestSchedule("execution");
		if (decision.admitted) return {};
		return {
			block: true,
			reason: `goal work not scheduled (${decision.reason}): ${decision.detail}`,
			terminate: true,
		};
	});
}

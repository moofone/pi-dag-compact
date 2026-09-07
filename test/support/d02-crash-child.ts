/**
 * One crash boundary, in its own process.
 *
 * The parent fixture starts this child, lets it run the real extension through
 * the real `AgentSession` and the real file-backed `SessionManager`, and the
 * child dies — `process.exit`, no cleanup, no `close()` — at exactly one of the
 * four boundaries D02 names. Nothing about publication, reconciliation or
 * reconstruction is stubbed; the only interception is the host `appendCustomEntry`
 * boundary, and only to choose the instant of death.
 *
 * Usage: `node --experimental-strip-types d02-crash-child.ts <root> <boundary> [sessionFile]`
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createFauxResponseFactory, isCompactionPrompt } from "../../src/eval/faux-agent.ts";
import { createClassicHarness } from "../../src/eval/harness.ts";
import { loadEvalConfig, loadScenario } from "../../src/eval/load.ts";
import type { IsolatedWorkspace } from "../../src/eval/workspace.ts";

export type CrashBoundary =
	| "after_sqlite_commit"
	| "after_pi_append"
	| "after_sqlite_ack"
	| "after_compaction_append";

export const CRASH_EXIT_CODE = 17;
const DAG_REF_TYPES = new Set(["dag_revision_ref", "dag_checkpoint_ref"]);

export interface ChildInfo {
	sessionFile: string;
	taskDir: string;
	boundary: string;
}

export function reopenWorkspace(root: string): IsolatedWorkspace {
	return {
		root,
		cwd: join(root, "workspace"),
		agentDir: join(root, "agent"),
		sessionDir: join(root, "sessions"),
		outDir: join(root, "out"),
		cleanup: () => {},
	};
}

export function childInfoPath(root: string): string {
	return join(root, "child-info.json");
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message: Message | undefined = context.messages[index];
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		return content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

/**
 * One `dag_update` per prompt that names an operation id, and plain text
 * otherwise. The operation id comes from the prompt so the fixture, not the
 * faux model, decides what identity is being retried.
 */
export function createOperationFactory(
	emitted: string[] = [],
): (context: Context) => AssistantMessage {
	const scenario = createFauxResponseFactory({ current: 1 }, { dag: false });
	return (context) => {
		if (isCompactionPrompt(context)) {
			return fauxAssistantMessage("Structured checkpoint summary for the crash fixture.");
		}
		const text = lastUserText(context);
		const match = text.match(/OP=([\w-]+)/);
		if (!match?.[1]) return scenario(context);
		let toolResults = 0;
		for (let index = context.messages.length - 1; index >= 0; index -= 1) {
			const message = context.messages[index];
			if (!message) continue;
			if (message.role === "user") break;
			if (message.role === "toolResult") toolResults += 1;
		}
		if (toolResults === 0) {
			emitted.push(match[1]);
			return fauxAssistantMessage(
				[
					fauxToolCall("dag_update", {
						operationId: match[1],
						upsertNodes: [
							{
								id: "goal",
								kind: "goal",
								title: "minimize pipeline p50",
								body: "",
								status: "open",
							},
							{ id: "ceiling", kind: "constraint", title: "smem <= 64%", body: "", status: "open" },
							{
								id: "next-a",
								kind: "task",
								title: `next after ${match[1]}`,
								body: "",
								status: "open",
							},
							{
								id: `n-${match[1]}`,
								kind: "hypothesis",
								title: `trial ${match[1]}`,
								body: "",
								status: "open",
							},
						],
						setSelection: {
							goalBinding: null,
							objectiveId: "goal",
							constraintIds: ["ceiling"],
							acceptedBaselineRecordId: null,
							bestObservedRecordId: null,
							bestValidatedRecordId: null,
							currentWorkIds: [],
							unresolvedIds: [],
							nextActionIds: ["next-a"],
							rejectedApproachIds: [],
							pinnedIds: [],
						},
					}),
				],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage(`no operation requested (${text.slice(0, 40)})`);
	};
}

async function main(): Promise<void> {
	const [root, boundary, sessionFile] = process.argv.slice(2);
	if (!root || !boundary) throw new Error("usage: d02-crash-child <root> <boundary> [sessionFile]");
	const workspace = reopenWorkspace(root);
	const harness = await createClassicHarness(workspace, loadEvalConfig(), {
		dag: true,
		fauxFactory: createOperationFactory(),
		...(sessionFile ? { sessionFile } : {}),
	});
	writeFileSync(
		childInfoPath(root),
		`${JSON.stringify({
			sessionFile: harness.sessionManager.getSessionFile() ?? "",
			taskDir: join(workspace.cwd, "research-task"),
			boundary,
		} satisfies ChildInfo)}\n`,
	);

	// Force the deferred first flush, so every later append is written
	// individually and a crash leaves a real file to reopen.
	await harness.session.prompt("Warm-up turn: force the deferred first session flush.");

	const manager = harness.sessionManager as unknown as {
		appendCustomEntry(customType: string, data?: unknown): string;
	};
	const realAppend = manager.appendCustomEntry.bind(harness.sessionManager);
	if (boundary === "after_sqlite_commit" || boundary === "after_pi_append") {
		manager.appendCustomEntry = (customType: string, data?: unknown): string => {
			if (!DAG_REF_TYPES.has(customType)) return realAppend(customType, data);
			// after_sqlite_commit: die before the host ever sees the pointer.
			// after_pi_append: let the host write the pointer, then die before the
			// SQLite acknowledgement the tool would have made next.
			if (boundary === "after_pi_append") realAppend(customType, data);
			process.exit(CRASH_EXIT_CODE);
		};
	}

	await harness.session.prompt("Record the working set. OP=d02-op");
	if (boundary === "after_compaction_append") {
		// A manual cut needs a session the host considers worth compacting, so
		// run real scenario turns before asking for one.
		for (const turn of loadScenario().turns.slice(0, 4)) {
			harness.latestTurn.current = turn.turn;
			await harness.session.prompt(turn.user);
		}
		await harness.session.compact();
	}
	process.exit(CRASH_EXIT_CODE);
}

if (process.argv[1]?.endsWith("d02-crash-child.ts")) {
	await main();
}

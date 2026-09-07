/**
 * L03 — origin evidence across a real fork, through the real `session_read`
 * tool.
 *
 * The fork here is Pi's own: a new session file, a new session ID, and entries
 * copied with their original IDs. That last detail is the whole problem. A bare
 * "look for this entry id on my branch" lookup answers *every* origin-qualified
 * request, including ones from sessions this fork has never met.
 *
 * The origin transcript is deleted mid-fixture, so the surviving answer can only
 * come from the recorded copy.
 */

import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { after, test } from "node:test";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadEvalConfig } from "../../src/eval/load.ts";
import { createIsolatedWorkspace } from "../../src/eval/workspace.ts";
import { createOperationFactory } from "../support/d02-crash-child.ts";
import { createLifecycleHost, type LifecycleHost } from "../support/lifecycle-harness.ts";
import { asSessionEvidence, type SessionEvidenceShape } from "../support/retrieval-shape.ts";

const config = loadEvalConfig();
const workspaces: Array<{ cleanup: () => void }> = [];

after(() => {
	for (const workspace of workspaces) workspace.cleanup();
});

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

/** `OP=` commits a revision; `READ=<sessionId>|<entryId>` calls `session_read`. */
function factory(): (context: Context) => AssistantMessage {
	const operations = createOperationFactory();
	return (context) => {
		const text = lastUserText(context);
		const match = text.match(/READ=([^|\s]+)\|([^\s]+)/);
		if (!match?.[1] || !match?.[2]) return operations(context);
		let toolResults = 0;
		for (let index = context.messages.length - 1; index >= 0; index -= 1) {
			const message = context.messages[index];
			if (!message) continue;
			if (message.role === "user") break;
			if (message.role === "toolResult") toolResults += 1;
		}
		if (toolResults > 0) return fauxAssistantMessage("read complete");
		return fauxAssistantMessage(
			[fauxToolCall("session_read", { sessionId: match[1], entryId: match[2] })],
			{ stopReason: "toolUse" },
		);
	};
}

/** The last `session_read` payload the model actually received. */
function lastToolResult(entries: readonly SessionEntry[]): SessionEvidenceShape {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			toolName?: string;
			content?: Array<{ type?: string; text?: string }>;
		};
		if (message.role !== "toolResult" || message.toolName !== "session_read") continue;
		for (const part of message.content ?? []) {
			if (typeof part.text !== "string") continue;
			try {
				return asSessionEvidence(JSON.parse(part.text) as unknown);
			} catch {
				// Not the JSON payload; keep looking.
			}
		}
	}
	throw new Error("no session_read result on the branch");
}

async function read(host: LifecycleHost, sessionId: string, entryId: string) {
	await host.session.prompt(`READ=${sessionId}|${entryId}`);
	return lastToolResult(host.session.sessionManager.getBranch());
}

test("L03 copied origin evidence outlives the transcript, and a stranger's ID does not", async () => {
	const space = createIsolatedWorkspace();
	workspaces.push(space);
	const host = await createLifecycleHost(space, config, { fauxFactory: factory() });
	await host.session.prompt("Warm-up turn: force the deferred first session flush.");
	await host.session.prompt("Record the working set. OP=l03-origin");

	const originSessionId = host.sessionId;
	const originFile = host.sessionFile;
	assert.ok(originFile && existsSync(originFile), "sanity: the origin transcript is on disk");

	const entries = host.session.sessionManager.getEntries();
	const evidenceEntry = entries.find(
		(entry) => entry.type === "message" && entry.message.role === "user",
	);
	assert.ok(evidenceEntry, "sanity: the origin has a user entry to cite as evidence");
	const checkpointEntry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === "dag_checkpoint_ref")
		.at(-1);
	assert.ok(checkpointEntry, "sanity: the origin recorded a checkpoint reference");

	await host.host.fork(checkpointEntry.id, { position: "at" });
	assert.notEqual(host.sessionId, originSessionId, "sanity: the fork is a different session");
	assert.ok(
		host.session.sessionManager.getBranch().some((entry) => entry.id === evidenceEntry.id),
		"sanity: Pi copied the origin entry keeping its id, which is what makes this hard",
	);

	const copied = await read(host, originSessionId, evidenceEntry.id);
	assert.equal(
		copied.entry?.id,
		evidenceEntry.id,
		"origin-qualified evidence resolves through the verified copy",
	);

	rmSync(originFile, { force: true });
	assert.equal(existsSync(originFile), false, "sanity: the original transcript is really gone");
	const afterRemoval = await read(host, originSessionId, evidenceEntry.id);
	assert.equal(
		afterRemoval.entry?.id,
		evidenceEntry.id,
		"verified copied origin evidence survives removal of the original transcript",
	);

	const stranger = await read(host, "a-session-this-fork-never-met", evidenceEntry.id);
	assert.equal(
		stranger.unavailable,
		true,
		"an unrelated session ID is unavailable even when the entry id matches locally",
	);
	assert.equal(stranger.reason, "uncopied_foreign_entry");
	assert.notEqual(
		stranger.entry?.id,
		evidenceEntry.id,
		"and the local same-id entry is never substituted for it",
	);

	await host.dispose();
});

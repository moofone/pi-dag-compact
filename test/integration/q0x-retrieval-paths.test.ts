/**
 * Q0x — retrieval through the registered public tools.
 *
 * Drives `dag_query` and `session_read` over a real in-memory SessionManager,
 * so the GREEN claim is on the tool responses the model actually sees rather
 * than on internal helpers.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import piDagCompact from "../../src/index.ts";
import { LIMITS, utf8Bytes } from "../../src/memory/limits.ts";
import { asQueryResult, type QueryResultShape } from "../support/retrieval-shape.ts";
import { makeTempDir } from "../support/tmp.ts";

interface ToolLike {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: () => void,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;
}

interface CommandLike {
	handler(args: string, ctx: ExtensionContext): Promise<void>;
}

interface Host {
	tools: Map<string, ToolLike>;
	commands: Map<string, CommandLike>;
	notifications: string[];
	sessionManager: SessionManager;
	ctx: ExtensionContext;
	cleanup(): void;
}

function createHost(prefix: string): Host {
	const tmp = makeTempDir(prefix);
	const cwd = tmp.path;
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "pi-dag-compact.json"),
		JSON.stringify({ mode: "explicit-handoff", taskDir: "task" }),
	);
	const sessionManager = SessionManager.inMemory(cwd);
	const tools = new Map<string, ToolLike>();
	const commands = new Map<string, CommandLike>();
	const notifications: string[] = [];
	const ctx = {
		cwd,
		sessionManager,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerTool: (tool: ToolLike) => {
			tools.set(tool.name, tool);
		},
		registerCommand: (name: string, command: CommandLike) => {
			commands.set(name, command);
		},
		on: () => {},
		appendEntry: (customType: string, data: unknown) =>
			sessionManager.appendCustomEntry(customType, data),
	} as unknown as ExtensionAPI;
	piDagCompact(pi);
	return { tools, commands, notifications, sessionManager, ctx, cleanup: tmp.cleanup };
}

async function callToolText(
	host: Host,
	name: string,
	params: Record<string, unknown>,
): Promise<string> {
	const tool = host.tools.get(name);
	assert.ok(tool, `tool ${name} is registered`);
	const output = await tool.execute(
		`call-${name}`,
		params,
		new AbortController().signal,
		() => {},
		host.ctx,
	);
	const text = output.content[0]?.text ?? "";
	assert.equal(
		text.includes("_error") || /^[a-z_]+: /.test(text),
		false,
		`tool ${name} failed: ${text.slice(0, 400)}`,
	);
	return text;
}

async function callTool(
	host: Host,
	name: string,
	params: Record<string, unknown>,
): Promise<{ text: string; value: Record<string, unknown> }> {
	const text = await callToolText(host, name, params);
	assert.equal(
		utf8Bytes(text) <= LIMITS.maxQueryBytes,
		true,
		`tool ${name} response is ${utf8Bytes(text)} bytes, over the 8 KiB budget`,
	);
	return { text, value: JSON.parse(text) as Record<string, unknown> };
}

function padBody(target: number): string {
	return "x".repeat(target);
}

test("Q0x dag_query pages the active set through the tool without repeating or skipping", async () => {
	const host = createHost("pi-dag-q0x-");
	try {
		const expected: string[] = [];
		// Three batches: 22 records of this size do not fit one 16 KiB batch.
		for (let wave = 0; wave < 3; wave += 1) {
			const upsertNodes = [];
			for (let index = wave * 8; index < Math.min(wave * 8 + 8, 22); index += 1) {
				const id = `t${String(index).padStart(2, "0")}`;
				expected.push(id);
				upsertNodes.push({
					id,
					kind: "hypothesis" as const,
					title: `tool record ${index}`,
					body: padBody(900),
					status: "open" as const,
				});
			}
			await callTool(host, "dag_update", { operationId: `q0x-seed-${wave}`, upsertNodes });
		}

		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		for (let guard = 0; guard < 40; guard += 1) {
			const { value } = await callTool(host, "dag_query", {
				scope: "active",
				...(cursor ? { cursor } : {}),
			});
			const page: QueryResultShape = asQueryResult(value);
			pages += 1;
			for (const record of page.records) seen.push(record.id);
			assert.ok(page.coverage, "every tool response declares its coverage");
			if (page.complete || !page.cursor) break;
			assert.notEqual(page.cursor, cursor, "the tool cursor advances");
			cursor = page.cursor;
		}
		assert.equal(pages >= 3, true, "900-byte records need several 8 KiB pages");
		assert.deepEqual([...seen].sort(), [...expected].sort());
		assert.equal(new Set(seen).size, seen.length);
	} finally {
		host.cleanup();
	}
});

test("Q0x dag_query resolves typed durable IDs and reports per-ID status", async () => {
	const host = createHost("pi-dag-q0x-");
	try {
		const created = await callTool(host, "dag_update", {
			operationId: "q0x-ids-1",
			upsertNodes: [
				{ id: "goal", kind: "goal", title: "minimize p50", body: "", status: "open" },
				{ id: "h-old", kind: "hypothesis", title: "retired idea", body: "why", status: "open" },
			],
		});
		await callTool(host, "dag_update", {
			operationId: "q0x-ids-2",
			setStatus: [{ id: "h-old", status: "done" }],
			archiveIds: ["h-old"],
		});

		const revisionId = created.value.revisionId as string;
		const resolved = await callTool(host, "dag_query", {
			scope: "history",
			ids: ["h-old", "not-a-record", revisionId],
		});
		const page = asQueryResult(resolved.value);
		assert.ok(Array.isArray(page.ids), "the tool reports a per-ID outcome");
		const byId = new Map((page.ids ?? []).map((outcome) => [outcome.id, outcome]));
		assert.equal(byId.get("h-old")?.status, "found");
		assert.equal(byId.get("h-old")?.type, "archived_node");
		assert.equal(byId.get("not-a-record")?.status, "missing");
		assert.equal(byId.get(revisionId)?.type, "revision");
		assert.deepEqual(
			page.records.map((record) => record.id),
			["h-old"],
			"a history ID read returns only what was asked for",
		);
	} finally {
		host.cleanup();
	}
});

test("Q0x session_read returns a bounded chunk of a large transcript entry", async () => {
	const host = createHost("pi-dag-q0x-");
	try {
		const sessionId = host.sessionManager.getSessionId();
		const entryId = host.sessionManager.appendCustomEntry("dag_test_blob", {
			note: "観測 🚀 ".repeat(20000),
		});
		assert.equal(typeof entryId, "string");

		let offset = 0;
		let assembled = "";
		let chunks = 0;
		let total = 0;
		for (let guard = 0; guard < 200; guard += 1) {
			const { value } = await callTool(host, "session_read", {
				sessionId,
				entryId,
				byteOffset: offset,
			});
			const chunk = value.chunk as
				| { text: string; complete: boolean; nextByteOffset: number | null; totalBytes: number }
				| undefined;
			assert.ok(chunk, "session_read delivers a bounded chunk, not the whole entry");
			total = chunk.totalBytes;
			assembled += chunk.text;
			chunks += 1;
			if (chunk.complete) break;
			assert.equal(chunk.nextByteOffset !== null, true);
			assert.equal((chunk.nextByteOffset ?? 0) > offset, true);
			offset = chunk.nextByteOffset ?? offset;
		}
		assert.equal(chunks >= 5, true, "a large entry needs several bounded chunks");
		assert.equal(utf8Bytes(assembled), total, "the chunks reassemble the whole entry");
		assert.equal(assembled.includes("🚀"), true, "multibyte content survives chunking");
	} finally {
		host.cleanup();
	}
});

test("Q0x read-only queries do not advance the revision or the selection", async () => {
	const host = createHost("pi-dag-q0x-");
	try {
		await callTool(host, "dag_update", {
			operationId: "q0x-ro",
			upsertNodes: [
				{ id: "goal", kind: "goal", title: "minimize p50", body: "", status: "open" },
				{ id: "h1", kind: "hypothesis", title: "does tiling help", body: "", status: "open" },
			],
		});
		const command = host.commands.get("dag");
		assert.ok(command);
		await command.handler("", host.ctx);
		const before = host.notifications.at(-1) ?? "";
		const entriesBefore = host.sessionManager.getBranch().length;

		await callTool(host, "dag_query", { scope: "active" });
		await callTool(host, "dag_query", { scope: "active", ids: ["goal", "h1"] });
		await callTool(host, "dag_query", { scope: "history", q: "tiling" });

		await command.handler("", host.ctx);
		const after = host.notifications.at(-1) ?? "";
		assert.equal(after, before, "queries change neither the revision nor the selection");
		assert.equal(
			host.sessionManager.getBranch().length,
			entriesBefore,
			"queries append no session entries",
		);
	} finally {
		host.cleanup();
	}
});

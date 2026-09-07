import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import piDagCompact from "../../src/index.ts";
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
	return { tools, commands, notifications, ctx, cleanup: tmp.cleanup };
}

async function callTool(
	host: Host,
	name: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
		`tool ${name} failed: ${text}`,
	);
	return JSON.parse(text) as Record<string, unknown>;
}

test("S0x dag_update returns assigned ids without a full graph reread", async () => {
	const host = createHost("pi-dag-s0x-");
	try {
		const created = await callTool(host, "dag_update", {
			operationId: "pub-1",
			upsertNodes: [
				{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
				{ kind: "hypothesis", title: "tiling reduces launch overhead", body: "", status: "open" },
			],
		});
		assert.equal(
			Array.isArray(created.assignedIds),
			true,
			"dag_update must return the ids it assigned",
		);
		const assigned = created.assignedIds as string[];
		assert.equal(assigned.length, 1);
		assert.equal(typeof assigned[0], "string");
		assert.equal(typeof created.selectionRevision, "string");

		const found = await callTool(host, "dag_query", { scope: "active", ids: [assigned[0]] });
		const records = found.records as Array<{ id: string }>;
		assert.equal(records[0]?.id, assigned[0]);
	} finally {
		host.cleanup();
	}
});

test("S0x /dag renders selected constraints, unresolved work, and typed baselines", async () => {
	const host = createHost("pi-dag-s0x-");
	try {
		await callTool(host, "dag_update", {
			operationId: "pub-2",
			upsertNodes: [
				{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
				{ id: "c-live", kind: "constraint", title: "smem le 64pct", body: "", status: "open" },
				{ id: "c-stale", kind: "constraint", title: "smem le 80pct", body: "", status: "stale" },
				{
					id: "d-accepted",
					kind: "decision",
					title: "schedule kept",
					body: "run-schedule",
					status: "done",
				},
				{
					id: "d-observed",
					kind: "decision",
					title: "fusion fastest observed",
					body: "run-fusion",
					status: "done",
				},
				{ id: "h1", kind: "hypothesis", title: "does tiling help", body: "", status: "open" },
				{ id: "b1", kind: "blocker", title: "profiler capture missing", body: "", status: "open" },
			],
			setSelection: {
				goalBinding: null,
				objectiveId: "goal",
				constraintIds: ["c-live"],
				acceptedBaselineRecordId: "d-accepted",
				bestObservedRecordId: "d-observed",
				bestValidatedRecordId: null,
				currentWorkIds: [],
				unresolvedIds: ["h1"],
				nextActionIds: [],
				rejectedApproachIds: [],
				pinnedIds: [],
			},
		});
		const command = host.commands.get("dag");
		assert.ok(command);
		await command.handler("", host.ctx);
		const rendered = host.notifications.join("\n");
		assert.equal(rendered.includes("unresolved:"), true, "/dag must render unresolved work");
		assert.equal(rendered.includes("does tiling help"), true);
		assert.equal(rendered.includes("profiler capture missing"), true);
		assert.equal(rendered.includes("schedule kept"), true);
		assert.equal(rendered.includes("fusion fastest observed"), true);
		assert.equal(rendered.includes("smem le 80pct"), false, "stale constraints stay out");
	} finally {
		host.cleanup();
	}
});

test("S0x dag_ingest_run reports evidence validity separately from promotion", async () => {
	const host = createHost("pi-dag-s0x-");
	try {
		const workspace = (host.ctx as unknown as { cwd: string }).cwd;
		const write = (runId: string, candidateId: string, pipeline: number, outcome: string) => {
			const dir = join(workspace, "runs", runId);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "manifest.json"),
				JSON.stringify({
					schemaVersion: 1,
					runId,
					candidateId,
					workloadId: "W1",
					question: "does it help?",
					source: { commit: "deadbeef", patchPath: `candidates/${candidateId}.patch` },
					command: ["replay-artifact", "--run", runId],
					environment: {
						gpu: "replay-gpu",
						driver: "replay-driver",
						host: "artifact-host",
						clocksLocked: true,
					},
					inputs: { workloadPath: "workloads/w1.json", dimensions: "M=4096", seed: 7 },
				}),
			);
			writeFileSync(
				join(dir, "result.json"),
				JSON.stringify({
					schemaVersion: 1,
					runId,
					status: "completed",
					measurements: {
						pipelineP50Ms: pipeline,
						kernelP50Ms: 2.1,
						smemPct: 40,
						unit: "ms",
						warmupIters: 10,
						sampleIters: 50,
					},
					correctness: { check: "ulp2", outcome, evidence: `runs/${runId}/correctness.txt` },
				}),
			);
		};
		write("run-base", "baseline", 12.4, "pass");
		write("run-fusion", "fusion", 13.8, "pass");

		const base = await callTool(host, "dag_ingest_run", {
			operationId: "ing-base",
			runId: "run-base",
		});
		assert.equal(typeof base.recordId, "string");
		const candidate = await callTool(host, "dag_ingest_run", {
			operationId: "ing-fusion",
			runId: "run-fusion",
			baselineRunId: "run-base",
			objectiveMetric: "pipelineP50Ms",
		});
		const promotion = candidate.promotion as { eligible: boolean; reasons: string[] } | undefined;
		assert.ok(promotion, "dag_ingest_run must report a promotion assessment");
		assert.equal(promotion.eligible, false);
		assert.equal(promotion.reasons.includes("objective_metric_regression"), true);

		const retry = await callTool(host, "dag_ingest_run", {
			operationId: "ing-base",
			runId: "run-base",
		});
		assert.equal(retry.recordId, base.recordId);
	} finally {
		host.cleanup();
	}
});

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createClassicHarness } from "../../src/eval/harness.ts";
import { loadEvalConfig } from "../../src/eval/load.ts";
import { createIsolatedWorkspace } from "../../src/eval/workspace.ts";
import piDagCompact from "../../src/index.ts";

/**
 * E03-metrics-not-constants (run boundary).
 *
 * One real memory-maintenance action (`dag_update`) and one real recovery
 * retrieval (`dag_query`) through the registered extension tools must produce
 * nonzero measured counts and costs. A no-maintenance control stays zero.
 * Shared prompt overhead is classified but never added on top of the total.
 */

const config = loadEvalConfig();

const memoryWorkspace = createIsolatedWorkspace();
const controlWorkspace = createIsolatedWorkspace();

const previousMode = process.env.PI_DAG_COMPACT_MODE;
const previousTaskDir = process.env.PI_DAG_COMPACT_TASK_DIR;
process.env.PI_DAG_COMPACT_MODE = "record-only";
process.env.PI_DAG_COMPACT_TASK_DIR = join(memoryWorkspace.root, "task");

const memory = await createClassicHarness(memoryWorkspace, config, {
	extensions: [piDagCompact],
});

memory.faux.setResponses([
	() =>
		fauxAssistantMessage(
			[
				fauxToolCall("dag_update", {
					operationId: "e03-maintenance-1",
					upsertNodes: [
						{
							id: "goal",
							kind: "goal",
							title: "minimize pipeline p50 for W1",
							body: "",
							status: "open",
						},
						{
							id: "A",
							kind: "hypothesis",
							title: "candidate A",
							body: "pipeline_regression",
							status: "rejected",
						},
					],
				}),
			],
			{ stopReason: "toolUse", responseId: "maintenance-call" },
		),
	() => fauxAssistantMessage("Recorded the rejection of A.", { responseId: "maintenance-done" }),
	() =>
		fauxAssistantMessage(
			[fauxToolCall("dag_query", { scope: "active", q: "pipeline_regression" })],
			{ stopReason: "toolUse", responseId: "recovery-call" },
		),
	() =>
		fauxAssistantMessage("A was rejected for pipeline_regression.", {
			responseId: "recovery-done",
		}),
	() => fauxAssistantMessage("done", { responseId: "spare" }),
]);

const driveErrors: string[] = [];
async function drive(session: { prompt: (text: string) => Promise<void> }, text: string) {
	try {
		await session.prompt(text);
	} catch (error) {
		driveErrors.push(`${text}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

await drive(memory.session, "# Scenario turn 1\nRecord the rejection of candidate A.");
await drive(memory.session, "# Scenario turn 2\nWhy was candidate A rejected?");
await drive(memory.session, "/dag");

const memorySnapshot = {
	messages: [...memory.session.messages],
	providerCalls: memory.faux.state.callCount,
	ledger: memory.ledger,
	commandOutputs: memory.commandOutputs,
};
await memory.cleanup();

process.env.PI_DAG_COMPACT_MODE = "disabled";
delete process.env.PI_DAG_COMPACT_TASK_DIR;

const control = await createClassicHarness(controlWorkspace, config);
control.faux.setResponses([
	() => fauxAssistantMessage("No memory maintenance in this arm.", { responseId: "control-1" }),
	() => fauxAssistantMessage("Still none.", { responseId: "control-2" }),
]);
await drive(control.session, "# Scenario turn 1\nSummarize the objective.");
await drive(control.session, "# Scenario turn 2\nSummarize again.");
const controlSnapshot = { ledger: control.ledger, providerCalls: control.faux.state.callCount };
await control.cleanup();

after(() => {
	memoryWorkspace.cleanup();
	controlWorkspace.cleanup();
	if (previousMode === undefined) delete process.env.PI_DAG_COMPACT_MODE;
	else process.env.PI_DAG_COMPACT_MODE = previousMode;
	if (previousTaskDir === undefined) delete process.env.PI_DAG_COMPACT_TASK_DIR;
	else process.env.PI_DAG_COMPACT_TASK_DIR = previousTaskDir;
});

test("the scripted fixture drives the real session without errors", () => {
	assert.deepEqual(driveErrors, []);
});

test("the harness exposes a per-attempt ledger with classified request kinds", () => {
	assert.ok(memorySnapshot.ledger, "the harness must expose an append-only per-attempt ledger");
	assert.equal(memorySnapshot.ledger.records.length, memorySnapshot.providerCalls);
	assert.ok(memorySnapshot.providerCalls >= 4);
});

test("one real maintenance action has a nonzero measured count and cost", () => {
	const totals = memorySnapshot.ledger.totals();
	assert.equal(totals.byKind.maintenance.attempts, 1);
	assert.ok(totals.byKind.maintenance.input > 0, "maintenance input tokens must be measured");
	assert.ok(totals.byKind.maintenance.output > 0, "maintenance output tokens must be measured");
	assert.ok(totals.maintenanceTokens > 0);
});

test("one real recovery retrieval has a nonzero measured count and cost", () => {
	const totals = memorySnapshot.ledger.totals();
	assert.equal(totals.byKind.recovery.attempts, 1);
	assert.ok(totals.byKind.recovery.input > 0, "recovery input tokens must be measured");
	assert.ok(totals.recoveryTokens > 0);
	assert.equal(totals.recoveryCalls, 1);
});

test("the real extension tools and the real /dag command ran", () => {
	const text = JSON.stringify(memorySnapshot.messages);
	assert.ok(text.includes("dag_update"), "the real dag_update tool must have been invoked");
	assert.ok(text.includes("dag_query"), "the real dag_query tool must have been invoked");
	assert.ok(text.includes("revisionId"), "dag_update must have persisted a revision");
	assert.ok(
		memorySnapshot.commandOutputs.some((entry) => entry.command === "dag"),
		"the real /dag command must have run",
	);
});

test("a no-maintenance control stays exactly zero", () => {
	assert.ok(controlSnapshot.ledger, "the control harness must expose the same ledger");
	const totals = controlSnapshot.ledger.totals();
	assert.equal(totals.maintenanceTokens, 0);
	assert.equal(totals.recoveryTokens, 0);
	assert.equal(totals.byKind.maintenance.attempts, 0);
	assert.equal(totals.byKind.recovery.attempts, 0);
	assert.ok(totals.input > 0, "the control still spends ordinary turn tokens");
});

test("shared prompt overhead is classified without being double counted", () => {
	const totals = memorySnapshot.ledger.totals();
	const perAttemptInput = memorySnapshot.ledger.records.reduce(
		(sum, record) => sum + (record.usage.known ? record.usage.input : 0),
		0,
	);
	assert.equal(totals.input, perAttemptInput, "the total is the sum of the attempts, nothing more");
	assert.ok(totals.sharedPromptOverheadTokens > 0, "shared overhead must be measured");
	assert.equal(
		totals.sharedPromptDistinctPrompts,
		1,
		"the shared prompt is counted once, not once per attempt",
	);
	assert.ok(
		totals.sharedPromptOverheadTokens < totals.input,
		"shared overhead is a classification of the total, not an addition to it",
	);
});

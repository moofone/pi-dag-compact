import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createMaintenanceFactory } from "../../src/eval/faux-simple.ts";
import { createClassicHarness } from "../../src/eval/harness.ts";
import { loadEvalConfig, loadScenario } from "../../src/eval/load.ts";
import { createIsolatedWorkspace } from "../../src/eval/workspace.ts";

/**
 * P03-core-fence (run boundary). CHARACTERISATION plus the extension fence.
 *
 * There is no core fence, and this fixture does not pretend otherwise. Pi does
 * not roll back a failed append, keeps the leaked entry in its leaf, branch and
 * context builder, and raises no error at reload when the resulting hole
 * truncates the branch. The CHARACTERISATION case records that.
 *
 * What is REQUIRED here is an EXTENSION-LEVEL fence over that unfenced host.
 * Once the extension has seen an append of its own go missing it must refuse
 * every downstream path it owns — ordinary user input, its own append,
 * automatic and manual compaction, the handoff fallback — and it must keep
 * refusing after a restart.
 *
 * The ceiling still applies. This fence does not stop a provider request the
 * host has already issued and it never claims an append reached disk; it
 * refuses to schedule more goal-owned work on a session whose own writes the
 * extension cannot read back.
 */

const config = loadEvalConfig();
const scenario = loadScenario();
/** Reserve almost the whole window, so the host compacts on its own. */
const eagerCompaction = { ...config, keepRecentTokens: 512, reserveTokens: 127200 };
const workspaces: Array<{ cleanup: () => void }> = [];

function isolated() {
	const workspace = createIsolatedWorkspace();
	workspaces.push(workspace);
	return workspace;
}

// ------------------- a session large enough to compact, then a failed append
const workspace = isolated();
const harness = await createClassicHarness(workspace, config, { dag: true });
for (const turn of scenario.turns.slice(0, 4)) {
	harness.latestTurn.current = turn.turn;
	await harness.session.prompt(turn.user);
}
const compactionsBeforeManual = harness.sessionManager
	.getBranch()
	.filter((entry) => entry.type === "compaction").length;

harness.persist?.arm({ failCustomTypes: ["dag_revision_ref"], maxFailures: 1 });
let appendError: unknown;
try {
	// The extension's own append path, the same one `dag_update` goes through.
	harness.boundary?.guardedAppend(harness.sessionManager, () =>
		harness.sessionManager.appendCustomEntry("dag_revision_ref", {
			v: 1,
			revisionId: "r-uncertain",
		}),
	);
} catch (error) {
	appendError = error;
}
harness.persist?.disarm();

const raised = harness.fence?.raised;
const raisedReason = harness.fence?.reason;
const fenceMessage = harness.fence?.message();
const leak = harness.durability?.leaks[0];
const leakInFile = harness.persistedEntryIds?.().has(leak?.entryId ?? "-");

// ----------------------------------------- ordinary user input, after the fence
const attemptsBeforeInput = harness.faux.attemptCount();
harness.latestTurn.current = 5;
await harness.session.prompt(scenario.turns[4]?.user ?? "Scenario turn 5");
const attemptsAfterInput = harness.faux.attemptCount();

// ------------------------------------------------------- manual compaction
let manualCompactionError: unknown;
try {
	await harness.session.compact();
} catch (error) {
	manualCompactionError = error;
}
const compactionsAfterManual = harness.sessionManager
	.getBranch()
	.filter((entry) => entry.type === "compaction").length;

// ---------------------------------------------------- the handoff fallback
const commandsBeforeHandoff = harness.commandOutputs.length;
await harness.session.prompt("/dag-handoff");
const handoffOutputs = harness.commandOutputs.slice(commandsBeforeHandoff);

const refusalPaths = harness.fence?.refusals.map((refusal) => refusal.path);
const sessionFile = harness.sessionManager.getSessionFile() ?? "";
await harness.cleanup();

// ------------------------------------------------------------------ restart
const reloaded = await createClassicHarness(workspace, config, { dag: true, sessionFile });
const attemptsBeforeReloadTurn = reloaded.faux.attemptCount();
await reloaded.session.prompt("Keep working after the restart.");
const attemptsAfterReloadTurn = reloaded.faux.attemptCount();
// `/dag` bypasses `input`, reaches ensureEngine, and so reaches the reconcile
// path that would append pending refs into the session that is in doubt.
await reloaded.session.prompt("/dag");
const reloadedRaised = reloaded.fence?.raised;
const reloadedReason = reloaded.fence?.reason;
const reloadedRefusals = reloaded.fence?.refusals.map((refusal) => refusal.path);
await reloaded.cleanup();

// ------------------------------------------- automatic (threshold) compaction
// Reserve almost the whole window so the host compacts on its own, then fail
// the write of the summary it produces. That is the host raising the fence
// through its own path, not the fixture raising it by hand.
const autoWorkspace = isolated();
const autoEvents: string[] = [];
const auto = await createClassicHarness(autoWorkspace, eagerCompaction, {
	dag: true,
	fauxFactory: createMaintenanceFactory({ operationPrefix: "p03-auto" }),
	extraExtensions: [
		(pi) => {
			pi.on("session_before_compact", async (event) => {
				autoEvents.push(`before:${event.reason}`);
				return undefined;
			});
			pi.on("session_compact", async (event) => {
				autoEvents.push(`done:${event.reason}`);
			});
			pi.on("session_compact_failed", async (event) => {
				autoEvents.push(`failed:fromExtension=${String(event.fromExtension)}`);
			});
		},
	],
});
await auto.session.prompt(scenario.turns[0]?.user ?? "Scenario turn 1");
auto.persist?.arm({ failEntryTypes: ["compaction"], maxFailures: 1 });
for (let index = 1; index < 8; index += 1) {
	try {
		auto.latestTurn.current = index + 1;
		await auto.session.prompt(scenario.turns[index]?.user ?? `Scenario turn ${index + 1}`);
	} catch (error) {
		autoEvents.push(`prompt_threw:${error instanceof Error ? error.message : String(error)}`);
	}
	if (auto.fence?.raised) auto.persist?.disarm();
}
const autoFenced = auto.fence?.raised;
const autoFenceReason = auto.fence?.reason;
const autoRefusals = auto.fence?.refusals.map((refusal) => refusal.path);
const autoCompactionEntries = auto.sessionManager
	.getBranch()
	.filter((entry) => entry.type === "compaction");
const autoPersisted = auto.persistedEntryIds?.();
const autoDurableCompactions = autoCompactionEntries.filter((entry) =>
	autoPersisted?.has(entry.id),
).length;
await auto.cleanup();

after(() => {
	for (const workspace of workspaces) workspace.cleanup();
});

test("an append the extension cannot read back raises the extension's own fence", () => {
	assert.ok(appendError, "the host propagates the write failure");
	assert.equal(raised, true);
	assert.equal(raisedReason, "append_failed");
	assert.ok(fenceMessage.includes("extension-level fence over an unfenced host"));
	assert.ok(
		fenceMessage.includes("not a core guarantee"),
		"the fence states its own scope; nothing here is host atomicity",
	);
});

test("CHARACTERISATION: the host itself is not fenced and reports no problem", () => {
	assert.ok(leak?.entryId, "the host kept the entry it failed to write");
	assert.equal(leak?.isLeaf, true, "it was the leaf the moment the write failed");
	assert.equal(leak?.inBranch, true);
	assert.equal(leak?.inContextEntries, true, "the context builder still selects it");
	assert.equal(leak?.inFile, false);
	assert.equal(leakInFile, false, "and it never appears in the file afterwards either");
});

test("the fence holds on ordinary user input", () => {
	assert.equal(
		attemptsAfterInput,
		attemptsBeforeInput,
		"no goal-owned turn is scheduled onto an uncertain session",
	);
	assert.ok(refusalPaths.includes("input"));
});

test("the fence holds on manual compaction", () => {
	assert.equal(
		compactionsAfterManual,
		compactionsBeforeManual,
		"session_before_compact is cancelled, so no cut is taken on an uncertain session",
	);
	assert.ok(
		refusalPaths.includes("compaction:manual"),
		`recorded refusals: ${refusalPaths.join(", ")}`,
	);
	assert.ok(
		manualCompactionError !== undefined || compactionsAfterManual === compactionsBeforeManual,
	);
});

test("the fence goes up on the host's own automatic compaction and no cut survives", () => {
	assert.ok(
		autoEvents.includes("before:threshold"),
		`the host compacts by itself under this reserve: ${autoEvents.join(", ")}`,
	);
	assert.equal(autoFenced, true);
	assert.equal(
		autoFenceReason,
		"compaction_append_failed",
		"a compaction summary that is the leaf and not in the file is a detected hole",
	);
	// NOT asserted, and recorded instead: that the fence was seen refusing a
	// LATER automatic compaction. Once the fence is up it refuses `input`, and
	// the host only evaluates its compaction threshold inside a turn, so offline
	// there is no turn left in which it could ask again. The fence is consulted
	// in session_before_compact before `event.reason` is read at all, and the
	// unit fixture covers threshold, overflow and manual on that same line.
	assert.ok(
		autoRefusals.length > 0,
		`the fence refused at least one downstream path: ${autoRefusals.join(", ")}`,
	);
	assert.equal(
		autoCompactionEntries.length,
		1,
		"CHARACTERISATION: the one compaction the host produced is still in memory",
	);
	assert.equal(
		autoDurableCompactions,
		0,
		"but no cut reached the session file, and no later one was allowed to start",
	);
});

test("the fence holds on the handoff fallback", () => {
	assert.ok(
		handoffOutputs.some((invocation) => invocation.command === "dag-handoff"),
		"the command runs: `input` does not fire for a slash command through AgentSession.prompt",
	);
	assert.ok(
		handoffOutputs.some((invocation) =>
			invocation.output.includes("extension-level fence over an unfenced host"),
		),
		"so the command checks the fence itself, and does",
	);
	assert.ok(refusalPaths.includes("handoff_fallback"));
});

test("the fence holds on the extension's own append path after a restart", () => {
	assert.equal(reloadedRaised, true, "a new process over the same task directory is still fenced");
	assert.equal(reloadedReason, "append_failed");
	assert.equal(
		attemptsAfterReloadTurn,
		attemptsBeforeReloadTurn,
		"and still refuses to schedule goal-owned work",
	);
	assert.ok(reloadedRefusals.includes("input"));
	assert.ok(
		reloadedRefusals.includes("reconcile_pending_after_restart"),
		`the reconcile path is refused too: ${reloadedRefusals.join(", ")}`,
	);
});

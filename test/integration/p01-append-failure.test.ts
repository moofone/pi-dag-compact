import assert from "node:assert/strict";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createMaintenanceFactory } from "../../src/eval/faux-simple.ts";
import { createClassicHarness } from "../../src/eval/harness.ts";
import { loadEvalConfig, loadScenario } from "../../src/eval/load.ts";
import { createIsolatedWorkspace } from "../../src/eval/workspace.ts";

/**
 * P01-append-failure (run boundary). CHARACTERISATION, plus one assertion.
 *
 * Everything named CHARACTERISATION below is a RECORD of what the installed Pi
 * peer does with an append whose write failed, taken through the real
 * `AgentSession` and the real file-backed `SessionManager`. None of it is a
 * requirement on the host. The host pushes the entry into memory, indexes it,
 * and advances the leaf before it writes, and it does not roll any of that back.
 *
 * The single requirement is on this extension: where the host leaks a failed
 * entry, the extension must detect it and fence its own downstream work. That
 * fence is extension-level, and it is asserted here as such — not as host
 * atomicity, which the host does not have.
 */

const config = loadEvalConfig();
const scenario = loadScenario();
const workspaces: Array<{ cleanup: () => void }> = [];

function isolated() {
	const workspace = createIsolatedWorkspace();
	workspaces.push(workspace);
	return workspace;
}

// ------------------------------------------------- a failed `custom` append
const customWorkspace = isolated();
const customHarness = await createClassicHarness(customWorkspace, config, {});
await customHarness.session.prompt("Scenario turn 1: establish a flushed session file.");
const flushedIds = customHarness.persistedEntryIds?.();
const knownBefore = new Set(customHarness.sessionManager.getEntries().map((entry) => entry.id));
customHarness.persist?.arm({ failCustomTypes: ["dag_revision_ref"], maxFailures: 1 });
let customError: unknown;
try {
	customHarness.sessionManager.appendCustomEntry("dag_revision_ref", {
		v: 1,
		revisionId: "r-leak",
	});
} catch (error) {
	customError = error;
}
customHarness.persist?.disarm();
const customLeak = customHarness.durability?.recordFailedAppend(
	customError,
	customHarness.sessionManager,
	knownBefore,
);
const capturesBeforeCustom = customHarness.captures.length;
await customHarness.session.prompt("Scenario turn 2: what does the next request carry?");
const captureAfterCustom = customHarness.captures[capturesBeforeCustom];
const customSessionFile = customHarness.sessionManager.getSessionFile() ?? "";
const customMemoryIds = customHarness.sessionManager.getEntries().map((entry) => entry.id);
const customLiveBranch = customHarness.sessionManager.getBranch().length;
await customHarness.cleanup();

const customReopened = SessionManager.open(customSessionFile, customWorkspace.sessionDir);

// ------------------------------------------- a failed `custom_message` append
const messageWorkspace = isolated();
const messageHarness = await createClassicHarness(messageWorkspace, config, {});
await messageHarness.session.prompt("Scenario turn 1: establish a flushed session file.");
messageHarness.persist?.arm({ failCustomTypes: ["dag_probe_message"], maxFailures: 1 });
let messageError: unknown;
const messageKnown = new Set(messageHarness.sessionManager.getEntries().map((entry) => entry.id));
try {
	messageHarness.sessionManager.appendCustomMessageEntry(
		"dag_probe_message",
		"LEAKED-CONTEXT-MARKER",
		false,
	);
} catch (error) {
	messageError = error;
}
messageHarness.persist?.disarm();
const messageLeak = messageHarness.durability?.recordFailedAppend(
	messageError,
	messageHarness.sessionManager,
	messageKnown,
);
const rebuiltContext = JSON.stringify(messageHarness.sessionManager.buildSessionContext());
const capturesBeforeMessage = messageHarness.captures.length;
await messageHarness.session.prompt("Scenario turn 2: does it reach the provider?");
const captureAfterMessage = messageHarness.captures[capturesBeforeMessage];
await messageHarness.cleanup();

// ----------------------------------------------- a failed compaction append
const compactionWorkspace = isolated();
const compactionEvents: string[] = [];
const compactionHarness = await createClassicHarness(compactionWorkspace, config, {
	extraExtensions: [
		(pi) => {
			pi.on("session_compact_failed", async (event) => {
				compactionEvents.push(
					`session_compact_failed fromExtension=${String(event.fromExtension)}`,
				);
			});
		},
	],
});
for (const turn of scenario.turns.slice(0, 4)) {
	compactionHarness.latestTurn.current = turn.turn;
	await compactionHarness.session.prompt(turn.user);
}
const contextEntriesBeforeCut = compactionHarness.sessionManager.buildContextEntries().length;
const messagesBeforeCut = compactionHarness.session.messages.length;
compactionHarness.persist?.arm({ failEntryTypes: ["compaction"], maxFailures: 1 });
let compactionError: unknown;
try {
	await compactionHarness.session.compact();
} catch (error) {
	compactionError = error;
}
compactionHarness.persist?.disarm();
const compactionEntries = compactionHarness.sessionManager
	.getBranch()
	.filter((entry) => entry.type === "compaction");
const leakedCompactionId = compactionEntries[compactionEntries.length - 1]?.id ?? "";
const contextEntriesAfterCut = compactionHarness.sessionManager.buildContextEntries().length;
const messagesAfterCut = compactionHarness.session.messages.length;
// Keep working afterwards, so later entries chain onto the entry the host
// failed to write. That is what turns a lost entry into a hole.
compactionHarness.latestTurn.current = 5;
await compactionHarness.session.prompt(scenario.turns[4]?.user ?? "Scenario turn 5");
const compactionOnDisk = compactionHarness.persistedEntryIds?.();
const compactionSessionFile = compactionHarness.sessionManager.getSessionFile() ?? "";
const compactionMemoryCount = compactionHarness.sessionManager.getEntries().length;
const compactionLiveBranch = compactionHarness.sessionManager.getBranch().length;
await compactionHarness.cleanup();

const compactionReopened = SessionManager.open(
	compactionSessionFile,
	compactionWorkspace.sessionDir,
);

// --------------------------------- the extension fence, through the real tool
const fenceWorkspace = isolated();
const fenceHarness = await createClassicHarness(fenceWorkspace, config, {
	dag: true,
	fauxFactory: createMaintenanceFactory({ operationPrefix: "p01" }),
});
await fenceHarness.session.prompt("Scenario turn 1: flush the session before injecting.");
fenceHarness.persist?.arm({
	failCustomTypes: ["dag_revision_ref", "dag_checkpoint_ref"],
	maxFailures: 1,
});
await fenceHarness.session.prompt("Record the working set through dag_update.");
fenceHarness.persist?.disarm();
const fenceRaised = fenceHarness.fence?.raised;
const fenceReason = fenceHarness.fence?.reason;
const fenceLeaks = fenceHarness.durability?.leaks.length;
const attemptsBeforeFencedTurn = fenceHarness.faux.attemptCount();
await fenceHarness.session.prompt("Ordinary user input after the fence went up.");
const attemptsAfterFencedTurn = fenceHarness.faux.attemptCount();
const fenceRefusals = fenceHarness.fence?.refusals.map((refusal) => refusal.path);
const fenceMessage = fenceHarness.fence?.message();
const fenceTaskDir = fenceHarness.boundary?.boundDirectory;
const fenceSessionFile = fenceHarness.sessionManager.getSessionFile() ?? "";
await fenceHarness.cleanup();

const fenceReloaded = await createClassicHarness(fenceWorkspace, config, {
	dag: true,
	fauxFactory: createMaintenanceFactory({ operationPrefix: "p01-reload" }),
	sessionFile: fenceSessionFile,
});
const reloadAttemptsBefore = fenceReloaded.faux.attemptCount();
await fenceReloaded.session.prompt("Try to keep working after the restart.");
const reloadAttemptsAfter = fenceReloaded.faux.attemptCount();
const reloadFenceRaised = fenceReloaded.fence?.raised;
const reloadFenceReason = fenceReloaded.fence?.reason;
await fenceReloaded.cleanup();

after(() => {
	for (const workspace of workspaces) workspace.cleanup();
});

test("CHARACTERISATION: a failed custom append stays leaf, branch and context", () => {
	assert.ok(customError, "the host propagates the write failure to the caller");
	assert.ok(customLeak.entryId, "and leaves the entry it failed to write in memory");
	assert.equal(customLeak.isLeaf, true);
	assert.equal(customLeak.inBranch, true);
	assert.equal(customLeak.inContextEntries, true);
	assert.equal(customLeak.inFile, false);
	assert.ok(flushedIds.size > 0, "the session file was already flushed before the injection");
});

test("CHARACTERISATION: the failed custom entry does not reach the next provider request", () => {
	assert.ok(captureAfterCustom, "a next request was captured at the provider");
	assert.equal(
		captureAfterCustom.serializedContext.includes(customLeak.entryId ?? "-"),
		false,
		"a `custom` entry is not a message, so the provider payload never carried it",
	);
	assert.equal(captureAfterCustom.serializedContext.includes("r-leak"), false);
});

test("CHARACTERISATION: the hole amputates the branch after a restart", () => {
	assert.ok(customMemoryIds.length > customReopened.getEntries().length);
	assert.equal(
		customReopened.getEntries().some((entry) => entry.id === customLeak.entryId),
		false,
		"the failed entry is not in the file, as expected",
	);
	assert.ok(
		customReopened.getBranch().length < customLiveBranch,
		"but the live process walked a longer branch than the reload can",
	);
	assert.ok(
		customReopened.getBranch().length < customReopened.getEntries().length,
		"the reloaded branch stops at the hole; entries before it are unreachable",
	);
	assert.ok(
		customReopened.getTree().length > 1,
		"and the broken parent chain shows up as an extra orphan root",
	);
});

test("CHARACTERISATION: a failed custom message reaches the rebuilt context, not the live request", () => {
	assert.ok(messageError);
	assert.equal(messageLeak.inContextEntries, true);
	assert.equal(messageLeak.inFile, false);
	assert.equal(
		rebuiltContext.includes("LEAKED-CONTEXT-MARKER"),
		true,
		"the session manager's own context rebuild selects the failed entry",
	);
	assert.equal(
		captureAfterMessage?.serializedContext.includes("LEAKED-CONTEXT-MARKER"),
		false,
		"the live AgentSession keeps its own message list, so the request did not carry it",
	);
});

test("CHARACTERISATION: a failed compaction append is applied to the context builder anyway", () => {
	assert.ok(compactionError, "the host propagates the compaction write failure");
	assert.deepEqual(compactionEvents, ["session_compact_failed fromExtension=false"]);
	assert.ok(leakedCompactionId, "the compaction entry is in memory");
	assert.equal(compactionOnDisk.has(leakedCompactionId), false, "and not in the file");
	assert.ok(
		contextEntriesAfterCut < contextEntriesBeforeCut,
		"the context builder honours a summary that was never written",
	);
	assert.equal(
		messagesAfterCut,
		messagesBeforeCut,
		"the live AgentSession message list is untouched, so the next request is unaffected",
	);
});

test("CHARACTERISATION: a failed compaction append amputates the whole session on reload", () => {
	assert.ok(compactionLiveBranch > 1);
	assert.ok(
		compactionMemoryCount > compactionReopened.getEntries().length,
		`memory ${compactionMemoryCount} entries, file ${compactionReopened.getEntries().length}`,
	);
	assert.ok(
		compactionReopened.getBranch().length < compactionLiveBranch / 2,
		"the reload resolves only the entries after the hole",
	);
	assert.equal(
		compactionReopened.getEntries().some((entry) => entry.type === "compaction"),
		false,
	);
	assert.ok(compactionReopened.getTree().length > 1, "an extra orphan root, and no error raised");
});

test("the extension detects the leak and fences its own downstream work", () => {
	// This is the assertion. It is about the extension, not the host: the host
	// leaked the entry and will keep leaking it.
	assert.equal(fenceRaised, true, "an append the extension made is not in the session file");
	assert.equal(fenceReason, "append_failed");
	assert.equal(fenceLeaks, 1);
	assert.ok(fenceTaskDir, "the fence is stored beside the extension's own records");
	assert.equal(
		attemptsAfterFencedTurn,
		attemptsBeforeFencedTurn,
		"the fence refuses ordinary input, so nothing reaches the provider",
	);
	assert.ok(fenceRefusals.includes("input"), "and the refusal is recorded, not merely implied");
	assert.ok(
		fenceMessage.includes("extension-level fence over an unfenced host"),
		"and it says what it is: an extension-level fence, not a core guarantee",
	);
	assert.ok(fenceMessage.includes("not a core guarantee"));
});

test("the extension fence survives the restart the host does not notice", () => {
	assert.equal(
		reloadFenceRaised,
		true,
		"a new process over the same task directory is still fenced",
	);
	assert.equal(reloadFenceReason, "append_failed");
	assert.equal(
		reloadAttemptsAfter,
		reloadAttemptsBefore,
		"and no goal-owned work is scheduled onto the uncertain session",
	);
});

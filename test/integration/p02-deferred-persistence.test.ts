import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { createClassicHarness } from "../../src/eval/harness.ts";
import { loadEvalConfig } from "../../src/eval/load.ts";
import { createIsolatedWorkspace } from "../../src/eval/workspace.ts";

/**
 * P02-deferred-persistence (run boundary). TRUE ASSERTION.
 *
 * An API return is not a durable acknowledgement. Through the real
 * `AgentSession` and the real file-backed `SessionManager`: the host names a
 * session file up front and does not create it, defers every write until an
 * assistant message exists, and then flushes everything at once through an
 * exclusive open that can fail as a unit. An entry id handed back before that
 * flush is acknowledging nothing.
 *
 * "Acknowledged" throughout means the bytes were read back out of the session
 * file. It is never an fsync or power-loss claim, and this package makes none.
 */

const config = loadEvalConfig();
const workspaces: Array<{ cleanup: () => void }> = [];

function isolated() {
	const workspace = createIsolatedWorkspace();
	workspaces.push(workspace);
	return workspace;
}

// ------------------------------------------------------- the deferred window
const deferredWorkspace = isolated();
const deferred = await createClassicHarness(deferredWorkspace, config, {});
const namedFile = deferred.sessionManager.getSessionFile() ?? "";
const fileExistsAtStart = existsSync(namedFile);
const beforeFlushEntryId = deferred.sessionManager.appendCustomEntry("dag_revision_ref", {
	v: 1,
	revisionId: "r-deferred",
});
const beforeFlushObservation = deferred.durability?.observeAppend(beforeFlushEntryId);
const fileExistsAfterAppend = existsSync(namedFile);
const persistedBeforeFlush = deferred.persistedEntryIds?.();
const memoryBeforeFlush = deferred.sessionManager.getEntries().map((entry) => entry.id);

await deferred.session.prompt("Scenario turn 1: force the deferred first flush.");
const fileExistsAfterTurn = existsSync(namedFile);
const persistedAfterFlush = deferred.persistedEntryIds?.();
const rechecked = deferred.durability?.recheck(beforeFlushEntryId);
const afterFlushEntryId = deferred.sessionManager.appendCustomEntry("dag_revision_ref", {
	v: 1,
	revisionId: "r-after",
});
const afterFlushObservation = deferred.durability?.observeAppend(afterFlushEntryId);
const persistedAtEnd = deferred.persistedEntryIds?.();
await deferred.cleanup();

// ------------------------------------------- the first flush fails as a unit
const flushWorkspace = isolated();
const flushHarness = await createClassicHarness(flushWorkspace, config, {});
const flushFile = flushHarness.sessionManager.getSessionFile() ?? "";
const preFlushEntryId = flushHarness.sessionManager.appendCustomEntry("dag_revision_ref", {
	v: 1,
	revisionId: "r-pre-flush",
});
const preFlushObservation = flushHarness.durability?.observeAppend(preFlushEntryId);
// Something else owns the path the host chose. The host opens it with the
// exclusive `wx` flag, so the whole first flush fails at once.
writeFileSync(flushFile, "");
let flushError: unknown;
try {
	await flushHarness.session.prompt("Scenario turn 1: the flush that cannot happen.");
} catch (error) {
	flushError = error;
}
const flushPersisted = flushHarness.persistedEntryIds?.();
const flushMemoryCount = flushHarness.sessionManager.getEntries().length;
const flushAcknowledged = [...(flushHarness.durability?.acknowledgedEntryIds ?? [])];
await flushHarness.cleanup();

after(() => {
	for (const workspace of workspaces) workspace.cleanup();
});

test("the host names a session file and does not create it", () => {
	assert.ok(namedFile.endsWith(".jsonl"), "a real file-backed session");
	assert.equal(fileExistsAtStart, false);
});

test("an entry id returned before the first flush acknowledges nothing", () => {
	assert.equal(typeof beforeFlushEntryId, "string");
	assert.ok(beforeFlushEntryId.length > 0, "the host hands back a real id");
	assert.equal(beforeFlushObservation.durability, "deferred");
	assert.equal(
		beforeFlushObservation.acknowledged,
		false,
		"an API return is not a durable acknowledgement",
	);
	assert.equal(fileExistsAfterAppend, false, "and no file was written");
	assert.equal(persistedBeforeFlush.size, 0);
	assert.ok(memoryBeforeFlush.length > 0, "while the host reports the entries in memory");
	assert.ok(
		memoryBeforeFlush.every((id) => !persistedBeforeFlush.has(id)),
		"every id the host reports before the flush is undurable",
	);
});

test("the first assistant message is what makes those entries readable back", () => {
	assert.equal(fileExistsAfterTurn, true);
	assert.equal(rechecked, "present_in_file", "the earlier deferred id can be read back now");
	assert.ok(persistedAfterFlush.has(beforeFlushEntryId));
	assert.equal(afterFlushObservation.durability, "present_in_file");
	assert.equal(
		afterFlushObservation.acknowledged,
		true,
		"read back out of the file, which is the strongest claim available",
	);
});

test("a failed first flush loses every entry the host had already accepted", () => {
	assert.ok(flushError, "the host surfaces the failure at the turn, not at the append");
	assert.equal(preFlushObservation.durability, "deferred");
	assert.equal(preFlushObservation.acknowledged, false);
	assert.ok(flushMemoryCount > 1, "the host still reports its entries in memory");
	assert.equal(flushPersisted.size, 0, "and not one of them reached the file");
	assert.deepEqual(
		flushAcknowledged,
		[],
		"nothing was ever acknowledged, so nothing has to be un-acknowledged",
	);
});

test("only ids read back out of the file are ever reported as acknowledged", () => {
	const persisted = persistedAtEnd;
	for (const id of deferred.durability?.acknowledgedEntryIds ?? []) {
		assert.ok(persisted.has(id), `acknowledged ids must be present in the file: ${id}`);
	}
	assert.ok(
		(deferred.durability?.observations ?? []).some((observation) => !observation.acknowledged),
		"and the observer records the undurable ones rather than dropping them",
	);
});

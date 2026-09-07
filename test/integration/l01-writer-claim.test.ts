/**
 * L01 — two real processes compete for one writer claim behind a barrier.
 *
 * Every competitor here is a separate OS process running the real
 * `MemoryEngine` over the real SQLite store. They are released by one IPC `go`
 * after every one of them has reported `armed`, so the contended call is the
 * claim itself. There are no sleeps and no timing assumptions: whatever order
 * the kernel picks, exactly one claim may survive.
 *
 * Nothing here is reclaimable by elapsed time. A crashed owner is recovered
 * only through an explicit recovery that verifies the owner is gone, and a live
 * owner is never displaced.
 */

import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openStoreDirect } from "../support/d0x-fixtures.ts";
import type { ChildResult, ClaimRole } from "../support/l01-claim-child.ts";
import { CRASH_EXIT_CODE } from "../support/l01-claim-child.ts";
import { makeTempDir } from "../support/tmp.ts";

const childPath = fileURLToPath(new URL("../support/l01-claim-child.ts", import.meta.url));
const temps: Array<{ cleanup: () => void }> = [];
/** Every competitor ever started, so a failed assertion cannot leave one alive. */
const spawned: ChildProcess[] = [];

function taskDir(prefix: string): string {
	const tmp = makeTempDir(prefix);
	temps.push(tmp);
	const dir = join(tmp.path, "research-task");
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface Competitor {
	child: ChildProcess;
	armed: Promise<void>;
	result: Promise<ChildResult>;
	exit: Promise<number | null>;
}

function spawnCompetitor(
	dir: string,
	sessionId: string,
	role: ClaimRole,
	opId?: string,
): Competitor {
	const child = fork(childPath, [dir, sessionId, role, ...(opId ? [opId] : [])], {
		execArgv: ["--experimental-strip-types"],
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	spawned.push(child);
	let armedResolve: () => void = () => {};
	let resultResolve: (value: ChildResult) => void = () => {};
	let resultReject: (reason: Error) => void = () => {};
	const armed = new Promise<void>((resolve) => {
		armedResolve = resolve;
	});
	const result = new Promise<ChildResult>((resolve, reject) => {
		resultResolve = resolve;
		resultReject = reject;
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	child.on("message", (message: unknown) => {
		const envelope = message as { type?: string; result?: ChildResult };
		if (envelope?.type === "armed") armedResolve();
		if (envelope?.type === "result" && envelope.result) resultResolve(envelope.result);
	});
	const exit = new Promise<number | null>((resolve) => {
		child.on("exit", (code) => {
			resultReject(new Error(`child ${sessionId}/${role} exited before reporting: ${stderr}`));
			resolve(code);
		});
	});
	return { child, armed, result, exit };
}

/** Release every competitor at once. This is the barrier. */
async function releaseAll(competitors: Competitor[]): Promise<ChildResult[]> {
	await Promise.all(competitors.map((competitor) => competitor.armed));
	for (const competitor of competitors) competitor.child.send({ type: "go" });
	return Promise.all(competitors.map((competitor) => competitor.result));
}

function finish(competitors: Competitor[]): Promise<Array<number | null>> {
	for (const competitor of competitors) {
		if (competitor.child.connected) competitor.child.send({ type: "exit" });
	}
	return Promise.all(competitors.map((competitor) => competitor.exit));
}

interface StoreView {
	claims: Array<Record<string, unknown>>;
	revisionOperations: string[];
	recoveryEvents: Array<Record<string, unknown>>;
	hasClaimTable: boolean;
	hasEventTable: boolean;
}

/**
 * Read the store directly, without opening an engine over it. Opening one would
 * itself be a claim, and the probe must never take ownership from the writers
 * it is observing.
 */
function readStore(dir: string): StoreView {
	const db = openStoreDirect(dir);
	try {
		const named = (name: string): boolean =>
			Number(
				(
					db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = ?").get(name) as {
						n: number;
					}
				).n,
			) > 0;
		const hasClaimTable = named("writer_claims");
		const hasEventTable = named("writer_claim_events");
		return {
			hasClaimTable,
			hasEventTable,
			claims: hasClaimTable
				? (db.prepare("SELECT * FROM writer_claims").all() as Array<Record<string, unknown>>)
				: [],
			recoveryEvents: hasEventTable
				? (db.prepare("SELECT * FROM writer_claim_events WHERE kind = 'recovered'").all() as Array<
						Record<string, unknown>
					>)
				: [],
			revisionOperations: (
				db.prepare("SELECT operation_id FROM revisions ORDER BY revision").all() as Array<{
					operation_id: string;
				}>
			).map((row) => row.operation_id),
		};
	} finally {
		db.close();
	}
}

after(() => {
	for (const child of spawned) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	for (const tmp of temps) tmp.cleanup();
});

test("L01 two processes reopening the same session ID are still competing writers", async () => {
	const dir = taskDir("pi-dag-l01-same-");
	const competitors = [
		spawnCompetitor(dir, "s-shared", "claim_and_write", "l01-same-a"),
		spawnCompetitor(dir, "s-shared", "claim_and_write", "l01-same-b"),
	];
	const results = await releaseAll(competitors);
	const opened = results.filter((result) => result.opened);
	const refused = results.filter((result) => !result.opened);

	assert.equal(results.length, 2, "sanity: both competitors reported");
	assert.equal(opened.length, 1, "exactly one process may hold the writer claim");
	assert.equal(refused.length, 1);
	assert.equal(
		refused[0]?.openCode,
		"competing_writer",
		"the loser is refused by name, not by silence",
	);
	assert.equal(opened[0]?.committed, true, "the winner is a real writer, not a hollow one");

	const store = readStore(dir);
	assert.equal(
		store.revisionOperations.length,
		1,
		"exactly one revision reached the store; two writers would have written two",
	);
	assert.equal(store.claims.length, 1, "the store holds exactly one claim");
	await finish(competitors);
});

test("L01 two processes with different session IDs still resolve to one writer", async () => {
	const dir = taskDir("pi-dag-l01-diff-");
	const competitors = [
		spawnCompetitor(dir, "s-one", "claim_and_write", "l01-diff-a"),
		spawnCompetitor(dir, "s-two", "claim_and_write", "l01-diff-b"),
	];
	const results = await releaseAll(competitors);
	assert.equal(
		results.filter((result) => result.opened).length,
		1,
		"the claim is atomic: a read-then-write check would let both in",
	);
	assert.equal(readStore(dir).revisionOperations.length, 1);
	await finish(competitors);
});

test("L01 restart recovery must not take a live owner's store", async () => {
	const dir = taskDir("pi-dag-l01-live-");
	const owner = spawnCompetitor(dir, "s-live", "hold");
	const ownerResult = (await releaseAll([owner]))[0];
	assert.equal(ownerResult?.opened, true, "sanity: the owner holds the claim and is still alive");

	// A restart of the very same session ID, while the owner is alive.
	const restart = spawnCompetitor(dir, "s-live", "claim_and_write", "l01-live-restart");
	const restartResult = (await releaseAll([restart]))[0];
	assert.equal(
		restartResult?.opened,
		false,
		"a live owner is never displaced; reclaim needs verified release or death",
	);
	assert.equal(restartResult?.openCode, "competing_writer");
	assert.equal(restartResult?.committed, false, "the refused process wrote nothing");
	assert.deepEqual(readStore(dir).revisionOperations, [], "sanity: nothing was committed at all");
	await finish([owner, restart]);
});

test("L01 a crashed owner is recovered only by an explicit verified recovery", async () => {
	const dir = taskDir("pi-dag-l01-crash-");
	const crasher = spawnCompetitor(dir, "s-crash", "crash_after_commit", "l01-crash-a");
	const crashed = (await releaseAll([crasher]))[0];
	assert.equal(crashed?.committed, true, "sanity: the crashed process committed before dying");
	assert.equal(
		await crasher.exit,
		CRASH_EXIT_CODE,
		"sanity: it really died, with no release and no cleanup",
	);

	const afterCrash = readStore(dir);
	assert.equal(afterCrash.hasClaimTable, true, "ownership survives the process that held it");
	assert.equal(afterCrash.claims.length, 1, "the dead owner's claim is still on record");

	const recovery = spawnCompetitor(dir, "s-crash", "claim_and_write", "l01-crash-b");
	const recovered = (await releaseAll([recovery]))[0];
	assert.equal(recovered?.opened, true, "a verifiably dead owner may be recovered from");
	assert.equal(recovered?.recovered, true, "the recovery is explicit and reported, not implicit");

	const store = readStore(dir);
	assert.equal(store.hasEventTable, true, "the recovery is recorded");
	assert.equal(
		store.recoveryEvents.length,
		1,
		"exactly one stale-owner recovery happened, and it is auditable",
	);
	assert.deepEqual(
		store.revisionOperations,
		["l01-crash-a", "l01-crash-b"],
		"the crashed writer's durable work survives its recovery",
	);
	assert.equal(store.claims.length, 1, "the recovered claim replaced the dead one");
	await finish([recovery]);
});

test("L01 a released owner cannot displace or release the writer that replaced it", async () => {
	const dir = taskDir("pi-dag-l01-stale-");
	const first = spawnCompetitor(dir, "s-stale", "claim_then_release");
	const firstResult = (await releaseAll([first]))[0];
	assert.equal(firstResult?.opened, true, "sanity: the first writer held and released the claim");
	await finish([first]);
	assert.deepEqual(readStore(dir).claims, [], "an orderly release leaves no claim behind");

	const next = spawnCompetitor(dir, "s-stale", "hold");
	const nextResult = (await releaseAll([next]))[0];
	assert.equal(nextResult?.opened, true, "the released store is claimable again");
	const heldToken = readStore(dir).claims[0]?.claim_token;
	assert.equal(typeof heldToken, "string", "sanity: the new owner's token is on record");

	// The old session identity comes back while the new owner is alive.
	const stale = spawnCompetitor(dir, "s-stale", "claim_and_write", "l01-stale-x");
	const staleResult = (await releaseAll([stale]))[0];
	assert.equal(staleResult?.opened, false, "a stale session identity is not a claim");
	assert.equal(staleResult?.openCode, "competing_writer");
	assert.equal(
		readStore(dir).claims[0]?.claim_token,
		heldToken,
		"the live owner's claim is untouched by the stale writer's attempt",
	);
	await finish([next, stale]);
});

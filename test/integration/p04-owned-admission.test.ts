import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createClassicHarness } from "../../src/eval/harness.ts";
import { loadEvalConfig, loadScenario } from "../../src/eval/load.ts";
import { createIsolatedWorkspace } from "../../src/eval/workspace.ts";

/**
 * P04-owned-admission (run boundary). TRUE ASSERTION, full force.
 *
 * One owner, one finite allowance, no refunds and no hidden retry allowance.
 * With allowance 3 and a provider that keeps requesting tools, there must be no
 * fourth goal-scheduled provider entry — including after a reload, because a
 * restart is not a refund.
 *
 * The enforcement is schedule-refusal through the two channels Pi honours:
 * `input` -> `{action:"handled"}` never starts the turn, and `tool_call` ->
 * `{block:true, terminate:true}` never starts the continuation. Requests the
 * host issues on its own — compaction summaries most obviously — reach the
 * provider whatever this extension does. Those are recorded as uncharged
 * host-issued attempts, which is the residual gap, reported rather than
 * asserted away.
 */

type ObservingLedger = {
	observeTransportAttempt(
		attemptId: string,
		requestId?: string,
		context?: { kind?: string },
	): string;
};

const GOAL = { kind: "goal" as const, id: "g1", stage: "build", generation: 1 };
const PEER = { kind: "peer" as const, id: "dag", stage: "build", generation: 1 };

const config = loadEvalConfig();
const scenario = loadScenario();

/**
 * Charge each observed attempt against a reservation of the same kind.
 *
 * Turns and every flavour of tool continuation — including the DAG's own
 * maintenance and recovery calls — are reserved through `input` and `tool_call`
 * as execution. Summarization is the one the host issues by itself, so a
 * summary attempt can never match a reservation and is recorded as the gap.
 */
function scheduleKindOf(captureKind: string): string {
	return captureKind === "summary" ? "summary" : "execution";
}

const toolLoop = (_context: Context): AssistantMessage =>
	fauxAssistantMessage([fauxToolCall("read", { path: "bench.mjs" })], { stopReason: "toolUse" });

// ---------------------------------------------------------------- allowance 3
const budgetWorkspace = createIsolatedWorkspace();
let budgetLedger: ObservingLedger | undefined;
const budget = await createClassicHarness(budgetWorkspace, config, {
	dag: true,
	fauxFactory: toolLoop,
	owner: { owner: GOAL, allowance: 3 },
	barriers: {
		beforeAttempt: (capture) => {
			budgetLedger?.observeTransportAttempt(capture.attemptId, undefined, {
				kind: scheduleKindOf(capture.kind),
			});
		},
	},
});
budgetLedger = budget.admission;
await budget.session.prompt("Drive the tool loop until admission refuses.");
const budgetAttempts = budget.faux.attemptCount();
const budgetRemaining = budget.admission?.remaining(GOAL);
const budgetScheduled = budget.admission?.scheduledFor(GOAL).length;
const budgetCharged = budget.admission
	?.scheduledFor(GOAL)
	.filter((reservation) => reservation.transportAttempts.length > 0).length;
await budget.cleanup();

// Same workspace, same task directory, same session file: a reload.
let reloadLedger: ObservingLedger | undefined;
const reloaded = await createClassicHarness(budgetWorkspace, config, {
	dag: true,
	fauxFactory: toolLoop,
	sessionFile: budget.sessionManager.getSessionFile() ?? "",
	owner: { owner: GOAL, allowance: 3 },
	barriers: {
		beforeAttempt: (capture) => {
			reloadLedger?.observeTransportAttempt(capture.attemptId, undefined, {
				kind: scheduleKindOf(capture.kind),
			});
		},
	},
});
reloadLedger = reloaded.admission;
await reloaded.session.prompt("Try again after a reload.");
const reloadAttempts = reloaded.faux.attemptCount();
// Read after the first hook has run: the durable store, not the in-process
// call to bindOwner, is what decides how much allowance is left.
const reloadRemaining = reloaded.admission?.remaining(GOAL);
const reloadScheduled = reloaded.admission?.scheduledFor(GOAL).length;
await reloaded.cleanup();

// -------------------------------------------------- host-issued, uncharged gap
const gapWorkspace = createIsolatedWorkspace();
let gapLedger: ObservingLedger | undefined;
const gap = await createClassicHarness(gapWorkspace, config, {
	dag: true,
	owner: { owner: GOAL, allowance: 400 },
	barriers: {
		beforeAttempt: (capture) => {
			gapLedger?.observeTransportAttempt(capture.attemptId, undefined, {
				kind: scheduleKindOf(capture.kind),
			});
		},
	},
});
gapLedger = gap.admission;
for (const turn of scenario.turns.slice(0, 4)) {
	gap.latestTurn.current = turn.turn;
	await gap.session.prompt(turn.user);
}
const gapBeforeCompaction = gap.admission?.unchargedHostIssued.length;
const gapRemainingBefore = gap.admission?.remaining(GOAL);
await gap.session.compact();
const gapAfterCompaction = gap.admission?.unchargedHostIssued.length;
const gapRemainingAfter = gap.admission?.remaining(GOAL);
await gap.cleanup();

// ------------------------------------------------- pause inside a real barrier
const pauseWorkspace = createIsolatedWorkspace();
let pauseHarness: { admission: ObservingLedger } | undefined;
let pauseArmed = false;
const paused = await createClassicHarness(pauseWorkspace, config, {
	dag: true,
	fauxFactory: toolLoop,
	owner: { owner: GOAL, allowance: 8 },
	barriers: {
		beforeAttempt: (capture) => {
			pauseHarness?.admission?.observeTransportAttempt(capture.attemptId, undefined, {
				kind: scheduleKindOf(capture.kind),
			});
			if (pauseArmed && capture.sequence === 2) {
				pausedLedgerPause();
			}
		},
	},
});
pauseHarness = paused;
const pausedLedgerPause = (): void => {
	paused.admission.pause(GOAL, "paused inside a provider barrier");
};
pauseArmed = true;
await paused.session.prompt("Pause halfway through the tool loop.");
const pausedAttempts = paused.faux.attemptCount();
const pausedDecision = paused.dagRuntime?.requestSchedule("execution");
paused.admission?.configure(PEER, 2);
const peerDecision = paused.admission?.schedule(PEER, "execution");
await paused.cleanup();

after(() => {
	budgetWorkspace.cleanup();
	gapWorkspace.cleanup();
	pauseWorkspace.cleanup();
});

test("allowance 3 admits exactly three goal-scheduled provider entries", () => {
	assert.equal(budgetScheduled, 3, "three reservations, and no fourth was ever made");
	assert.equal(budgetCharged, 3, "each reservation was charged by exactly one observed attempt");
	assert.equal(
		budgetAttempts,
		3,
		"there is no fourth goal-scheduled provider entry: the blocked tool call ends the loop",
	);
	assert.equal(budgetRemaining, 0);
});

test("a reload is not a refund: still no fourth goal-scheduled entry", () => {
	assert.equal(reloadRemaining, 0, "the spent allowance was restored, not reset");
	assert.equal(reloadScheduled, 3, "the three reservations from before the reload are still there");
	assert.equal(
		reloadAttempts,
		0,
		"the reloaded session refuses the turn at input, so nothing reaches the provider",
	);
});

test("a host-issued request is left uncharged and the gap is recorded", () => {
	assert.equal(gapBeforeCompaction, 0, "ordinary turns and continuations are all reserved first");
	assert.ok(
		gapAfterCompaction > gapBeforeCompaction,
		"compaction summaries reach the provider with no reservation and no way to deny them",
	);
	assert.ok(
		gapRemainingAfter >= 0 && gapRemainingAfter === gapRemainingBefore,
		"an uncharged host-issued attempt never moves the counter, least of all below zero",
	);
});

test("pausing inside a provider barrier prevents later scheduling", () => {
	assert.ok(pausedAttempts >= 2, "the attempt that was already in flight still completed");
	assert.ok(
		pausedAttempts < 8,
		"but the owner was paused mid-loop, so the allowance was not spent",
	);
	assert.equal(pausedDecision?.admitted, false);
	assert.equal(pausedDecision?.admitted === false && pausedDecision.reason, "paused");
});

test("peer work follows its own owner and is unaffected by the goal owner", () => {
	assert.equal(peerDecision.admitted, true);
});

test("the extension never claims it can deny a request the host issued", () => {
	// The recorded gap is the honest statement of the ceiling, in data.
	const gapDetails = paused.admission?.unchargedHostIssued.map((entry) => entry.detail);
	for (const detail of gapDetails) {
		assert.ok(detail.includes("cannot deny"));
	}
});

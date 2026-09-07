import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntime } from "../../src/extension/runtime.ts";
import { fakeExtensionApi } from "../support/fake-pi.ts";
import { makeTempDir } from "../support/tmp.ts";

/**
 * P04-owned-admission (unit boundary). TRUE ASSERTION.
 *
 * Schedule-refusal is genuinely enforceable, so this fixture keeps its full
 * force. One owner, one finite allowance, no refunds and no hidden retry
 * allowance: ordinary execution, review, summary, retry and recovery all draw
 * from the same budget.
 *
 * What is NOT asserted, because the host cannot deliver it: preventing a
 * provider request the host has already issued. Such a request is recorded as
 * an uncharged host-issued attempt. It never drives the counter negative, and
 * the gap is reported rather than absorbed.
 */

const GOAL = { kind: "goal" as const, id: "g1", stage: "build", generation: 1 };
const PEER = { kind: "peer" as const, id: "dag", stage: "build", generation: 1 };
const USER = { kind: "user" as const, id: "user", stage: "build", generation: 1 };

function ledger() {
	return createRuntime(fakeExtensionApi()).boundary?.admission;
}

test("the extension owns an owner-bound admission ledger", () => {
	const runtime = createRuntime(fakeExtensionApi());
	assert.equal(
		typeof runtime.boundary?.admission?.schedule,
		"function",
		"refusing to schedule goal-owned work is the enforceable half of admission",
	);
	assert.equal(typeof runtime.boundary?.admission?.observeTransportAttempt, "function");
});

test("every kind of goal work draws from the one owner budget", () => {
	const admission = ledger();
	admission?.configure(GOAL, 3);
	const kinds = ["execution", "review", "summary", "retry", "recovery"] as const;
	const decisions = kinds.map((kind) => admission?.schedule(GOAL, kind));
	assert.deepEqual(
		decisions.map((decision) => decision?.admitted),
		[true, true, true, false, false],
		"allowance 3 admits three requests whatever they are called",
	);
	const refused = decisions[3];
	assert.equal(refused?.admitted, false);
	assert.equal(refused?.admitted === false && refused.reason, "exhausted");
	assert.equal(admission?.remaining(GOAL), 0);
	assert.equal(
		admission?.scheduledFor(GOAL).length,
		3,
		"a retry is charged like anything else; there is no hidden retry allowance",
	);
});

test("transport attempts are recorded separately from logical requests", () => {
	const admission = ledger();
	admission?.configure(GOAL, 3);
	const first = admission?.schedule(GOAL, "execution");
	assert.equal(first?.admitted, true);
	if (!first.admitted) return;
	assert.equal(admission?.observeTransportAttempt("attempt-1", first.requestId), "charged");
	assert.equal(
		admission?.observeTransportAttempt("attempt-2", first.requestId),
		"additional_transport_attempt",
		"a transport-level retry of one logical request is not charged twice",
	);
	assert.equal(
		admission?.observeTransportAttempt("attempt-2", first.requestId),
		"duplicate_transport_attempt",
	);
	assert.equal(admission?.remaining(GOAL), 2);
	assert.deepEqual(admission?.transportAttemptsFor(first.requestId), ["attempt-1", "attempt-2"]);
});

test("a host-issued request is left uncharged and recorded, never negative", () => {
	const admission = ledger();
	admission?.configure(GOAL, 1);
	const only = admission?.schedule(GOAL, "execution");
	assert.equal(only?.admitted, true);
	assert.equal(admission?.observeTransportAttempt("attempt-1"), "charged");
	assert.equal(admission?.remaining(GOAL), 0);

	// The host issues a summarization request of its own. There is no channel
	// that could deny it, so it is observed, recorded, and not charged.
	assert.equal(
		admission?.observeTransportAttempt("attempt-2", undefined, { ownerKey: "goal:g1:build" }),
		"uncharged_host_issued",
	);
	assert.equal(admission?.remaining(GOAL), 0, "the counter is never driven negative");
	assert.equal(admission?.unchargedHostIssued.length, 1);
	assert.equal(admission?.unchargedHostIssued[0]?.attemptId, "attempt-2");
	assert.ok(admission?.unchargedHostIssued[0]?.detail.includes("cannot deny"));
});

test("pause prevents later scheduling and stale callbacks do not mutate", () => {
	const admission = ledger();
	admission?.configure(GOAL, 3);
	const first = admission?.schedule(GOAL, "execution");
	assert.equal(first?.admitted, true);
	if (!first.admitted) return;

	admission?.pause(GOAL, "paused inside a provider barrier");
	const during = admission?.schedule(GOAL, "execution");
	assert.equal(during?.admitted, false);
	assert.equal(during.admitted === false && during.reason, "paused");
	assert.equal(during.admitted === false && during.detail, "paused inside a provider barrier");

	// The generation moves on while an old callback is still in flight.
	admission?.advanceGeneration(GOAL);
	assert.equal(
		admission?.observeTransportAttempt("late-attempt", first.requestId),
		"stale_generation_ignored",
	);
	assert.deepEqual(
		admission?.transportAttemptsFor(first.requestId),
		[],
		"a callback that outlived its generation must not mutate the current one",
	);
	const stale = admission?.schedule(GOAL, "execution");
	assert.equal(stale?.admitted, false);
	assert.equal(stale.admitted === false && stale.reason, "stale_generation");

	admission?.resume({ ...GOAL });
	const resumed = admission?.schedule({ ...GOAL, generation: 2 }, "execution");
	assert.equal(resumed?.admitted, true);
});

test("peer and user work follow their own owner", () => {
	const admission = ledger();
	admission?.configure(GOAL, 1);
	admission?.configure(PEER, 2);
	admission?.configure(USER, 1);
	assert.equal(admission?.schedule(GOAL, "execution")?.admitted, true);
	assert.equal(admission?.schedule(GOAL, "execution")?.admitted, false);
	assert.equal(admission?.schedule(PEER, "execution")?.admitted, true);
	assert.equal(admission?.schedule(USER, "execution")?.admitted, true);
	assert.equal(admission?.remaining(PEER), 1);
	assert.equal(admission?.remaining(USER), 0);
});

test("a raised fence refuses goal work while peer and user owners are unaffected", () => {
	const runtime = createRuntime(fakeExtensionApi());
	const admission = runtime.boundary?.admission;
	admission?.configure(GOAL, 3);
	admission?.configure(USER, 3);
	runtime.boundary?.fence?.raise({
		reason: "append_failed",
		detail: "injected persist failure",
		sessionId: "s-1",
	});
	const refused = admission?.schedule(GOAL, "execution");
	assert.equal(refused?.admitted, false);
	assert.equal(refused.admitted === false && refused.reason, "fenced");
	assert.equal(admission?.schedule(USER, "execution")?.admitted, true);
});

test("exhaustion survives a reload; the budget is not handed back", () => {
	const tmp = makeTempDir("p04-unit-reload-");
	try {
		const first = createRuntime(fakeExtensionApi());
		assert.equal(
			typeof first.bindOwner,
			"function",
			"a session binds its goal-scheduled work to one owner with a finite allowance",
		);
		first.boundary?.bind(tmp.path);
		first.bindOwner(GOAL, 3);
		for (let index = 0; index < 3; index += 1) {
			assert.equal(first.requestSchedule("execution")?.admitted, true);
		}
		assert.equal(first.requestSchedule("execution")?.admitted, false);

		const reloaded = createRuntime(fakeExtensionApi());
		reloaded.boundary?.bind(tmp.path);
		reloaded.bindOwner(GOAL, 3);
		assert.equal(reloaded.boundary?.admission?.remaining(GOAL), 0);
		const after = reloaded.requestSchedule("execution");
		assert.equal(after?.admitted, false);
		assert.equal(after.admitted === false && after.reason, "exhausted");
	} finally {
		tmp.cleanup();
	}
});

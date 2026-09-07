import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntime } from "../../src/extension/runtime.ts";
import { fakeExtensionApi } from "../support/fake-pi.ts";
import { makeTempDir } from "../support/tmp.ts";

/**
 * P03-core-fence (unit boundary). CHARACTERISATION plus the extension fence.
 *
 * There is no core fence. Pi does not roll back a failed append, cannot deny a
 * provider request it has already issued, and reports no error at reload when
 * a hole in the parent chain silently truncates the branch. What this fixture
 * requires is an EXTENSION-LEVEL fence over that unfenced host: once the
 * extension has seen an append of its own go missing, it must refuse every one
 * of its own downstream paths, and it must keep refusing after a restart.
 *
 * Nothing here is a core guarantee, and the fence's own message says so.
 */

const RAISE = {
	reason: "append_failed" as const,
	detail: "injected persist failure",
	sessionId: "s-1",
	leafId: "e-9",
	entryId: "e-9",
};

test("the extension owns an uncertainty fence", () => {
	const runtime = createRuntime(fakeExtensionApi());
	assert.equal(
		typeof runtime.boundary?.fence?.raise,
		"function",
		"an extension over an unfenced host must own the fence itself",
	);
	assert.equal(runtime.boundary?.fence?.raised, false, "and must not be fenced by default");
});

test("the fence holds on every downstream path the extension owns", () => {
	const runtime = createRuntime(fakeExtensionApi());
	const fence = runtime.boundary?.fence;
	assert.equal(fence?.refuses("input"), false, "an unraised fence refuses nothing");

	fence?.raise(RAISE);
	const paths = [
		"input",
		"extension_append",
		"compaction:manual",
		"compaction:threshold",
		"compaction:overflow",
		"handoff_fallback",
		"context_rebuild",
		"reconcile_pending_after_restart",
	];
	for (const path of paths) {
		assert.equal(fence?.refuses(path), true, `the fence must hold on ${path}`);
	}
	assert.deepEqual(
		fence?.refusals.map((refusal) => refusal.path),
		paths,
		"every refusal is recorded, so coverage is evidence rather than assertion",
	);
});

test("the fence describes itself as an extension-level fence, not a core guarantee", () => {
	const runtime = createRuntime(fakeExtensionApi());
	runtime.boundary?.fence?.raise(RAISE);
	const message = runtime.boundary?.fence?.message();
	assert.ok(message.includes("extension-level fence over an unfenced host"));
	assert.ok(message.includes("not a core guarantee"));
});

test("the fence survives a restart because it is not stored in the session", () => {
	const tmp = makeTempDir("p03-unit-restart-");
	try {
		const first = createRuntime(fakeExtensionApi());
		assert.equal(typeof first.boundary?.bind, "function");
		first.boundary?.bind(tmp.path);
		first.boundary?.fence?.raise(RAISE);
		assert.equal(first.boundary?.fence?.raised, true);

		// A different process would build a different runtime over the same task
		// directory. The Pi session is the thing in doubt, so the fence is not
		// kept there.
		const second = createRuntime(fakeExtensionApi());
		assert.equal(second.boundary?.fence?.raised, false);
		second.boundary?.bind(tmp.path);
		assert.equal(
			second.boundary?.fence?.raised,
			true,
			"a fence raised in a previous process must outlive it",
		);
		assert.equal(second.boundary?.fence?.reason, "append_failed");
		assert.equal(second.boundary?.fence?.current?.entryId, "e-9");
	} finally {
		tmp.cleanup();
	}
});

test("only a deliberate repair clears the fence", () => {
	const tmp = makeTempDir("p03-unit-clear-");
	try {
		const runtime = createRuntime(fakeExtensionApi());
		assert.equal(typeof runtime.boundary?.bind, "function");
		runtime.boundary?.bind(tmp.path);
		runtime.boundary?.fence?.raise(RAISE);
		runtime.boundary?.fence?.raise({ ...RAISE, reason: "manual", detail: "later" });
		assert.equal(
			runtime.boundary?.fence?.reason,
			"append_failed",
			"the first reason is kept; a later raise never overwrites the diagnosis",
		);
		runtime.boundary?.fence?.clear();
		assert.equal(runtime.boundary?.fence?.raised, false);
		const reopened = createRuntime(fakeExtensionApi());
		reopened.boundary.bind(tmp.path);
		assert.equal(reopened.boundary.fence?.raised, false, "the repair outlives the process too");
	} finally {
		tmp.cleanup();
	}
});

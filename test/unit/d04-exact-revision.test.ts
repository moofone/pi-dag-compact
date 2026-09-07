/**
 * D04 — every revision reconstructs exactly, from one row.
 *
 * Under D1 there is one full immutable snapshot per revision and checkpoint
 * identity equals revision identity. So revision 2 is no less a checkpoint than
 * revision 1: it reconstructs to the same state and stays handoff-eligible
 * across a restart, and so does revision 40 of a long chain, an imported chain
 * and a fork point.
 *
 * The reviewed hash is recomputed from the snapshot that was actually loaded.
 * A stored hash column proves nothing about the bytes beside it; D05 covers the
 * case where they disagree.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalSnapshot, sha256 } from "../../src/memory/canonical.ts";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { assertHandoffEligible, formatHandoffCard } from "../../src/memory/handoff.ts";
import type { PiRefData } from "../../src/schema/working.ts";
import { branchAt, seedBatch } from "../support/d0x-fixtures.ts";
import { makeTempDir } from "../support/tmp.ts";

type Ref = { customType: string; data: PiRefData };

function ref(data: PiRefData): Ref {
	return { customType: "dag_checkpoint_ref", data };
}

function step(index: number) {
	return {
		operationId: `d04-step-${index}`,
		upsertNodes: [
			{
				id: `t-${index}`,
				kind: "task" as const,
				title: `step ${index}`,
				body: "",
				status: "open" as const,
			},
		],
	};
}

function loadedHash(engine: MemoryEngine): string {
	const snap = engine.snapshot();
	return sha256(canonicalSnapshot(snap.nodes, snap.edges));
}

test("D04 revision 2 reconstructs and stays handoff-eligible across a restart", () => {
	const tmp = makeTempDir("pi-dag-d04-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s1");
		const first = engine.update(seedBatch("d04-1"), branchAt());
		engine.acknowledgeRef(first.operationId, "entry-1");
		const second = engine.update(step(2), branchAt());
		engine.acknowledgeRef(second.operationId, "entry-2");

		assert.equal(
			engine.snapshot().revisionId,
			second.revisionId,
			"sanity: revision 2 is the published revision",
		);
		const cardBefore = assertHandoffEligible(engine).text;
		const hashBefore = loadedHash(engine);
		assert.equal(
			engine.snapshot().checkpointId,
			second.revisionId,
			"every revision is its own checkpoint",
		);
		engine.close();

		const restarted = MemoryEngine.open(tmp.path, "s1");
		restarted.reconstruct([ref(first.piRef), ref(second.piRef)]);
		assert.equal(restarted.snapshot().revisionId, second.revisionId);
		assert.equal(
			restarted.snapshot().checkpointId,
			second.revisionId,
			"the checkpoint identity survives the restart",
		);
		assert.equal(
			loadedHash(restarted),
			hashBefore,
			"the hash recomputed from the loaded snapshot is identical after restart",
		);
		assert.equal(
			assertHandoffEligible(restarted).text,
			cardBefore,
			"handoff eligibility and the rendered card are identical before and after restart",
		);
		restarted.close();
	} finally {
		tmp.cleanup();
	}
});

test("D04 the first revision is its own checkpoint", () => {
	const tmp = makeTempDir("pi-dag-d04-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s1");
		const first = engine.update(seedBatch("d04-1"), branchAt());
		engine.acknowledgeRef(first.operationId, "entry-1");
		assert.equal(first.checkpointId, first.revisionId);
		assert.equal(engine.snapshot().checkpointId, first.revisionId);
		assert.equal(
			first.piRef.checkpointId,
			first.revisionId,
			"the Pi reference carries the same identity for both",
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("D04 a long chain reconstructs exactly at any selected revision", () => {
	const tmp = makeTempDir("pi-dag-d04-");
	try {
		const engine = MemoryEngine.open(tmp.path, "s1");
		const refs: Ref[] = [];
		const first = engine.update(seedBatch("d04-1"), branchAt());
		engine.acknowledgeRef(first.operationId, "entry-1");
		refs.push(ref(first.piRef));
		const hashes: Array<{ revisionId: string; hash: string; card: string }> = [
			{
				revisionId: first.revisionId,
				hash: loadedHash(engine),
				card: formatHandoffCard(engine).text,
			},
		];
		for (let index = 2; index <= 40; index += 1) {
			const commit = engine.update(step(index), branchAt("s1", `leaf-${index}`));
			engine.acknowledgeRef(commit.operationId, `entry-${index}`);
			refs.push(ref(commit.piRef));
			hashes.push({
				revisionId: commit.revisionId,
				hash: loadedHash(engine),
				card: formatHandoffCard(engine).text,
			});
		}
		assert.equal(hashes.length, 40, "sanity: a 40-revision chain was built");
		engine.close();

		for (const index of [0, 1, 19, 31, 32, 39]) {
			const expected = hashes[index];
			assert.ok(expected, "sanity: the expected revision exists");
			const restarted = MemoryEngine.open(tmp.path, "s1");
			restarted.reconstruct(refs.slice(0, index + 1));
			assert.equal(
				restarted.snapshot().revisionId,
				expected.revisionId,
				`revision ${index + 1} is selected by its own pointer`,
			);
			assert.equal(
				restarted.snapshot().checkpointId,
				expected.revisionId,
				`revision ${index + 1} is its own checkpoint`,
			);
			assert.equal(
				loadedHash(restarted),
				expected.hash,
				`revision ${index + 1} reconstructs exactly`,
			);
			assert.equal(
				assertHandoffEligible(restarted).text,
				expected.card,
				`revision ${index + 1} is handoff-eligible with an identical card`,
			);
			restarted.close();
		}
	} finally {
		tmp.cleanup();
	}
});

test("D04 an imported chain and a fork point reconstruct exactly", () => {
	const tmp = makeTempDir("pi-dag-d04-");
	try {
		const origin = MemoryEngine.open(tmp.path, "origin");
		const first = origin.update(seedBatch("d04-1"), branchAt("origin", "leaf-1"));
		origin.acknowledgeRef(first.operationId, "e1");
		const second = origin.update(step(2), branchAt("origin", "leaf-2"));
		origin.acknowledgeRef(second.operationId, "e2");
		const third = origin.update(step(3), branchAt("origin", "leaf-3"));
		origin.acknowledgeRef(third.operationId, "e3");
		const forkPointHash = (() => {
			const probe = MemoryEngine.open(tmp.path, "origin");
			probe.reconstruct([ref(first.piRef), ref(second.piRef)]);
			const hash = loadedHash(probe);
			probe.close();
			return hash;
		})();
		origin.release();

		// An imported chain: the fork copies the whole reference chain.
		const imported = MemoryEngine.open(tmp.path, "fork");
		imported.reconstruct([ref(first.piRef), ref(second.piRef), ref(third.piRef)]);
		assert.equal(imported.snapshot().revisionId, third.revisionId);
		assert.equal(imported.snapshot().checkpointId, third.revisionId);
		assert.equal(assertHandoffEligible(imported).text.length > 0, true);
		imported.release();

		// A fork point: the fork copies the chain only as far as revision 2.
		const forked = MemoryEngine.open(tmp.path, "fork2");
		forked.reconstruct([ref(first.piRef), ref(second.piRef)]);
		assert.equal(forked.snapshot().revisionId, second.revisionId);
		assert.equal(loadedHash(forked), forkPointHash, "the fork point reconstructs exactly");
		forked.attachFork("origin", second.revisionId);
		const diverged = forked.update(step(99), branchAt("fork2", "leaf-f"));
		assert.equal(
			forked.revisionMeta(diverged.revisionId)?.parentRevisionId,
			second.revisionId,
			"the fork's first update takes the inherited revision as its parent",
		);
		forked.acknowledgeRef(diverged.operationId, "ef");
		assert.equal(forked.snapshot().checkpointId, diverged.revisionId);
		forked.release();
	} finally {
		tmp.cleanup();
	}
});

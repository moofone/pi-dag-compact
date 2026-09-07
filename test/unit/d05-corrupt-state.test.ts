/**
 * D05 — corruption is reported, not absorbed.
 *
 * A stored hash column is not evidence about the bytes beside it, so every load
 * recomputes the snapshot and selection hashes from the JSON it actually read
 * and revalidates the schema and the whole `depends_on` subgraph. Altered JSON
 * under an intact hash column, a missing revision, a broken parent link, a
 * dependency cycle and a schema error all have to be reported.
 *
 * And an older revision may not quietly stand in for a newer one: if the
 * selected suffix is gone, reconstruction says which revisions it lost and
 * refuses reduced context rather than presenting stale coverage as current.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { collectPiRefsFromEntries } from "../../src/extension/session.ts";
import { canonicalSnapshot, sha256 } from "../../src/memory/canonical.ts";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { assertHandoffEligible } from "../../src/memory/handoff.ts";
import type { PiRefData, WorkingEdge, WorkingNode } from "../../src/schema/working.ts";
import { branchAt, openStoreDirect, seedBatch } from "../support/d0x-fixtures.ts";
import { makeTempDir } from "../support/tmp.ts";

type Ref = { customType: string; data: PiRefData };

function ref(data: PiRefData): Ref {
	return { customType: "dag_checkpoint_ref", data };
}

interface Built {
	dir: string;
	cleanup: () => void;
	baseRef: Ref;
	headRef: Ref;
	baseRevisionId: string;
	headRevisionId: string;
}

function bothRefs(built: Built): Ref[] {
	return [built.baseRef, built.headRef];
}

/** Two acknowledged revisions on one branch, then the engine is closed. */
function build(): Built {
	const tmp = makeTempDir("pi-dag-d05-");
	const engine = MemoryEngine.open(tmp.path, "s1");
	const first = engine.update(seedBatch("d05-1"), branchAt());
	engine.acknowledgeRef(first.operationId, "entry-1");
	const second = engine.update(
		{
			operationId: "d05-2",
			upsertNodes: [{ id: "dep", kind: "task", title: "dependent work", body: "", status: "open" }],
			addEdges: [{ from: "dep", to: "next-a", kind: "depends_on" }],
		},
		branchAt(),
	);
	engine.acknowledgeRef(second.operationId, "entry-2");
	engine.close();
	return {
		dir: tmp.path,
		cleanup: tmp.cleanup,
		baseRef: ref(first.piRef),
		headRef: ref(second.piRef),
		baseRevisionId: first.revisionId,
		headRevisionId: second.revisionId,
	};
}

function tamper(dir: string, fn: (db: ReturnType<typeof openStoreDirect>) => void): void {
	const db = openStoreDirect(dir);
	try {
		fn(db);
	} finally {
		db.close();
	}
}

function expectCorrupt(built: Built, message: string, refs: Ref[] = bothRefs(built)): DagError {
	const engine = MemoryEngine.open(built.dir, "s1");
	try {
		let caught: unknown;
		try {
			engine.reconstruct(refs);
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof DagError, message);
		assert.equal(
			engine.snapshot().revisionId,
			null,
			"a corrupt load publishes nothing; it does not silently fall back",
		);
		assert.throws(
			() => assertHandoffEligible(engine),
			(error: unknown) => error instanceof DagError,
			"reduced context is forbidden while reconstruction is reporting corruption",
		);
		return caught as DagError;
	} finally {
		engine.close();
	}
}

test("D05 altered snapshot JSON under an intact hash column is reported", () => {
	const built = build();
	try {
		tamper(built.dir, (db) => {
			const row = db
				.prepare("SELECT nodes_json FROM revisions WHERE revision_id = ?")
				.get(built.headRevisionId) as { nodes_json: string };
			const nodes = JSON.parse(row.nodes_json) as WorkingNode[];
			const target = nodes.find((node) => node.id === "ceiling");
			assert.ok(target, "sanity: the record about to be altered exists in stored state");
			target.title = "smem <= 96%";
			const changed = db
				.prepare("UPDATE revisions SET nodes_json = ? WHERE revision_id = ?")
				.run(JSON.stringify(nodes), built.headRevisionId);
			assert.equal(Number(changed.changes), 1, "sanity: stored state really was altered");
		});
		const error = expectCorrupt(built, "altered JSON under an intact hash column must be reported");
		assert.match(error.code, /corrupt/);
	} finally {
		built.cleanup();
	}
});

test("D05 a missing selected revision is reported", () => {
	const built = build();
	try {
		tamper(built.dir, (db) => {
			const removed = db
				.prepare("DELETE FROM revisions WHERE revision_id = ?")
				.run(built.headRevisionId);
			assert.equal(Number(removed.changes), 1, "sanity: the selected revision really was removed");
		});
		expectCorrupt(built, "a reference with no revision row must be reported");
	} finally {
		built.cleanup();
	}
});

test("D05 a broken parent link is reported", () => {
	const built = build();
	try {
		tamper(built.dir, (db) => {
			const changed = db
				.prepare("UPDATE revisions SET parent_revision_id = ? WHERE revision_id = ?")
				.run("rev_does_not_exist", built.headRevisionId);
			assert.equal(Number(changed.changes), 1, "sanity: the parent link really was broken");
		});
		expectCorrupt(built, "a parent link pointing at nothing must be reported");
	} finally {
		built.cleanup();
	}
});

/**
 * Rewrite the selected revision's stored graph and bring the stored hash column
 * *and* the branch reference along with it, so a hash comparison alone cannot
 * detect the change. Only schema and dependency validation of the loaded
 * snapshot can.
 */
function rewriteConsistently(
	built: Built,
	mutate: (state: { nodes: WorkingNode[]; edges: WorkingEdge[] }) => void,
): Ref[] {
	let hash = "";
	tamper(built.dir, (db) => {
		const row = db
			.prepare("SELECT nodes_json, edges_json FROM revisions WHERE revision_id = ?")
			.get(built.headRevisionId) as { nodes_json: string; edges_json: string };
		const state = {
			nodes: JSON.parse(row.nodes_json) as WorkingNode[],
			edges: JSON.parse(row.edges_json) as WorkingEdge[],
		};
		mutate(state);
		hash = sha256(canonicalSnapshot(state.nodes, state.edges));
		const changed = db
			.prepare(
				"UPDATE revisions SET nodes_json = ?, edges_json = ?, payload_hash = ? WHERE revision_id = ?",
			)
			.run(JSON.stringify(state.nodes), JSON.stringify(state.edges), hash, built.headRevisionId);
		assert.equal(Number(changed.changes), 1, "sanity: stored state really was rewritten");
	});
	return [built.baseRef, { ...built.headRef, data: { ...built.headRef.data, payloadHash: hash } }];
}

test("D05 a dependency cycle in stored state is reported even when every hash agrees", () => {
	const built = build();
	try {
		const refs = rewriteConsistently(built, (state) => {
			state.edges.push({ from: "next-a", to: "dep", kind: "depends_on" });
		});
		expectCorrupt(built, "a dependency cycle in stored state must be reported", refs);
	} finally {
		built.cleanup();
	}
});

test("D05 a schema error in stored state is reported even when every hash agrees", () => {
	const built = build();
	try {
		const refs = rewriteConsistently(built, (state) => {
			const target = state.nodes.find((node) => node.id === "goal") as unknown as
				| Record<string, unknown>
				| undefined;
			assert.ok(target, "sanity: the record about to be corrupted exists");
			target.kind = "not-a-kind";
		});
		expectCorrupt(built, "a schema error in stored state must be reported", refs);
	} finally {
		built.cleanup();
	}
});

test("D05 a failed reload does not leave stale state standing in for the lost revision", () => {
	const built = build();
	try {
		const engine = MemoryEngine.open(built.dir, "s1");
		try {
			engine.reconstruct(bothRefs(built));
			assert.equal(
				engine.snapshot().revisionId,
				built.headRevisionId,
				"sanity: the selected revision loaded before anything was destroyed",
			);

			// The selected revision is destroyed under a branch that still points at
			// it. Reloading must report that, and must not carry on presenting the
			// state it happens to still hold in memory as current coverage.
			tamper(built.dir, (db) => {
				const removed = db
					.prepare("DELETE FROM revisions WHERE revision_id = ?")
					.run(built.headRevisionId);
				assert.equal(Number(removed.changes), 1, "sanity: the revision really was destroyed");
			});
			assert.throws(
				() => engine.reconstruct(bothRefs(built)),
				(error: unknown) => error instanceof DagError,
				"a lost selected revision must be reported",
			);
			assert.equal(
				engine.snapshot().revisionId,
				null,
				"a failed reload publishes nothing; older or stale state may not claim the lost coverage",
			);
			assert.throws(
				() => assertHandoffEligible(engine),
				(error: unknown) => error instanceof DagError,
				"reduced context is forbidden after a failed reload",
			);
		} finally {
			engine.close();
		}
	} finally {
		built.cleanup();
	}
});

test("D05 a reference the branch still carries but cannot be read is not silently dropped", () => {
	const built = build();
	try {
		const entries = [
			{
				id: "e1",
				type: "custom",
				customType: "dag_checkpoint_ref",
				data: built.baseRef.data,
			},
			// The head reference survived as an entry but its payload is truncated:
			// unreadable, not absent.
			{ id: "e2", type: "custom", customType: "dag_checkpoint_ref", data: { v: 1, taskId: "t" } },
		];
		const refs = collectPiRefsFromEntries(entries as unknown as SessionEntry[]);
		const engine = MemoryEngine.open(built.dir, "s1");
		try {
			assert.throws(
				() => engine.reconstruct(refs),
				(error: unknown) => error instanceof DagError,
				"an unreadable reference on the branch must be reported",
			);
			assert.equal(
				engine.snapshot().revisionId,
				null,
				"the readable older reference may not stand in for the unreadable newer one",
			);
		} finally {
			engine.close();
		}
	} finally {
		built.cleanup();
	}
});

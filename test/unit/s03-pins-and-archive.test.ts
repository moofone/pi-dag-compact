import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { DagError } from "../../src/memory/errors.ts";
import { makeTempDir } from "../support/tmp.ts";

const BRANCH = { sessionId: "s", leafId: "leaf-1" };

function emptySelection() {
	return {
		goalBinding: null,
		objectiveId: "",
		constraintIds: [],
		acceptedBaselineRecordId: null,
		bestObservedRecordId: null,
		bestValidatedRecordId: null,
		currentWorkIds: [],
		unresolvedIds: [],
		nextActionIds: [],
		rejectedApproachIds: [],
		pinnedIds: [],
	};
}

function seedPinned(dir: string): MemoryEngine {
	const engine = MemoryEngine.open(dir, "s");
	engine.update(
		{
			operationId: "seed",
			upsertNodes: [
				{ id: "goal", kind: "goal", title: "minimize pipeline p50", body: "", status: "open" },
				{ id: "ceiling", kind: "constraint", title: "smem <= 64%", body: "", status: "open" },
				{
					id: "baseline",
					kind: "decision",
					title: "schedule variant kept",
					body: "run-schedule-W1",
					status: "done",
				},
				{
					id: "experiment",
					kind: "task",
					title: "current experiment E",
					body: "",
					status: "open",
				},
				{ id: "next", kind: "task", title: "run the sweep", body: "", status: "open" },
				{
					id: "rej",
					kind: "hypothesis",
					title: "fusion A",
					body: "pipeline regression at 4096",
					status: "rejected",
					evidence: [{ kind: "artifact", path: "runs/run-fusion-W1/result.json" }],
				},
			],
			setSelection: {
				...emptySelection(),
				objectiveId: "goal",
				constraintIds: ["ceiling"],
				acceptedBaselineRecordId: "baseline",
				currentWorkIds: ["experiment"],
				nextActionIds: ["next"],
				rejectedApproachIds: ["rej"],
			},
		},
		BRANCH,
	);
	return engine;
}

test("S03 archiving any pinned selection member is refused", () => {
	for (const pinned of ["goal", "ceiling", "baseline", "experiment", "next", "rej"]) {
		const tmp = makeTempDir("pi-dag-s03-");
		try {
			const engine = seedPinned(tmp.path);
			const before = engine.snapshot().revisionId;
			assert.throws(
				() => engine.update({ operationId: `arch-${pinned}`, archiveIds: [pinned] }, BRANCH),
				(error: unknown) =>
					error instanceof DagError &&
					(error.code === "pinned_node" || error.code === "nonterminal_node"),
				`archiving ${pinned} must be refused`,
			);
			assert.equal(engine.snapshot().revisionId, before);
			assert.equal(
				engine.snapshot().nodes.some((item) => item.id === pinned),
				true,
			);
			engine.close();
		} finally {
			tmp.cleanup();
		}
	}
});

test("S03 archiving nonterminal work is refused even when it is not selected", () => {
	const tmp = makeTempDir("pi-dag-s03-");
	try {
		const engine = seedPinned(tmp.path);
		engine.update(
			{
				operationId: "add-loose",
				upsertNodes: [
					{ id: "loose", kind: "hypothesis", title: "loose idea", body: "", status: "open" },
					{ id: "wedged", kind: "task", title: "wedged work", body: "", status: "blocked" },
				],
			},
			BRANCH,
		);
		for (const id of ["loose", "wedged"]) {
			assert.throws(
				() => engine.update({ operationId: `arch-${id}`, archiveIds: [id] }, BRANCH),
				(error: unknown) => error instanceof DagError && error.code === "nonterminal_node",
				`archiving nonterminal ${id} must be refused`,
			);
		}
		engine.update(
			{
				operationId: "resolve-then-archive",
				setStatus: [
					{ id: "loose", status: "stale" },
					{ id: "wedged", status: "rejected" },
				],
				archiveIds: ["loose", "wedged"],
			},
			BRANCH,
		);
		assert.equal(
			engine.snapshot().nodes.some((item) => item.id === "loose" || item.id === "wedged"),
			false,
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S03 archiving a prerequisite still required by open work is refused, not silently unlinked", () => {
	const tmp = makeTempDir("pi-dag-s03-");
	try {
		const engine = seedPinned(tmp.path);
		engine.update(
			{
				operationId: "dep",
				upsertNodes: [
					{ id: "prereq", kind: "task", title: "harness ready", body: "", status: "done" },
				],
				addEdges: [{ from: "experiment", to: "prereq", kind: "depends_on" }],
			},
			BRANCH,
		);
		assert.throws(
			() => engine.update({ operationId: "arch-prereq", archiveIds: ["prereq"] }, BRANCH),
			(error: unknown) => error instanceof DagError && error.code === "unresolved_dependency",
		);
		assert.equal(
			engine.snapshot().edges.some((edge) => edge.to === "prereq" && edge.kind === "depends_on"),
			true,
		);

		engine.update(
			{
				operationId: "arch-prereq-resolved",
				removeEdges: [{ from: "experiment", to: "prereq", kind: "depends_on" }],
				archiveIds: ["prereq"],
			},
			BRANCH,
		);
		assert.equal(
			engine.snapshot().nodes.some((item) => item.id === "prereq"),
			false,
		);
		assert.equal(engine.archivedSearch("harness ready", 8)[0]?.id, "prereq");
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

test("S03 more than 200 historical nodes archive while selected rejections and evidence survive", () => {
	const tmp = makeTempDir("pi-dag-s03-");
	try {
		const engine = seedPinned(tmp.path);
		let archived = 0;
		for (let wave = 0; wave < 12; wave += 1) {
			const ids = Array.from({ length: 20 }, (_, index) => `h-${wave}-${index}`);
			engine.update(
				{
					operationId: `wave-${wave}`,
					upsertNodes: ids.map((id) => ({
						id,
						kind: "hypothesis" as const,
						title: `historical ${id}`,
						body: "measured then discarded",
						status: "rejected" as const,
						evidence: [{ kind: "artifact" as const, path: `runs/${id}/result.json` }],
					})),
				},
				BRANCH,
			);
			engine.update({ operationId: `wave-arch-${wave}`, archiveIds: ids }, BRANCH);
			archived += ids.length;
		}
		assert.equal(archived > 200, true);
		assert.equal(engine.snapshot().nodes.length <= 200, true);

		const sample = engine.archivedSearch("historical h-0-0", 8)[0];
		assert.equal(sample?.id, "h-0-0");
		assert.equal(sample?.body, "measured then discarded");
		assert.equal(sample?.evidence[0]?.kind, "artifact");

		assert.throws(
			() => engine.update({ operationId: "arch-selected-rej", archiveIds: ["rej"] }, BRANCH),
			(error: unknown) => error instanceof DagError && error.code === "pinned_node",
		);
		assert.equal(
			engine.snapshot().nodes.find((item) => item.id === "rej")?.body,
			"pipeline regression at 4096",
		);
		engine.close();
	} finally {
		tmp.cleanup();
	}
});

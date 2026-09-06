import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { listRunIds, readInvocations, runBench } from "../../src/eval/experiment-runner.ts";
import { loadOracle } from "../../src/eval/load.ts";
import { notesAfterTurn } from "../../src/eval/notes.ts";
import { scoreExpectedState } from "../../src/eval/oracle.ts";
import { workspaceSnapshot } from "../../src/eval/paths.ts";
import { makeTempDir } from "../support/tmp.ts";

test("bench.mjs is deterministic and records invocations", () => {
	const tmp = makeTempDir("pi-dag-bench-");
	try {
		cpSync(workspaceSnapshot(), tmp.path, { recursive: true });
		const first = runBench(tmp.path, "A", "W1");
		const second = runBench(tmp.path, "A", "W1");
		assert.equal(JSON.parse(first).runId, "run-A-W1");
		assert.equal(JSON.parse(second).runId, "run-A-W1");
		assert.deepEqual(listRunIds(tmp.path), ["run-A-W1"]);
		assert.equal(readInvocations(tmp.path).length, 2);
		assert.equal(JSON.parse(first).correctness, "pass");
	} finally {
		tmp.cleanup();
	}
});

test("bench.mjs refuses unknown candidates and does not talk to a GPU", () => {
	const tmp = makeTempDir("pi-dag-bench-");
	try {
		cpSync(workspaceSnapshot(), tmp.path, { recursive: true });
		assert.throws(() => runBench(tmp.path, "nope", "W1"), /unknown candidate/);
	} finally {
		tmp.cleanup();
	}
});

test("oracle detects a false promotion of candidate B", () => {
	const tmp = makeTempDir("pi-dag-oracle-");
	try {
		cpSync(workspaceSnapshot(), tmp.path, { recursive: true });
		for (const candidate of ["baseline", "A", "B", "C"]) {
			runBench(tmp.path, candidate, "W1");
		}
		mkdirSync(join(tmp.path, "notes"), { recursive: true });
		const notes = notesAfterTurn(8);
		notes.acceptedBaselineId = "B";
		notes.acceptedBaselineRunId = "run-B-W1";
		writeFileSync(join(tmp.path, "notes", "state.json"), `${JSON.stringify(notes, null, "\t")}\n`);
		const expected = loadOracle().states.find((state) => state.afterTurn === 8);
		assert.ok(expected);
		const score = scoreExpectedState(tmp.path, expected);
		assert.equal(score.falsePromotions >= 1, true);
	} finally {
		tmp.cleanup();
	}
});

test("oracle accepts the scripted turn-8 notes", () => {
	const tmp = makeTempDir("pi-dag-oracle-");
	try {
		cpSync(workspaceSnapshot(), tmp.path, { recursive: true });
		for (const candidate of ["baseline", "A", "B", "C"]) {
			runBench(tmp.path, candidate, "W1");
		}
		mkdirSync(join(tmp.path, "notes"), { recursive: true });
		writeFileSync(
			join(tmp.path, "notes", "state.json"),
			`${JSON.stringify(notesAfterTurn(8), null, "\t")}\n`,
		);
		const expected = loadOracle().states.find((state) => state.afterTurn === 8);
		assert.ok(expected);
		const score = scoreExpectedState(tmp.path, expected);
		assert.deepEqual(score, {
			constraintErrors: 0,
			falsePromotions: 0,
			unjustifiedReruns: 0,
			evidenceErrors: 0,
			details: [],
		});
	} finally {
		tmp.cleanup();
	}
});

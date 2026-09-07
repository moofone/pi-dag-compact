import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runClassicScenario } from "../../src/eval/controller.ts";
import { createClassicHarness } from "../../src/eval/harness.ts";
import { loadEvalConfig } from "../../src/eval/load.ts";
import { createIsolatedWorkspace } from "../../src/eval/workspace.ts";
import { HandoffController } from "../../src/extension/handoff.ts";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { formatHandoffCard } from "../../src/memory/handoff.ts";

test("DAG plumbing arm completes three real handoff cuts", async () => {
	const result = await runClassicScenario({ arm: "dag", keepWorkspace: true });
	try {
		assert.equal(result.totals.arm, "dag");
		assert.equal(result.totals.actualCuts, 3);
		assert.equal(result.totals.fallbacks, 0);
		assert.equal(result.score.constraintErrors, 0);
		assert.equal(result.score.falsePromotions, 0);
		assert.equal(
			result.cuts.every((cut) => !cut.noop),
			true,
		);
		assert.equal(
			result.cuts.every((cut) => cut.rawDroppedTurnHeadersAbsentFromNextRequest),
			true,
		);
		assert.deepEqual(
			result.cuts.map((cut) => cut.afterTurn),
			[4, 8, 12],
		);
	} finally {
		const isolatedRoot = result.workspaceCwd.replace(/[/\\]workspace$/, "");
		rmSync(isolatedRoot, { recursive: true, force: true });
		rmSync(result.outDir, { recursive: true, force: true });
	}
});

test("a correction after review falls back to classic and keeps the correction", async () => {
	const workspace = createIsolatedWorkspace();
	const config = loadEvalConfig();
	const dag = {
		engine: undefined as MemoryEngine | undefined,
		handoff: new HandoffController(),
	};
	const harness = await createClassicHarness(workspace, config, {
		extraExtensions: [
			(pi) => {
				pi.on("session_before_compact", async (event, ctx) => {
					if (!dag.engine) return;
					const card = formatHandoffCard(dag.engine);
					return dag.handoff.onBeforeCompact(
						event,
						{
							sessionId: ctx.sessionManager.getSessionId(),
							leafId: ctx.sessionManager.getLeafId() ?? "none",
							revisionId: dag.engine.snapshot().revisionId,
						},
						card.text,
					);
				});
			},
		],
	});
	try {
		dag.engine = MemoryEngine.open(
			join(workspace.cwd, "task"),
			harness.sessionManager.getSessionId(),
		);
		await harness.session.prompt(`# Scenario turn 1\nsetup\n${"alpha ".repeat(2000)}`);
		await harness.session.prompt(`# Scenario turn 2\nmore\n${"beta ".repeat(2000)}`);
		dag.engine.update(
			{
				operationId: "h1",
				upsertNodes: [
					{ id: "goal", kind: "goal", title: "pipeline p50", body: "", status: "open" },
					{ id: "ceiling", kind: "constraint", title: "smem 80", body: "", status: "open" },
					{
						id: "baseline",
						kind: "decision",
						title: "accepted baseline X",
						body: "",
						status: "done",
					},
					{ id: "next", kind: "task", title: "continue", body: "", status: "open" },
				],
			},
			{
				sessionId: harness.sessionManager.getSessionId(),
				leafId: harness.sessionManager.getLeafId() ?? "none",
			},
		);
		const review = dag.handoff.prepare(dag.engine, {
			sessionId: harness.sessionManager.getSessionId(),
			leafId: harness.sessionManager.getLeafId() ?? "none",
		});
		dag.handoff.arm(review);
		await harness.session.prompt("# Scenario turn 5\nTighten the ceiling to 64%.");
		await harness.session.compact();
		const text = JSON.stringify(harness.session.messages);
		assert.equal(text.includes("Tighten the ceiling to 64%"), true);
		assert.equal(dag.handoff.fallbacks >= 1, true);
	} finally {
		await harness.cleanup();
		dag.engine?.close();
		workspace.cleanup();
	}
});

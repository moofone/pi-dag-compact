import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendPiRef, collectPiRefs } from "../../src/extension/session.ts";
import { MemoryEngine } from "../../src/memory/engine.ts";
import { dagStatus } from "../../src/memory/query.ts";
import { makeTempDir } from "../support/tmp.ts";

test("file-backed session restart restores the working set from Pi refs", () => {
	const tmp = makeTempDir("pi-dag-record-");
	try {
		const taskDir = join(tmp.path, "task");
		const session = SessionManager.inMemory(tmp.path);
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "start" }],
			timestamp: Date.now(),
		});
		const engine = MemoryEngine.open(taskDir, session.getSessionId());
		const commit = engine.update(
			{
				operationId: "restart-op",
				upsertNodes: [
					{ id: "goal", kind: "goal", title: "pipeline p50", body: "", status: "open" },
					{ id: "ceiling", kind: "constraint", title: "smem 64", body: "", status: "open" },
					{
						id: "baseline",
						kind: "decision",
						title: "accepted baseline C",
						body: "",
						status: "done",
					},
					{
						id: "A",
						kind: "hypothesis",
						title: "A",
						body: "pipeline_regression",
						status: "rejected",
					},
					{ id: "next", kind: "task", title: "run E", body: "", status: "open" },
				],
			},
			{ sessionId: session.getSessionId(), leafId: session.getLeafId() ?? "none" },
		);
		const entryId = appendPiRef(session, commit.piRef, Boolean(commit.checkpointId));
		engine.acknowledgeRef(commit.operationId, entryId);
		const refs = collectPiRefs(session);
		assert.equal(refs.length > 0, true);
		const sessionId = session.getSessionId();
		engine.close();

		const restored = MemoryEngine.open(taskDir, sessionId);
		restored.reconstruct(refs);
		const status = dagStatus(restored);
		assert.equal(status.acceptedBaseline[0]?.id, "baseline");
		assert.equal(status.constraints[0]?.id, "ceiling");
		assert.equal(status.rejected[0]?.id, "A");
		assert.equal(status.nextAction[0]?.id, "next");
		restored.close();
	} finally {
		tmp.cleanup();
	}
});

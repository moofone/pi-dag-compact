import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { isCompactionPrompt } from "./faux-agent.ts";

export function createMaintenanceFactory(options: {
	operationPrefix: string;
}): (context: Context) => AssistantMessage {
	let calls = 0;
	return (context) => {
		if (isCompactionPrompt(context)) {
			return fauxAssistantMessage("Stress/pilot checkpoint summary. Not a CUDA result.");
		}
		calls += 1;
		const pendingTools = context.messages.filter((message) => message.role === "toolResult").length;
		const userCount = context.messages.filter((message) => message.role === "user").length;
		if (pendingTools < userCount) {
			const op = `${options.operationPrefix}-${calls}`;
			return fauxAssistantMessage(
				[
					fauxToolCall("dag_update", {
						operationId: op,
						upsertNodes: [
							{
								id: "goal",
								kind: "goal",
								title: "minimize pipeline p50 for W1",
								body: "pipeline_p50_ms",
								status: "open",
							},
							{
								id: "ceiling",
								kind: "constraint",
								title: "smem <= 64%",
								body: "resource ceiling",
								status: "open",
							},
							{
								id: "baseline",
								kind: "decision",
								title: "accepted baseline C",
								body: "run-schedule-W1",
								status: "done",
							},
							{
								id: "next",
								kind: "task",
								title: "continue search",
								body: "",
								status: "open",
							},
							{
								id: `h-${op}`,
								kind: "hypothesis",
								title: `trial ${op}`,
								body: "synthetic",
								status: "rejected",
							},
						],
					}),
				],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage(`maintenance turn complete (${calls})`);
	};
}

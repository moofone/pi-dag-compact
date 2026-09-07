import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { batchFromNotes } from "./graph-sync.ts";
import { formatClassicSummary, notesAfterTurn } from "./notes.ts";

interface ToolStep {
	name: string;
	args: Record<string, unknown>;
}

function messageText(message: Message): string {
	if (message.role === "user") {
		const content = message.content;
		if (typeof content === "string") return content;
		return content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "user") return messageText(message);
	}
	return "";
}

export function isCompactionPrompt(context: Context): boolean {
	const text = lastUserText(context);
	return (
		text.includes("Create a structured context checkpoint summary") ||
		text.includes("The messages above are a conversation to summarize") ||
		text.includes("Update the existing structured summary with new information") ||
		text.includes("This is the PREFIX of a turn that was too large to keep")
	);
}

export function parseScenarioTurn(context: Context): number | undefined {
	const match = lastUserText(context).match(/# Scenario turn (\d+)/);
	if (!match?.[1]) return undefined;
	return Number.parseInt(match[1], 10);
}

function toolResultsSinceLastUser(context: Context): number {
	let count = 0;
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (!message) continue;
		if (message.role === "user") break;
		if (message.role === "toolResult") count += 1;
	}
	return count;
}

function toolsForTurn(turn: number, dag: boolean): ToolStep[] {
	const writeNotes = {
		name: "write",
		args: {
			path: "notes/state.json",
			content: `${JSON.stringify(notesAfterTurn(turn), null, "\t")}\n`,
		},
	};
	const run = (candidateId: string): ToolStep => ({
		name: "bash",
		args: { command: `node bench.mjs run --candidate ${candidateId} --workload W1` },
	});
	const read = (path: string): ToolStep => ({ name: "read", args: { path } });

	const tools = (() => {
		switch (turn) {
			case 1:
				return [read("README.md"), read("experiments.json"), writeNotes];
			case 2:
				return [
					run("baseline"),
					read("runs/run-baseline-W1/result.json"),
					read("src/baseline.cu"),
					read("src/pipeline_notes.txt"),
					writeNotes,
				];
			case 3:
				return [
					run("A"),
					read("runs/run-A-W1/result.json"),
					read("candidates/A.patch"),
					read("src/pipeline_notes.txt"),
					writeNotes,
				];
			case 4:
				return [writeNotes];
			case 5:
				return [writeNotes];
			case 6:
				return [
					run("B"),
					read("runs/run-B-W1/result.json"),
					read("src/pipeline_notes.txt"),
					writeNotes,
				];
			case 7:
				return [
					run("C"),
					read("runs/run-C-W1/result.json"),
					read("candidates/C.patch"),
					read("src/pipeline_notes.txt"),
					writeNotes,
				];
			case 8:
				return [read("src/pipeline_notes.txt"), writeNotes];
			case 9:
				return [
					run("D"),
					read("runs/run-D-W1/result.json"),
					read("src/pipeline_notes.txt"),
					writeNotes,
				];
			case 10:
				return [writeNotes];
			case 11:
				return [
					run("E"),
					read("runs/run-E-W1/result.json"),
					read("candidates/E.patch"),
					read("src/pipeline_notes.txt"),
					writeNotes,
				];
			case 12:
				return [read("src/pipeline_notes.txt"), writeNotes];
			case 13:
				return [read("runs/run-A-W1/manifest.json"), read("candidates/A.patch")];
			case 14:
				return [writeNotes];
			case 15:
				return [writeNotes];
			case 16:
				return [writeNotes];
			default:
				return [];
		}
	})();
	if (!dag) return tools;
	return [
		...tools,
		{
			name: "dag_update",
			args: batchFromNotes(notesAfterTurn(turn), `turn-${turn}`) as unknown as Record<
				string,
				unknown
			>,
		},
	];
}

function finalForTurn(turn: number): string {
	const notes = notesAfterTurn(turn);
	return [
		`Turn ${turn} complete.`,
		`baseline=${notes.acceptedBaselineId}`,
		`ceiling=${notes.resourceCeilingSmemPct}`,
		`rejected=${notes.rejected.map((item) => item.candidateId).join(",") || "(none)"}`,
		`inconclusive=${notes.inconclusive.join(",") || "(none)"}`,
		`next=${notes.nextAction}`,
	].join("\n");
}

export function createFauxResponseFactory(
	latestTurn: { current: number },
	options: { dag?: boolean } = {},
): (context: Context) => AssistantMessage {
	const dag = options.dag === true;
	return (context) => {
		if (isCompactionPrompt(context)) {
			return fauxAssistantMessage(formatClassicSummary(notesAfterTurn(latestTurn.current)));
		}
		const turn = parseScenarioTurn(context);
		if (turn === undefined) {
			return fauxAssistantMessage("Unexpected prompt outside the scenario controller.");
		}
		latestTurn.current = turn;
		const tools = toolsForTurn(turn, dag);
		const done = toolResultsSinceLastUser(context);
		const next = tools[done];
		if (next) {
			return fauxAssistantMessage([fauxToolCall(next.name, next.args)], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(finalForTurn(turn));
	};
}

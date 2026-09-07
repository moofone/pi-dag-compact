import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	FauxModelDefinition,
	FauxProviderState,
	FauxResponseStep,
	Message,
	Model,
	Provider,
} from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	createFauxCore,
	createProvider,
} from "@earendil-works/pi-ai";
import {
	type AppendRequest,
	type RequestKind,
	type RequestLedger,
	sharedPromptFingerprint,
} from "./ledger.ts";
import { usageFromUnknown } from "./usage.ts";

/**
 * Provider-boundary capture.
 *
 * The faux provider never invokes `onPayload`, so the optional
 * `before_provider_request` extension hook observes nothing. Evidence about
 * what a request actually contained therefore has to be taken here, at the
 * provider, after `transformContext` and every other extension transformation
 * has already run.
 */

export interface ProviderCapture {
	attemptId: string;
	sequence: number;
	kind: RequestKind;
	systemPrompt: string;
	serializedContext: string;
	messageCount: number;
	promptChars: number;
	sharedPromptChars: number;
	sharedPromptFingerprint: string;
}

/**
 * Failure-injection seams at the host boundary. These intercept the boundary
 * only: response selection, context assembly and compaction stay production
 * code. R1 and R2 need the same seams for admission and persistence.
 */
export interface EvalInjection {
	/** Attempt number (1-based) that fails at the provider instead of answering. */
	failProviderAttempt?: number;
	/** Attempt number whose usage callback the host re-delivers. */
	redeliverUsageForAttempt?: number;
	/** Cut index (0-based) whose next-request capture is withheld from validation. */
	dropNextRequestCaptureAfterCut?: number;
	/** Cut index (0-based) whose next-request capture is made to carry a dropped entry. */
	retainDroppedTurnInCaptureAfterCut?: number;
}

/** Barriers for deterministic synchronization; never sleeps, never timing based. */
export interface EvalBarriers {
	/**
	 * Synchronous, and called for every attempt the moment its context is
	 * captured, before the provider answers. Synchronous on purpose: the
	 * streaming path returns a stream rather than a promise, so a barrier that
	 * could suspend there would have to reimplement the stream. Everything R1
	 * needs at this point - observing an attempt, charging it, pausing an owner -
	 * is synchronous.
	 */
	beforeAttempt?: (capture: ProviderCapture) => void;
	afterAttempt?: (capture: ProviderCapture, message: AssistantMessage) => void | Promise<void>;
}

export interface RecordingFauxProvider {
	provider: Provider;
	api: string;
	models: [Model<string>, ...Model<string>[]];
	getModel: (modelId?: string) => Model<string> | undefined;
	state: FauxProviderState;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	captures: ProviderCapture[];
	attemptCount: () => number;
}

const MAINTENANCE_TOOLS = new Set(["dag_update", "dag_ingest_run"]);
const RECOVERY_TOOLS = new Set(["dag_query", "session_read"]);

const COMPACTION_MARKERS = [
	"Create a structured context checkpoint summary",
	"The messages above are a conversation to summarize",
	"Update the existing structured summary with new information",
	"This is the PREFIX of a turn that was too large to keep",
];

function userText(message: Message): string {
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function looksLikeCompaction(context: Context): boolean {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		const text = userText(message);
		return COMPACTION_MARKERS.some((marker) => text.includes(marker));
	}
	return false;
}

/** Classify a request from the context that actually reached the provider. */
export function classifyRequest(context: Context): RequestKind {
	if (looksLikeCompaction(context)) return "summary";
	const last = context.messages[context.messages.length - 1];
	if (!last) return "unknown";
	if (last.role === "toolResult") {
		const toolName = (last as { toolName?: unknown }).toolName;
		if (typeof toolName === "string") {
			if (MAINTENANCE_TOOLS.has(toolName)) return "maintenance";
			if (RECOVERY_TOOLS.has(toolName)) return "recovery";
		}
		return "tool_continuation";
	}
	if (last.role === "user") return "turn";
	return "unknown";
}

function serializeContext(context: Context): string {
	try {
		return JSON.stringify({
			systemPrompt: context.systemPrompt ?? "",
			messages: context.messages,
			tools: context.tools ?? [],
		});
	} catch {
		return String(context.messages.length);
	}
}

function injectedFailure(model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "injected provider failure",
		timestamp: 0,
	} as AssistantMessage;
}

export function createRecordingFauxProvider(options: {
	models: FauxModelDefinition[];
	tokenSize?: { min?: number; max?: number };
	ledger: RequestLedger;
	injection?: EvalInjection;
	barriers?: EvalBarriers;
}): RecordingFauxProvider {
	const core = createFauxCore({
		provider: "faux",
		api: "faux",
		models: options.models,
		...(options.tokenSize ? { tokenSize: options.tokenSize } : {}),
	});
	const captures: ProviderCapture[] = [];
	let attempts = 0;

	const record = (context: Context): ProviderCapture => {
		attempts += 1;
		const systemPrompt = context.systemPrompt ?? "";
		const serialized = serializeContext(context);
		const sharedChars = systemPrompt.length + JSON.stringify(context.tools ?? []).length;
		const capture: ProviderCapture = {
			attemptId: `attempt-${attempts}`,
			sequence: attempts,
			kind: classifyRequest(context),
			systemPrompt,
			serializedContext: serialized,
			messageCount: context.messages.length,
			promptChars: serialized.length,
			sharedPromptChars: sharedChars,
			sharedPromptFingerprint: sharedPromptFingerprint(systemPrompt, context.tools ?? []),
		};
		captures.push(capture);
		const append: AppendRequest = {
			attemptId: capture.attemptId,
			kind: capture.kind,
			promptChars: capture.promptChars,
			sharedPromptChars: capture.sharedPromptChars,
			sharedPromptFingerprint: capture.sharedPromptFingerprint,
		};
		options.ledger.append(append);
		return capture;
	};

	const observe = (capture: ProviderCapture, message: AssistantMessage): void => {
		options.ledger.observeUsage(capture.attemptId, usageFromUnknown(message.usage));
		options.ledger.setOutcome(
			capture.attemptId,
			message.stopReason === "error"
				? "error"
				: message.stopReason === "aborted"
					? "aborted"
					: "ok",
		);
		if (options.injection?.redeliverUsageForAttempt === capture.sequence) {
			// The host re-delivers the same callback. Identity must absorb it.
			options.ledger.observeUsage(capture.attemptId, usageFromUnknown(message.usage));
		}
	};

	const wrap =
		(
			inner: (
				model: Model<string>,
				context: Context,
				streamOptions?: never,
			) => AssistantMessageEventStream,
		) =>
		(
			model: Model<string>,
			context: Context,
			streamOptions?: never,
		): AssistantMessageEventStream => {
			const capture = record(context);
			options.barriers?.beforeAttempt?.(capture);
			if (options.injection?.failProviderAttempt === capture.sequence) {
				const outer = createAssistantMessageEventStream();
				const message = injectedFailure(model);
				queueMicrotask(async () => {
					await options.barriers?.beforeAttempt?.(capture);
					observe(capture, message);
					outer.push({ type: "error", reason: "error", error: message });
					outer.end(message);
					await options.barriers?.afterAttempt?.(capture, message);
				});
				return outer;
			}
			const stream = inner(model, context, streamOptions);
			void stream.result().then(async (message) => {
				observe(capture, message);
				await options.barriers?.afterAttempt?.(capture, message);
			});
			return stream;
		};

	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
		models: core.models,
		api: {
			stream: wrap(core.stream as never) as never,
			streamSimple: wrap(core.streamSimple as never) as never,
			fetchDeferred: core.fetchDeferred,
			cancelDeferred: core.cancelDeferred,
		},
	});

	return {
		provider,
		api: core.api,
		models: core.models,
		getModel: core.getModel as (modelId?: string) => Model<string> | undefined,
		state: core.state,
		setResponses: core.setResponses,
		appendResponses: core.appendResponses,
		captures,
		attemptCount: () => attempts,
	};
}

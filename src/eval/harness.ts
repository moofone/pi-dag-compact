import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionFactory,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import piDagCompact from "../index.ts";
import type { EvalConfig } from "../schema/scenario.ts";
import { createFauxResponseFactory } from "./faux-agent.ts";
import { createRequestLedger, type RequestLedger } from "./ledger.ts";
import {
	createRecordingFauxProvider,
	type EvalBarriers,
	type EvalInjection,
	type ProviderCapture,
	type RecordingFauxProvider,
} from "./provider.ts";
import type { IsolatedWorkspace } from "./workspace.ts";

export type { ProviderCapture } from "./provider.ts";

const DAG_TOOLS = ["dag_update", "dag_query", "session_read", "dag_ingest_run"];
const BUILTIN_TOOLS = ["read", "bash", "edit", "write"];

export interface CommandInvocation {
	command: string;
	args: string;
	output: string;
}

export interface ClassicHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	faux: RecordingFauxProvider;
	/** Raw provider-boundary captures, in attempt order. */
	captures: ProviderCapture[];
	/** Append-only per-attempt accounting, independent of the conversation. */
	ledger: RequestLedger;
	/**
	 * Requests seen by the optional `before_provider_request` extension hook.
	 * The faux provider never calls `onPayload`, so this stays empty; it is
	 * recorded to document why the hook is not sufficient capture evidence.
	 */
	providerHookCaptures: unknown[];
	providerHookCaptureCount: number;
	/** Real extension commands that ran, with their notified output. */
	commandOutputs: CommandInvocation[];
	latestTurn: { current: number };
	peakRssBytes: () => number;
	cleanup: () => Promise<void>;
}

export interface HarnessOptions {
	/** Load the pi-dag-compact extension in explicit-handoff mode. */
	dag?: boolean;
	/** Extra extensions loaded as-is, without command observation. */
	extraExtensions?: InlineExtension[];
	/** Real extensions to load with their commands observed. */
	extensions?: ExtensionFactory[];
	fauxFactory?: (context: Context) => AssistantMessage;
	injection?: EvalInjection;
	barriers?: EvalBarriers;
}

/**
 * Wrap an extension so command execution is observable.
 *
 * This intercepts the host boundary only: the registered production handler
 * still runs, with the real command context behind a prototype so its lazy
 * getters keep their staleness checks.
 */
function observeCommands(
	extension: ExtensionFactory,
	commandOutputs: CommandInvocation[],
): ExtensionFactory {
	return async (pi: ExtensionAPI) => {
		const register = pi.registerCommand.bind(pi);
		const patched = pi as unknown as {
			registerCommand: (name: string, definition: Parameters<typeof register>[1]) => void;
		};
		patched.registerCommand = (name, definition) => {
			register(name, {
				...definition,
				handler: async (args: string, ctx: ExtensionCommandContext) => {
					const notified: string[] = [];
					const proxied = Object.create(ctx) as ExtensionCommandContext;
					Object.defineProperty(proxied, "ui", {
						value: {
							...ctx.ui,
							notify: (message: string, type?: "info" | "warning" | "error") => {
								notified.push(message);
								ctx.ui.notify(message, type);
							},
						},
					});
					try {
						await definition.handler(args, proxied);
					} finally {
						commandOutputs.push({ command: name, args, output: notified.join("\n") });
					}
				},
			});
		};
		try {
			await extension(pi);
		} finally {
			patched.registerCommand = register;
		}
	};
}

export async function createClassicHarness(
	workspace: IsolatedWorkspace,
	config: EvalConfig,
	options: HarnessOptions = {},
): Promise<ClassicHarness> {
	writeFileSync(join(workspace.agentDir, "auth.json"), "{}\n");
	const dag = options.dag === true;
	if (dag) {
		const taskDir = join(workspace.cwd, "research-task");
		mkdirSync(join(workspace.cwd, ".pi"), { recursive: true });
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			join(workspace.cwd, ".pi", "pi-dag-compact.json"),
			`${JSON.stringify({ mode: "explicit-handoff", taskDir }, null, "\t")}\n`,
		);
	}

	const ledger = createRequestLedger();
	const faux = createRecordingFauxProvider({
		tokenSize: { min: 8000, max: 8000 },
		models: [
			{
				id: "faux-1",
				name: "Faux Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
		ledger,
		...(options.injection ? { injection: options.injection } : {}),
		...(options.barriers ? { barriers: options.barriers } : {}),
	});
	const latestTurn = { current: 1 };
	const factory = options.fauxFactory ?? createFauxResponseFactory(latestTurn, { dag });
	faux.setResponses(Array.from({ length: 512 }, () => factory));

	const model = faux.getModel();
	if (!model) throw new Error("faux provider exposed no model");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(workspace.agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);

	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			keepRecentTokens: config.keepRecentTokens,
			reserveTokens: config.reserveTokens,
		},
		retry: { enabled: false },
	});
	settingsManager.applyOverrides({
		compaction: {
			enabled: true,
			keepRecentTokens: config.keepRecentTokens,
			reserveTokens: config.reserveTokens,
		},
		retry: { enabled: false },
	});

	const providerHookCaptures: unknown[] = [];
	const commandOutputs: CommandInvocation[] = [];
	const hookExtension: InlineExtension = (pi) => {
		pi.on("before_provider_request", (event) => {
			providerHookCaptures.push(event.payload);
		});
	};

	const observed: ExtensionFactory[] = [
		...(dag ? [piDagCompact] : []),
		...(options.extensions ?? []),
	];
	const extensionFactories: InlineExtension[] = [
		hookExtension,
		...observed.map((extension) => observeCommands(extension, commandOutputs)),
		...(options.extraExtensions ?? []),
	];

	const resourceLoader = new DefaultResourceLoader({
		cwd: workspace.cwd,
		agentDir: workspace.agentDir,
		settingsManager,
		extensionFactories,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPrompt:
			"You are an isolated research eval agent. Use node bench.mjs. Do not invent measurements. Cite run IDs.",
	});
	await resourceLoader.reload();

	const sessionManager = SessionManager.create(workspace.cwd, workspace.sessionDir);
	const { session } = await createAgentSession({
		cwd: workspace.cwd,
		agentDir: workspace.agentDir,
		model,
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		// The allowlist has to name the extension's own tools, otherwise loading
		// a real extension registers tools the session then filters out.
		tools: observed.length > 0 ? [...BUILTIN_TOOLS, ...DAG_TOOLS] : BUILTIN_TOOLS,
		sessionManager,
		settingsManager,
	});

	let peakRss = process.memoryUsage().rss;
	const rssTimer = setInterval(() => {
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
	}, 50);
	rssTimer.unref();

	return {
		session,
		sessionManager,
		faux,
		captures: faux.captures,
		ledger,
		providerHookCaptures,
		get providerHookCaptureCount() {
			return providerHookCaptures.length;
		},
		commandOutputs,
		latestTurn,
		peakRssBytes: () => Math.max(peakRss, process.memoryUsage().rss),
		cleanup: async () => {
			clearInterval(rssTimer);
			session.dispose();
		},
	};
}

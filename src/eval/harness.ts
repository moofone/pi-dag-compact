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
import { HostBoundary } from "../extension/boundary.ts";
import type { ExtensionRuntime } from "../extension/runtime.ts";
import type { AdmissionLedger, OwnerId } from "../host/admission.ts";
import { type DurabilityObserver, readPersistedEntryIds } from "../host/durability.ts";
import type { UncertaintyFence } from "../host/fence.ts";
import { createPiDagCompact } from "../index.ts";
import type { EvalConfig } from "../schema/scenario.ts";
import { createFauxResponseFactory } from "./faux-agent.ts";
import { createRequestLedger, type RequestLedger } from "./ledger.ts";
import {
	installPersistInjection,
	type PersistFailurePlan,
	type PersistInjectionHandle,
} from "./persist-injection.ts";
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
	/**
	 * Failure injection at `SessionManager._persist`, the host's write boundary.
	 * Installed always, armed only when a plan is supplied. It intercepts the
	 * boundary; the leaf advance, the tree, the context builder and compaction
	 * all stay production code.
	 */
	persist: PersistInjectionHandle;
	/** The real extension runtime, when the DAG extension is loaded. */
	dagRuntime: ExtensionRuntime | undefined;
	/**
	 * The extension-owned host boundary. When the DAG extension is loaded this is
	 * the extension's own boundary, so a fixture asserts the real fence and the
	 * real admission ledger, not a copy of them.
	 */
	boundary: HostBoundary;
	durability: DurabilityObserver;
	fence: UncertaintyFence;
	admission: AdmissionLedger;
	/** Entry ids readable out of the session file right now. Never an fsync claim. */
	persistedEntryIds: () => Set<string>;
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
	/** Arm the host persistence boundary to fail. */
	persistFailure?: PersistFailurePlan;
	/** Resume an existing session file instead of starting a new session. */
	sessionFile?: string;
	/** Bind this session's goal-scheduled work to one owner with a finite allowance. */
	owner?: { owner: OwnerId; allowance: number };
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

	let dagRuntime: ExtensionRuntime | undefined;
	const observed: ExtensionFactory[] = [
		...(dag ? [createPiDagCompact({ onRuntime: (runtime) => (dagRuntime = runtime) })] : []),
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

	const sessionManager = options.sessionFile
		? SessionManager.open(options.sessionFile, workspace.sessionDir, workspace.cwd)
		: SessionManager.create(workspace.cwd, workspace.sessionDir);
	const persist = installPersistInjection(
		sessionManager,
		...(options.persistFailure ? [options.persistFailure] : []),
	);
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

	// When the DAG extension is loaded, its own boundary is the one under test.
	const boundary = dagRuntime?.boundary ?? new HostBoundary();
	boundary.attach(sessionManager);
	if (options.owner) {
		if (!dagRuntime) {
			throw new Error("binding an owner requires the DAG extension (dag: true)");
		}
		dagRuntime.bindOwner(options.owner.owner, options.owner.allowance);
	}

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
		persist,
		dagRuntime,
		boundary,
		durability: boundary.durability,
		get fence() {
			return boundary.fence;
		},
		get admission() {
			return boundary.admission;
		},
		persistedEntryIds: () => readPersistedEntryIds(sessionManager.getSessionFile()),
		peakRssBytes: () => Math.max(peakRss, process.memoryUsage().rss),
		cleanup: async () => {
			clearInterval(rssTimer);
			persist.restore();
			session.dispose();
		},
	};
}

/**
 * The real host lifecycle, not a simulation of it.
 *
 * `AgentSessionRuntime` is the object Pi's own CLI uses to start, replace, fork
 * and tear down sessions. Driving it here means `session_start`,
 * `session_shutdown`, `session_before_fork` and `session_tree` are emitted by
 * the host on its own schedule, in its own order, with its own reasons — and
 * that a fork is a real new session file with a real new session ID and real
 * copied entries.
 *
 * R1 recorded that an embedded `AgentSession` never emits `session_start`,
 * because the event is emitted from `bindExtensions`, which only the app layer
 * calls. That is exactly what the factory below does, so the events under test
 * here are the host's, not the fixture's.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionContext,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createFauxResponseFactory } from "../../src/eval/faux-agent.ts";
import { createRequestLedger } from "../../src/eval/ledger.ts";
import { createRecordingFauxProvider } from "../../src/eval/provider.ts";
import type { IsolatedWorkspace } from "../../src/eval/workspace.ts";
import type { ExtensionRuntime } from "../../src/extension/runtime.ts";
import { createPiDagCompact } from "../../src/index.ts";
import type { EvalConfig } from "../../src/schema/scenario.ts";

const DAG_TOOLS = ["dag_update", "dag_query", "session_read", "dag_ingest_run"];
const BUILTIN_TOOLS = ["read", "bash", "edit", "write"];

export interface LifecycleHost {
	/** The host object that owns session replacement. */
	host: AgentSessionRuntime;
	session: AgentSession;
	sessionId: string;
	sessionFile: string | undefined;
	taskDir: string;
	/** The extension runtime belonging to the session the host holds right now. */
	dag: () => ExtensionRuntime | undefined;
	/** Every extension runtime the host has built, oldest first. */
	runtimes: ExtensionRuntime[];
	/** Every lifecycle event the extension actually received, in order. */
	events: Array<{ type: string; reason?: string; sessionId: string }>;
	dispose: () => Promise<void>;
}

export interface LifecycleOptions {
	fauxFactory?: (context: Context) => AssistantMessage;
	/** Reuse an existing workspace's task directory and config. */
	prepared?: boolean;
}

/**
 * Build a host runtime over an isolated workspace with the DAG extension loaded
 * in explicit-handoff mode.
 */
export async function createLifecycleHost(
	workspace: IsolatedWorkspace,
	config: EvalConfig,
	options: LifecycleOptions = {},
): Promise<LifecycleHost> {
	const taskDir = join(workspace.cwd, "research-task");
	if (!options.prepared) {
		writeFileSync(join(workspace.agentDir, "auth.json"), "{}\n");
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
	});
	const latestTurn = { current: 1 };
	const factory = options.fauxFactory ?? createFauxResponseFactory(latestTurn, { dag: true });
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

	const runtimes: ExtensionRuntime[] = [];
	const events: Array<{ type: string; reason?: string; sessionId: string }> = [];
	const extensionFactories: ExtensionFactory[] = [
		createPiDagCompact({
			onRuntime: (runtime) => {
				runtimes.push(runtime);
			},
		}),
		// A silent observer of the same events, so a fixture can assert that the
		// host really emitted them rather than inferring it from side effects.
		(pi) => {
			const record = (type: string) => async (event: unknown, ctx: ExtensionContext) => {
				const reason = (event as { reason?: string } | null)?.reason;
				events.push({
					type,
					...(reason ? { reason } : {}),
					sessionId: ctx.sessionManager.getSessionId(),
				});
			};
			pi.on("session_start", record("session_start"));
			pi.on("session_shutdown", record("session_shutdown"));
			pi.on("session_tree", record("session_tree"));
		},
	];

	const buildRuntime = async (opts: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"];
	}) => {
		const services = await createAgentSessionServices({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				systemPrompt: "You are an isolated research eval agent. Cite run IDs.",
			},
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: opts.sessionManager,
			...(opts.sessionStartEvent ? { sessionStartEvent: opts.sessionStartEvent } : {}),
			model,
			thinkingLevel: "off",
			tools: [...BUILTIN_TOOLS, ...DAG_TOOLS],
		});
		// The app layer's job, and the only thing that makes `session_start` fire.
		await result.session.bindExtensions({});
		return { ...result, services, diagnostics: services.diagnostics };
	};

	const sessionManager = SessionManager.create(workspace.cwd, workspace.sessionDir);
	const host = await createAgentSessionRuntime(buildRuntime, {
		cwd: workspace.cwd,
		agentDir: workspace.agentDir,
		sessionManager,
	});

	return {
		host,
		get session() {
			return host.session;
		},
		get sessionId() {
			return host.session.sessionManager.getSessionId();
		},
		get sessionFile() {
			return host.session.sessionManager.getSessionFile();
		},
		taskDir,
		dag: () => runtimes.at(-1),
		runtimes,
		events,
		dispose: async () => {
			await host.dispose();
		},
	};
}

/** The last user message entry id, which is what `/fork` is given in the CLI. */
export function lastUserEntryId(session: AgentSession): string {
	const entries = session.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "user") return entry.id;
	}
	throw new Error("no user entry to fork at");
}

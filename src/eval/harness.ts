import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import piDagCompact from "../index.ts";
import type { EvalConfig } from "../schema/scenario.ts";
import { createFauxResponseFactory } from "./faux-agent.ts";
import type { IsolatedWorkspace } from "./workspace.ts";

export interface ProviderCapture {
	kind: "turn" | "compaction";
	serialized: string;
}

export interface ClassicHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	faux: FauxProviderHandle;
	captures: ProviderCapture[];
	latestTurn: { current: number };
	peakRssBytes: () => number;
	cleanup: () => Promise<void>;
}

function serializePayload(payload: unknown): string {
	try {
		return JSON.stringify(payload);
	} catch {
		return String(payload);
	}
}

export async function createClassicHarness(
	workspace: IsolatedWorkspace,
	config: EvalConfig,
	options: {
		extraExtensions?: InlineExtension[];
		dag?: boolean;
		fauxFactory?: (context: Context) => AssistantMessage;
	} = {},
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

	const faux = fauxProvider({
		provider: "faux",
		api: "faux",
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
	});
	const latestTurn = { current: 1 };
	const factory = options.fauxFactory ?? createFauxResponseFactory(latestTurn, { dag });
	faux.setResponses(Array.from({ length: 512 }, () => factory));

	const model = faux.getModel();
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

	const captures: ProviderCapture[] = [];
	const captureExtension: InlineExtension = (pi) => {
		pi.on("before_provider_request", (event) => {
			const serialized = serializePayload(event.payload);
			captures.push({
				kind: serialized.includes("Create a structured context checkpoint summary")
					? "compaction"
					: "turn",
				serialized,
			});
		});
	};

	const resourceLoader = new DefaultResourceLoader({
		cwd: workspace.cwd,
		agentDir: workspace.agentDir,
		settingsManager,
		extensionFactories: [
			captureExtension,
			...(dag ? [piDagCompact] : []),
			...(options.extraExtensions ?? []),
		],
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
		tools: dag
			? [
					"read",
					"bash",
					"edit",
					"write",
					"dag_update",
					"dag_query",
					"session_read",
					"dag_ingest_run",
				]
			: ["read", "bash", "edit", "write"],
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
		captures,
		latestTurn,
		peakRssBytes: () => Math.max(peakRss, process.memoryUsage().rss),
		cleanup: async () => {
			clearInterval(rssTimer);
			session.dispose();
		},
	};
}

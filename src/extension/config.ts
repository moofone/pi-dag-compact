import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ExtensionConfigSchema, type ExtensionMode } from "../schema/mode.ts";
import { parseWithSchema } from "../schema/validate.ts";

export interface ResolvedConfig {
	mode: ExtensionMode;
	taskDir?: string;
}

function parseMode(value: string | undefined): ExtensionMode | undefined {
	if (value === "disabled" || value === "record-only" || value === "explicit-handoff") {
		return value;
	}
	return undefined;
}

function readFileConfig(cwd: string): { mode?: ExtensionMode; taskDir?: string } {
	const path = join(cwd, ".pi", "pi-dag-compact.json");
	if (!existsSync(path)) return {};
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	return parseWithSchema(ExtensionConfigSchema, raw, path);
}

export function resolveConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
	const file = readFileConfig(cwd);
	const mode = parseMode(env.PI_DAG_COMPACT_MODE) ?? file.mode ?? "disabled";
	const taskDirRaw = env.PI_DAG_COMPACT_TASK_DIR ?? file.taskDir;
	const taskDir = taskDirRaw
		? isAbsolute(taskDirRaw)
			? taskDirRaw
			: resolve(cwd, taskDirRaw)
		: undefined;
	return taskDir ? { mode, taskDir } : { mode };
}

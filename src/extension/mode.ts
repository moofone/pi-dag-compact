import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ExtensionConfigSchema, type ExtensionMode } from "../schema/mode.ts";
import { parseWithSchema } from "../schema/validate.ts";

const DEFAULT_MODE: ExtensionMode = "disabled";

function parseMode(value: string | undefined): ExtensionMode | undefined {
	if (value === "disabled" || value === "record-only" || value === "explicit-handoff") {
		return value;
	}
	return undefined;
}

function readConfigFile(cwd: string): ExtensionMode | undefined {
	const path = join(cwd, ".pi", "pi-dag-compact.json");
	if (!existsSync(path)) {
		return undefined;
	}
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	const config = parseWithSchema(ExtensionConfigSchema, raw, path);
	return config.mode;
}

export function resolveExtensionMode(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): ExtensionMode {
	return parseMode(env.PI_DAG_COMPACT_MODE) ?? readConfigFile(cwd) ?? DEFAULT_MODE;
}

import type { ExtensionMode } from "../schema/mode.ts";
import { resolveConfig } from "./config.ts";

export function resolveExtensionMode(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): ExtensionMode {
	return resolveConfig(cwd, env).mode;
}

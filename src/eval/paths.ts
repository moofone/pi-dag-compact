import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function repoRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function scenarioRoot(): string {
	return join(repoRoot(), "fixtures", "scenario-16");
}

export function workspaceSnapshot(): string {
	return join(scenarioRoot(), "workspace");
}

export function cudaPilotRoot(): string {
	return join(repoRoot(), "fixtures", "cuda-pilot");
}

export function cudaPilotWorkspace(): string {
	return join(cudaPilotRoot(), "workspace");
}

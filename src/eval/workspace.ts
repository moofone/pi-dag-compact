import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSnapshot } from "./paths.ts";

export interface IsolatedWorkspace {
	root: string;
	cwd: string;
	agentDir: string;
	sessionDir: string;
	outDir: string;
	cleanup: () => void;
}

export function createIsolatedWorkspace(
	outDir?: string,
	snapshot: string = workspaceSnapshot(),
): IsolatedWorkspace {
	const root = mkdtempSync(join(tmpdir(), "pi-dag-compact-run-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const resolvedOut = outDir ?? join(root, "out");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(resolvedOut, { recursive: true });
	cpSync(snapshot, cwd, { recursive: true });
	return {
		root,
		cwd,
		agentDir,
		sessionDir,
		outDir: resolvedOut,
		cleanup: () => {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

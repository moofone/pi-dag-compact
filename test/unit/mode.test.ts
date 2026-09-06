import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resolveExtensionMode } from "../../src/extension/mode.ts";
import { makeTempDir } from "../support/tmp.ts";

test("defaults to disabled", () => {
	const tmp = makeTempDir("pi-dag-mode-");
	try {
		assert.equal(resolveExtensionMode(tmp.path, {}), "disabled");
	} finally {
		tmp.cleanup();
	}
});

test("env overrides config file", () => {
	const tmp = makeTempDir("pi-dag-mode-");
	try {
		mkdirSync(join(tmp.path, ".pi"));
		writeFileSync(
			join(tmp.path, ".pi", "pi-dag-compact.json"),
			JSON.stringify({ mode: "record-only" }),
		);
		assert.equal(resolveExtensionMode(tmp.path, { PI_DAG_COMPACT_MODE: "disabled" }), "disabled");
		assert.equal(resolveExtensionMode(tmp.path, {}), "record-only");
	} finally {
		tmp.cleanup();
	}
});

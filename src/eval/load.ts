import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type OracleFile, OracleFileSchema } from "../schema/oracle.ts";
import {
	type EvalConfig,
	EvalConfigSchema,
	type ScenarioFile,
	ScenarioFileSchema,
} from "../schema/scenario.ts";
import { parseWithSchema } from "../schema/validate.ts";
import { scenarioRoot } from "./paths.ts";

export function loadScenario(): ScenarioFile {
	const path = join(scenarioRoot(), "scenario.json");
	return parseWithSchema(ScenarioFileSchema, JSON.parse(readFileSync(path, "utf8")), path);
}

export function loadEvalConfig(): EvalConfig {
	const path = join(scenarioRoot(), "eval-config.json");
	return parseWithSchema(EvalConfigSchema, JSON.parse(readFileSync(path, "utf8")), path);
}

export function loadOracle(): OracleFile {
	const path = join(scenarioRoot(), "oracle.json");
	return parseWithSchema(OracleFileSchema, JSON.parse(readFileSync(path, "utf8")), path);
}

import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export function parseWithSchema<T extends TSchema>(
	schema: T,
	data: unknown,
	label: string,
): Static<T> {
	if (Value.Check(schema, data)) {
		return data as Static<T>;
	}
	const errors = [...Value.Errors(schema, data)].slice(0, 12);
	const detail = errors
		.map((error) => {
			const record = error as { instancePath?: string; path?: string; message?: string };
			const path = record.instancePath ?? record.path ?? "/";
			return `${path}: ${record.message ?? JSON.stringify(error)}`;
		})
		.join("; ");
	throw new Error(`${label} failed schema validation: ${detail || "unknown error"}`);
}

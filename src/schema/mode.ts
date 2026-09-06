import { type Static, Type } from "typebox";

export const ExtensionModeSchema = Type.Union([
	Type.Literal("disabled"),
	Type.Literal("record-only"),
	Type.Literal("explicit-handoff"),
]);

export type ExtensionMode = Static<typeof ExtensionModeSchema>;

export const ExtensionConfigSchema = Type.Object({
	mode: Type.Optional(ExtensionModeSchema),
});

export type ExtensionConfig = Static<typeof ExtensionConfigSchema>;

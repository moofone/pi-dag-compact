import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The smallest `ExtensionAPI` that lets `createRuntime` be built in a unit test.
 *
 * It records registrations and does nothing else. The production runtime, the
 * host boundary it owns, the fence and the admission ledger are all real; only
 * the host that would deliver events to them is absent. Anything that needs a
 * real host event is an integration fixture, not a unit one.
 */
export interface FakeExtensionApi {
	api: ExtensionAPI;
	events: string[];
	commands: string[];
	tools: string[];
	appended: Array<{ customType: string; data: unknown }>;
}

export function fakeExtensionApiWithRecord(): FakeExtensionApi {
	const events: string[] = [];
	const commands: string[] = [];
	const tools: string[] = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	const api = {
		on: (event: string) => {
			events.push(event);
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		registerTool: (definition: { name: string }) => {
			tools.push(definition.name);
		},
		appendEntry: (customType: string, data?: unknown) => {
			appended.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	return { api, events, commands, tools, appended };
}

export function fakeExtensionApi(): ExtensionAPI {
	return fakeExtensionApiWithRecord().api;
}

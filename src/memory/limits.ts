export const LIMITS = {
	maxNodes: 200,
	maxEdges: 400,
	maxSerializedBytes: 128 * 1024,
	maxBatchBytes: 16 * 1024,
	maxEventBytes: 16 * 1024,
	maxQueryRecords: 20,
	maxQueryBytes: 8 * 1024,
	maxIdReads: 8,
	maxReplayMutations: 32,
	historyScanBytes: 4 * 1024 * 1024,
	maxTitle: 120,
	maxBody: 1000,
	maxHandoffTokens: 1000,
} as const;

export function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

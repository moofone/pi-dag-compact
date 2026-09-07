import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * An extension-level fence over an unfenced host.
 *
 * This is not a core guarantee and must never be described as one. Pi appends
 * before it persists, does not roll back a failed append, and gives an
 * extension no way to deny a provider request the host has already issued. What
 * an extension can do is notice that an append it made is not in the session
 * file, refuse to schedule any further goal-owned work, and refuse to hand off
 * or publish anything derived from a session it can no longer trust.
 *
 * The fence therefore holds over: ordinary user input, extension appends,
 * automatic and manual compaction, the handoff fallback path, and context
 * rebuilds. It is stored beside the extension's own records, not in the Pi
 * session, because the Pi session is the thing that is in doubt. That store is
 * a rename-over-temp write and is not fsynced either — the ceiling applies to
 * the fence as much as to anything else.
 */

export type FenceReason =
	| "append_failed"
	| "append_absent_from_file"
	| "compaction_append_failed"
	| "handoff_append_failed"
	| "manual";

export interface FenceRecord {
	v: 1;
	reason: FenceReason;
	detail: string;
	sessionId: string;
	/** The leaf at the moment the fence went up, which may itself be the leak. */
	leafId: string | null;
	entryId: string | null;
	raisedAt: string;
}

export interface UncertaintyFenceStore {
	load(): FenceRecord | undefined;
	save(record: FenceRecord): void;
	clear(): void;
}

function fenceFilePath(dir: string): string {
	return join(dir, "host-uncertainty-fence.json");
}

/** Durable across restart, extension-owned, and explicitly not fsynced. */
export function createFileFenceStore(dir: string): UncertaintyFenceStore {
	const path = fenceFilePath(dir);
	return {
		load() {
			if (!existsSync(path)) return undefined;
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8")) as FenceRecord;
				return parsed.v === 1 ? parsed : undefined;
			} catch {
				return undefined;
			}
		},
		save(record) {
			mkdirSync(dirname(path), { recursive: true });
			const temp = `${path}.tmp`;
			writeFileSync(temp, `${JSON.stringify(record, null, "\t")}\n`);
			renameSync(temp, path);
		},
		clear() {
			rmSync(path, { force: true });
		},
	};
}

export class UncertaintyFence {
	private record: FenceRecord | undefined;
	private store: UncertaintyFenceStore | undefined;
	/** Every path the fence actually refused, so a fixture can prove coverage. */
	readonly refusals: Array<{ path: string; reason: FenceReason }> = [];

	constructor(store?: UncertaintyFenceStore) {
		this.store = store;
		this.record = store?.load();
	}

	/**
	 * Point the fence at persistent storage once the task directory is known. The
	 * stored record wins: a fence raised in a previous process outlives it.
	 */
	rebindStore(store: UncertaintyFenceStore): void {
		this.store = store;
		const stored = store.load();
		if (stored) {
			this.record = stored;
		} else if (this.record) {
			store.save(this.record);
		}
	}

	get raised(): boolean {
		return this.record !== undefined;
	}

	get reason(): FenceReason | undefined {
		return this.record?.reason;
	}

	get detail(): string | undefined {
		return this.record?.detail;
	}

	get current(): FenceRecord | undefined {
		return this.record;
	}

	raise(input: {
		reason: FenceReason;
		detail: string;
		sessionId: string;
		leafId?: string | null;
		entryId?: string | null;
	}): FenceRecord {
		if (this.record) return this.record;
		this.record = {
			v: 1,
			reason: input.reason,
			detail: input.detail,
			sessionId: input.sessionId,
			leafId: input.leafId ?? null,
			entryId: input.entryId ?? null,
			raisedAt: new Date().toISOString(),
		};
		this.store?.save(this.record);
		return this.record;
	}

	/**
	 * Ask the fence about one downstream path. Recording the question is the
	 * point: a fixture proves the fence held on every path by reading `refusals`.
	 */
	refuses(path: string): boolean {
		if (!this.record) return false;
		this.refusals.push({ path, reason: this.record.reason });
		return true;
	}

	/** Only a deliberate repair clears it. Reload never clears it by itself. */
	clear(): void {
		this.record = undefined;
		this.store?.clear();
	}

	message(): string {
		if (!this.record) return "";
		return `session persistence is uncertain (${this.record.reason}): ${this.record.detail}. This is an extension-level fence over an unfenced host, not a core guarantee.`;
	}
}

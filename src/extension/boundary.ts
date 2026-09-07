import { AdmissionLedger, createFileAdmissionStore } from "../host/admission.ts";
import {
	type AppendObservation,
	createDurabilityObserver,
	type DurabilityObserver,
	type LeakProbe,
	type SessionFileReader,
} from "../host/durability.ts";
import { createFileFenceStore, UncertaintyFence } from "../host/fence.ts";
import { DagError } from "../memory/errors.ts";

/**
 * The extension's own view of the host boundary.
 *
 * It observes what an append did, fences the extension's downstream work when
 * an append is not in the session file, and holds the owner-bound admission
 * ledger. None of this makes the host atomic. The host leaks a failed append
 * into its leaf, its branch and its context builder, and it will keep doing so;
 * what changes is that this extension stops trusting the session and stops
 * scheduling goal-owned work on top of it.
 */
export class HostBoundary {
	private readonly sessionRef: { current: (SessionFileReader & Partial<LeakProbe>) | undefined } = {
		current: undefined,
	};
	readonly fence: UncertaintyFence;
	readonly admission: AdmissionLedger;
	readonly durability: DurabilityObserver;
	/** Directory the fence and the admission ledger are stored in, once known. */
	private boundDir: string | undefined;

	constructor() {
		this.durability = createDurabilityObserver({
			getSessionFile: () => this.sessionRef.current?.getSessionFile(),
		});
		this.fence = new UncertaintyFence();
		this.admission = new AdmissionLedger({ isFenced: () => this.fence.raised });
	}

	get boundDirectory(): string | undefined {
		return this.boundDir;
	}

	/** Track the session whose file the observer reads back. */
	attach(session: SessionFileReader & Partial<LeakProbe>): void {
		this.sessionRef.current = session;
	}

	/**
	 * Point the fence and the ledger at persistent, extension-owned storage.
	 *
	 * Deliberately not the Pi session: the session is the thing in doubt. This
	 * store is a rename-over-temp write and is not fsynced either.
	 */
	bind(dir: string): void {
		if (this.boundDir === dir) return;
		this.boundDir = dir;
		this.fence.rebindStore(createFileFenceStore(dir));
		this.admission.rebindStore(createFileAdmissionStore(dir));
	}

	/**
	 * Append through the host and observe what it did.
	 *
	 * A throwing append leaves the entry in memory and as the leaf. A returning
	 * append may have written nothing at all. Either way the extension records
	 * what it saw, and fences itself when the session file does not agree with
	 * what it was told.
	 */
	guardedAppend(
		session: LeakProbe & SessionFileReader & { getSessionId(): string },
		append: () => unknown,
	): AppendObservation {
		this.attach(session);
		const known = new Set(session.getEntries().map((entry) => entry.id));
		let entryId: string;
		try {
			// `pi.appendEntry` returns void; the host advances the leaf to the entry
			// it just pushed, so the leaf is the id when the caller has none.
			const returned = append();
			entryId = typeof returned === "string" ? returned : (session.getLeafId() ?? "");
		} catch (error) {
			const leak = this.durability.recordFailedAppend(error, session, known);
			this.fence.raise({
				reason: "append_failed",
				detail: leak.error,
				sessionId: session.getSessionId(),
				leafId: session.getLeafId(),
				entryId: leak.entryId ?? null,
			});
			throw new DagError(
				"append_uncertain",
				`append failed and the host did not roll it back: ${leak.error}`,
			);
		}
		const observation = this.durability.observeAppend(entryId);
		if (observation.durability === "absent_from_file") {
			this.fence.raise({
				reason: "append_absent_from_file",
				detail: `entry ${entryId} is not in the session file the host has already flushed`,
				sessionId: session.getSessionId(),
				leafId: session.getLeafId(),
				entryId,
			});
		}
		return observation;
	}
}

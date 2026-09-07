/**
 * Live scored variants / second model family.
 *
 * Tests and default eval paths must not call paid providers. This command is
 * the explicit gate; it still refuses to run a provider from this package.
 */
const enabled = process.env.PI_DAG_COMPACT_LIVE === "1";
if (!enabled) {
	console.error(
		"pi-dag-compact: refusing live providers. Set PI_DAG_COMPACT_LIVE=1 only after an explicit paid run is approved.",
	);
	process.exit(2);
}

console.error(
	"pi-dag-compact: PI_DAG_COMPACT_LIVE=1 is set, but live model-family evaluation is not wired in this package. No provider was called. Cross-model and hundreds-of-turn memory claims remain out of scope.",
);
process.exit(2);

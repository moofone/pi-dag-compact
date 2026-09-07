import { measureRevisionGrowth } from "./revision-growth.ts";

/**
 * D1 storage growth at near-cap active state. Reports the number; it does not
 * decide anything. A miss against the §11 target is reported as a miss.
 */
const result = measureRevisionGrowth();
process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);

/**
 * @ss/entitlements — the pure maths behind the Portal's hourly charges: millicredit units, UTC hour helpers and the
 * canonical JSON hash used by the ledger's hash chain. No I/O; time is always a parameter. See README.md.
 */

export { MILLICREDITS_PER_CREDIT, assertMillicredits, isMillicredits, toCredits, toMillicredits } from './units.js';
export { HOUR_MS, ceilHour, floorHour, isoHour, isoInstant, toMs } from './time.js';
export { deepEqual, sha256Hex, stableStringify } from './hash.js';

/**
 * UTC hour helpers. Instants are integer milliseconds since the Unix epoch (UTC); {@link toMs} turns a number, an
 * ISO-8601 string or a `Date` into one.
 */

/** @typedef {number | string | Date} Instant */

/** Milliseconds in one hour. */
export const HOUR_MS = 3_600_000;

/**
 * Normalises an instant to epoch milliseconds. Throws on invalid input.
 * @param {Instant} instant
 * @param {string} [label]
 * @returns {number}
 */
export const toMs = (instant, label = 'instant') => {
	const ms = instant instanceof Date ? instant.getTime() : typeof instant === 'string' ? Date.parse(instant) : instant;
	if (typeof ms !== 'number' || !Number.isFinite(ms))
		throw new RangeError(`${label} is not a valid instant: ${String(instant)}`);
	return Math.trunc(ms);
};

/**
 * Start of the UTC hour containing `ms`.
 * @param {number} ms
 * @returns {number}
 */
export const floorHour = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;

/**
 * Start of the first UTC hour at or after `ms`.
 * @param {number} ms
 * @returns {number}
 */
export const ceilHour = (ms) => Math.ceil(ms / HOUR_MS) * HOUR_MS;

/**
 * Canonical hour-bucket label: `YYYY-MM-DDTHH:00:00Z` (no milliseconds).
 * @param {number} ms Must be hour-aligned.
 * @returns {string}
 */
export const isoHour = (ms) => `${new Date(ms).toISOString().slice(0, 13)}:00:00Z`;

/**
 * ISO-8601 UTC string with seconds precision (`YYYY-MM-DDTHH:MM:SSZ`), milliseconds kept when non-zero.
 * @param {number} ms
 * @returns {string}
 */
export const isoInstant = (ms) => {
	const iso = new Date(ms).toISOString();
	return iso.endsWith('.000Z') ? `${iso.slice(0, 19)}Z` : iso;
};

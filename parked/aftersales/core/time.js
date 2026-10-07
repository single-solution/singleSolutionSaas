/**
 * Time helpers (pure). Instants are epoch milliseconds in, ISO-8601 UTC out; no zone is assumed (the website's zone
 * comes from the entitlement document and only matters to rules@1 conditions).
 * @module
 */

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** @param {number} ms */
export const iso = (ms) => new Date(ms).toISOString();

/**
 * Epoch milliseconds of an ISO string, a Date or a number, else null.
 * @param {unknown} value
 * @returns {number | null}
 */
export const toMs = (value) => {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string' || value.length > 40) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
};

/**
 * True when `timeZone` is a zone this runtime knows.
 * @param {unknown} timeZone
 */
export const isTimeZone = (timeZone) => {
	if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
	try {
		new Intl.DateTimeFormat('en', { timeZone });
		return true;
	} catch {
		return false;
	}
};

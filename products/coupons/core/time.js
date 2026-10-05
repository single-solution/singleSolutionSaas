/**
 * Time helpers (pure; `Intl` only, no zone data of our own). Validity windows are authored in the website's local time
 * (or a coupon's own zone), so the wall clock is read through `Intl.DateTimeFormat` with that zone: the answer is the
 * same on a UTC server and in a browser anywhere. Ported from ibrahimMobiles `offerSchedule` (store zone → any zone).
 * @module
 */

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Weekday keys, index 0 = Sunday (the `Date#getDay` convention). */
export const WEEKDAYS = Object.freeze(/** @type {const} */ (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']));

/** @typedef {(typeof WEEKDAYS)[number]} Weekday */

const WEEKDAY_INDEX = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();

/**
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
const formatFor = (timeZone) => {
	let format = formats.get(timeZone);
	if (!format) {
		format = new Intl.DateTimeFormat('en-US', {
			timeZone,
			weekday: 'short',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		});
		formats.set(timeZone, format);
	}
	return format;
};

/**
 * True when `timeZone` is an IANA zone this runtime knows.
 * @param {unknown} timeZone
 * @returns {timeZone is string}
 */
export const isTimeZone = (timeZone) => {
	if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
	try {
		formatFor(timeZone);
		return true;
	} catch {
		return false;
	}
};

/**
 * Wall clock of an instant in a zone: weekday (0 = Sunday) and minutes since local midnight. Unknown zones read UTC.
 * @param {number} ms
 * @param {string} timeZone
 * @returns {{ weekday: number, minutes: number }}
 */
export const clockIn = (ms, timeZone) => {
	const format = formatFor(isTimeZone(timeZone) ? timeZone : 'UTC');
	let weekday = 0;
	let hours = 0;
	let minutes = 0;
	for (const part of format.formatToParts(new Date(ms))) {
		if (part.type === 'weekday') weekday = WEEKDAY_INDEX[/** @type {keyof typeof WEEKDAY_INDEX} */ (part.value)] ?? 0;
		// some engines render midnight as "24" even with h23
		else if (part.type === 'hour') hours = Number(part.value) % 24;
		else if (part.type === 'minute') minutes = Number(part.value);
	}
	return { weekday, minutes: hours * 60 + minutes };
};

/**
 * ISO string of an instant.
 * @param {number} ms
 */
export const iso = (ms) => new Date(ms).toISOString();

/**
 * Milliseconds of an ISO string, a `Date` or an epoch value (`NaN` when invalid).
 * @param {unknown} value
 * @returns {number}
 */
export const toMs = (value) => {
	if (typeof value === 'number') return value;
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'string') return Date.parse(value);
	return Number.NaN;
};

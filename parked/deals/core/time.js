/**
 * Wall-clock maths in a website's time zone (pure; `Intl` only). Deal windows are authored in local time ("weekdays
 * 18:00–02:00 in Europe/Berlin"), so the same instant gives the same answer on a browser, a UTC server function or a
 * test — the price the shopper sees is the price the checkout bills. Ported and generalised from ibrahimMobiles
 * `offerSchedule.ts` (which pinned one store zone); here the zone is data.
 * @module
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Day keys, index = JavaScript `getUTCDay()` (0 = Sunday), as in the Loader's placement schedule. */
export const DAYS = Object.freeze(/** @type {const} */ (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']));

/** @typedef {(typeof DAYS)[number]} Day */
/** @typedef {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} LocalParts */

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
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric',
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
 * Wall-clock parts of an instant in a zone (an unknown zone falls back to UTC).
 * @param {number} ms
 * @param {string} timeZone
 * @returns {LocalParts}
 */
export const localParts = (ms, timeZone) => {
	const format = isTimeZone(timeZone) ? formatFor(timeZone) : formatFor('UTC');
	/** @type {Record<string, number>} */
	const parts = {};
	for (const part of format.formatToParts(new Date(ms))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
	return {
		year: parts.year ?? 1970,
		month: parts.month ?? 1,
		day: parts.day ?? 1,
		// some engines render midnight as 24 even with h23
		hour: (parts.hour ?? 0) % 24,
		minute: parts.minute ?? 0,
		second: parts.second ?? 0,
	};
};

/**
 * Offset of the zone from UTC at an instant, in ms (local − UTC), whole seconds.
 * @param {number} ms
 * @param {string} timeZone
 */
export const zoneOffset = (ms, timeZone) => {
	const p = localParts(ms, timeZone);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return asUtc - Math.floor(ms / 1000) * 1000;
};

/**
 * The instant of a local wall-clock time in a zone. Times skipped by a DST jump resolve forward; repeated times resolve
 * to the first occurrence.
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number }} local
 * @param {string} timeZone
 * @returns {number}
 */
export const zonedToUtc = ({ year, month, day, hour = 0, minute = 0 }, timeZone) => {
	const guess = Date.UTC(year, month - 1, day, hour, minute);
	const first = guess - zoneOffset(guess, timeZone);
	const second = guess - zoneOffset(first, timeZone);
	return Math.min(first, second);
};

/**
 * Local calendar date `offset` days after `date` (pure calendar arithmetic) and its weekday.
 * @param {{ year: number, month: number, day: number }} date
 * @param {number} offset
 * @returns {{ year: number, month: number, day: number, weekday: number }}
 */
export const addDays = ({ year, month, day }, offset) => {
	const t = new Date(Date.UTC(year, month - 1, day + offset));
	return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), weekday: t.getUTCDay() };
};

/**
 * Minutes since midnight of an `HH:MM` string (00:00–24:00), else null.
 * @param {unknown} value
 * @returns {number | null}
 */
export const clockMinutes = (value) => {
	if (typeof value !== 'string') return null;
	const match = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(value);
	if (!match) return null;
	const minutes = Number(match[1]) * 60 + Number(match[2]);
	return minutes > 24 * 60 ? null : minutes;
};

/**
 * Parse an ISO-8601 instant (with a zone designator) to epoch ms, else null.
 * @param {unknown} value
 * @returns {number | null}
 */
export const parseInstant = (value) => {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
		return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
};

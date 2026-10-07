/**
 * Calendar maths in a website's time zone (pure; `Intl` only). Cap periods, tier windows and expiry notices are
 * local-calendar concepts, so they are computed in the website zone; lot expiry itself is plain UTC calendar-month
 * addition on the credit instant (deterministic and zone-free, ported from ibrahimMobiles `addLoyaltyMonths`).
 * @module
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Periods a cap can reset on. */
export const PERIODS = Object.freeze(/** @type {const} */ (['day', 'week', 'month', 'year']));

/** @typedef {(typeof PERIODS)[number]} Period */
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
 * True when `timeZone` is a zone this runtime knows.
 * @param {unknown} timeZone
 * @returns {boolean}
 */
export const isTimeZone = (timeZone) => {
	if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
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
		hour: parts.hour ?? 0,
		minute: parts.minute ?? 0,
		second: parts.second ?? 0,
	};
};

/**
 * Offset of the zone from UTC at an instant, in ms (local − UTC).
 * @param {number} ms
 * @param {string} timeZone
 */
export const zoneOffset = (ms, timeZone) => {
	const p = localParts(ms, timeZone);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
};

/**
 * The instant of a local wall-clock time (the first one when a DST gap or overlap makes it ambiguous).
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number }} local month is 1-based
 * @param {string} timeZone
 * @returns {number}
 */
export const fromLocal = ({ year, month, day, hour = 0, minute = 0 }, timeZone) => {
	const guess = Date.UTC(year, month - 1, day, hour, minute);
	const first = guess - zoneOffset(guess, timeZone);
	const second = guess - zoneOffset(first, timeZone);
	return Math.min(first, second);
};

/** @param {number} n @param {number} [width] */
const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * Local calendar day `YYYY-MM-DD`.
 * @param {number} ms
 * @param {string} timeZone
 */
export const dayKey = (ms, timeZone) => {
	const p = localParts(ms, timeZone);
	return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
};

/**
 * Local calendar month `YYYY-MM`.
 * @param {number} ms
 * @param {string} timeZone
 */
export const monthKey = (ms, timeZone) => dayKey(ms, timeZone).slice(0, 7);

/**
 * ISO week of a local date (`YYYY-Www`, weeks start on Monday).
 * @param {LocalParts} p
 */
const isoWeek = (p) => {
	const date = Date.UTC(p.year, p.month - 1, p.day);
	const weekday = (new Date(date).getUTCDay() + 6) % 7; // Monday = 0
	const thursday = date - weekday * DAY_MS + 3 * DAY_MS;
	const year = new Date(thursday).getUTCFullYear();
	const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
	return `${pad(year, 4)}-W${pad(week)}`;
};

/**
 * Key of the cap period containing an instant (local calendar of the zone).
 * @param {number} ms
 * @param {Period} period
 * @param {string} timeZone
 * @returns {string}
 */
export const periodKey = (ms, period, timeZone) => {
	const p = localParts(ms, timeZone);
	switch (period) {
		case 'day':
			return dayKey(ms, timeZone);
		case 'week':
			return isoWeek(p);
		case 'year':
			return pad(p.year, 4);
		default:
			return `${pad(p.year, 4)}-${pad(p.month)}`;
	}
};

/**
 * The `count` local month keys ending with the month of `ms` (newest first).
 * @param {number} ms
 * @param {number} count
 * @param {string} timeZone
 * @returns {string[]}
 */
export const recentMonthKeys = (ms, count, timeZone) => {
	const p = localParts(ms, timeZone);
	/** @type {string[]} */
	const keys = [];
	for (let i = 0; i < count; i += 1) {
		const index = p.year * 12 + (p.month - 1) - i;
		keys.push(`${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`);
	}
	return keys;
};

/**
 * UTC calendar-month addition clamped to the target month's last day (31 Jan + 1 month → 28/29 Feb).
 * @param {number} ms
 * @param {number} months may be negative
 * @returns {number}
 */
export const addMonths = (ms, months) => {
	const date = new Date(ms);
	const month = date.getUTCMonth() + months;
	const year = date.getUTCFullYear() + Math.floor(month / 12);
	const target = ((month % 12) + 12) % 12;
	const lastDay = new Date(Date.UTC(year, target + 1, 0)).getUTCDate();
	return Date.UTC(
		year,
		target,
		Math.min(date.getUTCDate(), lastDay),
		date.getUTCHours(),
		date.getUTCMinutes(),
		date.getUTCSeconds(),
		date.getUTCMilliseconds(),
	);
};

/**
 * ISO string of an instant.
 * @param {number} ms
 */
export const iso = (ms) => new Date(ms).toISOString();

/**
 * Milliseconds of an ISO string or epoch value (`NaN` when invalid).
 * @param {unknown} value
 * @returns {number}
 */
export const toMs = (value) => {
	if (typeof value === 'number') return value;
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'string') return Date.parse(value);
	return Number.NaN;
};

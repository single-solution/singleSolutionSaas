/**
 * Calendar maths in the website's time zone (pure; `Intl` only): quiet hours, per-day / per-week frequency-cap
 * periods and the next period start. The time zone is a feature (`dispatch.time_zone`, IANA, default UTC); an unknown
 * zone falls back to UTC so a typo never stops dispatch.
 * @module
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

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
 * A usable zone: the given one when known, else UTC.
 * @param {unknown} timeZone
 * @returns {string}
 */
export const zoneOr = (timeZone) => (isTimeZone(timeZone) ? /** @type {string} */ (timeZone) : 'UTC');

/**
 * Wall-clock parts of an instant in a zone (an unknown zone falls back to UTC).
 * @param {number} ms
 * @param {string} timeZone
 * @returns {LocalParts}
 */
export const localParts = (ms, timeZone) => {
	/** @type {Record<string, number>} */
	const parts = {};
	for (const part of formatFor(zoneOr(timeZone)).formatToParts(new Date(ms)))
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
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
const zoneOffset = (ms, timeZone) => {
	const p = localParts(ms, timeZone);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
};

/**
 * The instant of a local wall-clock time (the earlier one when a DST overlap makes it ambiguous; a time inside a DST
 * gap maps to the instant just after the gap).
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number }} local month is 1-based; day may overflow
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
 * `HH:MM` → minutes after midnight (null when malformed).
 * @param {unknown} text
 * @returns {number | null}
 */
export const parseClock = (text) => {
	const match = typeof text === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text) : null;
	return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

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
 * ISO week of the local date (`YYYY-Www`, weeks start on Monday).
 * @param {number} ms
 * @param {string} timeZone
 */
export const weekKey = (ms, timeZone) => {
	const p = localParts(ms, timeZone);
	const date = Date.UTC(p.year, p.month - 1, p.day);
	const weekday = (new Date(date).getUTCDay() + 6) % 7; // Monday = 0
	const thursday = date - weekday * DAY_MS + 3 * DAY_MS;
	const year = new Date(thursday).getUTCFullYear();
	const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
	return `${pad(year, 4)}-W${pad(week)}`;
};

/**
 * Start of the next local day.
 * @param {number} ms
 * @param {string} timeZone
 */
export const nextDayStart = (ms, timeZone) => {
	const p = localParts(ms, timeZone);
	return fromLocal({ year: p.year, month: p.month, day: p.day + 1 }, timeZone);
};

/**
 * Start of the next local ISO week (Monday 00:00).
 * @param {number} ms
 * @param {string} timeZone
 */
export const nextWeekStart = (ms, timeZone) => {
	const p = localParts(ms, timeZone);
	const weekday = (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
	return fromLocal({ year: p.year, month: p.month, day: p.day + (7 - weekday) }, timeZone);
};

/**
 * Quiet hours: a `[start, end)` local time-of-day window that wraps past midnight when start > end (start = end means
 * no quiet hours). Returns whether `ms` is inside and, if so, the instant the window ends.
 * @param {number} ms
 * @param {{ start: string, end: string, timeZone: string }} window
 * @returns {{ quiet: false } | { quiet: true, endsAt: number }}
 */
export const quietHours = (ms, { start, end, timeZone }) => {
	const s = parseClock(start);
	const e = parseClock(end);
	if (s === null || e === null || s === e) return { quiet: false };
	const p = localParts(ms, timeZone);
	const minute = p.hour * 60 + p.minute;
	const inside = s < e ? minute >= s && minute < e : minute >= s || minute < e;
	if (!inside) return { quiet: false };
	const endsTomorrow = s > e && minute >= s;
	const endsAt = fromLocal(
		{ year: p.year, month: p.month, day: p.day + (endsTomorrow ? 1 : 0), hour: Math.floor(e / 60), minute: e % 60 },
		timeZone,
	);
	return { quiet: true, endsAt: Math.max(endsAt, ms + 1) };
};

/**
 * ISO string of an instant.
 * @param {number} ms
 */
export const iso = (ms) => new Date(ms).toISOString();

/**
 * Milliseconds of an ISO string, Date or epoch value (`NaN` when invalid).
 * @param {unknown} value
 * @returns {number}
 */
export const toMs = (value) => {
	if (typeof value === 'number') return value;
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'string') return Date.parse(value);
	return Number.NaN;
};

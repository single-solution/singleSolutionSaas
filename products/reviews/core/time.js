/**
 * Time helpers (pure; `Intl` only): ISO conversion, local wall-clock parts in the website's zone, quiet-hour windows
 * and analytics buckets. Nothing assumes a region: the zone always comes from configuration (default UTC).
 * @module
 */

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Analytics bucket sizes. */
export const BUCKETS = Object.freeze(/** @type {const} */ (['day', 'week', 'month']));

/** @typedef {(typeof BUCKETS)[number]} Bucket */

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
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number }}
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
	};
};

/** @param {number} n @param {number} [width] */
const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * Minutes since local midnight of `HH:MM` (null when malformed; `24:00` is 1440).
 * @param {unknown} text
 * @returns {number | null}
 */
export const parseClock = (text) => {
	if (typeof text !== 'string') return null;
	const match = /^(\d{2}):(\d{2})$/.exec(text);
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null;
	return hours * 60 + minutes;
};

/**
 * Whether an instant falls in a local `[start, end)` window that may cross midnight (start = end: never).
 * @param {number} ms
 * @param {{ start?: string, end?: string } | null | undefined} hours
 * @param {string} timeZone
 * @returns {boolean}
 */
export const inWindow = (ms, hours, timeZone) => {
	const start = parseClock(hours?.start);
	const end = parseClock(hours?.end);
	if (start === null || end === null || start === end) return false;
	const p = localParts(ms, timeZone);
	const now = p.hour * 60 + p.minute;
	return start < end ? now >= start && now < end : now >= start || now < end;
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
 * Bucket key of an instant: `YYYY-MM-DD` (day), the Monday `YYYY-MM-DD` of its ISO week (week) or `YYYY-MM` (month).
 * @param {number} ms
 * @param {Bucket} bucket
 * @param {string} timeZone
 * @returns {string}
 */
export const bucketKey = (ms, bucket, timeZone) => {
	const p = localParts(ms, timeZone);
	if (bucket === 'month') return `${pad(p.year, 4)}-${pad(p.month)}`;
	if (bucket === 'week') {
		const date = Date.UTC(p.year, p.month - 1, p.day);
		const monday = date - ((new Date(date).getUTCDay() + 6) % 7) * DAY_MS;
		return new Date(monday).toISOString().slice(0, 10);
	}
	return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
};

/**
 * Every bucket key from `from` to `to` (inclusive), oldest first — gaps are filled by the caller with zeros.
 * @param {number} from
 * @param {number} to
 * @param {Bucket} bucket
 * @param {string} timeZone
 * @returns {string[]}
 */
export const bucketKeys = (from, to, bucket, timeZone) => {
	/** @type {string[]} */
	const keys = [];
	// one step per day reaches every local day (zone offsets move by hours, never by a day)
	for (let at = from; at <= to; at += DAY_MS) {
		const key = bucketKey(at, bucket, timeZone);
		if (keys[keys.length - 1] !== key) keys.push(key);
	}
	const last = bucketKey(to, bucket, timeZone);
	if (keys[keys.length - 1] !== last) keys.push(last);
	return keys;
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

/**
 * ISO string of a stored date (Date or string), else null.
 * @param {unknown} value
 * @returns {string | null}
 */
export const isoOrNull = (value) => {
	const ms = toMs(value);
	return Number.isFinite(ms) ? iso(ms) : null;
};

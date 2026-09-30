/**
 * Calendar and time-zone helpers. Parsing is hand-written (no `Date.parse` quirks); zone conversion uses
 * `Intl.DateTimeFormat`, so any IANA zone known to the runtime works and nothing is hard-coded.
 */

export const DAY_MS = 86400000;
export const MIN_DATE_MS = -62167219200000; // 0000-01-01T00:00:00Z
export const MAX_DATE_MS = 253402300799999; // 9999-12-31T23:59:59.999Z

/**
 * Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm).
 * @param {number} year @param {number} month 1-12 @param {number} day
 * @returns {number}
 */
export function daysFromCivil(year, month, day) {
	const y = month <= 2 ? year - 1 : year;
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

/** @param {number} year @param {number} month @returns {number} */
function daysInMonth(year, month) {
	if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Parse an ISO-8601 date / date-time starting at `pos`.
 * Grammar: `YYYY-MM-DD` [ `T` `HH:MM` [`:SS` [`.fff…`]] [ `Z` | `±HH:MM` | `±HHMM` ] ]. No zone means UTC.
 * @param {string} s
 * @param {number} pos
 * @param {boolean} loose Also accept a space instead of `T` (used for context data, not for literals).
 * @returns {{ ms: number, end: number } | null}
 */
export function parseIsoPrefix(s, pos, loose) {
	let i = pos;
	/** @param {number} len */
	const num = (len) => {
		if (i + len > s.length) return -1;
		let v = 0;
		for (let k = 0; k < len; k++) {
			const c = s.charCodeAt(i + k);
			if (c < 48 || c > 57) return -1;
			v = v * 10 + c - 48;
		}
		i += len;
		return v;
	};
	/** @param {string} c */
	const eat = (c) => {
		if (s.charAt(i) !== c) return false;
		i++;
		return true;
	};
	const digitAt = (/** @type {number} */ j) => s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57;

	const year = num(4);
	if (year < 0 || !eat('-')) return null;
	const month = num(2);
	if (month < 1 || month > 12 || !eat('-')) return null;
	const day = num(2);
	if (day < 1 || day > daysInMonth(year, month)) return null;
	let ms = daysFromCivil(year, month, day) * DAY_MS;
	const sep = s.charAt(i);
	if (!(sep === 'T' || sep === 't' || (loose && sep === ' ' && digitAt(i + 1)))) return { ms, end: i };
	i++;
	const hour = num(2);
	if (hour < 0 || hour > 23 || !eat(':')) return null;
	const minute = num(2);
	if (minute < 0 || minute > 59) return null;
	ms += hour * 3600000 + minute * 60000;
	if (eat(':')) {
		const second = num(2);
		if (second < 0 || second > 59) return null;
		ms += second * 1000;
		if (eat('.')) {
			const fs = i;
			while (digitAt(i)) i++;
			if (i === fs) return null;
			ms += Number(s.slice(fs, Math.min(i, fs + 3)).padEnd(3, '0'));
		}
	}
	const z = s.charAt(i);
	if (z === 'Z' || z === 'z') i++;
	else if (z === '+' || z === '-') {
		i++;
		const oh = num(2);
		if (oh < 0 || oh > 23) return null;
		eat(':');
		const om = num(2);
		if (om < 0 || om > 59) return null;
		const offset = (oh * 60 + om) * 60000;
		ms += z === '+' ? -offset : offset;
	}
	return { ms, end: i };
}

/**
 * Strictly parse a whole string as an ISO date/date-time (space separator allowed).
 * @param {string} s
 * @returns {number | null} Epoch milliseconds.
 */
export function parseIso(s) {
	const r = parseIsoPrefix(s, 0, true);
	return r !== null && r.end === s.length ? r.ms : null;
}

/**
 * Canonical literal text for an epoch-ms instant: `@YYYY-MM-DD` at UTC midnight, else `@YYYY-MM-DDTHH:MM[:SS[.mmm]]Z`.
 * @param {number} ms
 * @returns {string}
 */
export function formatDateLiteral(ms) {
	const iso = new Date(ms).toISOString();
	if (((ms % DAY_MS) + DAY_MS) % DAY_MS === 0) return `@${iso.slice(0, 10)}`;
	let body = iso.slice(0, 23); // YYYY-MM-DDTHH:MM:SS.mmm
	if (body.endsWith('.000')) body = body.slice(0, 19);
	if (body.length === 19 && body.endsWith(':00')) body = body.slice(0, 16);
	return `@${body}Z`;
}

/** @type {Map<string, Intl.DateTimeFormat | null>} */
const formatters = new Map();

/**
 * Cached formatter for a zone, or null when the runtime does not know the zone.
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat | null}
 */
function formatterFor(timeZone) {
	const cached = formatters.get(timeZone);
	if (cached !== undefined) return cached;
	/** @type {Intl.DateTimeFormat | null} */
	let fmt = null;
	try {
		fmt = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric',
			weekday: 'short',
		});
	} catch {
		fmt = null;
	}
	if (formatters.size >= 200) formatters.clear();
	formatters.set(timeZone, fmt);
	return fmt;
}

/**
 * @param {unknown} timeZone
 * @returns {boolean}
 */
export function isValidTimeZone(timeZone) {
	return typeof timeZone === 'string' && timeZone.length > 0 && timeZone.length <= 64 && formatterFor(timeZone) !== null;
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * @typedef {object} ZonedParts
 * @property {number} year
 * @property {number} month 1-12
 * @property {number} day 1-31
 * @property {number} hour 0-23
 * @property {number} minute 0-59
 * @property {number} second 0-59
 * @property {number} weekday ISO weekday, 1 = Monday … 7 = Sunday
 * @property {string} weekdayName `mon` … `sun`
 */

/**
 * Wall-clock parts of an instant in a zone.
 * @param {number} ms
 * @param {string} timeZone
 * @returns {ZonedParts | null} null for an unknown zone.
 */
export function zonedParts(ms, timeZone) {
	if (timeZone === 'UTC') {
		const d = new Date(ms);
		const wd = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
		return {
			year: d.getUTCFullYear(),
			month: d.getUTCMonth() + 1,
			day: d.getUTCDate(),
			hour: d.getUTCHours(),
			minute: d.getUTCMinutes(),
			second: d.getUTCSeconds(),
			weekday: wd,
			weekdayName: WEEKDAYS[wd - 1] ?? 'mon',
		};
	}
	const fmt = formatterFor(timeZone);
	if (fmt === null) return null;
	/** @type {Record<string, string>} */
	const p = {};
	for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
	const name = (p.weekday ?? 'Mon').slice(0, 3).toLowerCase();
	const wd = WEEKDAYS.indexOf(name) + 1;
	return {
		year: Number(p.year),
		month: Number(p.month),
		day: Number(p.day),
		hour: Number(p.hour) % 24,
		minute: Number(p.minute),
		second: Number(p.second),
		weekday: wd,
		weekdayName: name,
	};
}

/**
 * Parse a wall-clock `HH:MM` (00:00 … 23:59, plus `24:00` as an end bound) to minutes since midnight.
 * @param {unknown} s
 * @returns {number | null}
 */
export function parseClock(s) {
	if (typeof s !== 'string' || s.length !== 5 || s.charAt(2) !== ':') return null;
	if (s === '24:00') return 1440;
	const h = Number(s.slice(0, 2));
	const m = Number(s.slice(3));
	const digits = /^\d\d:\d\d$/.test(s);
	if (!digits || h > 23 || m > 59) return null;
	return h * 60 + m;
}

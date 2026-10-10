/**
 * Time in a zone (pure): weekly working-hour windows (overnight windows belong to their start day, `24:00` = end of
 * day), the next opening, and the calendar day and month keys (token caps, reports) and the start of a local day, all
 * in the business.json time zone (PLAN 0.8.10 K8) with `@ss/contracts`' zone helpers.
 * @module
 */
import { zonedDay, zonedDayStart, zonedParts } from '@ss/contracts/format';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Week days in `Intl` short English order, as working-hour windows name them. */
export const WEEK_DAYS = Object.freeze(/** @type {const} */ (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']));

/** @typedef {(typeof WEEK_DAYS)[number]} WeekDay */
/** @typedef {{ days: string[], start: string, end: string }} HoursWindow */

/** Zones already checked (the office-hours search asks thousands of times). @type {Map<string, boolean>} */
const known = new Map();

/**
 * True when the runtime knows `timeZone`.
 * @param {unknown} timeZone
 * @returns {timeZone is string}
 */
const isTimeZone = (timeZone) => {
	if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
	let ok = known.get(timeZone);
	if (ok === undefined) {
		try {
			new Intl.DateTimeFormat('en-US', { timeZone });
			ok = true;
		} catch {
			ok = false;
		}
		if (known.size >= 100) known.clear();
		known.set(timeZone, ok);
	}
	return ok;
};

/**
 * A known zone, else the fallback, else UTC.
 * @param {unknown} timeZone
 * @param {unknown} [fallback]
 * @returns {string}
 */
export const zoneOr = (timeZone, fallback = 'UTC') => {
	if (isTimeZone(timeZone)) return timeZone;
	return isTimeZone(fallback) ? fallback : 'UTC';
};

/**
 * `HH:MM` → minutes of the day (`24:00` = 1440), or null.
 * @param {unknown} text
 * @returns {number | null}
 */
const minutesOf = (text) => {
	const match = typeof text === 'string' ? /^(\d{2}):(\d{2})$/.exec(text) : null;
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) return null;
	return hours * 60 + minutes;
};

/**
 * Is an instant inside the weekly windows? An empty list means always open. A window whose end is not after its start
 * runs past midnight and belongs to its start day.
 * @param {readonly HoursWindow[] | null | undefined} windows
 * @param {number} ms
 * @param {string} timeZone
 * @returns {boolean}
 */
export const isOpenAt = (windows, ms, timeZone) => {
	if (!windows || windows.length === 0) return true;
	const now = zonedParts(ms, zoneOr(timeZone));
	const minute = now.hour * 60 + now.minute;
	const today = WEEK_DAYS[now.weekday];
	const yesterday = WEEK_DAYS[(now.weekday + 6) % 7];
	return windows.some((slot) => {
		const start = minutesOf(slot.start);
		const end = minutesOf(slot.end);
		if (start === null || end === null || !Array.isArray(slot.days)) return false;
		if (end > start) return slot.days.includes(/** @type {string} */ (today)) && minute >= start && minute < end;
		// overnight (or 24 h when start === end): today's part and the tail of yesterday's slot
		return (
			(slot.days.includes(/** @type {string} */ (today)) && minute >= start) ||
			(slot.days.includes(/** @type {string} */ (yesterday)) && minute < end)
		);
	});
};

/**
 * The first open minute at or after `ms` (within `horizonDays`), or null when the windows never open.
 * @param {readonly HoursWindow[] | null | undefined} windows
 * @param {number} ms
 * @param {string} timeZone
 * @param {{ horizonDays?: number }} [options]
 * @returns {number | null}
 */
export const nextOpenAt = (windows, ms, timeZone, { horizonDays = 8 } = {}) => {
	if (isOpenAt(windows, ms, timeZone)) return ms;
	// minute steps: windows are minute-aligned, so a one-minute window is never skipped (≈ 11 520 checks for 8 days)
	for (let t = Math.ceil(ms / MINUTE_MS) * MINUTE_MS; t <= ms + horizonDays * DAY_MS; t += MINUTE_MS) {
		if (isOpenAt(windows, t, timeZone)) return t;
	}
	return null;
};

/**
 * Calendar month key `YYYY-MM` of an instant in a zone (monthly budgets).
 * @param {number} ms
 * @param {string} timeZone
 */
export const monthKey = (ms, timeZone) => zonedDay(ms, zoneOr(timeZone)).slice(0, 7);

/**
 * Calendar day key `YYYY-MM-DD` of an instant in a zone.
 * @param {number} ms
 * @param {string} timeZone
 */
export const dayKey = (ms, timeZone) => zonedDay(ms, zoneOr(timeZone));

/**
 * The UTC instant of local midnight starting a calendar day (`YYYY-MM-DD`) in a zone.
 * @param {string} date
 * @param {string} timeZone
 */
export const dayStart = (date, timeZone) => zonedDayStart(date, zoneOr(timeZone));

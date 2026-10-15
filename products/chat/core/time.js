/**
 * Time in a zone (pure): office hours as weekly windows by ISO 8601 weekday number (1 = Monday … 7 = Sunday; overnight
 * windows belong to their start day, `24:00` = end of day) with dated exceptions that replace a day's hours (C9), the
 * next opening, and the calendar day and month keys (token caps, reports) and the start of a local day, all in the
 * business.json time zone (PLAN 0.8.10 K8) with `@ss/contracts`' zone helpers. No weekday names: screens name days in
 * the viewer's language with `Intl`.
 * @module
 */
import { zonedDay, zonedDayStart, zonedParts } from '@ss/contracts/format';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** @typedef {{ start: string, end: string }} TimeRange `HH:MM`; an end not after the start runs past midnight */
/** @typedef {TimeRange & { day: number }} HoursWindow one weekly window: `day` 1 = Monday … 7 = Sunday (ISO 8601) */
/** @typedef {{ date: string, name: string, hours: TimeRange[] }} HoursException a date's own hours (none = closed) */
/**
 * @typedef {{ weekly: readonly HoursWindow[], exceptions?: readonly HoursException[] }} OfficeHours no weekly windows =
 *   open all day on every day without an exception
 */

/** Zones already checked (the office-hours search asks many times). @type {Map<string, boolean>} */
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
export const minutesOf = (text) => {
	const match = typeof text === 'string' ? /^(\d{2}):(\d{2})$/.exec(text) : null;
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) return null;
	return hours * 60 + minutes;
};

/**
 * A calendar day moved by whole days (`YYYY-MM-DD`).
 * @param {string} date
 * @param {number} days
 */
const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The ISO weekday (1 = Monday … 7 = Sunday) of a calendar day.
 * @param {string} date
 */
const isoWeekday = (date) => {
	const day = new Date(`${date}T00:00:00Z`).getUTCDay();
	return day === 0 ? 7 : day;
};

/** The whole day, for a website with no weekly windows. */
const ALL_DAY = Object.freeze([Object.freeze({ start: '00:00', end: '24:00' })]);

/**
 * The windows of one calendar day: its exception's hours when it has one, else its weekday's windows.
 * @param {OfficeHours} hours
 * @param {string} date
 * @returns {readonly TimeRange[]}
 */
const windowsOn = (hours, date) => {
	const exception = (hours.exceptions ?? []).find((each) => each.date === date);
	if (exception) return exception.hours;
	if (hours.weekly.length === 0) return ALL_DAY;
	const day = isoWeekday(date);
	return hours.weekly.filter((slot) => slot.day === day);
};

/**
 * Is an instant inside the office hours? No weekly windows and no exceptions means always open. A window whose end is
 * not after its start runs past midnight and belongs to its start day (24 hours when they are equal).
 * @param {OfficeHours | null | undefined} hours
 * @param {number} ms
 * @param {string} timeZone
 * @returns {boolean}
 */
export const isOpenAt = (hours, ms, timeZone) => {
	if (!hours || (hours.weekly.length === 0 && (hours.exceptions ?? []).length === 0)) return true;
	const zone = zoneOr(timeZone);
	const now = zonedParts(ms, zone);
	const minute = now.hour * 60 + now.minute;
	const today = zonedDay(ms, zone);
	const inToday = windowsOn(hours, today).some((slot) => {
		const start = minutesOf(slot.start);
		const end = minutesOf(slot.end);
		if (start === null || end === null) return false;
		return end > start ? minute >= start && minute < end : minute >= start;
	});
	if (inToday) return true;
	// the tail of yesterday's overnight windows
	return windowsOn(hours, shiftDate(today, -1)).some((slot) => {
		const start = minutesOf(slot.start);
		const end = minutesOf(slot.end);
		return start !== null && end !== null && end <= start && minute < end;
	});
};

/** How far ahead the next opening is looked for (days): long closures included. */
const HORIZON_DAYS = 400;

/**
 * The instant of a wall-clock minute on a calendar day in a zone (a minute a clock change skips: the next one).
 * @param {string} date
 * @param {number} minutes
 * @param {string} zone
 */
const instantOf = (date, minutes, zone) => {
	const guess = zonedDayStart(date, zone) + minutes * MINUTE_MS;
	const parts = zonedParts(guess, zone);
	// a day of 23 or 25 hours: the guess is an hour off the wall clock (or already on the next day)
	const shown = (zonedDay(guess, zone) === date ? 0 : 1440) + parts.hour * 60 + parts.minute;
	return guess + (minutes - shown) * MINUTE_MS;
};

/**
 * The first open minute at or after `ms` (within {@link HORIZON_DAYS} days), or null when the hours never open.
 * @param {OfficeHours | null | undefined} hours
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number | null}
 */
export const nextOpenAt = (hours, ms, timeZone) => {
	if (isOpenAt(hours, ms, timeZone)) return ms;
	const zone = zoneOr(timeZone);
	const today = zonedDay(ms, zone);
	for (let offset = 0; offset <= HORIZON_DAYS; offset += 1) {
		const date = shiftDate(today, offset);
		const starts = windowsOn(/** @type {OfficeHours} */ (hours), date)
			.map((slot) => minutesOf(slot.start))
			.filter((start) => start !== null && start < 1440)
			.sort((a, b) => Number(a) - Number(b));
		for (const start of starts) {
			const at = instantOf(date, Number(start), zone);
			if (at < ms) continue;
			// a window that starts in a skipped hour opens when the clock gets there
			for (let t = at; t <= at + 3 * 60 * MINUTE_MS; t += MINUTE_MS) if (isOpenAt(hours, t, zone)) return t;
		}
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

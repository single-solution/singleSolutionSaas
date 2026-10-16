/**
 * Bookings (PLAN 0.8.8: services booked in simple slots — a duration, weekly hours, no double booking; fixed-choices
 * E30: schedules per service or place, with dated exceptions). The merchant keeps the `booking_schedules` list:
 * `[{ key, name, weekly: [{ day, start, end }], exceptions: [{ date, name, hours: [{ start, end }] }] }]`, in the shape of
 * Chat's office hours: `day` is the ISO weekday (1 = Monday … 7 = Sunday), times are `HH:MM` (`24:00` = the end of the
 * day; a period ends after it starts), and a dated exception (a holiday, special hours) replaces that date's weekly
 * hours (no hours = closed all day). A schedule may stand for a place, a person or a service: each service names its
 * schedule (`booking.schedule`, '' = the first of the list). Times are in the time zone of the website's business.json.
 * A product's slots are back-to-back periods of its `durationMinutes` from the start of each opening period, ending
 * inside it. Booked slots are kept with a unique index (the ledger), so one start of one product is booked once.
 * Time-zone arithmetic is `zonedParts` of `@ss/contracts/format` (no I/O); an unknown zone is read as UTC.
 * @module
 */
import { zonedParts } from '@ss/contracts/format';
import { isObject } from '@ss/contracts/util';

/** @typedef {{ start: string, end: string }} TimeRange `HH:MM`, the end after the start (`24:00` = the end of the day) */
/** @typedef {TimeRange & { day: number }} HoursWindow one weekly window: `day` 1 = Monday … 7 = Sunday (ISO 8601) */
/** @typedef {{ date: string, name: string, hours: TimeRange[] }} HoursException a date's own hours (none = closed) */
/** @typedef {{ weekly: HoursWindow[], exceptions: HoursException[] }} Hours */
/** @typedef {Hours & { key: string, name: string }} BookingSchedule */

/** At most this many schedules, weekly windows per schedule, dated exceptions per schedule and windows on one date. */
const SCHEDULE_LIMITS = Object.freeze({ schedules: 20, windows: 70, exceptions: 200, perDay: 6, name: 80 });
/** A slot list covers at most this many days. */
export const MAX_SLOT_DAYS = 14;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[a-z][a-z0-9_]{1,39}$/;
const DAY_MS = 86_400_000;

/** @param {string} time 'HH:MM' @returns {number} minutes after midnight ('24:00' = 1440) */
const minutesOf = (time) => (time === '24:00' ? 1440 : Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)));

/**
 * A time range as saved, or null: two `HH:MM` times, the end after the start (`24:00` = the end of the day).
 * @param {unknown} item
 * @returns {TimeRange | null}
 */
const rangeOf = (item) => {
	if (!isObject(item)) return null;
	const { start, end } = /** @type {Record<string, unknown>} */ (item);
	if (typeof start !== 'string' || !TIME.test(start) || typeof end !== 'string' || !(TIME.test(end) || end === '24:00'))
		return null;
	return minutesOf(start) < minutesOf(end) ? { start, end } : null;
};

/** @param {TimeRange[]} ranges whether two of them overlap */
const overlapping = (ranges) =>
	ranges.some((a, i) =>
		ranges.some((b, j) => j > i && minutesOf(a.start) < minutesOf(b.end) && minutesOf(b.start) < minutesOf(a.end)),
	);

/** The schedule until the merchant saves the list: one, without hours (nothing can be booked until they are set). */
export const defaultSchedules = () => [{ key: 'main', name: 'Main', weekly: [], exceptions: [] }];

/**
 * Check the schedules the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: BookingSchedule[] } | { ok: false, errors: string[] }}
 */
export const checkBookingSchedules = (value) => {
	if (!Array.isArray(value) || value.length === 0 || value.length > SCHEDULE_LIMITS.schedules)
		return { ok: false, errors: [`A list of 1–${SCHEDULE_LIMITS.schedules} schedules is expected.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {BookingSchedule[]} */
	const out = [];
	const keys = new Set();
	for (const raw of value) {
		const entry = isObject(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
		const key = typeof entry.key === 'string' ? entry.key : '';
		if (!KEY.test(key)) {
			errors.push(`Schedule key '${key}' must be 2–40 lowercase letters, digits or _ starting with a letter.`);
			continue;
		}
		const at = `Schedule '${key}'`;
		if (keys.has(key)) errors.push(`${at} is listed twice.`);
		keys.add(key);
		const name = typeof entry.name === 'string' ? entry.name.trim() : '';
		if (!name || name.length > SCHEDULE_LIMITS.name)
			errors.push(`${at} needs a name of at most ${SCHEDULE_LIMITS.name} characters.`);
		const weeklyRaw = entry.weekly ?? [];
		/** @type {HoursWindow[]} */
		const weekly = [];
		if (!Array.isArray(weeklyRaw) || weeklyRaw.length > SCHEDULE_LIMITS.windows)
			errors.push(`${at}: weekly is a list of at most ${SCHEDULE_LIMITS.windows} windows.`);
		else
			weeklyRaw.forEach((item, index) => {
				const range = rangeOf(item);
				const day = isObject(item) ? /** @type {Record<string, unknown>} */ (item).day : undefined;
				if (!range || !Number.isInteger(day) || Number(day) < 1 || Number(day) > 7)
					return void errors.push(
						`${at} period ${index + 1}: a day from 1 (Monday) to 7 (Sunday), and a start and a later end as HH:MM (24:00 = the end of the day).`,
					);
				weekly.push({ day: Number(day), ...range });
			});
		for (let day = 1; day <= 7; day += 1)
			if (overlapping(weekly.filter((period) => period.day === day)))
				errors.push(`${at}: two windows of the same day overlap.`);
		const exceptionsRaw = entry.exceptions ?? [];
		/** @type {HoursException[]} */
		const exceptions = [];
		const dates = new Set();
		if (!Array.isArray(exceptionsRaw) || exceptionsRaw.length > SCHEDULE_LIMITS.exceptions)
			errors.push(`${at}: exceptions is a list of at most ${SCHEDULE_LIMITS.exceptions} dates.`);
		else
			exceptionsRaw.forEach((item, index) => {
				const where = `${at} date ${index + 1}`;
				const exception = isObject(item) ? /** @type {Record<string, unknown>} */ (item) : {};
				const date = typeof exception.date === 'string' ? exception.date : '';
				const real = DATE.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
				if (!real || dates.has(date)) return void errors.push(`${where}: a real date as YYYY-MM-DD, once.`);
				dates.add(date);
				const label = typeof exception.name === 'string' ? exception.name.trim() : '';
				if (label.length > SCHEDULE_LIMITS.name)
					return void errors.push(`${where}: a name of at most ${SCHEDULE_LIMITS.name} characters.`);
				const given = exception.hours ?? [];
				const hours = Array.isArray(given) && given.length <= SCHEDULE_LIMITS.perDay ? given.map(rangeOf) : [null];
				if (hours.some((range) => range === null) || overlapping(/** @type {TimeRange[]} */ (hours)))
					return void errors.push(
						`${where}: up to ${SCHEDULE_LIMITS.perDay} windows that do not overlap, each a start and a later end as HH:MM (none = closed all day).`,
					);
				exceptions.push({ date, name: label, hours: /** @type {TimeRange[]} */ (hours) });
			});
		out.push({ key, name, weekly, exceptions: exceptions.sort((a, b) => a.date.localeCompare(b.date)) });
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: out };
};

/**
 * The schedule a service is booked on: the one it names, '' = the first of the list; null when it names one the list no
 * longer has (nothing can be booked).
 * @param {BookingSchedule[]} schedules
 * @param {string | undefined} key
 * @returns {BookingSchedule | null}
 */
export const scheduleOf = (schedules, key) => (key ? schedules.find((entry) => entry.key === key) : schedules[0]) ?? null;

/** The zone's offset from UTC at an instant, in ms. @param {number} at @param {string} timeZone */
const offsetAt = (at, timeZone) => {
	const w = zonedParts(at, timeZone);
	return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - (at - (((at % 1000) + 1000) % 1000));
};

/**
 * The instant of a wall-clock time in a time zone (a time skipped by a clock change moves forward).
 * @param {{ year: number, month: number, day: number }} date
 * @param {number} minutes after midnight
 * @param {string} timeZone
 */
export const instantOf = (date, minutes, timeZone) => {
	const guess = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
	const first = guess - offsetAt(guess, timeZone);
	const second = guess - offsetAt(first, timeZone);
	return second;
};

/**
 * The opening windows of a date: its dated exception's hours, else the weekly windows of its weekday.
 * @param {Hours} hours @param {{ year: number, month: number, day: number }} date @param {number} weekday 0 = Sunday
 * @returns {TimeRange[]}
 */
const windowsOn = (hours, date, weekday) => {
	const key = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
	const exception = hours.exceptions.find((entry) => entry.date === key);
	if (exception) return exception.hours;
	const iso = weekday === 0 ? 7 : weekday;
	return hours.weekly.filter((period) => period.day === iso);
};

/**
 * Every slot of a product between two instants: back-to-back periods of `durationMinutes` from the start of each
 * opening period of each date (its dated exception, else its weekday's windows), ending inside it, starting at or after
 * `from` and before `to`.
 * @param {{ hours: Hours, durationMinutes: number, from: number, to: number, timeZone: string }} input epoch ms
 * @returns {Array<{ start: number, end: number }>}
 */
export const slotsBetween = ({ hours, durationMinutes, from, to, timeZone }) => {
	if (!(durationMinutes > 0) || to <= from || (hours.weekly.length === 0 && hours.exceptions.length === 0)) return [];
	/** @type {Array<{ start: number, end: number }>} */
	const out = [];
	const first = zonedParts(from - DAY_MS, timeZone);
	const days = Math.ceil((to - from) / DAY_MS) + 2;
	for (let n = 0; n <= days; n += 1) {
		const noon = new Date(Date.UTC(first.year, first.month - 1, first.day + n, 12));
		const date = { year: noon.getUTCFullYear(), month: noon.getUTCMonth() + 1, day: noon.getUTCDate() };
		for (const period of [...windowsOn(hours, date, noon.getUTCDay())].sort(
			(a, b) => minutesOf(a.start) - minutesOf(b.start),
		)) {
			const close = minutesOf(period.end);
			for (let m = minutesOf(period.start); m + durationMinutes <= close; m += durationMinutes) {
				const start = instantOf(date, m, timeZone);
				if (start >= from && start < to) out.push({ start, end: start + durationMinutes * 60_000 });
			}
		}
	}
	const seen = new Set();
	return out.filter((slot) => (seen.has(slot.start) ? false : (seen.add(slot.start), true))).sort((a, b) => a.start - b.start);
};

/**
 * Whether `start` is the start of one of the product's slots.
 * @param {{ hours: Hours, durationMinutes: number, start: number, timeZone: string }} input
 * @returns {{ start: number, end: number } | null}
 */
export const slotAt = ({ hours, durationMinutes, start, timeZone }) =>
	slotsBetween({ hours, durationMinutes, from: start, to: start + 1, timeZone })[0] ?? null;

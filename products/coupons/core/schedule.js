/**
 * Validity windows of a coupon (pure), ported from ibrahimMobiles `offerSchedule` and generalised: any IANA zone
 * instead of the store zone, several weekly windows instead of one, weekday keys instead of indexes.
 *
 * - `starts_at` / `ends_at` are inclusive instants (ISO-8601).
 * - A window `{ days?, start?, end? }` is a local time-of-day range (`HH:MM`, minute resolution, both ends inclusive).
 *   `start > end` wraps past midnight (22:00–02:00) and the after-midnight part **belongs to the day the window
 *   started on** (a Friday-night window still matches at 01:00 on Saturday). Open ends (`start` only / `end` only) are
 *   allowed; `24:00` is accepted as an end.
 * - No windows = any time inside the date range; several windows = any of them.
 * @module
 */
import { clockIn, isTimeZone, toMs, WEEKDAYS } from './time.js';

const DAYS_IN_WEEK = 7;
const MINUTES_IN_DAY = 24 * 60;
const CLOCK = /^([01]\d|2[0-4]):([0-5]\d)$/;

/** @typedef {{ days?: string[], start?: string, end?: string }} TimeWindow */
/** @typedef {{ starts_at?: string | null, ends_at?: string | null, time_zone?: string | null, windows?: TimeWindow[] }} Validity */
/** @typedef {'active' | 'not_started' | 'ended' | 'outside_schedule'} ValidityState */

/**
 * Minutes since midnight of an `HH:MM` string (null when absent or malformed; `24:00` = 1440).
 * @param {unknown} value
 * @returns {number | null}
 */
export const parseClock = (value) => {
	if (typeof value !== 'string') return null;
	const match = CLOCK.exec(value);
	if (!match) return null;
	const minutes = Number(match[1]) * 60 + Number(match[2]);
	return minutes > MINUTES_IN_DAY ? null : minutes;
};

/**
 * Does a weekly window contain the wall clock `{ weekday, minutes }`?
 * @param {TimeWindow} slot
 * @param {{ weekday: number, minutes: number }} clock
 * @returns {boolean}
 */
export const windowMatches = (slot, clock) => {
	const start = parseClock(slot.start);
	const end = parseClock(slot.end);
	let day = clock.weekday;
	if (start !== null || end !== null) {
		const current = clock.minutes;
		if (start !== null && end !== null && start > end) {
			const evening = current >= start;
			const morning = current <= end;
			if (!evening && !morning) return false;
			if (morning && !evening) day = (clock.weekday + DAYS_IN_WEEK - 1) % DAYS_IN_WEEK;
		} else {
			if (start !== null && current < start) return false;
			if (end !== null && current > end) return false;
		}
	}
	const days = Array.isArray(slot.days) ? slot.days : [];
	return days.length === 0 || days.includes(/** @type {string} */ (WEEKDAYS[day]));
};

/**
 * The zone a coupon's windows are read in: its own valid `time_zone`, else the website's, else UTC.
 * @param {Validity | null | undefined} validity
 * @param {string} websiteZone
 */
export const zoneOf = (validity, websiteZone) => {
	const own = validity?.time_zone;
	if (isTimeZone(own)) return own;
	return isTimeZone(websiteZone) ? websiteZone : 'UTC';
};

/**
 * State of a coupon's validity at an instant.
 * @param {Validity | null | undefined} validity
 * @param {number} now
 * @param {string} websiteZone
 * @returns {ValidityState}
 */
export const validityState = (validity, now, websiteZone) => {
	if (!validity) return 'active';
	const startsAt = validity.starts_at ? toMs(validity.starts_at) : Number.NaN;
	const endsAt = validity.ends_at ? toMs(validity.ends_at) : Number.NaN;
	if (Number.isFinite(startsAt) && now < startsAt) return 'not_started';
	if (Number.isFinite(endsAt) && now > endsAt) return 'ended';
	const windows = Array.isArray(validity.windows) ? validity.windows : [];
	if (windows.length === 0) return 'active';
	const clock = clockIn(now, zoneOf(validity, websiteZone));
	return windows.some((slot) => windowMatches(slot, clock)) ? 'active' : 'outside_schedule';
};

/**
 * Convenience predicate.
 * @param {Validity | null | undefined} validity
 * @param {number} now
 * @param {string} websiteZone
 */
export const isActiveAt = (validity, now, websiteZone) => validityState(validity, now, websiteZone) === 'active';

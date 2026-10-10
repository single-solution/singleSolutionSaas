/**
 * Calendar days in the business time zone (PLAN 0.8.10 K8: every calendar rule uses the business.json `timeZone`, UTC
 * when it is missing): where a `YYYY-MM-DD` day starts and ends. Report ranges use it on the server, and the admin
 * widgets' date pickers to turn a picked day into the instants they send. Pure and browser-safe, no I/O.
 * @module
 */
import { zonedDayStart } from '@ss/contracts/format';

/** A calendar day as `YYYY-MM-DD`. */
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 86_400_000;

/**
 * Where a day starts and ends (the next day's start, exclusive) in a time zone, in epoch ms; null when the value is
 * not a day of the calendar.
 * @param {unknown} day `YYYY-MM-DD`
 * @param {string | null | undefined} timeZone
 * @returns {{ start: number, end: number } | null}
 */
export const dayBounds = (day, timeZone) => {
	if (typeof day !== 'string' || !DAY.test(day)) return null;
	const start = zonedDayStart(day, timeZone);
	if (Number.isNaN(start)) return null;
	const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
	return { start, end: zonedDayStart(next, timeZone) };
};

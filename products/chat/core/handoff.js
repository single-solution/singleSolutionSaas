/**
 * Handoff (pure, PLAN 0.8.3 Handoff): the visitor asks (button or phrases), a keyword matches, the AI escalates, or N
 * AI failures happen in a row. Office hours (C9) are the merchant's weekly windows by ISO weekday number (1 = Monday …
 * 7 = Sunday, `HH:MM` with minutes) and dated exceptions (holidays closed all day, or a day's own hours), both lists
 * in the business.json time zone; outside them the visitor is told when staff are back (in the website's Format).
 * @module
 */
import { containsPhrase } from './text.js';
import { isOpenAt, minutesOf, nextOpenAt } from './time.js';

/** @typedef {import('./time.js').HoursWindow} HoursWindow */
/** @typedef {import('./time.js').HoursException} HoursException */
/** @typedef {import('./time.js').OfficeHours} OfficeHours */

/** Most weekly windows, dated exceptions, and windows on one exception day. */
const HOURS_LIMITS = Object.freeze({ windows: 50, exceptions: 200, perDay: 6, name: 80 });

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Why a visitor message hands off, or null: the visitor asks for a person, or a handoff keyword matches.
 * @param {string} text
 * @param {{ askPhrases: string[], keywords: string[] }} settings
 * @returns {'asked' | 'keyword' | null}
 */
export const handoffReason = (text, { askPhrases, keywords }) => {
	if (askPhrases.some((phrase) => containsPhrase(text, phrase))) return 'asked';
	if (keywords.some((keyword) => containsPhrase(text, keyword))) return 'keyword';
	return null;
};

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A time range as saved, or null: two `HH:MM` times (`24:00` = the end of the day); an end not after the start runs
 * past midnight (24 hours when they are equal).
 * @param {unknown} item
 * @returns {import('./time.js').TimeRange | null}
 */
const rangeOf = (item) => {
	if (!isObject(item)) return null;
	const { start, end } = /** @type {Record<string, unknown>} */ (item);
	const from = minutesOf(start);
	if (from === null || from >= 1440 || minutesOf(end) === null) return null;
	return { start: String(start), end: String(end) };
};

/**
 * Check the weekly office hours a merchant saves: windows `{ day, start, end }`, `day` the ISO weekday number.
 * @param {unknown} items
 * @returns {{ ok: true, value: HoursWindow[] } | { ok: false, errors: string[] }}
 */
export const checkOfficeHours = (items) => {
	if (!Array.isArray(items) || items.length > HOURS_LIMITS.windows)
		return { ok: false, errors: [`Up to ${HOURS_LIMITS.windows} windows.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {HoursWindow[]} */
	const value = [];
	items.forEach((item, index) => {
		const range = rangeOf(item);
		const day = isObject(item) ? /** @type {Record<string, unknown>} */ (item).day : undefined;
		if (!range || !Number.isInteger(day) || Number(day) < 1 || Number(day) > 7)
			return void errors.push(
				`Window ${index + 1}: a day from 1 (Monday) to 7 (Sunday), and a start and an end as HH:MM (24:00 = the end of the day).`,
			);
		value.push({ day: Number(day), ...range });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * Check the dated exceptions a merchant saves: `{ date, name, hours }`, one per date; no hours = closed all day.
 * @param {unknown} items
 * @returns {{ ok: true, value: HoursException[] } | { ok: false, errors: string[] }}
 */
export const checkOfficeExceptions = (items) => {
	if (!Array.isArray(items) || items.length > HOURS_LIMITS.exceptions)
		return { ok: false, errors: [`Up to ${HOURS_LIMITS.exceptions} dates.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {HoursException[]} */
	const value = [];
	const dates = new Set();
	items.forEach((item, index) => {
		const at = `Date ${index + 1}`;
		const entry = isObject(item) ? /** @type {Record<string, unknown>} */ (item) : {};
		const date = typeof entry.date === 'string' ? entry.date : '';
		const real = DATE.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
		if (!real || dates.has(date)) return void errors.push(`${at}: a real date as YYYY-MM-DD, once.`);
		const name = typeof entry.name === 'string' ? entry.name.trim() : '';
		if (name.length > HOURS_LIMITS.name) return void errors.push(`${at}: a name up to ${HOURS_LIMITS.name} characters.`);
		const raw = entry.hours === undefined ? [] : entry.hours;
		const hours = Array.isArray(raw) && raw.length <= HOURS_LIMITS.perDay ? raw.map(rangeOf) : [null];
		if (hours.some((range) => range === null))
			return void errors.push(
				`${at}: up to ${HOURS_LIMITS.perDay} windows, each a start and an end as HH:MM (none = closed all day).`,
			);
		dates.add(date);
		value.push({ date, name, hours: /** @type {import('./time.js').TimeRange[]} */ (hours) });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * Whether staff are in now and, when not, when they are back.
 * @param {OfficeHours} hours no windows and no exceptions = always open
 * @param {number} now
 * @param {string} timeZone
 * @returns {{ open: boolean, backAt: number | null }}
 */
export const officeState = (hours, now, timeZone) =>
	isOpenAt(hours, now, timeZone) ? { open: true, backAt: null } : { open: false, backAt: nextOpenAt(hours, now, timeZone) };

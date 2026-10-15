/**
 * Return and warranty times (E14): a whole number of days, months or years, kept as the merchant typed it (`1 year`
 * stays `1 year`, never `365 days`) and counted on the calendar from delivery (a month from January 31 ends on the
 * last day of February). Shown in the reader's language by `Intl` (`1 year`, `2 Jahre`). No I/O.
 * @module
 */

/** The units of a time. */
export const DURATION_UNITS = Object.freeze(/** @type {const} */ (['days', 'months', 'years']));
/** The longest time of each unit (ten years). */
export const DURATION_MAX = Object.freeze({ days: 3650, months: 120, years: 10 });

/** @typedef {(typeof DURATION_UNITS)[number]} DurationUnit */
/** A time: `amount` of `unit` (0: none). @typedef {{ amount: number, unit: DurationUnit }} Duration */

const DAY_MS = 86_400_000;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether a value is a time: `{ amount, unit }`, a whole amount from 0 to the unit's most.
 * @param {unknown} value
 * @returns {value is Duration}
 */
export const isDuration = (value) =>
	isObject(value) &&
	Object.keys(value).every((key) => key === 'amount' || key === 'unit') &&
	DURATION_UNITS.includes(value.unit) &&
	Number.isSafeInteger(value.amount) &&
	value.amount >= 0 &&
	value.amount <= DURATION_MAX[/** @type {DurationUnit} */ (value.unit)];

/**
 * A time as given (null stays null: none set, so the next one applies); undefined when it is not a time.
 * @param {unknown} value
 * @returns {Duration | null | undefined}
 */
export const durationOf = (value) =>
	value === null ? null : isDuration(value) ? { amount: value.amount, unit: value.unit } : undefined;

/** What a time check says when it fails. */
export const DURATION_RULE = 'Give { amount, unit }: a whole amount of days (up to 3650), months (120) or years (10), or null.';

/**
 * The time a setting pair gives (`returnTime` + `returnTimeUnit`).
 * @param {unknown} amount @param {unknown} unit
 * @returns {Duration}
 */
export const settingDuration = (amount, unit) => {
	const given = { amount: Number(amount) || 0, unit: DURATION_UNITS.includes(/** @type {any} */ (unit)) ? unit : 'days' };
	return isDuration(given) ? given : { amount: 0, unit: 'days' };
};

/** Whether a time is none (null or 0). @param {Duration | null | undefined} duration */
export const isNone = (duration) => !duration || duration.amount <= 0;

/**
 * When a time from `start` ends: days as whole days, months and years on the calendar (UTC), the day kept or the
 * month's last day when it has fewer.
 * @param {Date} start @param {Duration} duration
 * @returns {Date}
 */
export const endOf = (start, duration) => {
	if (duration.unit === 'days') return new Date(start.getTime() + duration.amount * DAY_MS);
	const months = duration.unit === 'years' ? duration.amount * 12 : duration.amount;
	const year = start.getUTCFullYear();
	const month = start.getUTCMonth() + months;
	const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const out = new Date(start.getTime());
	out.setUTCFullYear(year, month, Math.min(start.getUTCDate(), last));
	return out;
};

/**
 * About how many days a time is, for what counts only days (schema.org `merchantReturnDays`): a month as 30, a year as
 * 365.
 * @param {Duration | null | undefined} duration
 */
export const daysOf = (duration) =>
	!duration ? 0 : duration.amount * (duration.unit === 'years' ? 365 : duration.unit === 'months' ? 30 : 1);

/** `Intl`'s unit for each. */
const INTL_UNIT = Object.freeze({ days: 'day', months: 'month', years: 'year' });

/**
 * A time in words, in a language (`1 year`, `6 months`, `30 days`; `en-US` when the language is unknown).
 * @param {Duration} duration @param {string} [locale]
 */
export const durationText = (duration, locale = 'en-US') => {
	const options = /** @type {Intl.NumberFormatOptions} */ ({
		style: 'unit',
		unit: INTL_UNIT[duration.unit],
		unitDisplay: 'long',
	});
	try {
		return new Intl.NumberFormat(locale || 'en-US', options).format(duration.amount);
	} catch {
		return new Intl.NumberFormat('en-US', options).format(duration.amount);
	}
};

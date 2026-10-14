/**
 * Order numbers (E30): the `checkout` settings `numberPattern`, `numberPrefix` and `numberDigits` give a website's
 * form. Pure: the ledger keeps the counters, the import checks and finish use the same form.
 *
 * - `{prefix}{number}` (the default): one running counter, `<prefix><sequence>` (for example `001043`, or `SH-001043`
 *   with the prefix `SH-`);
 * - `{prefix}{year}-{number}`: a counter per year (the year in the business time zone), `<prefix><year>-<sequence>`
 *   (for example `SH-2026-0043` with 4 digits).
 *
 * The sequence has at least `numberDigits` digits (4–8, default 6; zeros in front) and grows past them when it must.
 * A number is letters, digits, `-` and `_` only (it goes in addresses and is looked up by them): other characters of
 * the prefix are left out.
 * @module
 */
import { escapeRegex } from './lookup.js';

/** @typedef {'{prefix}{number}' | '{prefix}{year}-{number}'} NumberPattern */
/** A website's order number form. @typedef {{ pattern: NumberPattern, prefix: string, digits: number }} NumberForm */

/** The forms an order number may take (the `checkout` setting `numberPattern`). */
export const NUMBER_PATTERNS = Object.freeze(/** @type {NumberPattern[]} */ (['{prefix}{number}', '{prefix}{year}-{number}']));
/** The form of a new website: one running counter. @type {NumberPattern} */
export const DEFAULT_NUMBER_PATTERN = '{prefix}{number}';
/** Digits of the sequence by default, and their range. */
const NUMBER_DIGITS = Object.freeze({ default: 6, min: 4, max: 8 });
/** The longest sequence a number may carry. */
const MAX_SEQUENCE_DIGITS = 12;
/** Every order number: what an order page looks a number up by (`GET /v1/shop/orders/by-number/:number`). */
export const ORDER_NUMBER = /^[A-Za-z0-9_-]{1,40}$/;
/** Characters a prefix may not carry. */
const NOT_IN_NUMBERS = /[^A-Za-z0-9_-]/g;

/**
 * A website's order number form from its `checkout` settings (unknown values fall back to the defaults).
 * @param {{ numberPattern?: unknown, numberPrefix?: unknown, numberDigits?: unknown }} checkout
 * @returns {NumberForm}
 */
export const numberFormOf = ({ numberPattern, numberPrefix, numberDigits }) => ({
	pattern: NUMBER_PATTERNS.includes(/** @type {NumberPattern} */ (numberPattern))
		? /** @type {NumberPattern} */ (numberPattern)
		: DEFAULT_NUMBER_PATTERN,
	prefix: typeof numberPrefix === 'string' ? numberPrefix.replace(NOT_IN_NUMBERS, '') : '',
	digits: Number.isSafeInteger(numberDigits)
		? Math.min(NUMBER_DIGITS.max, Math.max(NUMBER_DIGITS.min, Number(numberDigits)))
		: NUMBER_DIGITS.default,
});

/**
 * Whether the form has a counter per year.
 * @param {NumberForm} form
 */
export const isYearly = (form) => form.pattern === '{prefix}{year}-{number}';

/**
 * An order number of the form.
 * @param {NumberForm} form @param {{ year: number, sequence: number }} at `year`: the business time zone's
 */
export const orderNumberOf = (form, { year, sequence }) => {
	const digits = String(sequence).padStart(form.digits, '0');
	return isYearly(form) ? `${form.prefix}${year}-${digits}` : `${form.prefix}${digits}`;
};

/**
 * The id of the counter that numbers the orders of a year (or of all time, for a running counter). The two kinds
 * never share an id: a year's ends with its four digits, a running one with `:`.
 * @param {NumberForm} form @param {number} year
 */
export const counterIdOf = (form, year) => (isYearly(form) ? `orders-${form.prefix}${year}` : `orders-${form.prefix}:`);

/**
 * A regular expression (source) for the numbers one counter gave (any count of digits), capturing the sequence.
 * @param {NumberForm} form @param {number} year
 */
export const counterNumbers = (form, year) =>
	isYearly(form)
		? `^${escapeRegex(form.prefix)}${year}-(\\d{1,${MAX_SEQUENCE_DIGITS}})$`
		: `^${escapeRegex(form.prefix)}(\\d{1,${MAX_SEQUENCE_DIGITS}})$`;

/**
 * A regular expression for every number of the form, with at least its digits: capturing the year (yearly form) and
 * the sequence.
 * @param {NumberForm} form
 */
export const numberMatcher = (form) =>
	new RegExp(
		isYearly(form)
			? `^${escapeRegex(form.prefix)}(\\d{4})-(\\d{${form.digits},${MAX_SEQUENCE_DIGITS}})$`
			: `^${escapeRegex(form.prefix)}(\\d{${form.digits},${MAX_SEQUENCE_DIGITS}})$`,
	);

/**
 * The form in words, for messages: `SH-<year>-<at least 4 digits>`.
 * @param {NumberForm} form
 */
export const describeNumberForm = (form) => `${form.prefix}${isYearly(form) ? '<year>-' : ''}<at least ${form.digits} digits>`;

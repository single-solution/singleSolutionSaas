/**
 * Order numbers (E30, E29): the `checkout` settings `numberPattern`, `numberPrefix`, `numberSuffix` and `numberDigits`
 * give a website's form. Pure: the ledger keeps the counters, the import checks and finish use the same form.
 *
 * The pattern is the merchant's: the tokens `{prefix}`, `{year}`, `{month}`, `{number}` and `{suffix}` with letters,
 * digits, `-` and `_` between them, `{number}` exactly once, each other token at most once, and `{month}` only with
 * `{year}` (a number must never come back). For example `{prefix}{number}` (the default: `001043`, or `SH-001043` with
 * the prefix `SH-`), `{prefix}{year}-{number}` (`SH-2026-0043` with 4 digits) or `{year}{month}-{number}{suffix}`.
 * The counter starts again each month with `{month}`, each year with `{year}` only, and never without them (the year
 * and month in the business time zone). A pattern that breaks these rules reads as the default.
 *
 * The sequence has at least `numberDigits` digits (1–10, default 6; zeros in front) and grows past them when it must.
 * A number is letters, digits, `-` and `_` only (it goes in addresses and is looked up by them): other characters of
 * the prefix and suffix are left out.
 * @module
 */
import { escapeRegex } from './lookup.js';

/** A website's order number form. @typedef {{ pattern: string, prefix: string, suffix: string, digits: number }} NumberForm */
/** When a number is made: its year and month (1–12) in the business time zone. @typedef {{ year: number, month: number }} NumberAt */
/** How long one counter runs: a calendar month, a year, or all time. @typedef {'month' | 'year' | 'all'} NumberPeriod */

/** The form of a new website: one running counter. */
export const DEFAULT_NUMBER_PATTERN = '{prefix}{number}';
/** The tokens a pattern may hold. */
export const NUMBER_TOKENS = Object.freeze(['prefix', 'year', 'month', 'number', 'suffix']);
/** Digits of the sequence by default, and their range. */
const NUMBER_DIGITS = Object.freeze({ default: 6, min: 1, max: 10 });
/** The longest sequence a number may carry. */
const MAX_SEQUENCE_DIGITS = 12;
/** The longest pattern. */
const MAX_PATTERN = 60;
/** Every order number: what an order page looks a number up by (`GET /v1/shop/orders/by-number/:number`). */
export const ORDER_NUMBER = /^[A-Za-z0-9_-]{1,40}$/;
/** Characters a prefix or suffix may not carry. */
const NOT_IN_NUMBERS = /[^A-Za-z0-9_-]/g;
/** A pattern's parts: a token or one character. */
const PART = /\{([a-z]+)\}|([^{])/g;

/**
 * The parts of a pattern, or null when it breaks the rules (see the module).
 * @param {unknown} pattern
 * @returns {Array<{ token: string } | { text: string }> | null}
 */
const partsOf = (pattern) => {
	if (typeof pattern !== 'string' || pattern === '' || pattern.length > MAX_PATTERN) return null;
	/** @type {Array<{ token: string } | { text: string }>} */
	const parts = [];
	const seen = new Set();
	let read = 0;
	for (const match of pattern.matchAll(PART)) {
		read += match[0].length;
		const [, token, text] = match;
		if (token !== undefined) {
			if (!NUMBER_TOKENS.includes(token) || seen.has(token)) return null;
			seen.add(token);
			parts.push({ token });
		} else if (text !== undefined && /^[A-Za-z0-9_-]$/.test(text)) parts.push({ text });
		else return null;
	}
	if (read !== pattern.length || !seen.has('number') || (seen.has('month') && !seen.has('year'))) return null;
	return parts;
};

/**
 * Whether a pattern is one an order number may take (the `checkout` setting `numberPattern`).
 * @param {unknown} pattern
 */
export const isNumberPattern = (pattern) => partsOf(pattern) !== null;

/**
 * A website's order number form from its `checkout` settings (unknown values fall back to the defaults).
 * @param {{ numberPattern?: unknown, numberPrefix?: unknown, numberSuffix?: unknown, numberDigits?: unknown }} checkout
 * @returns {NumberForm}
 */
export const numberFormOf = ({ numberPattern, numberPrefix, numberSuffix, numberDigits }) => ({
	pattern: isNumberPattern(numberPattern) ? /** @type {string} */ (numberPattern) : DEFAULT_NUMBER_PATTERN,
	prefix: typeof numberPrefix === 'string' ? numberPrefix.replace(NOT_IN_NUMBERS, '') : '',
	suffix: typeof numberSuffix === 'string' ? numberSuffix.replace(NOT_IN_NUMBERS, '') : '',
	digits: Number.isSafeInteger(numberDigits)
		? Math.min(NUMBER_DIGITS.max, Math.max(NUMBER_DIGITS.min, Number(numberDigits)))
		: NUMBER_DIGITS.default,
});

/**
 * How long one counter of the form runs: a month with `{month}`, a year with `{year}`, else all time.
 * @param {NumberForm} form
 * @returns {NumberPeriod}
 */
export const periodOf = (form) => (form.pattern.includes('{month}') ? 'month' : form.pattern.includes('{year}') ? 'year' : 'all');

/**
 * The form written out: each literal part (its text, the prefix and the suffix) through `literal`, and the year,
 * month and sequence as given.
 * @param {NumberForm} form
 * @param {{ literal: (text: string) => string, year: string, month: string, sequence: string }} pieces
 */
const build = (form, { literal, year, month, sequence }) =>
	/** @type {Array<{ token: string } | { text: string }>} */ (partsOf(form.pattern))
		.map((part) => {
			if ('text' in part) return literal(part.text);
			if (part.token === 'number') return sequence;
			if (part.token === 'year') return year;
			if (part.token === 'month') return month;
			return literal(part.token === 'prefix' ? form.prefix : form.suffix);
		})
		.join('');

/** @param {string} text */
const asIs = (text) => text;
/** @param {NumberAt} at */
const dateOf = (at) => ({ year: String(at.year), month: String(at.month).padStart(2, '0') });

/**
 * An order number of the form.
 * @param {NumberForm} form @param {NumberAt & { sequence: number }} at
 */
export const orderNumberOf = (form, at) =>
	build(form, { literal: asIs, ...dateOf(at), sequence: String(at.sequence).padStart(form.digits, '0') });

/**
 * The id of the counter that numbers the orders of a period (a month, a year or all time): the number with its
 * sequence as `:`, so forms that could give the same number share a counter and two that cannot never do.
 * @param {NumberForm} form @param {NumberAt} at
 */
export const counterIdOf = (form, at) => `orders-${build(form, { literal: asIs, ...dateOf(at), sequence: ':' })}`;

/**
 * A counter's name for people: the number with its sequence as `#` (`SH-2026-#`).
 * @param {NumberForm} form @param {NumberAt} at
 */
export const counterNameOf = (form, at) => build(form, { literal: asIs, ...dateOf(at), sequence: '#' });

/**
 * A regular expression (source) for the numbers one counter gave (any count of digits), capturing the sequence.
 * @param {NumberForm} form @param {NumberAt} at
 */
export const counterNumbers = (form, at) =>
	`^${build(form, { literal: escapeRegex, ...dateOf(at), sequence: `(\\d{1,${MAX_SEQUENCE_DIGITS}})` })}$`;

/** What the year, month and sequence of any number of a form look like. */
const ANY_YEAR = '(\\d{4})';
const ANY_MONTH = '(0[1-9]|1[0-2])';

/**
 * A regular expression (source, for the database) for every number of the form with at least `digits` digits, its
 * captures in the order of the form's parts; {@link numberParts} reads them.
 * @param {NumberForm} form @param {number} [digits]
 */
export const formNumbers = (form, digits = 1) =>
	`^${build(form, { literal: escapeRegex, year: ANY_YEAR, month: ANY_MONTH, sequence: `(\\d{${digits},${MAX_SEQUENCE_DIGITS}})` })}$`;

/**
 * A regular expression for every number of the form, with at least its digits ({@link numberParts} reads a match).
 * @param {NumberForm} form
 */
export const numberMatcher = (form) => new RegExp(formNumbers(form, form.digits));

/**
 * Where the year, month and sequence are among the captures of {@link formNumbers} (-1: the form has none).
 * @param {NumberForm} form
 * @returns {{ year: number, month: number, sequence: number }}
 */
export const captureIndexes = (form) => {
	const order = /** @type {Array<{ token: string } | { text: string }>} */ (partsOf(form.pattern)).flatMap((part) =>
		'token' in part && ['year', 'month', 'number'].includes(part.token) ? [part.token] : [],
	);
	return { year: order.indexOf('year'), month: order.indexOf('month'), sequence: order.indexOf('number') };
};

/**
 * The form in words, for messages: `SH-<year>-<at least 4 digits>`.
 * @param {NumberForm} form
 */
export const describeNumberForm = (form) =>
	build(form, { literal: asIs, year: '<year>', month: '<month>', sequence: `<at least ${form.digits} digits>` });

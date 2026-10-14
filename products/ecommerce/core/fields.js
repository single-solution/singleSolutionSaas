/**
 * Merchant fields (PLAN 0.8.10 dynamic model §2): the format a text field's values must have, checked by one pure
 * function, {@link checkFormat}, that walks each value once, character by character. No regular expression is ever
 * built from what a merchant types, so a format can never make a check slow (no ReDoS), whatever the value's length.
 * Also the check digits values use: Luhn ({@link luhnValid}) and the GS1 check digit of a GTIN ({@link gtinOf}). No I/O.
 * @module
 */

/** Which characters a format allows. */
export const FORMAT_CHARS = Object.freeze(
	/** @type {const} */ (['any', 'digits', 'letters', 'letters_digits', 'letters_digits_dash']),
);
/** The check digits a format can ask for. */
export const CHECK_DIGITS = Object.freeze(/** @type {const} */ (['none', 'luhn']));
/**
 * Why a value does not match its format: the wrong characters, the wrong length, not one of the starts, not the mask's
 * pattern, or a wrong check digit.
 */
export const FORMAT_REFUSALS = Object.freeze(/** @type {const} */ (['chars', 'length', 'starts', 'mask', 'check_digit']));

/** Longest value of a text field, and the format limits. */
export const FORMAT_LIMITS = Object.freeze({ length: 200, mask: 64, starts: 10, start: 20 });

/**
 * A text field's format: the characters allowed, the length, the starts a value may have (none = any), a mask (`A` a
 * letter, `9` a digit, `*` a letter or a digit, any other character itself; '' = none), a check digit, and whether
 * spaces are dropped and letters upper-cased before the check (the value is kept that way).
 * @typedef {object} Format
 * @property {typeof FORMAT_CHARS[number]} chars
 * @property {number} minLength
 * @property {number} maxLength
 * @property {string[]} startsWith
 * @property {string} mask
 * @property {typeof CHECK_DIGITS[number]} checkDigit
 * @property {boolean} ignoreSpaces
 * @property {boolean} upperCase
 */

/** @typedef {typeof FORMAT_REFUSALS[number]} FormatRefusal */

/** One letter of any script (tested on one character at a time). */
const LETTER = /^\p{L}$/u;
/** A space of any kind (dropped with `ignoreSpaces`). */
const SPACE = /\s/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /^[\u0000-\u001F\u007F]$/;

/** @param {string} char */
const isDigit = (char) => char >= '0' && char <= '9';
/** @param {string} char */
const isLetter = (char) => LETTER.test(char);

/**
 * Whether a character is one the format's `chars` allows.
 * @param {string} char @param {Format['chars']} chars
 */
const allowed = (char, chars) => {
	if (chars === 'digits') return isDigit(char);
	if (chars === 'letters') return isLetter(char);
	if (chars === 'letters_digits') return isLetter(char) || isDigit(char);
	if (chars === 'letters_digits_dash') return isLetter(char) || isDigit(char) || char === '-';
	return !CONTROL.test(char);
};

/**
 * Whether a character fits one place of a mask.
 * @param {string} char @param {string} place
 */
const fitsMask = (char, place) => {
	if (place === 'A') return isLetter(char);
	if (place === '9') return isDigit(char);
	if (place === '*') return isLetter(char) || isDigit(char);
	return char === place;
};

/**
 * Whether a string of digits passes the Luhn check (its last digit is the check digit): payment cards, IMEIs and many
 * other numbers use it.
 * @param {string} digits
 */
export const luhnValid = (digits) => {
	if (digits.length < 2) return false;
	let sum = 0;
	for (let index = 0; index < digits.length; index += 1) {
		const char = digits[digits.length - 1 - index] ?? '';
		if (!isDigit(char)) return false;
		let digit = char.charCodeAt(0) - 48;
		if (index % 2 === 1) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
	}
	return sum % 10 === 0;
};

/**
 * A value as its format keeps it: spaces dropped and letters upper-cased when the format says so.
 * @param {string} value @param {Pick<Format, 'ignoreSpaces' | 'upperCase'>} format
 */
export const formatted = (value, format) => {
	let out = value.trim();
	if (format.ignoreSpaces) {
		let kept = '';
		for (const char of out) if (!SPACE.test(char)) kept += char;
		out = kept;
	}
	return format.upperCase ? out.toUpperCase() : out;
};

/**
 * Check one value against a format, in one pass over its characters: first its length, then its characters, its start,
 * the mask and the check digit. The value is first kept as the format says (spaces dropped, upper-cased).
 * @param {string} value
 * @param {Format} format
 * @returns {{ ok: true, value: string } | { ok: false, code: FormatRefusal }}
 */
export const checkFormat = (value, format) => {
	const kept = formatted(value, format);
	const chars = [...kept];
	if (chars.length < format.minLength || chars.length > format.maxLength) return { ok: false, code: 'length' };
	if (!chars.every((char) => allowed(char, format.chars))) return { ok: false, code: 'chars' };
	if (format.startsWith.length > 0 && !format.startsWith.some((start) => kept.startsWith(start)))
		return { ok: false, code: 'starts' };
	if (format.mask) {
		const mask = [...format.mask];
		if (mask.length !== chars.length || !chars.every((char, index) => fitsMask(char, mask[index] ?? '')))
			return { ok: false, code: 'mask' };
	}
	if (format.checkDigit === 'luhn' && !luhnValid(kept)) return { ok: false, code: 'check_digit' };
	return { ok: true, value: kept };
};

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {unknown} value @param {number} min @param {number} max
 * @returns {value is number}
 */
const isWhole = (value, min, max) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

/** @param {string} text */
const hasControl = (text) => [...text].some((char) => CONTROL.test(char));

/**
 * Check a format a merchant gives a text field: null (none) or its parts, with defaults for the parts left out. The
 * starts and the mask are kept as the format keeps values (upper-cased with `upperCase`, without spaces with
 * `ignoreSpaces`), so they compare with the values.
 * @param {unknown} raw
 * @returns {{ ok: true, value: Format | null } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkFormatRule = (raw) => {
	if (raw === null || raw === undefined) return { ok: true, value: null };
	if (!isObject(raw)) return { ok: false, errors: [{ path: '/format', message: 'The format is an object, or null.' }] };
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	const chars = raw.chars ?? 'any';
	if (!FORMAT_CHARS.includes(chars))
		errors.push({ path: '/format/chars', message: `Characters are one of ${FORMAT_CHARS.join(', ')}.` });
	const ignoreSpaces = raw.ignoreSpaces ?? false;
	const upperCase = raw.upperCase ?? false;
	if (typeof ignoreSpaces !== 'boolean') errors.push({ path: '/format/ignoreSpaces', message: 'true or false.' });
	if (typeof upperCase !== 'boolean') errors.push({ path: '/format/upperCase', message: 'true or false.' });
	const keep = (/** @type {string} */ text) =>
		formatted(text, { ignoreSpaces: ignoreSpaces === true, upperCase: upperCase === true });
	const minLength = raw.minLength ?? 1;
	const maxLength = raw.maxLength ?? FORMAT_LIMITS.length;
	if (!isWhole(minLength, 1, FORMAT_LIMITS.length) || !isWhole(maxLength, 1, FORMAT_LIMITS.length) || minLength > maxLength)
		errors.push({
			path: '/format/minLength',
			message: `The length is from 1 to ${FORMAT_LIMITS.length} characters, the least no more than the most.`,
		});
	const startsRaw = raw.startsWith ?? [];
	/** @type {string[]} */
	const startsWith = [];
	if (!Array.isArray(startsRaw) || startsRaw.length > FORMAT_LIMITS.starts)
		errors.push({ path: '/format/startsWith', message: `Give at most ${FORMAT_LIMITS.starts} starts.` });
	else
		for (const entry of startsRaw) {
			const start = typeof entry === 'string' ? keep(entry) : '';
			if (!start || start.length > FORMAT_LIMITS.start || hasControl(start)) {
				errors.push({ path: '/format/startsWith', message: `A start has 1 to ${FORMAT_LIMITS.start} characters.` });
				break;
			}
			if (!startsWith.includes(start)) startsWith.push(start);
		}
	const maskRaw = raw.mask ?? '';
	const mask = typeof maskRaw === 'string' ? keep(maskRaw) : null;
	if (mask === null || mask.length > FORMAT_LIMITS.mask || hasControl(mask))
		errors.push({ path: '/format/mask', message: `The mask has at most ${FORMAT_LIMITS.mask} characters.` });
	else if (mask && ([...mask].length < Number(minLength) || [...mask].length > Number(maxLength)))
		errors.push({ path: '/format/mask', message: 'The mask is as long as the values: within the length.' });
	const checkDigit = raw.checkDigit ?? 'none';
	if (!CHECK_DIGITS.includes(checkDigit))
		errors.push({ path: '/format/checkDigit', message: `The check digit is one of ${CHECK_DIGITS.join(', ')}.` });
	else if (checkDigit === 'luhn' && chars !== 'digits')
		errors.push({ path: '/format/checkDigit', message: 'A Luhn check digit needs digits only.' });
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			chars,
			minLength,
			maxLength,
			startsWith,
			mask: mask ?? '',
			checkDigit,
			ignoreSpaces,
			upperCase,
		},
	};
};

/** GTIN lengths: GTIN-8, GTIN-12 (UPC-A), GTIN-13 (EAN) and GTIN-14. */
const GTIN_LENGTHS = Object.freeze([8, 12, 13, 14]);

/**
 * A GTIN (barcode number) as kept: its digits (spaces and dashes dropped), 8, 12, 13 or 14 of them, the last the GS1
 * check digit; null when it is not one.
 * @param {unknown} value
 * @returns {string | null}
 */
export const gtinOf = (value) => {
	if (typeof value !== 'string' || value.length > 40) return null;
	let digits = '';
	for (const char of value) {
		if (char === ' ' || char === '-') continue;
		if (!isDigit(char)) return null;
		digits += char;
	}
	if (!GTIN_LENGTHS.includes(digits.length)) return null;
	let sum = 0;
	// from the digit left of the check digit, weights 3, 1, 3 …
	for (let index = 1; index < digits.length; index += 1)
		sum += (digits.charCodeAt(digits.length - 1 - index) - 48) * (index % 2 === 1 ? 3 : 1);
	return (10 - (sum % 10)) % 10 === digits.charCodeAt(digits.length - 1) - 48 ? digits : null;
};

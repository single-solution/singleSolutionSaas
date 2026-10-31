/**
 * Merchant fields (PLAN 0.8.10 dynamic model §2): the format a text field's values must have, checked by one pure
 * function, {@link checkFormat}, that walks each value once, character by character. No regular expression is ever
 * built from what a merchant types, so a format can never make a check slow (no ReDoS), whatever the value's length.
 * Also the check digits values use (E21): Luhn (`luhnValid` of `@ss/contracts/text`), the GS1 mod-10 check digit of a GTIN
 * ({@link gtinOf}), ISBN-10 and ISBN-13 ({@link isbnValid}) and the VIN's ({@link vinValid}); `none` checks the pattern
 * only. No I/O.
 * @module
 */
import { luhnValid } from '@ss/contracts/text';
import { isObject } from '@ss/contracts/util';

/** Which characters a format allows. */
export const FORMAT_CHARS = Object.freeze(
	/** @type {const} */ (['any', 'digits', 'letters', 'letters_digits', 'letters_digits_dash']),
);
/** The check digits a format can ask for (`none`: the pattern only). */
export const CHECK_DIGITS = Object.freeze(/** @type {const} */ (['none', 'luhn', 'gtin', 'isbn', 'vin']));
/** The check digits that need values of digits only. */
const DIGITS_ONLY = Object.freeze(['luhn', 'gtin']);
/**
 * Why a value does not match its format: the wrong characters, the wrong length, not one of the starts, not the mask's
 * pattern, or a wrong check digit.
 */
export const FORMAT_REFUSALS = Object.freeze(/** @type {const} */ (['chars', 'length', 'starts', 'mask', 'check_digit']));

/** Longest value of a text field, and the format limits. */
const FORMAT_LIMITS = Object.freeze({ length: 200, mask: 64, starts: 10, start: 20 });

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
 * Whether a value is an ISBN with its check digit: ISBN-10 (nine digits and a digit or X, mod 11) or ISBN-13 (a GTIN-13
 * starting 978 or 979); hyphens and spaces are passed over.
 * @param {string} value
 */
const isbnValid = (value) => {
	const plain = value.replace(/[-\s]/g, '').toUpperCase();
	if (plain.length === 13) return /^97[89]/.test(plain) && gtinOf(plain) !== null;
	if (!/^\d{9}[\dX]$/.test(plain)) return false;
	let sum = 0;
	for (let index = 0; index < 10; index += 1) {
		const char = plain[index] ?? '';
		sum += (char === 'X' ? 10 : char.charCodeAt(0) - 48) * (10 - index);
	}
	return sum % 11 === 0;
};

/** The value of each VIN letter in its check digit (I, O and Q are never used). */
const VIN_LETTERS = 'A1B2C3D4E5F6G7H8J1K2L3M4N5P7R9S2T3U4V5W6X7Y8Z9';
/** The weight of each VIN position. */
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * Whether a value is a 17-character vehicle identification number whose ninth character is its check digit (mod 11, X
 * for 10), as North America and some other markets use it.
 * @param {string} value
 */
const vinValid = (value) => {
	const plain = value.toUpperCase();
	if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(plain)) return false;
	let sum = 0;
	for (let index = 0; index < 17; index += 1) {
		const char = plain[index] ?? '';
		const at = VIN_LETTERS.indexOf(char);
		const digit = isDigit(char) ? char.charCodeAt(0) - 48 : Number(VIN_LETTERS[at + 1]);
		sum += digit * (VIN_WEIGHTS[index] ?? 0);
	}
	const check = sum % 11;
	return plain[8] === (check === 10 ? 'X' : String(check));
};

/**
 * Whether a value passes a format's check digit.
 * @param {string} value @param {Format['checkDigit']} checkDigit
 */
const checkDigitValid = (value, checkDigit) => {
	if (checkDigit === 'luhn') return luhnValid(value);
	if (checkDigit === 'gtin') return gtinOf(value) !== null;
	if (checkDigit === 'isbn') return isbnValid(value);
	if (checkDigit === 'vin') return vinValid(value);
	return true;
};

/**
 * A value as its format keeps it: spaces dropped and letters upper-cased when the format says so.
 * @param {string} value @param {Pick<Format, 'ignoreSpaces' | 'upperCase'>} format
 */
const formatted = (value, format) => {
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
	if (!checkDigitValid(kept, format.checkDigit)) return { ok: false, code: 'check_digit' };
	return { ok: true, value: kept };
};

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
	else if (DIGITS_ONLY.includes(checkDigit) && chars !== 'digits')
		errors.push({ path: '/format/checkDigit', message: `A ${checkDigit} check digit needs digits only.` });
	else if ((checkDigit === 'isbn' || checkDigit === 'vin') && chars === 'letters')
		errors.push({ path: '/format/checkDigit', message: `An ${checkDigit} has digits.` });
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
 * check digit, not all zeros (it names no item; GS1 and Google refuse it); null when it is not one.
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
	if (!GTIN_LENGTHS.includes(digits.length) || /^0+$/.test(digits)) return null;
	let sum = 0;
	// from the digit left of the check digit, weights 3, 1, 3 …
	for (let index = 1; index < digits.length; index += 1)
		sum += (digits.charCodeAt(digits.length - 1 - index) - 48) * (index % 2 === 1 ? 3 : 1);
	return (10 - (sum % 10)) % 10 === digits.charCodeAt(digits.length - 1) - 48 ? digits : null;
};

// ------------------------------------------------------------------------------------------------------ fields

/** Where a field's values live: products, variants, units (one numbered item each), orders and customers. */
export const FIELD_ON = Object.freeze(/** @type {const} */ (['product', 'variant', 'unit', 'order', 'customer']));
/** Field types. */
export const FIELD_TYPES = Object.freeze(/** @type {const} */ (['text', 'number', 'choice', 'yes_no', 'date']));
/** The dates a date field takes: any, only today or before, only today or after. */
export const FIELD_DATES = Object.freeze(/** @type {const} */ (['any', 'past', 'future']));
/**
 * When a required order field must be filled: at checkout (by the shopper), or before staff move the order into a
 * packed, shipped or delivered status.
 */
export const REQUIRED_AT = Object.freeze(/** @type {const} */ (['checkout', 'packed', 'shipped', 'delivered']));
/** How product cards show a field's values. */
export const CARD_MODES = Object.freeze(/** @type {const} */ (['none', 'image', 'chips']));
/**
 * Where the product feeds send a field's value: a custom label, an attribute of the item, the apparel attributes (sent
 * only with the catalogs' own values), each value as a product highlight, or the field as a product detail (G11).
 */
export const FEED_TARGETS = Object.freeze(
	/** @type {const} */ ([
		'none',
		'custom_label_0',
		'custom_label_1',
		'custom_label_2',
		'custom_label_3',
		'custom_label_4',
		'color',
		'material',
		'size',
		'pattern',
		'gender',
		'age_group',
		'size_system',
		'product_highlight',
		'product_detail',
	]),
);
/** Where structured data names a field's value. */
export const JSONLD_TARGETS = Object.freeze(
	/** @type {const} */ (['none', 'additionalProperty', 'color', 'material', 'size', 'pattern']),
);
/** The places a field's values may show, by where they live; every other place stays off. */
export const SHOW_PLACES = Object.freeze({
	product: Object.freeze(['page', 'card', 'filter', 'compare', 'feeds', 'jsonLd', 'chat']),
	variant: Object.freeze(['page', 'card', 'filter', 'feeds', 'jsonLd', 'chat']),
	unit: Object.freeze(['shopper', 'invoice', 'packingSlip']),
	order: Object.freeze(['shopper', 'invoice', 'packingSlip']),
	customer: Object.freeze(['invoice', 'packingSlip']),
});
/**
 * The limits of fields: per shop, values of a field, unit fields of one item type, values of a unit field (the
 * merchant sets each field's own, E21; a unit field taking several values takes 2 unless it says), the largest number.
 */
export const FIELD_LIMITS = Object.freeze({
	fields: 200,
	values: 20,
	unitFields: 10,
	unitValues: 10,
	unitValuesDefault: 2,
	number: 1e12,
});

/** @typedef {typeof FIELD_ON[number]} FieldOn */
/** @typedef {typeof FIELD_TYPES[number]} FieldType */
/** @typedef {typeof FEED_TARGETS[number]} FeedTarget */
/** @typedef {typeof JSONLD_TARGETS[number]} JsonLdTarget */
/**
 * Where a field's values show (each place only where its values live, {@link SHOW_PLACES}): the product page, cards,
 * the shop's filters, compare, the feeds and structured data (as which attribute), invoices, packing slips, the
 * shopper's own order (and, for order fields, the checkout) and Chat. A field shown nowhere a shopper looks is the
 * staff's alone: its values never leave staff answers.
 * @typedef {{ page: boolean, card: typeof CARD_MODES[number], filter: boolean, compare: boolean, feeds: FeedTarget,
 *   jsonLd: JsonLdTarget, invoice: boolean, packingSlip: boolean, shopper: boolean, chat: boolean }} FieldShow
 */
/** @typedef {string | number | boolean | Array<string | number>} FieldValue */
/**
 * What checking a value needs of its field.
 * @typedef {{ name: string, type: FieldType, choices: Array<{ value: string, label: string }>, multiple: boolean,
 *   maxValues: number, min: number | null, max: number | null, decimals: number, dates: typeof FIELD_DATES[number],
 *   format: Format | null }} ValueRules
 */

/**
 * Where a field shows when nothing is said: product and variant fields on the product page and in Chat (as attributes
 * always did), the others nowhere a shopper looks.
 * @param {FieldOn} on
 * @returns {FieldShow}
 */
export const showDefaults = (on) => {
	const catalog = on === 'product' || on === 'variant';
	return {
		page: catalog,
		card: 'none',
		filter: false,
		compare: false,
		feeds: 'none',
		jsonLd: 'none',
		invoice: false,
		packingSlip: false,
		shopper: false,
		chat: catalog,
	};
};

/** The value each place of `show` takes. */
const SHOW_VALUES = Object.freeze({
	page: [true, false],
	card: CARD_MODES,
	filter: [true, false],
	compare: [true, false],
	feeds: FEED_TARGETS,
	jsonLd: JSONLD_TARGETS,
	invoice: [true, false],
	packingSlip: [true, false],
	shopper: [true, false],
	chat: [true, false],
});

/**
 * Check where a field shows: the places given over those it had (or the defaults), each one of its values, and every
 * place that does not apply to where its values live left off.
 * @param {unknown} given
 * @param {FieldOn} on
 * @param {FieldShow | null} before
 * @returns {{ ok: true, value: FieldShow } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkShow = (given, on, before) => {
	const base = before ?? showDefaults(on);
	const raw = given === undefined ? {} : given;
	if (!isObject(raw)) return { ok: false, errors: [{ path: '/show', message: 'Say where the field shows, as an object.' }] };
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	const off = showDefaults('customer');
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const [place, values] of Object.entries(SHOW_VALUES)) {
		const given = raw[place];
		if (given !== undefined && !(/** @type {readonly unknown[]} */ (values).includes(given))) {
			errors.push({ path: `/show/${place}`, message: `${place} is one of ${values.join(', ')}.` });
			continue;
		}
		const value = given === undefined ? /** @type {Record<string, unknown>} */ (base)[place] : given;
		const applies = /** @type {readonly string[]} */ (SHOW_PLACES[on]).includes(place);
		const empty = /** @type {Record<string, unknown>} */ (off)[place];
		if (!applies && given !== undefined && given !== empty)
			errors.push({ path: `/show/${place}`, message: `${on} fields show only in: ${SHOW_PLACES[on].join(', ')}.` });
		out[place] = applies ? value : empty;
	}
	for (const place of Object.keys(raw))
		if (!(place in SHOW_VALUES)) errors.push({ path: `/show/${place}`, message: 'There is no such place.' });
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: /** @type {FieldShow} */ (out) };
};

/**
 * Whether a field's values show at a place.
 * @param {{ show: FieldShow }} field
 * @param {keyof FieldShow} place
 */
const showsAt = (field, place) => {
	const value = field.show[place];
	return value !== false && value !== 'none';
};

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001F\u007F]/g;

/**
 * A text value on one line without control characters, or null when empty, too long or not text.
 * @param {unknown} value @param {number} max
 */
const textOf = (value, max) => {
	if (typeof value !== 'string') return null;
	const text = value
		.replace(/[\r\n\t]+/g, ' ')
		.replace(CONTROLS, '')
		.trim();
	return text === '' || text.length > max ? null : text;
};

/** A date as values keep it: `YYYY-MM-DD`, a real calendar day. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar day `YYYY-MM-DD`, or null.
 * @param {unknown} value
 */
const dayOf = (value) => {
	if (typeof value !== 'string') return null;
	const match = DATE.exec(value);
	if (!match) return null;
	const day = new Date(`${value}T00:00:00Z`);
	return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value ? null : value;
};

/**
 * Why a value is refused: not of the field's type, not one of its choices, out of its range, too many decimals, a day
 * not allowed, a wrong number of values, or a format refusal.
 * @typedef {'type' | 'choice' | 'range' | 'decimals' | 'date' | 'values' | FormatRefusal} ValueRefusal
 */

/**
 * Check one value of a field.
 * @param {ValueRules} field @param {unknown} raw @param {ReadonlyArray<string>} extra @param {string} today
 * @returns {{ ok: true, value: string | number | boolean } | { ok: false, code: ValueRefusal }}
 */
const oneValue = (field, raw, extra, today) => {
	if (field.type === 'yes_no') return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, code: 'type' };
	if (field.type === 'number') {
		if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > FIELD_LIMITS.number)
			return { ok: false, code: 'type' };
		if ((field.min !== null && raw < field.min) || (field.max !== null && raw > field.max)) return { ok: false, code: 'range' };
		return Number(raw.toFixed(field.decimals)) === raw ? { ok: true, value: raw } : { ok: false, code: 'decimals' };
	}
	if (field.type === 'date') {
		const day = dayOf(raw);
		if (!day) return { ok: false, code: 'type' };
		if ((field.dates === 'past' && day > today) || (field.dates === 'future' && day < today))
			return { ok: false, code: 'date' };
		return { ok: true, value: day };
	}
	const text = textOf(raw, FORMAT_LIMITS.length);
	if (text === null) return { ok: false, code: 'type' };
	if (field.type === 'choice')
		return field.choices.some((choice) => choice.value === text) || extra.includes(text)
			? { ok: true, value: text }
			: { ok: false, code: 'choice' };
	return field.format ? checkFormat(text, field.format) : { ok: true, value: text };
};

/**
 * Check a value of a field: one value, or several different ones (1 to its `maxValues`) when it takes several.
 * @param {ValueRules} field
 * @param {unknown} raw
 * @param {{ extra?: ReadonlyArray<string>, today?: string }} [options] `extra`: more choice values (a product's own,
 *   E7); `today`: the day past and future dates compare with (UTC, `YYYY-MM-DD`)
 * @returns {{ ok: true, value: FieldValue } | { ok: false, code: ValueRefusal, value?: string }} `value`: the value
 *   refused
 */
export const checkValue = (field, raw, { extra = [], today = new Date().toISOString().slice(0, 10) } = {}) => {
	if (!Array.isArray(raw)) {
		const one = oneValue(field, raw, extra, today);
		return one.ok ? one : { ...one, ...(typeof raw === 'string' ? { value: raw } : {}) };
	}
	if (!field.multiple || field.type === 'yes_no' || raw.length === 0 || raw.length > field.maxValues)
		return { ok: false, code: 'values' };
	/** @type {Array<string | number>} */
	const out = [];
	for (const entry of raw) {
		const one = oneValue(field, entry, extra, today);
		if (!one.ok) return { ...one, ...(typeof entry === 'string' ? { value: entry } : {}) };
		if (out.includes(/** @type {string | number} */ (one.value))) return { ok: false, code: 'values' };
		out.push(/** @type {string | number} */ (one.value));
	}
	return { ok: true, value: out };
};

/**
 * The English words of a refused value (the API's message; widgets show their own texts by the code).
 * @param {ValueRules} field
 * @param {{ code: ValueRefusal, value?: string }} refusal
 */
export const valueProblem = (field, { code, value }) => {
	const name = field.name;
	if (code === 'choice') return `Pick one of the choices of ${name}.`;
	if (code === 'range')
		return field.min !== null && field.max !== null
			? `${name} is from ${field.min} to ${field.max}.`
			: field.min !== null
				? `${name} is at least ${field.min}.`
				: `${name} is at most ${field.max}.`;
	if (code === 'decimals') return `${name} has at most ${field.decimals} decimals.`;
	if (code === 'date') return field.dates === 'past' ? `${name} is today or earlier.` : `${name} is today or later.`;
	if (code === 'values') return `${name} takes 1 to ${field.maxValues} different values.`;
	if (code === 'type') return `This is not a valid value of ${name}.`;
	return `${value ?? 'This value'} does not match the format of ${name}.`;
};

/**
 * Whether a field applies to a product: its category, else its categories ([] = every one), among the product's
 * categories and those above them (`lineage`).
 * @param {{ categoryId: string | null, categoryIds: string[] }} field
 * @param {ReadonlyArray<string>} lineage
 */
export const fieldApplies = (field, lineage) => {
	const scope = field.categoryId ? [field.categoryId] : field.categoryIds;
	return scope.length === 0 || scope.some((id) => lineage.includes(id));
};

// ------------------------------------------------------------------------------------------------------- units

/** A plain serial number (a unit of a product without unit fields): 1 to 64 letters, digits, spaces and . _ / : # - */
const PLAIN_SERIAL = /^[\p{L}\p{N}][\p{L}\p{N} ._/:#-]{0,63}$/u;
/** The words of a plain serial number's rule. */
export const PLAIN_SERIAL_RULE = 'A serial number is 1 to 64 letters, digits, spaces and . _ / : # -';

/**
 * Whether a text is a plain serial number.
 * @param {string} value
 */
export const isPlainSerial = (value) => PLAIN_SERIAL.test(value);

/**
 * One unit as the shop keeps it: its serial (the plain serial number, else the first value of its first unit field
 * that has one; order lines, packing and searches name the unit by it), its values by unit field, and its keys
 * (`num:<number>` for its serial and each value, whatever field holds it) the shop keeps unique, so no number names two
 * units.
 * @typedef {{ serial: string, values: Record<string, string[]>, keys: string[] }} UnitRecordValues
 */

/**
 * The keys of a unit: each of its numbers (its serial and every value, in any field) once.
 * @param {string} serial @param {Record<string, string[]>} [values]
 */
export const unitKeys = (serial, values = {}) => [
	...new Set([serial, ...Object.values(values).flat()].map((number) => `num:${number}`)),
];

/**
 * Check one unit against the unit fields of its item type (`core/item-types.js`). Without unit fields, a unit is a plain
 * serial number. With them, its values: a field's one value, or as many as the field takes (a unit with several numbers
 * of one kind), each in the field's format (kept as the format keeps it), every required field given; a text alone is the first field's value. A unit is named by the first value of its first field that has one.
 * @param {unknown} input a serial number (or the first field's value), or `{ values: { <fieldId>: value or [values] } }`
 * @param {ReadonlyArray<ValueRules & { id: string, required: boolean }>} fields
 * @returns {{ ok: true, value: UnitRecordValues } | { ok: false, path: string, message: string, code?: ValueRefusal }}
 */
export const checkUnit = (input, fields) => {
	if (fields.length === 0) {
		const serial = typeof input === 'string' ? input.trim() : null;
		if (serial === null || !isPlainSerial(serial)) return { ok: false, path: '', message: PLAIN_SERIAL_RULE };
		return { ok: true, value: { serial, values: {}, keys: unitKeys(serial, {}) } };
	}
	const first = /** @type {ValueRules & { id: string, required: boolean }} */ (fields[0]);
	if (typeof input !== 'string' && !(isObject(input) && isObject(input.values)))
		return { ok: false, path: '', message: 'Give the unit as its number, or as { values } by unit field.' };
	/** @type {Record<string, unknown>} */
	const given = typeof input === 'string' ? { [first.id]: input } : /** @type {any} */ (input).values;
	/** @type {Record<string, string[]>} */
	const values = {};
	for (const id of Object.keys(given))
		if (!fields.some((field) => field.id === id))
			return { ok: false, path: `/values/${id}`, message: 'This is not a unit field of this product.' };
	for (const field of fields) {
		const raw = given[field.id];
		if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
			if (field.required)
				return { ok: false, path: `/values/${field.id}`, message: `Give ${field.name}: every unit needs it.` };
			continue;
		}
		const checked = checkValue(field, raw);
		if (!checked.ok)
			return { ok: false, path: `/values/${field.id}`, message: valueProblem(field, checked), code: checked.code };
		values[field.id] = (Array.isArray(checked.value) ? checked.value : [checked.value]).map(String);
	}
	const named = fields.find((field) => values[field.id] !== undefined);
	if (!named) return { ok: false, path: '/values', message: 'Give at least one number of the unit.' };
	const serial = /** @type {string} */ ((values[named.id] ?? [])[0]);
	return { ok: true, value: { serial, values, keys: unitKeys(serial, values) } };
};

/**
 * The keys two or more of these units share (a number given twice in one request), else [].
 * @param {ReadonlyArray<{ keys: string[] }>} units
 */
export const sharedKeys = (units) => {
	const seen = new Set();
	/** @type {string[]} */
	const twice = [];
	for (const unit of units)
		for (const key of unit.keys) {
			if (seen.has(key) && !twice.includes(key)) twice.push(key);
			seen.add(key);
		}
	return twice;
};

/**
 * What a place shows of an order line's units: the serial numbers of units without unit field values (plain serial
 * numbers), and per unit field shown there (`show.shopper`, `show.invoice` or `show.packingSlip`) its values, in the
 * fields' order. A unit named by a field that does not show there shows none of its numbers.
 * @param {ReadonlyArray<string>} serials the line's units, by serial
 * @param {ReadonlyMap<string, Record<string, string[]>>} values each unit's values by serial (none: a plain serial)
 * @param {ReadonlyArray<{ id: string, name: string, sort: number, show: FieldShow }>} fields the unit fields
 * @param {'shopper' | 'invoice' | 'packingSlip'} place
 * @returns {{ serials: string[], values: Array<{ name: string, values: string[] }> }}
 */
export const unitsShown = (serials, values, fields, place) => ({
	serials: serials.filter((serial) => Object.keys(values.get(serial) ?? {}).length === 0),
	values: [...fields]
		.filter((field) => showsAt(field, place))
		.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
		.flatMap((field) => {
			const list = serials.flatMap((serial) => values.get(serial)?.[field.id] ?? []);
			return list.length > 0 ? [{ name: field.name, values: list }] : [];
		}),
});

// ------------------------------------------------------------------------------------------- orders, customers

/**
 * Check values given for some fields (an order's or a customer's): each key one of the fields, each value checked
 * ({@link checkValue}); null or '' clears a value.
 * @param {unknown} raw `{ <fieldId>: value or [values] or null }`
 * @param {ReadonlyArray<ValueRules & { id: string }>} fields the fields that may be given
 * @param {{ today?: string, path?: string }} [options] `path`: where refusals point (default `fields`)
 * @returns {{ ok: true, value: Record<string, FieldValue>, cleared: string[] } | { ok: false, path: string, message: string }}
 */
export const checkFieldValues = (raw, fields, { today, path = 'fields' } = {}) => {
	if (!isObject(raw)) return { ok: false, path, message: 'Give the values by field id.' };
	/** @type {Record<string, FieldValue>} */
	const value = {};
	/** @type {string[]} */
	const cleared = [];
	for (const [id, given] of Object.entries(raw)) {
		const field = fields.find((entry) => entry.id === id);
		if (!field) return { ok: false, path: `${path}/${id}`, message: 'There is no such field here.' };
		if (given === null || given === '' || (Array.isArray(given) && given.length === 0)) {
			cleared.push(id);
			continue;
		}
		const checked = checkValue(field, given, today ? { today } : {});
		if (!checked.ok) return { ok: false, path: `${path}/${id}`, message: valueProblem(field, checked) };
		value[id] = checked.value;
	}
	return { ok: true, value, cleared };
};

/**
 * The order stages a required order field may be needed by, in the order an order reaches them.
 * @type {Readonly<Record<string, number>>}
 */
const STAGE_RANK = Object.freeze({ packed: 1, shipped: 2, delivered: 3 });

/**
 * The required order fields an order still lacks for a staff move into a stage: those required by that stage or one
 * before it (fields checkout needs are the shopper's, asked when the order is placed).
 * @param {Record<string, FieldValue>} values the order's fields
 * @param {ReadonlyArray<{ id: string, name: string, active: boolean, required: boolean, requiredAt: string | null }>} fields
 *   the order fields
 * @param {string} stage the role of the status the order moves into
 */
export const missingOrderFields = (values, fields, stage) => {
	const rank = STAGE_RANK[stage] ?? 0;
	return fields.filter(
		(field) =>
			field.active &&
			field.required &&
			field.requiredAt !== null &&
			rank >= (STAGE_RANK[field.requiredAt] ?? Infinity) &&
			values[field.id] === undefined,
	);
};

/**
 * The values of fields a place shows (an order's or a customer's): each field shown there with a value, in the fields'
 * order, as people read it (`label`: a choice's label, a number with its unit, yes/no and dates as given).
 * @param {Record<string, FieldValue>} values
 * @param {ReadonlyArray<{ id: string, name: string, sort: number, show: FieldShow, type: FieldType, unit: string,
 *   choices: Array<{ value: string, label: string }> }>} fields
 * @param {keyof FieldShow | null} place null: every field (staff)
 * @returns {Array<{ id: string, name: string, value: FieldValue, label: string }>}
 */
export const fieldValuesShown = (values, fields, place) =>
	[...fields]
		.filter((field) => values[field.id] !== undefined && (place === null || showsAt(field, place)))
		.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
		.map((field) => {
			const value = /** @type {FieldValue} */ (values[field.id]);
			const one = (/** @type {string | number | boolean} */ entry) =>
				field.type === 'choice'
					? (field.choices.find((choice) => choice.value === entry)?.label ?? String(entry))
					: field.type === 'number' && field.unit
						? `${String(entry)} ${field.unit}`
						: String(entry);
			return { id: field.id, name: field.name, value, label: Array.isArray(value) ? value.map(one).join(', ') : one(value) };
		});

/**
 * The `{field.<slug>}` placeholders of documents (E26) for the values given (an order's, a customer's …): each field
 * with a value, as people read it ({@link fieldValuesShown}), by its slug.
 * @param {ReadonlyArray<{ values: Record<string, FieldValue>,
 *   fields: ReadonlyArray<Parameters<typeof fieldValuesShown>[1][number] & { slug: string }> }>} sources
 * @returns {Record<string, string>}
 */
export const fieldPlaceholders = (sources) => {
	/** @type {Record<string, string>} */
	const out = {};
	for (const { values, fields } of sources) {
		const slugs = new Map(fields.map((field) => [field.id, field.slug]));
		for (const entry of fieldValuesShown(values, fields, null)) out[`field.${slugs.get(entry.id)}`] = entry.label;
	}
	return out;
};

/** The longest message value (Notifications takes values of at most 1,000 characters). */
const MESSAGE_VALUE = 1000;
/** Message values of fields at most, so a message stays within Notifications' 50 values. */
const MAX_FIELD_VALUES = 25;

/**
 * The field values a message carries (E28): `field_<slug>` (the slug's dashes as underscores) for the order's, its
 * customer's and its lines' fields with a value, each as people read it (a line field: the lines' values, each once,
 * joined), at most {@link MAX_FIELD_VALUES}. A field whose slug cannot be a message value name (letters a–z, digits and
 * dashes, at most 58 characters) is left out. Templates use them as `{field_<slug>}`.
 * @param {Record<string, string>} placeholders `{field.<slug>}` values ({@link fieldPlaceholders}), lines' joined
 * @returns {Record<string, string>}
 */
export const fieldMessageValues = (placeholders) =>
	Object.fromEntries(
		Object.entries(placeholders)
			.map(
				([key, value]) =>
					/** @type {[string, string]} */ ([
						`field_${key.slice('field.'.length).replaceAll('-', '_')}`,
						value.slice(0, MESSAGE_VALUE),
					]),
			)
			.filter(([name]) => /^field_[a-z0-9_]{1,58}$/.test(name))
			.slice(0, MAX_FIELD_VALUES),
	);

/**
 * What a checkout asks of the shopper: the order fields shown to shoppers (active), with what their values take.
 * @param {ReadonlyArray<import('./model.js').AttributeRecord>} fields
 */
export const checkoutFields = (fields) =>
	fields
		.filter((field) => field.on === 'order' && field.active && field.show.shopper)
		.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
		.map((field) => ({
			id: field.id,
			name: field.name,
			type: field.type,
			choices: field.choices,
			unit: field.unit,
			min: field.min,
			max: field.max,
			decimals: field.decimals,
			dates: field.dates,
			multiple: field.multiple,
			maxValues: field.maxValues,
			format: field.format,
			required: field.required && field.requiredAt === 'checkout',
		}));

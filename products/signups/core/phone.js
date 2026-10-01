/**
 * Phone numbers, country-agnostic (pure). Generalises the proven ibrahimMobiles rules (`packages/shared/src/phone.ts`:
 * accept every common way a number is typed, persist one canonical form) from one hard-coded country to **E.164** for
 * any country:
 *
 * - `+<country code><national number>` and `00<country code>…` are international and need no configuration.
 * - A national number (`0320 4862403`, `(415) 555-0100`) is accepted only when the website configured a default
 *   calling code (`otp.default_calling_code`, e.g. `+92`, `+1`); its trunk prefix (`otp.trunk_prefix`, e.g. `0`) is
 *   dropped first. Without a default calling code national numbers are refused — the product never guesses a country.
 * - The canonical form is E.164: `+` then 7–15 digits, the first not `0` (ITU-T E.164 allows at most 15 digits).
 *
 * Separators (spaces, dots, dashes, slashes, parentheses) are ignored; letters and a second `+` are refused.
 * @module
 */

/** Canonical E.164 shape (7–15 digits overall, the shape `@ss/contracts` uses for phone identities). */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
/** A default calling code as configured (`+` and 1–3 digits, first not `0`). */
export const CALLING_CODE_PATTERN = /^\+[1-9]\d{0,2}$/;
/** Longest raw input considered (anything longer is refused before parsing). */
export const PHONE_INPUT_MAX = 40;

const ALLOWED_CHARACTERS = /^[\d\s()+./-]+$/;

/**
 * @typedef {object} PhoneOptions
 * @property {string} [defaultCallingCode] e.g. `+92`; empty = national numbers are refused
 * @property {string} [trunkPrefix] national trunk prefix dropped before the subscriber number, e.g. `0`
 */

/**
 * Normalise any accepted phone shape to E.164, or null.
 * @param {unknown} input
 * @param {PhoneOptions} [options]
 * @returns {string | null}
 */
export const normalisePhone = (input, { defaultCallingCode = '', trunkPrefix = '' } = {}) => {
	if (typeof input !== 'string') return null;
	const raw = input.trim();
	if (raw.length === 0 || raw.length > PHONE_INPUT_MAX || !ALLOWED_CHARACTERS.test(raw)) return null;
	const plus = raw.indexOf('+');
	if (plus > 0 || raw.lastIndexOf('+') !== plus) return null;
	const digits = raw.replace(/\D/g, '');
	if (plus === 0) return canonical(digits);
	if (digits.startsWith('00')) return canonical(digits.slice(2));
	if (!CALLING_CODE_PATTERN.test(defaultCallingCode)) return null;
	const national =
		trunkPrefix && /^\d{1,2}$/.test(trunkPrefix) && digits.startsWith(trunkPrefix) ? digits.slice(trunkPrefix.length) : digits;
	if (national.length < 4) return null;
	return canonical(`${defaultCallingCode.slice(1)}${national}`);
};

/**
 * @param {string} digits country code + national number, digits only
 * @returns {string | null}
 */
const canonical = (digits) => {
	const value = `+${digits}`;
	return E164_PATTERN.test(value) ? value : null;
};

/**
 * True for a canonical E.164 number.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isE164 = (value) => typeof value === 'string' && E164_PATTERN.test(value);

/**
 * Digits-only international form (`923204862403`) for messaging gateways that want it.
 * @param {string} e164
 */
export const internationalDigits = (e164) => e164.replace(/\D/g, '');

/**
 * A phone number masked for display (`+92 ••• ••• 403`): the country code's first digits and the last three digits.
 * @param {string} e164
 */
export const maskPhone = (e164) => {
	const digits = internationalDigits(e164);
	const tail = digits.slice(-3);
	const head = digits.slice(0, Math.min(2, Math.max(0, digits.length - 6)));
	return `+${head}${'•'.repeat(Math.max(3, digits.length - head.length - tail.length))}${tail}`;
};

/**
 * Money (pure, `Intl` only): integer minor units of an ISO-4217 currency. Display uses the runtime's currency data for
 * the number of minor digits (2 for EUR, 0 for JPY, 3 for KWD …) — never assumed. Arithmetic stays in integers.
 * @module
 */

/** @type {Map<string, Intl.NumberFormat>} */
const formats = new Map();

/**
 * @param {string} locale
 * @param {string} currency
 * @returns {Intl.NumberFormat | null}
 */
const formatFor = (locale, currency) => {
	const key = `${locale}|${currency}`;
	let format = formats.get(key);
	if (!format) {
		try {
			format = new Intl.NumberFormat(locale, { style: 'currency', currency });
		} catch {
			try {
				format = new Intl.NumberFormat('en', { style: 'currency', currency });
			} catch {
				return null;
			}
		}
		formats.set(key, format);
	}
	return format;
};

/**
 * Minor-unit digits of a currency (2 when unknown).
 * @param {string} currency
 */
export const minorDigits = (currency) => formatFor('en', currency)?.resolvedOptions().maximumFractionDigits ?? 2;

/**
 * @param {number} minor integer minor units
 * @param {string} currency ISO-4217
 * @param {string} [locale]
 * @returns {string}
 */
export const formatMoney = (minor, currency, locale = 'en') => {
	const format = formatFor(locale, currency);
	const digits = minorDigits(currency);
	const major = minor / 10 ** digits;
	return format ? format.format(major) : `${major.toFixed(digits)} ${currency}`;
};

/**
 * `amount × basisPoints / 10 000`, rounded half up (integers in and out). 100 bp = 1 %.
 * @param {number} amount
 * @param {number} basisPoints
 */
export const applyBasisPoints = (amount, basisPoints) =>
	amount <= 0 || basisPoints <= 0 ? 0 : Math.floor((amount * basisPoints + 5_000) / 10_000);

/**
 * Clamp to `[0, max]` (integers).
 * @param {number} value
 * @param {number} max
 */
export const clampAmount = (value, max) => Math.max(0, Math.min(Math.floor(max), Math.floor(value)));

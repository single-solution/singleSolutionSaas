/**
 * Money display (pure, `Intl` only): integer minor units of an ISO-4217 currency → localised text. The number of minor
 * digits comes from the runtime's currency data (2 for EUR, 0 for JPY, 3 for KWD …) — never assumed.
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

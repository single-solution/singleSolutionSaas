/**
 * Money display (pure, `Intl` only): integer minor units of an ISO 4217 currency → localised text. The number of minor
 * digits comes from the runtime's currency data (2 for EUR, 0 for JPY, 3 for KWD …) — never assumed. Kept apart from
 * the pricer so browser bundles that only format prices stay small.
 * @module
 */

/**
 * Minor-unit digits of a currency (2 when unknown).
 * @param {string} currency
 */
export const minorDigits = (currency) => {
	try {
		return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
	} catch {
		return 2;
	}
};

/**
 * Localised money text of integer minor units (a plain number when the currency is unknown).
 * @param {number} minor
 * @param {string | null} currency
 * @param {string} [locale]
 */
export const formatMoney = (minor, currency, locale = 'en') => {
	let tag = locale;
	try {
		new Intl.NumberFormat(tag);
	} catch {
		tag = 'en';
	}
	if (!currency) return new Intl.NumberFormat(tag).format(minor);
	const digits = minorDigits(currency);
	const major = minor / 10 ** digits;
	try {
		return new Intl.NumberFormat(tag, { style: 'currency', currency }).format(major);
	} catch {
		return `${major.toFixed(digits)} ${currency}`;
	}
};

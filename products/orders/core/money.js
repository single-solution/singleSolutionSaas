/**
 * Money (pure): integer minor units with the order's ISO 4217 currency. No float ever represents money and no currency
 * is assumed — amounts are formatted with the order's currency in the website's language.
 * @module
 */

const CURRENCY = /^[A-Z]{3}$/;

/** @param {unknown} value @returns {value is number} */
export const isAmount = (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;

/** @param {unknown} value @returns {value is string} */
export const isCurrency = (value) => typeof value === 'string' && CURRENCY.test(value);

/**
 * Minor-unit exponent of a currency (Intl knows every ISO 4217 code; 2 when unknown).
 * @param {string | null | undefined} currency
 */
export const exponentOf = (currency) => {
	if (!currency) return 2;
	try {
		return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
	} catch {
		return 2;
	}
};

/**
 * Parse a decimal amount in major units ("12.50", 12.5) into minor units with the currency's exponent; null when it has
 * more decimals than the currency allows or is not a non-negative number.
 * @param {unknown} value
 * @param {number} exponent digits after the decimal point (0–4)
 * @returns {number | null}
 */
export const parseMajor = (value, exponent) => {
	const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value : null;
	if (text === null) return null;
	const match = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(text.replace(/[\s_]/g, ''));
	if (!match) return null;
	const fraction = (match[2] ?? '').replace(/0+$/, '');
	if (fraction.length > exponent) return null;
	const amount = Number(match[1]) * 10 ** exponent + Number(fraction.padEnd(exponent, '0') || '0');
	return Number.isSafeInteger(amount) ? amount : null;
};

/**
 * Minor units as a major-unit decimal string ("1250" with exponent 2 → "12.50").
 * @param {number} amount
 * @param {number} exponent
 */
export const formatMajor = (amount, exponent) => {
	const sign = amount < 0 ? '-' : '';
	const abs = Math.abs(amount);
	if (exponent === 0) return `${sign}${abs}`;
	const text = String(abs).padStart(exponent + 1, '0');
	return `${sign}${text.slice(0, -exponent)}.${text.slice(-exponent)}`;
};

/**
 * Minor units as display text in a locale ("12,50 €"); the plain decimal when the currency is unknown.
 * @param {number} amount
 * @param {string | null | undefined} currency
 * @param {string} locale
 */
export const formatMoney = (amount, currency, locale) => {
	const exponent = exponentOf(currency);
	if (!currency) return formatMajor(amount, exponent);
	try {
		return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 10 ** exponent);
	} catch {
		return `${formatMajor(amount, exponent)} ${currency}`;
	}
};

/**
 * The amount configured for a currency in a `[{ currency, amount }]` list (0 when absent).
 * @param {ReadonlyArray<{ currency: string, amount: number }>} list
 * @param {string} currency
 */
export const amountFor = (list, currency) => list.find((entry) => entry.currency === currency)?.amount ?? 0;

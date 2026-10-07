/**
 * Money (pure): integer minor units only, with an ISO 4217 currency per website (the Portal's website settings), per
 * catalog (`items.currency`) or per item (`items.item_currency`). No float ever represents money.
 * @module
 */

/** Largest amount in minor units. */
export const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;

const CURRENCY = /^[A-Z]{3}$/;

/** @param {unknown} value */
export const isAmount = (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;

/** @param {unknown} value */
export const isCurrency = (value) => typeof value === 'string' && CURRENCY.test(value);

/**
 * The currency of an item: its own (when allowed), else the catalog's, else the website's; null when none is known.
 * @param {{ itemCurrency: boolean, catalogCurrency: string, websiteCurrency?: string | null }} settings
 * @param {{ currency?: string | null } | null} [item]
 * @returns {string | null}
 */
export const currencyOf = ({ itemCurrency, catalogCurrency, websiteCurrency = null }, item = null) => {
	if (itemCurrency && isCurrency(item?.currency)) return /** @type {string} */ (item?.currency);
	if (isCurrency(catalogCurrency)) return catalogCurrency;
	return isCurrency(websiteCurrency) ? websiteCurrency : null;
};

/**
 * Parse a decimal amount written in major units ("12.50") into minor units with the currency's exponent.
 * @param {string} text
 * @param {number} exponent digits after the decimal point (0–4)
 * @returns {number | null}
 */
export const parseMajor = (text, exponent) => {
	const cleaned = text.replace(/[\s_]/g, '');
	const match = /^(\d{1,15})(?:\.(\d{1,4}))?$/.exec(cleaned);
	if (!match) return null;
	const fraction = match[2] ?? '';
	if (fraction.length > exponent) return null;
	const value = Number(match[1]) * 10 ** exponent + Number(fraction.padEnd(exponent, '0') || '0');
	return Number.isSafeInteger(value) ? value : null;
};

/**
 * Minor units as a major-unit decimal string ("1250" with exponent 2 → "12.50").
 * @param {number} amount
 * @param {number} exponent
 */
export const formatMajor = (amount, exponent) => {
	if (exponent === 0) return String(amount);
	const text = String(amount).padStart(exponent + 1, '0');
	return `${text.slice(0, -exponent)}.${text.slice(-exponent)}`;
};

/**
 * Minor-unit exponent of a currency (Intl knows every ISO 4217 code; 2 when unknown).
 * @param {string | null} currency
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
 * Minor units as display text in a locale ("12,50 €"); the plain decimal when the currency is unknown.
 * @param {number} amount
 * @param {string | null} currency
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
 * Price range over variants (ported price rollup: min and max over every variant price).
 * @param {ReadonlyArray<{ price?: unknown, status?: string }>} variants
 * @returns {{ priceMin: number | null, priceMax: number | null }}
 */
export const priceRange = (variants) => {
	const prices = variants
		.filter((variant) => variant.status !== 'inactive')
		.map((variant) => variant.price)
		.filter((price) => isAmount(price))
		.map(Number);
	if (prices.length === 0) return { priceMin: null, priceMax: null };
	return { priceMin: Math.min(...prices), priceMax: Math.max(...prices) };
};

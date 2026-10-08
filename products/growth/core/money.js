/**
 * Money in browser events: integer minor units plus an ISO 4217 currency (PLAN 0.4.13), as Ecommerce dispatches them.
 * Pixels want major units (12.5 for 1250 cents), so this module knows each currency's decimals.
 * @module
 */

/** Currencies without minor units. */
const ZERO_DECIMALS = new Set([
	'BIF',
	'CLP',
	'DJF',
	'GNF',
	'ISK',
	'JPY',
	'KMF',
	'KRW',
	'PYG',
	'RWF',
	'UGX',
	'UYI',
	'VND',
	'VUV',
	'XAF',
	'XOF',
	'XPF',
]);

/** Currencies with three decimals. */
const THREE_DECIMALS = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** The largest amount an event may carry (minor units). */
export const MAX_AMOUNT = 1e12;

/** @param {unknown} value @returns {value is string} */
export const isCurrency = (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value);

/** @param {unknown} value @returns {value is number} an integer amount in minor units, 0 … 10^12 */
export const isAmount = (value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_AMOUNT;

/** @param {string} currency */
export const decimalsOf = (currency) => (ZERO_DECIMALS.has(currency) ? 0 : THREE_DECIMALS.has(currency) ? 3 : 2);

/**
 * Minor units as a major-unit number (1250 USD → 12.5).
 * @param {number} minor
 * @param {string} currency
 */
export const toMajor = (minor, currency) => minor / 10 ** decimalsOf(currency);

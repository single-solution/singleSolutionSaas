/**
 * Money (PLAN 0.4.13): amounts are integer minor units plus an ISO 4217 currency code, per payment (PLAN 0.8.7). The
 * gateways that want a decimal text get it from here. No currency, language or country is assumed. No I/O.
 * @module
 */

/** Currencies with no minor unit (ISO 4217 exponent 0). */
const ZERO_DECIMAL = new Set([
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
/** Currencies with three decimals (ISO 4217 exponent 3). */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** The largest amount of one payment, in minor units (keeps every sum an exact integer). */
export const MAX_AMOUNT = 1_000_000_000_000;

/**
 * True for an ISO 4217-shaped code (three capital letters).
 * @param {unknown} value
 * @returns {value is string}
 */
export const isCurrency = (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value);

/**
 * True for an amount in minor units: a whole number from 1 to {@link MAX_AMOUNT}.
 * @param {unknown} value
 * @returns {value is number}
 */
export const isAmount = (value) => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_AMOUNT;

/**
 * Decimals of a currency (ISO 4217 exponent; 2 unless listed).
 * @param {string} currency
 */
export const exponentOf = (currency) => (ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2);

/**
 * Minor units as the decimal text gateways take (`1050`, `PKR` → `10.50`).
 * @param {number} amount
 * @param {string} currency
 */
export const toDecimal = (amount, currency) => {
	const exponent = exponentOf(currency);
	if (exponent === 0) return String(amount);
	const text = String(amount).padStart(exponent + 1, '0');
	return `${text.slice(0, -exponent)}.${text.slice(-exponent)}`;
};

/**
 * A decimal text (`10.5`, `10.50`, `10`) as minor units, or null when it is not a plain positive amount with at most the
 * currency's decimals.
 * @param {unknown} text
 * @param {string} currency
 * @returns {number | null}
 */
export const fromDecimal = (text, currency) => {
	const exponent = exponentOf(currency);
	const value = typeof text === 'number' ? String(text) : typeof text === 'string' ? text.trim() : '';
	const match = /^(\d{1,13})(?:\.(\d+))?$/.exec(value);
	if (!match) return null;
	const fraction = match[2] ?? '';
	if (fraction.length > exponent && !/^0*$/.test(fraction.slice(exponent))) return null;
	const minor = Number(`${match[1]}${fraction.slice(0, exponent).padEnd(exponent, '0')}`);
	return isAmount(minor) ? minor : null;
};

/**
 * An amount for people: the currency code and the decimal with thousands grouped by commas (`PKR 1,250.00`).
 * @param {number} amount
 * @param {string} currency
 */
export const formatMoney = (amount, currency) => {
	const [whole = '0', fraction] = toDecimal(amount, currency).split('.');
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return `${currency} ${fraction === undefined ? grouped : `${grouped}.${fraction}`}`;
};

/**
 * Money (PLAN 0.4.13): amounts are integer minor units plus an ISO 4217 currency code, per payment (PLAN 0.8.7). The
 * gateways that want a decimal text get it from here (each currency's decimals from `@ss/contracts`). No currency,
 * language or country is assumed. No I/O.
 * @module
 */
import { currencyDigits } from '@ss/contracts/format';

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
 * Minor units as the decimal text gateways take (`1050`, `USD` → `10.50`).
 * @param {number} amount
 * @param {string} currency
 */
export const toDecimal = (amount, currency) => {
	const exponent = currencyDigits(currency);
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
	const exponent = currencyDigits(currency);
	const value = typeof text === 'number' ? String(text) : typeof text === 'string' ? text.trim() : '';
	const match = /^(\d{1,13})(?:\.(\d+))?$/.exec(value);
	if (!match) return null;
	const fraction = match[2] ?? '';
	if (fraction.length > exponent && !/^0*$/.test(fraction.slice(exponent))) return null;
	const minor = Number(`${match[1]}${fraction.slice(0, exponent).padEnd(exponent, '0')}`);
	return isAmount(minor) ? minor : null;
};

/**
 * The decimal sign money is shown with in a language (`.` for '' and for a language the runtime does not know).
 * @param {string} locale BCP 47 language tag, or ''
 */
export const decimalSignOf = (locale) => {
	try {
		const parts = new Intl.NumberFormat(locale || 'en-US').formatToParts(1.5);
		return parts.find((part) => part.type === 'decimal')?.value ?? '.';
	} catch {
		return '.';
	}
};

/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An amount a person typed (P6), as minor units, or null when it is not a plain positive amount with at most the
 * currency's decimals. It is digits with at most one decimal sign: `sign` (the one money is shown with, for example
 * from {@link decimalSignOf}), or the other of `.` and `,`, except when exactly three digits follow that other one, as
 * it could then be a thousands separator (`1,250` where the decimal sign is a dot, `1.250` where it is a comma): such a
 * text is refused, never misread. Thousands separators and spaces inside are refused.
 * @param {unknown} text
 * @param {string} currency
 * @param {string} [sign]
 * @returns {number | null}
 */
export const amountOf = (text, currency, sign = '.') => {
	const value = typeof text === 'number' ? String(text) : typeof text === 'string' ? text.trim() : '';
	const signs = new Set(['.', ',', sign]);
	const match = new RegExp(`^(\\d+)(?:(${[...signs].map(escapeRegExp).join('|')})(\\d+))?$`).exec(value);
	if (!match) return null;
	const [, whole, used, fraction] = match;
	if (used !== undefined && used !== sign && fraction?.length === 3) return null;
	return fromDecimal(used === undefined ? whole : `${whole}.${fraction}`, currency);
};

/**
 * Minor units as a plain number to type, with a decimal sign (`255050`, `USD`, `,` → `2550,50`).
 * @param {number} amount
 * @param {string} currency
 * @param {string} [sign]
 */
export const amountText = (amount, currency, sign = '.') => toDecimal(amount, currency).replace('.', sign);

/**
 * An amount for people: the currency code and the decimal with thousands grouped by commas (`USD 1,250.00`).
 * @param {number} amount
 * @param {string} currency
 */
export const formatMoney = (amount, currency) => {
	const [whole = '0', fraction] = toDecimal(amount, currency).split('.');
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return `${currency} ${fraction === undefined ? grouped : `${grouped}.${fraction}`}`;
};

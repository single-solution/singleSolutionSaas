/**
 * Amounts people type (P6): read with the decimal sign money is shown with, or the other of `.` and `,` when it cannot
 * be a thousands separator, and written back for typing. The rest of money (minor units, ISO 4217 checks, the plain
 * decimal of gateways and the API) is `@ss/contracts/format`'s. No I/O.
 * @module
 */
import { fromDecimal, toDecimal } from '@ss/contracts/format';

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

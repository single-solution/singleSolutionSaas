/**
 * Money in browser events: integer minor units plus an ISO 4217 currency (PLAN 0.4.13), as Ecommerce dispatches them.
 * Pixels want major units (12.5 for 1250 cents), from each currency's decimals (`@ss/contracts`).
 * @module
 */
import { currencyDigits } from '@ss/contracts/format';

/** The largest amount an event may carry (minor units). */
const MAX_AMOUNT = 1e12;

/** @param {unknown} value @returns {value is string} */
export const isCurrency = (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value);

/** @param {unknown} value @returns {value is number} an integer amount in minor units, 0 … 10^12 */
export const isAmount = (value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_AMOUNT;

/**
 * Minor units as a major-unit number (1250 USD → 12.5).
 * @param {number} minor
 * @param {string} currency
 */
export const toMajor = (minor, currency) => minor / 10 ** currencyDigits(currency);

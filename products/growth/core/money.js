/**
 * Money in browser events: integer minor units plus an ISO 4217 currency (PLAN 0.4.13), as Ecommerce dispatches them
 * (`isCurrency` and `isAmount` of `@ss/contracts/format` check them). Pixels want major units (12.5 for 1250 cents),
 * from each currency's decimals.
 * @module
 */
import { currencyDigits } from '@ss/contracts/format';

/**
 * Minor units as a major-unit number (1250 USD → 12.5).
 * @param {number} minor
 * @param {string} currency
 */
export const toMajor = (minor, currency) => minor / 10 ** currencyDigits(currency);

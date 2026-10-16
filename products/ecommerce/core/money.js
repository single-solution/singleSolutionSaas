/**
 * Money (PLAN 0.4.13): amounts are integer minor units plus an ISO 4217 currency code. The shop's currency is the
 * `catalog` setting `currency`; no currency, language or country is assumed in code. The checks and the decimal text
 * (`isAmount`, `isCurrency`, `toDecimal`, `fromDecimal`, `currencyDigits`) come from `@ss/contracts/format`, and the
 * text for people from the kit's `formatMoney` and the website's Format (PLAN 0.8.10 K7). This file keeps Ecommerce's
 * own sums: percentages, splitting a total over lines, rounding to whole units. No I/O.
 * @module
 */
import { currencyDigits } from '@ss/contracts/format';

/**
 * `percent` % of an amount, not rounded (deals rounded once per order, `deals.rounding: total_half_up`).
 * @param {number} amount minor units
 * @param {number} percent 0–100, may have decimals
 */
export const exactPercentOf = (amount, percent) => (amount * Math.min(100, Math.max(0, percent))) / 100;

/**
 * `percent` % of an amount, rounded half up to whole minor units (`percent` may have decimals, 0–100).
 * @param {number} amount minor units
 * @param {number} percent
 */
export const percentOf = (amount, percent) => Math.round(exactPercentOf(amount, percent));

/**
 * Split `total` minor units over parts in proportion to `weights` (largest remainder; the parts add up to `total`).
 * Used to spread an order-level discount over its lines.
 * @param {number} total
 * @param {number[]} weights
 * @returns {number[]}
 */
export const allocate = (total, weights) => {
	const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
	if (sum <= 0 || total <= 0) return weights.map(() => 0);
	const exact = weights.map((w) => (total * Math.max(0, w)) / sum);
	const parts = exact.map(Math.floor);
	let left = total - parts.reduce((a, b) => a + b, 0);
	const order = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest);
	for (const { index } of order) {
		if (left <= 0) break;
		parts[index] = /** @type {number} */ (parts[index]) + 1;
		left -= 1;
	}
	return parts;
};

/**
 * The smallest amount Ecommerce computes (PLAN 0.8.10 E25): one whole unit of the currency (100 minor units of USD)
 * while the website's Format shows whole units, else one minor unit.
 * @param {string} currency
 * @param {boolean} wholeUnits the Format's `wholeUnits`
 */
export const unitOf = (currency, wholeUnits) => (wholeUnits ? 10 ** currencyDigits(currency) : 1);

/**
 * An amount rounded down to whole `unit`s (deal discounts and the points' value, E25).
 * @param {number} amount minor units
 * @param {number} [unit]
 */
export const roundDown = (amount, unit = 1) => (unit > 1 ? Math.floor(amount / unit) * unit : Math.floor(amount));

/**
 * An amount rounded half up to whole `unit`s (percentage fees, role discounts and tax, E25).
 * @param {number} amount minor units (may have a fraction)
 * @param {number} [unit]
 */
export const roundHalfUp = (amount, unit = 1) => Math.round(amount / unit + 1e-9) * unit;

/**
 * `allocate` in whole `unit`s: the parts are whole units when `total` is, and add up to `total` (a total that is not a
 * multiple of `unit` leaves its remainder on the largest part).
 * @param {number} total minor units
 * @param {number[]} weights
 * @param {number} [unit]
 * @returns {number[]}
 */
export const allocateUnits = (total, weights, unit = 1) => {
	if (unit <= 1) return allocate(total, weights);
	const whole = Math.floor(total / unit);
	const parts = allocate(whole, weights).map((part) => part * unit);
	const rest = total - whole * unit;
	if (rest > 0 && parts.length > 0) {
		const largest = weights.reduce((best, weight, index) => (weight > (weights[best] ?? 0) ? index : best), 0);
		parts[largest] = /** @type {number} */ (parts[largest]) + rest;
	}
	return parts;
};

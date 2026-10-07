/**
 * Money helpers (pure). Amounts are integer minor units of one currency per cart (Part E §5); fractions only appear
 * inside a computation and are rounded once per deal and line with the website's rounding mode.
 * @module
 */

/** Rounding modes of computed discounts (`quote_api.rounding`). */
export const ROUNDING = Object.freeze(/** @type {const} */ (['half_up', 'floor', 'ceil']));

/** @typedef {(typeof ROUNDING)[number]} Rounding */

/** Below this, a computed fraction is treated as an exact integer (absorbs binary floating-point noise). */
const EPSILON = 1e-9;

/**
 * Round a non-negative amount to an integer.
 * @param {number} value
 * @param {Rounding} mode
 * @returns {number}
 */
export const roundAmount = (value, mode) => {
	if (!Number.isFinite(value) || value <= 0) return 0;
	const nearest = Math.round(value);
	if (Math.abs(value - nearest) < EPSILON) return nearest;
	if (mode === 'floor') return Math.floor(value);
	if (mode === 'ceil') return Math.ceil(value);
	return Math.floor(value + 0.5);
};

/**
 * Integer money check (safe, non-negative).
 * @param {unknown} value
 * @returns {value is number}
 */
export const isAmount = (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;

/**
 * Split `total` across `weights` proportionally with the largest-remainder method, so the parts are integers that sum
 * exactly to `total` (ties go to the earlier weight). Zero weights get zero unless every weight is zero.
 * @param {number} total
 * @param {number[]} weights
 * @returns {number[]}
 */
export const allocate = (total, weights) => {
	if (weights.length === 0) return [];
	const sum = weights.reduce((acc, w) => acc + Math.max(0, w), 0);
	if (sum <= 0) return weights.map((_, index) => (index === 0 ? total : 0));
	const raw = weights.map((w) => (total * Math.max(0, w)) / sum);
	const parts = raw.map((value) => Math.floor(value + EPSILON));
	let rest = total - parts.reduce((acc, value) => acc + value, 0);
	const order = raw
		.map((value, index) => ({ index, remainder: value - Math.floor(value + EPSILON) }))
		.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (const { index } of order) {
		if (rest <= 0) break;
		parts[index] = /** @type {number} */ (parts[index]) + 1;
		rest -= 1;
	}
	return parts;
};

/**
 * Percent (0–100, up to two decimals) of an amount, before rounding.
 * @param {number} amount
 * @param {number} percent
 */
export const percentOf = (amount, percent) => (amount * Math.round(Math.min(100, Math.max(0, percent)) * 100)) / 10_000;

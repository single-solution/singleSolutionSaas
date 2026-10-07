/**
 * Money units. Every amount is an **integer number of millicredits** (1 credit = 1000 millicredits).
 * Plain JS numbers are exact for integers up to 2^53, far beyond any balance.
 */

/** Number of millicredits in one credit. */
export const MILLICREDITS_PER_CREDIT = 1000;

/**
 * True when `value` is a non-negative safe integer.
 * @param {unknown} value
 * @returns {value is number}
 */
export const isMillicredits = (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;

/**
 * Throws unless `value` is a non-negative safe integer amount of millicredits.
 * @param {unknown} value
 * @param {string} [label]
 * @returns {number}
 */
export const assertMillicredits = (value, label = 'amount') => {
	if (!isMillicredits(value))
		throw new RangeError(`${label} must be a non-negative integer (millicredits), got ${String(value)}`);
	return value;
};

/**
 * Converts a decimal credit amount (for example a price of `1.25` credits per hour) into integer millicredits.
 * Throws when the amount is negative, not finite, or has more than 3 decimals.
 * @param {number} credits
 * @returns {number}
 */
export const toMillicredits = (credits) => {
	if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0) {
		throw new RangeError(`credits must be a finite non-negative number, got ${String(credits)}`);
	}
	const scaled = credits * MILLICREDITS_PER_CREDIT;
	const rounded = Math.round(scaled);
	if (Math.abs(scaled - rounded) > 1e-6 || !Number.isSafeInteger(rounded)) {
		throw new RangeError(`credits ${credits} cannot be represented in whole millicredits`);
	}
	return rounded;
};

/**
 * Converts integer millicredits into a decimal credit number for display only.
 * @param {number} millicredits
 * @returns {number}
 */
export const toCredits = (millicredits) => millicredits / MILLICREDITS_PER_CREDIT;

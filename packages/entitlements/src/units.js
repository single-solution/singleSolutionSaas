/**
 * Money representation for the commerce core.
 *
 * - All amounts are **integer millicredits** (1 credit = 1000 millicredits). Plain JS numbers
 *   are exact for integers up to 2^53, i.e. ~9 × 10^12 credits — far beyond any balance.
 * - Per-unit prices that are smaller than one millicredit (e.g. AI tokens) are expressed as a
 *   rational {@link Rate}: `millicredits` charged per `per` units. Charges for a quantity are
 *   `floor(quantity × millicredits / per)`; callers bill cumulative-within-period deltas so the sum
 *   of hourly charges equals the charge of the period total exactly (no rounding drift).
 */

/** Number of millicredits in one credit. */
export const MILLICREDITS_PER_CREDIT = 1000;

/** Largest denominator accepted when converting a decimal per-unit price into a {@link Rate}. */
const MAX_RATE_DENOMINATOR = 1_000_000_000;

/**
 * @typedef {object} Rate
 * @property {number} millicredits Integer millicredits charged per `per` units (≥ 0).
 * @property {number} per Integer number of units the price applies to (≥ 1).
 */

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
 * Converts a decimal credit amount (as written in manifests, e.g. `1.25`) into integer millicredits.
 * Throws when the amount is negative, not finite, or has sub-millicredit precision.
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
		throw new RangeError(`credits ${credits} cannot be represented in whole millicredits; use a per-unit Rate`);
	}
	return rounded;
};

/**
 * Converts integer millicredits into a decimal credit number for display only.
 * @param {number} millicredits
 * @returns {number}
 */
export const toCredits = (millicredits) => millicredits / MILLICREDITS_PER_CREDIT;

/**
 * Builds a {@link Rate} from a decimal per-unit credit price (e.g. `0.00001` credits per token →
 * `{ millicredits: 1, per: 100 }`). Throws when the price needs more than 9 decimal places of a millicredit.
 * @param {number} creditsPerUnit
 * @returns {Rate}
 */
export const rateFromCredits = (creditsPerUnit) => {
	if (typeof creditsPerUnit !== 'number' || !Number.isFinite(creditsPerUnit) || creditsPerUnit < 0) {
		throw new RangeError(`per-unit price must be a finite non-negative number, got ${String(creditsPerUnit)}`);
	}
	const scaled = creditsPerUnit * MILLICREDITS_PER_CREDIT;
	for (let per = 1; per <= MAX_RATE_DENOMINATOR; per *= 10) {
		const millicredits = Math.round(scaled * per);
		if (Math.abs(scaled * per - millicredits) <= 1e-6 && (millicredits > 0 || scaled === 0))
			return reduceRate({ millicredits, per });
	}
	throw new RangeError(`per-unit price ${creditsPerUnit} is too precise`);
};

/**
 * Greatest common divisor of two non-negative integers.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/**
 * Reduces a rate to lowest terms (so equal prices compare equal).
 * @param {Rate} rate
 * @returns {Rate}
 */
export const reduceRate = ({ millicredits, per }) => {
	if (millicredits === 0) return { millicredits: 0, per: 1 };
	const d = gcd(millicredits, per);
	return { millicredits: millicredits / d, per: per / d };
};

/**
 * Validates and normalises a rate given either as a {@link Rate} or as a decimal per-unit credit price.
 * @param {Rate | number} rate
 * @returns {Rate}
 */
export const normaliseRate = (rate) => {
	if (typeof rate === 'number') return rateFromCredits(rate);
	if (!rate || !isMillicredits(rate.millicredits) || !Number.isSafeInteger(rate.per) || rate.per < 1) {
		throw new RangeError('rate must be { millicredits: int ≥ 0, per: int ≥ 1 }');
	}
	return reduceRate(rate);
};

/**
 * Charge in millicredits for `quantity` units at `rate`, rounded down.
 * Uses `(quantity × millicredits) / per` with a split to keep intermediate values exact.
 * @param {number} quantity Non-negative integer.
 * @param {Rate} rate
 * @returns {number}
 */
export const chargeFor = (quantity, rate) => {
	if (!Number.isSafeInteger(quantity) || quantity < 0)
		throw new RangeError(`quantity must be a non-negative integer, got ${quantity}`);
	const whole = Math.floor(quantity / rate.per);
	const rest = quantity % rate.per;
	return whole * rate.millicredits + Math.floor((rest * rate.millicredits) / rate.per);
};

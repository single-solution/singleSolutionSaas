/**
 * Redemption maths (pure), ported from ibrahimMobiles `maxRedeemable` / `pointsToRupees` with configurable rates:
 * `rate_points` points are worth `rate_value_minor` minor units. The value of points is always rounded down and the
 * maximum is computed so the value never exceeds `max_share_percent` of the amount (the share itself is floored).
 * @module
 */

/** @typedef {{ min_points: number, max_share_percent: number, rate_points: number, rate_value_minor: number, allow_with_offers: boolean }} RedeemConfig */
/**
 * @typedef {object} Quote
 * @property {boolean} allowed
 * @property {string | null} reason why nothing can be redeemed
 * @property {number} balance
 * @property {number} minPoints
 * @property {number} maxPoints
 * @property {number} maxValue value of `maxPoints` in minor units
 * @property {number} capValue the share cap in minor units
 */

/** @param {unknown} v */
const whole = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0);

/**
 * Value of points in minor units (floored, never negative).
 * @param {number} points
 * @param {Pick<RedeemConfig, 'rate_points' | 'rate_value_minor'>} config
 */
export const pointsToValue = (points, config) =>
	Math.max(0, Math.floor((whole(points) * config.rate_value_minor) / Math.max(1, config.rate_points)));

/**
 * Most points whose value fits into `value` minor units.
 * @param {number} value
 * @param {Pick<RedeemConfig, 'rate_points' | 'rate_value_minor'>} config
 */
export const valueToPoints = (value, config) =>
	Math.max(0, Math.floor((whole(value) * Math.max(1, config.rate_points)) / Math.max(1, config.rate_value_minor)));

/**
 * What a member can redeem against an amount.
 * @param {{ balance: number, amount: number, discount?: number, config: RedeemConfig }} input
 * @returns {Quote}
 */
export const quote = ({ balance, amount, discount = 0, config }) => {
	const available = Math.max(0, whole(balance));
	const base = Math.max(0, whole(amount));
	const capValue = Math.floor((base * Math.min(100, Math.max(0, config.max_share_percent))) / 100);
	const maxPoints = Math.min(available, valueToPoints(capValue, config));
	const out = {
		balance: available,
		minPoints: config.min_points,
		maxPoints,
		maxValue: pointsToValue(maxPoints, config),
		capValue,
	};
	/** @type {string | null} */
	let reason = null;
	if (whole(discount) > 0 && !config.allow_with_offers) reason = 'offers_not_allowed';
	else if (base <= 0) reason = 'amount_required';
	else if (available <= 0) reason = 'no_balance';
	else if (maxPoints < config.min_points) reason = available < config.min_points ? 'below_minimum' : 'share_too_small';
	return reason ? { ...out, allowed: false, reason, maxPoints: 0, maxValue: 0 } : { ...out, allowed: true, reason: null };
};

/**
 * Check a requested number of points against a quote.
 * @param {number} points
 * @param {Quote} q
 * @returns {string | null} problem code or null
 */
export const redeemProblem = (points, q) => {
	if (!Number.isInteger(points) || points <= 0) return 'points_invalid';
	if (!q.allowed) return q.reason;
	if (points < q.minPoints) return 'below_minimum';
	if (points > q.maxPoints) return points > q.balance ? 'insufficient_points' : 'above_maximum';
	return null;
};

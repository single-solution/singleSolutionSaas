/**
 * Tiers (pure): qualification metric over a rolling window of local calendar months, the tier ladder, earn
 * multipliers, progress to the next tier and the downgrade policy.
 *
 * - Metric: `points_earned` (points credited by earn rules and referrals, minus reversals) or `spend` (completed order
 *   amounts in minor units, minus refunds), summed over the last `window_months` local months (0 = lifetime).
 * - The member qualifies for the highest tier whose `threshold` ≤ metric; with no tier at 0, a member may have none.
 * - Upgrades apply at once. Downgrades follow the policy: `never`; `immediate`; `end_of_period` — a tier is kept until
 *   its review date (achieved + window months; 12 months when the window is lifetime) and re-evaluated then.
 * @module
 */
import { addMonths, iso, recentMonthKeys, toMs } from './time.js';

/**
 * @typedef {object} Tier
 * @property {string} key
 * @property {string} name
 * @property {number} threshold
 * @property {number} [multiplier]
 * @property {{ free_shipping?: boolean, priority_support?: boolean, early_access?: boolean }} [perks]
 */
/** @typedef {{ key: string, since: string, reviewAt: string | null }} MemberTier */
/** @typedef {Record<string, { points: number, spend: number }>} Buckets local month → totals */
/** @typedef {{ tiers: Tier[], basis: 'points_earned' | 'spend', window_months: number, downgrade: 'never' | 'end_of_period' | 'immediate' }} TierConfig */

/** Months a review date is pushed out when the window is lifetime. */
export const LIFETIME_REVIEW_MONTHS = 12;

/**
 * Tiers sorted by threshold (stable).
 * @param {readonly Tier[]} tiers
 * @returns {Tier[]}
 */
export const ladder = (tiers) => [...tiers].sort((a, b) => a.threshold - b.threshold);

/**
 * Add to a month bucket.
 * @param {Buckets} buckets
 * @param {string} month
 * @param {{ points?: number, spend?: number }} delta
 * @returns {Buckets}
 */
export const addToBucket = (buckets, month, { points = 0, spend = 0 }) => {
	const current = buckets[month] ?? { points: 0, spend: 0 };
	return { ...buckets, [month]: { points: current.points + points, spend: current.spend + spend } };
};

/**
 * Drop buckets outside the window (lifetime keeps everything).
 * @param {Buckets} buckets
 * @param {{ now: number, months: number, timeZone: string }} window
 * @returns {Buckets}
 */
export const pruneBuckets = (buckets, { now, months, timeZone }) => {
	if (!(months > 0)) return buckets;
	const keep = new Set(recentMonthKeys(now, months, timeZone));
	return Object.fromEntries(Object.entries(buckets).filter(([key]) => keep.has(key)));
};

/**
 * Qualifying metric.
 * @param {{ buckets: Buckets, lifetime: { points: number, spend: number } }} member
 * @param {Pick<TierConfig, 'basis' | 'window_months'>} config
 * @param {{ now: number, timeZone: string }} at
 * @returns {number}
 */
export const tierMetric = (member, config, { now, timeZone }) => {
	const field = config.basis === 'spend' ? 'spend' : 'points';
	if (!(config.window_months > 0)) return Math.max(0, member.lifetime[field]);
	const total = recentMonthKeys(now, config.window_months, timeZone).reduce(
		(sum, key) => sum + (member.buckets[key]?.[field] ?? 0),
		0,
	);
	return Math.max(0, total);
};

/**
 * Highest tier reached by a metric, or null.
 * @param {readonly Tier[]} tiers
 * @param {number} metric
 * @returns {Tier | null}
 */
export const tierFor = (tiers, metric) => {
	/** @type {Tier | null} */
	let found = null;
	for (const tier of ladder(tiers)) if (tier.threshold <= metric) found = tier;
	return found;
};

/**
 * Next tier above the current metric and what is missing to reach it.
 * @param {readonly Tier[]} tiers
 * @param {number} metric
 * @returns {{ tier: Tier, remaining: number } | null}
 */
export const nextTier = (tiers, metric) => {
	const next = ladder(tiers).find((tier) => tier.threshold > metric);
	return next ? { tier: next, remaining: next.threshold - metric } : null;
};

/**
 * Earn multiplier of a tier key (1 when unknown or none).
 * @param {readonly Tier[]} tiers
 * @param {string | null | undefined} key
 */
export const multiplierOf = (tiers, key) => {
	const tier = key ? tiers.find((candidate) => candidate.key === key) : undefined;
	return typeof tier?.multiplier === 'number' && Number.isFinite(tier.multiplier) ? tier.multiplier : 1;
};

/**
 * Rank of a tier key in the ladder (-1 = none / unknown).
 * @param {readonly Tier[]} tiers
 * @param {string | null | undefined} key
 */
export const rankOf = (tiers, key) => (key ? ladder(tiers).findIndex((tier) => tier.key === key) : -1);

/**
 * Decide the member's tier after a change.
 * @param {{ current: MemberTier | null, metric: number, config: TierConfig, now: number }} input
 * @returns {{ tier: MemberTier | null, changed: boolean, direction: 'up' | 'down' | null }}
 */
export const decideTier = ({ current, metric, config, now }) => {
	const evaluated = tierFor(config.tiers, metric);
	const currentRank = rankOf(config.tiers, current?.key);
	const evaluatedRank = evaluated ? rankOf(config.tiers, evaluated.key) : -1;
	const reviewMonths = config.window_months > 0 ? config.window_months : LIFETIME_REVIEW_MONTHS;
	const fresh = (/** @type {Tier} */ tier) => ({ key: tier.key, since: iso(now), reviewAt: iso(addMonths(now, reviewMonths)) });
	// the member's tier was removed from the ladder: move to what the metric reaches now
	if (current && currentRank < 0)
		return evaluated
			? { tier: fresh(evaluated), changed: true, direction: 'up' }
			: { tier: null, changed: true, direction: 'down' };
	if (evaluatedRank > currentRank && evaluated) return { tier: fresh(evaluated), changed: true, direction: 'up' };
	if (evaluatedRank === currentRank) {
		// still qualifies: an end-of-period review renews the tier for another period
		if (current && config.downgrade === 'end_of_period' && current.reviewAt && toMs(current.reviewAt) <= now)
			return { tier: { ...current, reviewAt: iso(addMonths(now, reviewMonths)) }, changed: false, direction: null };
		return { tier: current, changed: false, direction: null };
	}
	// the metric points to a lower tier (or none)
	const keep = { tier: current, changed: false, direction: /** @type {null} */ (null) };
	if (config.downgrade === 'never') return keep;
	if (config.downgrade === 'end_of_period' && current?.reviewAt && toMs(current.reviewAt) > now) return keep;
	return { tier: evaluated ? fresh(evaluated) : null, changed: true, direction: 'down' };
};

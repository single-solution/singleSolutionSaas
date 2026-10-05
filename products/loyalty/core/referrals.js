/**
 * Referrals (pure): code format, attribution and reward decisions with fraud caps.
 *
 * - Codes are `<prefix><random>` over an unambiguous alphabet (no 0/O, 1/I/L) and are compared normalised
 *   (upper-case, spaces and dashes removed).
 * - Attribution refuses self-referrals, a second referrer for the same customer and — with `new_customers_only` —
 *   customers who already completed an order.
 * - Rewards are granted on the referee's first completed order of at least `min_order_amount` within
 *   `attribution_days` of attribution. The referee is always rewarded then; the referrer only while under the monthly
 *   and lifetime caps (fraud limits), otherwise the referral is recorded as `capped`.
 * @module
 */
import { DAY_MS, toMs } from './time.js';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * @typedef {{ referrer_points: number, referee_points: number, min_order_amount: number, code_prefix: string,
 *   code_length: number, attribution_days: number, source_prefix: string, new_customers_only: boolean,
 *   max_rewards_per_month: number, max_rewards_lifetime: number }} ReferralConfig
 */

/**
 * Build a code from random bytes (one byte per character).
 * @param {{ prefix: string, length: number, bytes: ArrayLike<number> }} input
 */
export const codeFromBytes = ({ prefix, length, bytes }) => {
	let out = prefix;
	for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
	return out;
};

/**
 * Normalise a code typed by a customer.
 * @param {unknown} input
 * @returns {string}
 */
export const normaliseCode = (input) => (typeof input === 'string' ? input.toUpperCase().replace(/[\s-]+/g, '') : '');

/**
 * Code from a `customer.created@1` `source` such as `referral:REF7K2M9QPA`.
 * @param {unknown} source
 * @param {string} prefix
 * @returns {string | null}
 */
export const codeFromSource = (source, prefix) => {
	if (typeof source !== 'string' || !prefix || !source.startsWith(prefix)) return null;
	const code = normaliseCode(source.slice(prefix.length));
	return code.length > 0 ? code : null;
};

/**
 * Can this customer be attributed to this referrer?
 * @param {{ referrerId: string | null, refereeId: string, alreadyReferred: boolean, refereeOrders: number, config: Pick<ReferralConfig, 'new_customers_only'> }} input
 * @returns {string | null} refusal reason
 */
export const attributionRefusal = ({ referrerId, refereeId, alreadyReferred, refereeOrders, config }) => {
	if (!referrerId) return 'unknown_code';
	if (referrerId === refereeId) return 'self_referral';
	if (alreadyReferred) return 'already_referred';
	if (config.new_customers_only && refereeOrders > 0) return 'not_a_new_customer';
	return null;
};

/**
 * Decide the rewards of a pending referral when the referee completes an order.
 * @param {{ attributedAt: string, now: number, orderAmount: number, referrerRewardsThisMonth: number,
 *   referrerRewardsTotal: number, config: ReferralConfig }} input
 * @returns {{ decision: 'wait' | 'expired' | 'reward', referee: number, referrer: number, reason: string | null }}
 */
export const rewardDecision = ({ attributedAt, now, orderAmount, referrerRewardsThisMonth, referrerRewardsTotal, config }) => {
	if (now > toMs(attributedAt) + config.attribution_days * DAY_MS)
		return { decision: 'expired', referee: 0, referrer: 0, reason: 'attribution_expired' };
	if (orderAmount < config.min_order_amount) return { decision: 'wait', referee: 0, referrer: 0, reason: 'order_below_minimum' };
	const capped = referrerRewardsThisMonth >= config.max_rewards_per_month || referrerRewardsTotal >= config.max_rewards_lifetime;
	return {
		decision: 'reward',
		referee: config.referee_points,
		referrer: capped ? 0 : config.referrer_points,
		reason: capped ? 'referrer_cap_reached' : null,
	};
};

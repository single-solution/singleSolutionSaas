/**
 * Reversal semantics (pure), ported from ibrahimMobiles `orderTransitions` (`reverseEarnedPoints`,
 * `refundRedeemedPoints`) and extended with partial refunds and a negative-balance policy:
 *
 * - The target reversal of an order is ⌊earned × refunded / total⌋ (cancelled or fully refunded = everything earned;
 *   `partial_refunds: none` ignores partial refunds). Each event reverses `target − reversed so far`, so replays and
 *   several partial refunds converge on the target and never exceed what was earned.
 * - `cap_at_balance` (ibrahimMobiles: "points already spent can't be clawed back below zero") reverses at most the
 *   current balance; `allow_negative` takes the balance below zero and later credits repay the debt.
 * - Redeemed points are given back on cancellation and on a full refund (once per redemption).
 * @module
 */

/** @typedef {{ reverse_earned: boolean, negative_balance: 'cap_at_balance' | 'allow_negative', partial_refunds: 'proportional' | 'none', refund_redeemed: boolean }} ReversalConfig */

/**
 * Fraction of the order that is refunded (0..1).
 * @param {{ cancelled?: boolean, refunded?: number, total: number }} order
 */
export const refundedFraction = ({ cancelled = false, refunded = 0, total }) => {
	if (cancelled) return 1;
	if (!(total > 0)) return refunded > 0 ? 1 : 0;
	return Math.min(1, Math.max(0, refunded) / total);
};

/**
 * Total points that should be reversed for an order once `fraction` of it is undone.
 * @param {{ earned: number, fraction: number, config: ReversalConfig }} input
 */
export const reversalTarget = ({ earned, fraction, config }) => {
	if (!config.reverse_earned) return 0;
	const effective = fraction < 1 && config.partial_refunds === 'none' ? 0 : Math.min(1, Math.max(0, fraction));
	return Math.floor(Math.max(0, earned) * effective);
};

/**
 * Spend (minor units) to take out of the tier metric once `fraction` of an order is undone.
 * @param {{ total: number, fraction: number, config: ReversalConfig }} input
 */
export const spendTarget = ({ total, fraction, config }) => {
	const effective = fraction < 1 && config.partial_refunds === 'none' ? 0 : Math.min(1, Math.max(0, fraction));
	return Math.floor(Math.max(0, total) * effective);
};

/**
 * Points actually reversed for a due amount under the negative-balance policy.
 * @param {{ due: number, balance: number, config: ReversalConfig }} input
 * @returns {{ points: number, allowNegative: boolean, uncollected: number }}
 */
export const collectible = ({ due, balance, config }) => {
	const allowNegative = config.negative_balance === 'allow_negative';
	const owed = Math.max(0, Math.floor(due));
	const points = allowNegative ? owed : Math.min(owed, Math.max(0, Math.floor(balance)));
	return { points, allowNegative, uncollected: owed - points };
};

/**
 * Points to reverse now (target − already reversed, then the negative-balance policy).
 * @param {{ earned: number, reversed: number, fraction: number, balance: number, config: ReversalConfig }} input
 * @returns {{ points: number, allowNegative: boolean, target: number, uncollected: number }}
 */
export const reversalFor = ({ earned, reversed, fraction, balance, config }) => {
	const target = reversalTarget({ earned, fraction, config });
	const due = Math.max(0, target - Math.max(0, reversed));
	return { ...collectible({ due, balance, config }), target };
};

/**
 * Should redeemed points be given back for this order change?
 * @param {{ fraction: number, config: ReversalConfig }} input
 */
export const returnsRedeemed = ({ fraction, config }) => config.refund_redeemed && fraction >= 1;

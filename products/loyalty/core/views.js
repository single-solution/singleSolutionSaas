/**
 * Public representations (pure): what Mode C returns and what the headless wallet renders. Tenant keys, journals,
 * lots and cap usage never leave the product.
 * @module
 */
import { upcomingExpiry } from './lots.js';
import { multiplierOf, nextTier, tierMetric } from './tiers.js';
import { DAY_MS } from './time.js';

/** @typedef {import('./member.js').Member} Member */
/** @typedef {import('./member.js').Transaction} Transaction */
/** @typedef {import('./tiers.js').TierConfig} TierConfig */

/**
 * @param {Transaction} tx
 */
export const transactionView = (tx) => ({
	id: tx.id,
	customerId: tx.customerId,
	kind: tx.kind,
	points: tx.points,
	balanceAfter: tx.balanceAfter,
	reason: tx.reason,
	note: tx.note,
	occurredAt: tx.occurredAt,
	orderId: typeof tx.source?.orderId === 'string' ? tx.source.orderId : null,
	ruleIds: Array.isArray(tx.source?.ruleIds) ? tx.source.ruleIds : [],
});

/**
 * Tier summary of a member (null without a tier configuration).
 * @param {Member} member
 * @param {TierConfig | null} config
 * @param {{ now: number, timeZone: string }} at
 */
export const tierView = (member, config, at) => {
	if (!config || config.tiers.length === 0) return null;
	const metric = tierMetric(
		{ buckets: member.buckets, lifetime: { points: member.lifetime.points, spend: member.lifetime.spend } },
		config,
		at,
	);
	const current = member.tier ? (config.tiers.find((tier) => tier.key === member.tier?.key) ?? null) : null;
	const next = nextTier(config.tiers, metric);
	return {
		key: current?.key ?? null,
		name: current?.name ?? null,
		multiplier: multiplierOf(config.tiers, current?.key),
		perks: current?.perks ?? {},
		since: member.tier?.since ?? null,
		reviewAt: member.tier?.reviewAt ?? null,
		basis: config.basis,
		metric,
		next: next ? { key: next.tier.key, name: next.tier.name, remaining: next.remaining } : null,
	};
};

/**
 * Points expiring next within `days` (null when none, expiry is off or the window is 0).
 * @param {Member} member
 * @param {{ now: number, timeZone: string, days: number, expiry: import('./lots.js').ExpiryPolicy | null }} options
 */
export const expiringView = (member, { now, timeZone, days, expiry }) => {
	if (!(days > 0) || !expiry) return null;
	const next = upcomingExpiry(
		{ lots: member.lots, debt: member.debt },
		{ now, windowMs: days * DAY_MS, timeZone, policy: expiry },
	);
	return next ? { points: next.points, expiresAt: next.expiresAt, expiresOn: next.expiresOn } : null;
};

/**
 * @param {Member} member
 * @param {{ tiers: TierConfig | null, now: number, timeZone: string, expiringWindowDays?: number, expiry?: import('./lots.js').ExpiryPolicy | null }} options
 */
export const memberView = (member, { tiers, now, timeZone, expiringWindowDays = 0, expiry = null }) => ({
	customerId: member.customerId,
	balance: member.balance,
	lifetime: { earned: member.lifetime.earned, redeemed: member.lifetime.redeemed, spend: member.lifetime.spend },
	tier: tierView(member, tiers, { now, timeZone }),
	expiring: expiringView(member, { now, timeZone, days: expiringWindowDays, expiry }),
	orders: member.orders,
	joinedAt: member.joinedAt,
	referralCode: member.referralCode,
	referredBy: member.referredBy,
});

/**
 * @param {Record<string, any>} redemption stored document
 */
export const redemptionView = (redemption) => ({
	id: redemption.id,
	customerId: redemption.customerId,
	status: redemption.status,
	points: redemption.points,
	valueAmount: redemption.valueAmount,
	currency: redemption.currency,
	orderId: redemption.orderId ?? null,
	reference: redemption.reference ?? null,
	balanceAfter: redemption.balanceAfter,
	createdAt: redemption.createdAt instanceof Date ? redemption.createdAt.toISOString() : redemption.createdAt,
	returnedAt: redemption.returnedAt ?? null,
});

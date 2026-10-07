/**
 * Waitlist priority (pure): who is told first when stock or capacity comes back. FIFO by default; with the
 * `waitlist_priority` element in `tier` order, a rank derived from a claim of the customer's own verified identity
 * token (e.g. `tier: "gold"`) comes first and FIFO breaks ties. Lower rank = earlier. Unknown or missing tiers rank
 * after every configured tier.
 * @module
 */

/** @typedef {{ key: string, rank: number }} TierRank */

/**
 * Rank of a subscription.
 * @param {unknown} tier the tier claim (string) or null
 * @param {{ order: 'fifo' | 'tier', tiers: readonly TierRank[] }} settings
 * @returns {number}
 */
export const rankOf = (tier, { order, tiers }) => {
	if (order !== 'tier') return 0;
	const lowest = tiers.reduce((max, entry) => Math.max(max, entry.rank), 0) + 1;
	if (typeof tier !== 'string') return lowest;
	const match = tiers.find((entry) => entry.key === tier);
	return match ? match.rank : lowest;
};

/**
 * How many waiters a change may notify: availability waitlists (and capacity-limited custom types) notify
 * `freeUnits × perUnit` (none when no unit is free); everything else is unlimited (`null`) — the per-run fan-out limit
 * only splits the work across runs.
 * @param {{ type: string, freeUnits: number | null, perUnit: number, capacityLimited?: boolean }} input
 * @returns {number | null}
 */
export const notifyCount = ({ type, freeUnits, perUnit, capacityLimited = false }) => {
	if ((type !== 'availability' && !capacityLimited) || freeUnits === null) return null;
	return Math.max(0, Math.floor(freeUnits)) * Math.max(1, Math.floor(perUnit));
};

/**
 * Comparator of waitlist order: rank, then subscription time, then id.
 * @param {{ rank?: number, subscribedAt: string, id: string }} a
 * @param {{ rank?: number, subscribedAt: string, id: string }} b
 */
export const waitlistOrder = (a, b) =>
	(a.rank ?? 0) - (b.rank ?? 0) || a.subscribedAt.localeCompare(b.subscribedAt) || a.id.localeCompare(b.id);

/**
 * A claim read from a verified token's payload (string claims only; nested paths with dots).
 * @param {Record<string, unknown> | null} claims
 * @param {string} name
 * @returns {string | null}
 */
export const claimOf = (claims, name) => {
	if (!claims || !name) return null;
	/** @type {unknown} */
	let value = claims;
	for (const part of name.split('.')) {
		if (typeof value !== 'object' || value === null || !Object.hasOwn(value, part)) return null;
		value = /** @type {Record<string, unknown>} */ (value)[part];
	}
	return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
};

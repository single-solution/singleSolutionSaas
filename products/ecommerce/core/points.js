/**
 * Loyalty points as lots (PLAN 0.8.8: earn, redeem, expiry, history). Each earning is a lot with an optional expiry;
 * spending takes the oldest lots first; a lot past its expiry is written off the next time the account is read or
 * changed (no scheduled job). Pure functions; the ledger applies them inside the order transaction. No I/O.
 * @module
 */

/** @typedef {import('./model.js').LoyaltyRecord} LoyaltyRecord */
/** @typedef {LoyaltyRecord['lots'][number]} Lot */

/**
 * Write off the points of lots that expired by `now`.
 * @param {Lot[]} lots
 * @param {number} now epoch ms
 * @returns {{ lots: Lot[], expired: number }}
 */
export const expireLots = (lots, now) => {
	let expired = 0;
	const out = lots.map((lot) => {
		if (lot.left > 0 && lot.expiresAt !== null && new Date(lot.expiresAt).getTime() <= now) {
			expired += lot.left;
			return { ...lot, left: 0 };
		}
		return lot;
	});
	return { lots: out, expired };
};

/** @param {Lot[]} lots */
export const balanceOf = (lots) => lots.reduce((sum, lot) => sum + lot.left, 0);

/**
 * Take `points` from the lots, oldest (soonest expiring) first.
 * @param {Lot[]} lots
 * @param {number} points
 * @returns {{ ok: true, lots: Lot[] } | { ok: false }} not ok when the lots hold fewer points
 */
export const spendFromLots = (lots, points) => {
	if (!Number.isSafeInteger(points) || points < 0) return { ok: false };
	if (balanceOf(lots) < points) return { ok: false };
	const order = lots
		.map((lot, index) => ({ lot, index }))
		.sort((a, b) => {
			const ea = a.lot.expiresAt === null ? Infinity : new Date(a.lot.expiresAt).getTime();
			const eb = b.lot.expiresAt === null ? Infinity : new Date(b.lot.expiresAt).getTime();
			return ea - eb || new Date(a.lot.earnedAt).getTime() - new Date(b.lot.earnedAt).getTime() || a.index - b.index;
		});
	const out = [...lots];
	let left = points;
	for (const { lot, index } of order) {
		if (left === 0) break;
		const take = Math.min(lot.left, left);
		out[index] = { ...lot, left: lot.left - take };
		left -= take;
	}
	return { ok: true, lots: out };
};

/**
 * Take back up to `points` (a reversal: an order that earned them was returned or refunded), first from the lots that
 * order earned, then from the oldest. The balance never goes below 0.
 * @param {Lot[]} lots
 * @param {number} points
 * @param {string | null} orderId
 * @returns {{ lots: Lot[], taken: number }}
 */
export const takeFromLots = (lots, points, orderId) => {
	const out = [...lots];
	let left = Math.max(0, Math.floor(points));
	const indexes = out.map((_, index) => index);
	indexes.sort((a, b) => Number(out[b]?.orderId === orderId) - Number(out[a]?.orderId === orderId) || a - b);
	for (const index of indexes) {
		if (left === 0) break;
		const lot = /** @type {Lot} */ (out[index]);
		const take = Math.min(lot.left, left);
		out[index] = { ...lot, left: lot.left - take };
		left -= take;
	}
	return { lots: out, taken: Math.max(0, Math.floor(points)) - left };
};

/** Lots that are spent and older than this many kept lots are dropped from the record. */
const KEEP_EMPTY_LOTS = 50;

/**
 * Drop empty lots beyond the newest {@link KEEP_EMPTY_LOTS}, so the record stays small.
 * @param {Lot[]} lots
 * @returns {Lot[]}
 */
export const compactLots = (lots) => {
	const empty = lots.filter((lot) => lot.left === 0);
	if (empty.length <= KEEP_EMPTY_LOTS) return lots;
	const drop = new Set(empty.slice(0, empty.length - KEEP_EMPTY_LOTS));
	return lots.filter((lot) => !drop.has(lot));
};

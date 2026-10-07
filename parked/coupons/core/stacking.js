/**
 * Stacking policy (pure): which of several eligible coupons apply together, in what order, and the resulting totals.
 * Ported from ibrahimMobiles `evaluateCartOffers` (item deals first, then a cart-wide offer on the post-deal total;
 * a non-stackable side blocks the other; loyalty allowed only when every applied offer allows it) and generalised to
 * merchant-defined **classes** (`stacking.classes`, e.g. item / order / shipping, each listing the classes it combines
 * with), a per-cart maximum, exclusive coupons, priorities and two selection strategies:
 *
 * - `in_order` — codes are accepted in the order the customer entered them;
 * - `best_discount` — codes are ranked by their standalone value first (the customer gets the best combination the
 *   greedy pass finds).
 *
 * Accepted coupons are then applied class by class (in the order of `classes`), by priority, so each sees the
 * remaining amounts left by the ones before it. Without the `stacking` element a cart takes one coupon.
 * @module
 */
import { computeAction } from './actions.js';

/** @typedef {import('./evaluate.js').Candidate} Candidate */
/** @typedef {import('./actions.js').ActionBounds} ActionBounds */
/**
 * @typedef {object} StackPolicy
 * @property {number} maxCoupons
 * @property {ReadonlyArray<{ key: string, combines_with?: string[] }>} classes
 * @property {boolean} allowSameClass
 * @property {'in_order' | 'best_discount'} strategy
 */
/**
 * @typedef {object} AppliedCoupon
 * @property {string} couponId
 * @property {string} code
 * @property {string} name
 * @property {string} class
 * @property {number} discount
 * @property {number} shippingDiscount
 * @property {boolean} freeShipping
 * @property {Array<{ lineId: string, amount: number }>} lines
 * @property {Array<{ itemId: string, variantId: string | null, quantity: number }>} gifts
 * @property {boolean} withLoyalty
 * @property {boolean} withDeals
 */
/**
 * @typedef {object} StackResult
 * @property {AppliedCoupon[]} applied
 * @property {Array<{ code: string, couponId?: string | null, reason: string }>} rejected
 * @property {number} subtotal
 * @property {number} discount line discounts
 * @property {number} shipping
 * @property {number} shippingDiscount
 * @property {number} total subtotal − discount + shipping − shippingDiscount
 * @property {boolean} freeShipping
 * @property {Array<{ itemId: string, variantId: string | null, quantity: number }>} gifts
 * @property {Array<{ lineId: string, discount: number }>} lines per-line discount (lines with a discount only)
 * @property {boolean} loyaltyAllowed every applied coupon allows loyalty points
 * @property {boolean} dealsAllowed every applied coupon allows automatic deals
 */

/** The policy of a website without the stacking element: one coupon per cart. */
export const SINGLE_COUPON = Object.freeze(
	/** @type {StackPolicy} */ ({ maxCoupons: 1, classes: [], allowSameClass: false, strategy: 'in_order' }),
);

/**
 * Do two classes combine (either side lists the other)?
 * @param {string} a
 * @param {string} b
 * @param {StackPolicy} policy
 */
export const classesCombine = (a, b, policy) => {
	if (a === b) return policy.allowSameClass;
	const listed = (/** @type {string} */ from, /** @type {string} */ to) =>
		policy.classes.some(
			(entry) => entry.key === from && Array.isArray(entry.combines_with) && entry.combines_with.includes(to),
		);
	return listed(a, b) || listed(b, a);
};

/**
 * Why a candidate cannot join the already accepted ones (null = it can).
 * @param {Candidate} candidate
 * @param {readonly Candidate[]} accepted
 * @param {StackPolicy} policy
 * @returns {string | null}
 */
export const combinationRefusal = (candidate, accepted, policy) => {
	if (accepted.some((other) => other.couponId === candidate.couponId)) return 'duplicate_coupon';
	if (accepted.length >= policy.maxCoupons) return 'too_many_coupons';
	if (accepted.length > 0 && (candidate.exclusive || accepted.some((other) => other.exclusive))) return 'not_combinable';
	if (accepted.some((other) => !classesCombine(other.class, candidate.class, policy))) return 'not_combinable';
	return null;
};

/**
 * @param {import('./cart.js').Cart} cart
 * @returns {import('./actions.js').WorkLine[]}
 */
const freshLines = (cart) =>
	cart.lines.map((line) => ({
		lineId: line.lineId,
		itemId: line.itemId,
		variantId: line.variantId,
		quantity: line.quantity,
		unitAmount: line.unitAmount,
		remaining: line.amount,
	}));

/**
 * Apply candidates to a cart under a policy.
 * @param {{ cart: import('./cart.js').Cart, candidates: readonly Candidate[], policy: StackPolicy, bounds: ActionBounds }} input
 * @returns {StackResult}
 */
export const applyStack = ({ cart, candidates, policy, bounds }) => {
	/** @type {Candidate[]} */
	let ranked = [...candidates].sort((a, b) => a.index - b.index);
	if (policy.strategy === 'best_discount') {
		const value = new Map(
			ranked.map((candidate) => {
				const alone = computeAction(candidate.action, {
					lines: freshLines(cart),
					matched: candidate.matched,
					shipping: cart.shipping,
					bounds,
				});
				return [candidate, alone.discount + alone.shippingDiscount];
			}),
		);
		ranked = ranked.sort((a, b) => (value.get(b) ?? 0) - (value.get(a) ?? 0) || a.index - b.index);
	}
	/** @type {Candidate[]} */
	const accepted = [];
	/** @type {StackResult['rejected']} */
	const rejected = [];
	for (const candidate of ranked) {
		const refusal = combinationRefusal(candidate, accepted, policy);
		if (refusal) rejected.push({ code: candidate.code, couponId: candidate.couponId, reason: refusal });
		else accepted.push(candidate);
	}
	const classIndex = (/** @type {string} */ key) => {
		const index = policy.classes.findIndex((entry) => entry.key === key);
		return index === -1 ? policy.classes.length : index;
	};
	const sequence = [...accepted].sort(
		(a, b) => classIndex(a.class) - classIndex(b.class) || b.priority - a.priority || a.index - b.index,
	);
	const lines = freshLines(cart);
	let shippingLeft = cart.shipping;
	/** @type {AppliedCoupon[]} */
	const applied = [];
	for (const candidate of sequence) {
		const outcome = computeAction(candidate.action, { lines, matched: candidate.matched, shipping: shippingLeft, bounds });
		if (outcome.discount === 0 && outcome.shippingDiscount === 0 && !outcome.freeShipping && outcome.gifts.length === 0) {
			rejected.push({ code: candidate.code, couponId: candidate.couponId, reason: 'no_discount' });
			continue;
		}
		for (const share of outcome.lines) {
			const line = lines.find((entry) => entry.lineId === share.lineId);
			if (line) line.remaining -= share.amount;
		}
		shippingLeft -= outcome.shippingDiscount;
		applied.push({
			couponId: candidate.couponId,
			code: candidate.code,
			name: candidate.name,
			class: candidate.class,
			discount: outcome.discount,
			shippingDiscount: outcome.shippingDiscount,
			freeShipping: outcome.freeShipping,
			lines: outcome.lines,
			gifts: outcome.gifts,
			withLoyalty: candidate.withLoyalty,
			withDeals: candidate.withDeals,
		});
	}
	const discount = applied.reduce((sum, coupon) => sum + coupon.discount, 0);
	const shippingDiscount = applied.reduce((sum, coupon) => sum + coupon.shippingDiscount, 0);
	return {
		applied,
		rejected,
		subtotal: cart.subtotal,
		discount,
		shipping: cart.shipping,
		shippingDiscount,
		total: cart.subtotal - discount + cart.shipping - shippingDiscount,
		freeShipping: applied.some((coupon) => coupon.freeShipping),
		gifts: applied.flatMap((coupon) => coupon.gifts),
		lines: cart.lines
			.map((line, index) => ({ lineId: line.lineId, discount: line.amount - (lines[index]?.remaining ?? line.amount) }))
			.filter((line) => line.discount > 0),
		loyaltyAllowed: applied.every((coupon) => coupon.withLoyalty),
		dealsAllowed: applied.every((coupon) => coupon.withDeals),
	};
};

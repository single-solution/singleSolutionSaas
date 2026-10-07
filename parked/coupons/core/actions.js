/**
 * Coupon actions (pure): what a coupon takes off. Ported from ibrahimMobiles `offerEvaluator` (percentage clamped to
 * 0–100 %, fixed amounts capped at what they apply to, free shipping, BXGY) and extended with tiered discounts and gift
 * items. Amounts are integer minor units; rounding happens once per discount (`rounding`: floor / round / ceil) and the
 * result is allocated to lines with the largest-remainder method, so line discounts always add up to the total and a
 * line never goes below zero.
 *
 * Every computation runs on the **remaining** amounts of the lines (after coupons applied before it in the stack), so a
 * stacked order coupon sees the post-item-discount total (ported stacking order).
 * @module
 */

/** Action types. */
export const ACTION_TYPES = Object.freeze(['percent', 'fixed', 'free_shipping', 'bxgy', 'tiered', 'gift']);
/** Targets of percent / fixed / tiered actions. */
export const TARGETS = Object.freeze(['matched', 'order']);
/** Rounding modes. */
export const ROUNDING = Object.freeze(['floor', 'round', 'ceil']);
/** The largest percentage any action may take off (a hard bound; `actions.max_percent` may lower it). */
export const MAX_PERCENT = 100;

/**
 * @typedef {object} WorkLine a line as the action sees it
 * @property {string} lineId
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {number} quantity
 * @property {number} unitAmount
 * @property {number} remaining amount still payable on the line (≥ 0)
 */
/**
 * @typedef {object} ActionResult
 * @property {number} discount line discounts (minor units)
 * @property {Array<{ lineId: string, amount: number }>} lines allocation of `discount`
 * @property {number} shippingDiscount
 * @property {boolean} freeShipping
 * @property {Array<{ itemId: string, variantId: string | null, quantity: number }>} gifts
 */
/** @typedef {{ rounding: string, maxPercent: number, maxFixedAmount: number }} ActionBounds */

/**
 * Round a non-negative amount to an integer.
 * @param {number} value
 * @param {string} mode
 */
export const roundMinor = (value, mode) => {
	if (!Number.isFinite(value) || value <= 0) return 0;
	if (mode === 'floor') return Math.floor(value + 1e-9);
	if (mode === 'ceil') return Math.ceil(value - 1e-9);
	return Math.floor(value + 0.5 + 1e-9);
};

/**
 * Fraction a percentage takes off, clamped to 0…`maxPercent` (a bad value can never go negative or above 100 %).
 * @param {unknown} percent
 * @param {number} [maxPercent]
 */
export const percentFraction = (percent, maxPercent = MAX_PERCENT) => {
	if (typeof percent !== 'number' || !Number.isFinite(percent) || percent <= 0) return 0;
	return Math.min(percent, maxPercent, MAX_PERCENT) / 100;
};

/**
 * Allocate an integer total over lines in proportion to their remaining amounts (largest remainder; ties by order).
 * `total` is clamped to Σ remaining, so no line is ever over-discounted.
 * @param {number} total
 * @param {readonly WorkLine[]} lines
 * @returns {Array<{ lineId: string, amount: number }>}
 */
export const allocate = (total, lines) => {
	const weights = lines.map((line) => Math.max(0, line.remaining));
	const sum = weights.reduce((a, b) => a + b, 0);
	const amount = Math.min(Math.max(0, Math.floor(total)), sum);
	if (amount === 0 || sum === 0) return [];
	const exact = weights.map((weight) => (amount * weight) / sum);
	const shares = exact.map((value) => Math.floor(value));
	let left = amount - shares.reduce((a, b) => a + b, 0);
	const order = exact
		.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
		.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
	for (const { index } of order) {
		if (left <= 0) break;
		if ((shares[index] ?? 0) < (weights[index] ?? 0)) {
			shares[index] = (shares[index] ?? 0) + 1;
			left -= 1;
		}
	}
	return lines.map((line, index) => ({ lineId: line.lineId, amount: shares[index] ?? 0 })).filter((share) => share.amount > 0);
};

/**
 * @param {Array<{ lineId: string, amount: number }>} lines
 * @param {Partial<ActionResult>} [extra]
 * @returns {ActionResult}
 */
const result = (lines, extra = {}) => ({
	discount: lines.reduce((sum, line) => sum + line.amount, 0),
	lines,
	shippingDiscount: extra.shippingDiscount ?? 0,
	freeShipping: extra.freeShipping ?? false,
	gifts: extra.gifts ?? [],
});

/** @param {readonly WorkLine[]} lines */
const remainingOf = (lines) => lines.reduce((sum, line) => sum + Math.max(0, line.remaining), 0);

/**
 * A percentage of the base lines' remaining amounts, optionally capped.
 * @param {number} percent
 * @param {readonly WorkLine[]} base
 * @param {number} cap 0 = none
 * @param {ActionBounds} bounds
 */
const percentOf = (percent, base, cap, bounds) => {
	let total = roundMinor(remainingOf(base) * percentFraction(percent, bounds.maxPercent), bounds.rounding);
	if (cap > 0) total = Math.min(total, cap);
	return allocate(total, base);
};

/**
 * A fixed amount once over the base lines (capped at what remains and at `maxFixedAmount`).
 * @param {number} amount
 * @param {readonly WorkLine[]} base
 * @param {ActionBounds} bounds
 */
const fixedOnce = (amount, base, bounds) => {
	const bounded = bounds.maxFixedAmount > 0 ? Math.min(amount, bounds.maxFixedAmount) : amount;
	return allocate(Math.max(0, Math.floor(bounded)), base);
};

/**
 * Buy X get Y: among the selected units (highest price first), every group of `buy + get` units gives `get` units at
 * `percent` off; the discounted units are the cheapest ones, so the customer always pays for the most valuable items.
 * @param {Record<string, any>} action
 * @param {readonly WorkLine[]} base
 * @param {ActionBounds} bounds
 */
const bxgy = (action, base, bounds) => {
	const buy = Math.max(1, Math.floor(action.buy ?? 1));
	const get = Math.max(1, Math.floor(action.get ?? 1));
	const fraction = percentFraction(action.percent ?? MAX_PERCENT, bounds.maxPercent);
	/** @type {Array<{ lineId: string, price: number }>} */
	const units = [];
	for (const line of base)
		for (let i = 0; i < line.quantity; i += 1) units.push({ lineId: line.lineId, price: line.unitAmount });
	units.sort((a, b) => b.price - a.price);
	let groups = Math.floor(units.length / (buy + get));
	const max = Math.floor(action.max_applications ?? 0);
	if (max > 0) groups = Math.min(groups, max);
	const free = units.slice(units.length - groups * get);
	/** @type {Map<string, number>} */
	const perLine = new Map();
	for (const unit of free) perLine.set(unit.lineId, (perLine.get(unit.lineId) ?? 0) + unit.price);
	const lines = base
		.map((line) => ({
			lineId: line.lineId,
			amount: Math.min(Math.max(0, line.remaining), roundMinor((perLine.get(line.lineId) ?? 0) * fraction, bounds.rounding)),
		}))
		.filter((line) => line.amount > 0);
	return lines;
};

/**
 * The tier that applies: the highest `min` reached by the basis (units or remaining amount of the base lines).
 * @param {Record<string, any>} action
 * @param {readonly WorkLine[]} base
 * @returns {Record<string, any> | null}
 */
export const tierFor = (action, base) => {
	const basis = action.basis === 'quantity' ? base.reduce((sum, line) => sum + line.quantity, 0) : remainingOf(base);
	const tiers = (Array.isArray(action.tiers) ? action.tiers : [])
		.filter((tier) => typeof tier?.min === 'number')
		.sort((a, b) => a.min - b.min);
	let chosen = null;
	for (const tier of tiers) if (basis >= tier.min) chosen = tier;
	return chosen;
};

/**
 * Compute an action on the current state of the cart.
 * @param {Record<string, any>} action validated action `{ type, … }`
 * @param {{ lines: readonly WorkLine[], matched: ReadonlySet<string>, shipping: number, bounds: ActionBounds }} input
 *   `matched` = line ids selected by the coupon's conditions; `shipping` = shipping still payable
 * @returns {ActionResult}
 */
export const computeAction = (action, { lines, matched, shipping, bounds }) => {
	const selected = lines.filter((line) => matched.has(line.lineId));
	const base = action.target === 'order' ? [...lines] : selected;
	switch (action.type) {
		case 'percent':
			return result(percentOf(action.percent, base, Math.floor(action.max_discount ?? 0), bounds));
		case 'fixed': {
			if (action.per_unit === true && action.target !== 'order') {
				const amount = bounds.maxFixedAmount > 0 ? Math.min(action.amount, bounds.maxFixedAmount) : action.amount;
				return result(
					selected
						.map((line) => ({ lineId: line.lineId, amount: Math.min(Math.max(0, line.remaining), amount * line.quantity) }))
						.filter((line) => line.amount > 0),
				);
			}
			return result(fixedOnce(action.amount, base, bounds));
		}
		case 'free_shipping': {
			const cap = Math.floor(action.max_amount ?? 0);
			const shippingDiscount = Math.max(0, cap > 0 ? Math.min(shipping, cap) : shipping);
			return result([], { shippingDiscount, freeShipping: true });
		}
		case 'bxgy':
			return result(bxgy(action, selected, bounds));
		case 'tiered': {
			const tier = tierFor(action, base);
			if (!tier) return result([]);
			if (typeof tier.percent === 'number') return result(percentOf(tier.percent, base, 0, bounds));
			return result(fixedOnce(Math.floor(tier.amount ?? 0), base, bounds));
		}
		case 'gift': {
			const quantity = Math.max(1, Math.floor(action.quantity ?? 1));
			const gift = { itemId: String(action.item_id), variantId: action.variant_id ?? null, quantity };
			if (action.discount_in_cart === false) return result([], { gifts: [gift] });
			let left = quantity;
			/** @type {Array<{ lineId: string, amount: number }>} */
			const shares = [];
			for (const line of lines) {
				if (left <= 0) break;
				if (line.itemId !== gift.itemId || (gift.variantId !== null && line.variantId !== gift.variantId)) continue;
				const units = Math.min(left, line.quantity);
				const amount = Math.min(Math.max(0, line.remaining), units * line.unitAmount);
				left -= units;
				if (amount > 0) shares.push({ lineId: line.lineId, amount });
			}
			return result(shares, { gifts: [gift] });
		}
		default:
			return result([]);
	}
};

/**
 * True when an action reads money (needs the coupon currency to equal the cart currency).
 * @param {Record<string, any>} action
 */
export const actionUsesMoney = (action) =>
	action.type === 'fixed' ||
	(action.type === 'percent' && (action.max_discount ?? 0) > 0) ||
	(action.type === 'free_shipping' && (action.max_amount ?? 0) > 0) ||
	(action.type === 'tiered' &&
		(action.basis !== 'quantity' ||
			(Array.isArray(action.tiers) && action.tiers.some((/** @type {any} */ tier) => typeof tier?.amount === 'number'))));

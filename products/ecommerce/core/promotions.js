/**
 * Promotions pricing (PLAN 0.8.8): which deals, bundles and coupon apply to a cart and how much each takes off each
 * line. Checkout calls `applyPromotions` when it prices a cart and again when it places the order (the ledger then
 * counts the uses in the order transaction); the Chat lookups and the product page quote one product with
 * `quoteProduct`. The order, from the parked deals product and ibrahimMobiles:
 * 1. deals: each line takes its single best live deal, per unit (`core/deals.js`);
 * 2. bundles: sets form on the cart's units; a unit a bundle discounts takes no deal, and a set forms only when it saves
 *    more than those deals (`core/bundles.js`);
 * 3. the coupon, on what is left of the lines in its scope (`core/coupons.js`); its minimum subtotal is measured after
 *    deals and bundles.
 * Every amount is integer minor units; no line ever goes below 0. No I/O.
 * @module
 */
import { formBundles } from './bundles.js';
import { couponBlocked, couponDiscount, couponProblem, normaliseCode } from './coupons.js';
import { bestDeal } from './deals.js';

/**
 * A cart line as promotions see it.
 * @typedef {object} PricingLine
 * @property {string} key unique per cart (`<productId>|<variantId>`, plus `|<slot start>` for bookings)
 * @property {string} productId
 * @property {string} variantId
 * @property {string[]} categoryIds the product's categories and all their ancestors
 * @property {string | null} brandId
 * @property {number} unitPrice minor units
 * @property {number} quantity
 */

/**
 * What promotions take off.
 * @typedef {object} PromotionsResult
 * @property {Array<{ key: string, dealId: string | null, dealDiscount: number, bundleDiscount: number, couponDiscount: number }>} lines
 *   one per input line, in the same order; discounts in minor units, never more than the line
 * @property {string[]} dealIds deals that took something off
 * @property {string[]} bundleIds bundles that took something off
 * @property {string | null} couponId the coupon, when it applies
 * @property {string} couponCode the code entered, trimmed and upper case ('' = none)
 * @property {boolean} freeDelivery a free-delivery coupon applies
 * @property {{ code: string, message: string } | null} couponProblem why the code given does not apply
 * @property {Array<{ id: string, name: string, kind: 'deal' | 'bundle' | 'coupon', amount: number }>} applied for receipts
 *   (deals and bundles by name, the coupon by its code; a free-delivery coupon has amount 0: checkout knows the fee)
 */

/**
 * @param {object} input
 * @param {PricingLine[]} input.lines
 * @param {import('./model.js').DealRecord[]} input.deals active deals (switched off: [])
 * @param {import('./model.js').BundleRecord[]} input.bundles active bundles (switched off: [])
 * @param {import('./model.js').CouponRecord | null} input.coupon the coupon of the code entered (null: none or unknown)
 * @param {string} input.couponCode the code as entered ('' = none)
 * @param {{ orderCount: number, couponUses: number }} input.customer the shopper's past orders and uses of this coupon
 * @param {number} input.now epoch ms
 * @returns {PromotionsResult}
 */
export const applyPromotions = ({ lines, deals, bundles, coupon, couponCode, customer, now }) => {
	const best = lines.map((line) => (line.quantity > 0 && line.unitPrice > 0 ? bestDeal(line, deals, now) : null));
	const formed = formBundles(
		bundles,
		lines.map((line, index) => ({
			productId: line.productId,
			categoryIds: line.categoryIds,
			brandId: line.brandId,
			unitPrice: Math.max(0, line.unitPrice),
			quantity: Math.max(0, line.quantity),
			dealUnit: best[index]?.perUnit ?? 0,
		})),
		now,
	);
	const priced = lines.map((line, index) => {
		const found = best[index] ?? null;
		const { bundleDiscount, bundleUnits } = /** @type {{ bundleDiscount: number, bundleUnits: number }} */ (
			formed.lines[index]
		);
		const dealDiscount = found ? found.perUnit * Math.max(0, line.quantity - bundleUnits) : 0;
		return {
			key: line.key,
			dealId: dealDiscount > 0 && found ? found.deal.id : null,
			dealDiscount,
			bundleDiscount,
			couponDiscount: 0,
		};
	});

	/** @type {PromotionsResult['applied']} */
	const applied = [];
	/** @type {string[]} */
	const dealIds = [];
	for (const [index, line] of priced.entries()) {
		if (!line.dealId) continue;
		const deal = /** @type {{ deal: import('./model.js').DealRecord }} */ (best[index]).deal;
		const entry = applied.find((item) => item.kind === 'deal' && item.id === deal.id);
		if (entry) entry.amount += line.dealDiscount;
		else {
			dealIds.push(deal.id);
			applied.push({ id: deal.id, name: deal.name, kind: 'deal', amount: line.dealDiscount });
		}
	}
	const bundleIds = [...formed.savings.keys()];
	for (const [id, amount] of formed.savings) {
		const bundle = /** @type {import('./model.js').BundleRecord} */ (bundles.find((item) => item.id === id));
		applied.push({ id, name: bundle.name, kind: 'bundle', amount });
	}

	const code = normaliseCode(couponCode);
	/** @type {PromotionsResult} */
	const result = {
		lines: priced,
		dealIds,
		bundleIds,
		couponId: null,
		couponCode: code,
		freeDelivery: false,
		couponProblem: null,
		applied,
	};
	if (code === '') return result;
	const blocked = couponBlocked(coupon, { code, now, customer });
	if (blocked || !coupon) return { ...result, couponProblem: couponProblem(blocked ?? 'coupon_unknown') };
	const discount = couponDiscount(
		coupon,
		lines.map((line, index) => {
			const { dealDiscount, bundleDiscount } = /** @type {(typeof priced)[number]} */ (priced[index]);
			return {
				productId: line.productId,
				categoryIds: line.categoryIds,
				brandId: line.brandId,
				remaining: Math.max(0, line.unitPrice * line.quantity - dealDiscount - bundleDiscount),
			};
		}),
	);
	if (!discount.ok) return { ...result, couponProblem: couponProblem(discount.code) };
	const amount = discount.amounts.reduce((sum, value) => sum + value, 0);
	return {
		...result,
		lines: priced.map((line, index) => ({ ...line, couponDiscount: discount.amounts[index] ?? 0 })),
		couponId: coupon.id,
		freeDelivery: discount.freeDelivery,
		applied: [...applied, { id: coupon.id, name: coupon.code, kind: 'coupon', amount }],
	};
};

/**
 * What one product costs after deals: its lowest active variant (or the variant asked for), with the best live deal.
 * Used by the product page quote and the Chat lookups.
 * @param {object} input
 * @param {import('./model.js').ProductRecord} input.product
 * @param {string | null} [input.variantId] a variant of the product ('' or null: the lowest-priced active one)
 * @param {import('./model.js').DealRecord[]} input.deals live deals (switched off: [])
 * @param {number} input.now epoch ms
 * @param {string[]} [input.categoryIds] the product's categories with their ancestors (default: the product's own)
 * @param {string} [input.currency] the shop's currency
 * @returns {{ productId: string, variantId: string, price: number, priceAfterDeals: number, savings: number, currency: string,
 *   deals: Array<{ id: string, name: string }> } | null} null when the product has no such active variant
 */
export const quoteProduct = ({ product, variantId = null, deals, now, categoryIds, currency = '' }) => {
	const active = product.variants.filter((variant) => variant.active);
	const variant = variantId
		? active.find((item) => item.id === variantId)
		: active.reduce(
				(/** @type {import('./model.js').VariantRecord | undefined} */ low, item) =>
					!low || item.price < low.price ? item : low,
				undefined,
			);
	if (!variant) return null;
	const found = bestDeal(
		{
			productId: product.id,
			categoryIds: categoryIds ?? product.categoryIds,
			brandId: product.brandId,
			unitPrice: variant.price,
		},
		deals,
		now,
	);
	const savings = found?.perUnit ?? 0;
	return {
		productId: product.id,
		variantId: variant.id,
		price: variant.price,
		priceAfterDeals: variant.price - savings,
		savings,
		currency,
		deals: found ? [{ id: found.deal.id, name: found.deal.name }] : [],
	};
};

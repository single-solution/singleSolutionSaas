/**
 * Promotions pricing (owner: promotions; stub until built): which deals, bundles and coupon apply to a cart and how
 * much each takes off each line. Checkout calls `applyPromotions` when it prices a cart and again when it places the
 * order (the ledger then counts the uses in the order transaction). No I/O.
 * @module
 */

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
 * @property {string} couponCode
 * @property {boolean} freeDelivery a free-delivery coupon applies
 * @property {{ code: string, message: string } | null} couponProblem why the code given does not apply
 * @property {Array<{ id: string, name: string, kind: 'deal' | 'bundle' | 'coupon', amount: number }>} applied for receipts
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
export const applyPromotions = ({ lines, couponCode }) => ({
	lines: lines.map((line) => ({ key: line.key, dealId: null, dealDiscount: 0, bundleDiscount: 0, couponDiscount: 0 })),
	dealIds: [],
	bundleIds: [],
	couponId: null,
	couponCode,
	freeDelivery: false,
	couponProblem: couponCode ? { code: 'coupon_unknown', message: 'This code is not valid.' } : null,
	applied: [],
});

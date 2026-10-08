/**
 * The promotions part's queries in the merchant database (owner: promotions; stub until built).
 * @module
 */

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** Merchant database indexes of this part. @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [];

/**
 * The offers that may apply now: active deals and bundles within their dates, and the coupon of a code (null when the
 * code is empty or unknown; an inactive or expired coupon is returned so pricing can say why it does not apply).
 * Checkout prices carts with them, and the Chat lookups quote savings with them.
 * @param {WebsiteData} data
 * @param {{ now: number, couponCode?: string, deals?: boolean, bundles?: boolean }} options `deals` / `bundles`: whether
 *   those features are on (off: none are loaded)
 * @returns {Promise<{ deals: import('../core/model.js').DealRecord[], bundles: import('../core/model.js').BundleRecord[],
 *   coupon: import('../core/model.js').CouponRecord | null }>}
 */
export const loadOffers = async (data, options) =>
	data && options ? { deals: [], bundles: [], coupon: null } : { deals: [], bundles: [], coupon: null };

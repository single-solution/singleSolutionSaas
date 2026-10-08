/**
 * Promotions: coupons, deals, bundles and loyalty points for the merchant and the shopper (owner: promotions; stub until built).
 * @module
 */

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createPromotions = (product, service) => (product && service ? { routes: [] } : { routes: [] });

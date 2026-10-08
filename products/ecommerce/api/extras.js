/**
 * Returns and warranty claims, reviews, wishlist, alerts, compare and reports (owner: extras; stub until built).
 * @module
 */

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createExtras = (product, service) => (product && service ? { routes: [] } : { routes: [] });

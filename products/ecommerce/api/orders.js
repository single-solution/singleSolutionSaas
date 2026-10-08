/**
 * Orders for the merchant: the order list, status moves in the merchant's flow, serials, couriers and courier APIs, invoices and packing slips, customers and the blocklist, waiting orders that end (owner: checkout; stub until built).
 * @module
 */

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createOrders = (product, service) => (product && service ? { routes: [] } : { routes: [] });

/**
 * The cart and checkout: pricing a cart, delivery, taxes, COD safety, placing orders, paying through Payments, the shopper's orders, digital goods and bookings (owner: checkout; stub until built).
 * @module
 */

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createCheckout = (product, service) => (product && service ? { routes: [] } : { routes: [] });

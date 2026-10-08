/**
 * The catalog: products, variants, categories, brands, attributes, locations and stock, grades and serials, media, search, listings and filters, the product page, compare data, CSV, bulk actions and AI copy (owner: catalog; stub until built).
 * @module
 */

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createCatalog = (product, service) => (product && service ? { routes: [] } : { routes: [] });

/**
 * Catalog SEO (meta, structured data, sitemaps), feeds, llms.txt, the Chat lookups and the customer orders lookup (owner: seo; stub until built).
 * @module
 */

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createSeo = (product, service) => (product && service ? { routes: [] } : { routes: [] });

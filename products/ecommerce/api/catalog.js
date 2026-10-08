/**
 * The catalog (PLAN 0.8.8 Catalog, Items, Admin tools, Catalog SEO): products with variants, categories, brands,
 * attributes, stock locations and stock, grades and serials, images in the merchant's storage, search, listings and
 * filters, the product page, CSV, bulk actions and AI copy. The routes live in `catalog-*.js`; this joins them and
 * gives the visitor widgets their settings. The catalog holds no personal data (no data-rights answers).
 * @module
 */
import { createCatalogCommon } from './catalog-common.js';
import { createCatalogFiles } from './catalog-files.js';
import { createCatalogProducts } from './catalog-products.js';
import { createCatalogShop } from './catalog-shop.js';
import { createCatalogTaxonomy } from './catalog-taxonomy.js';
import { createCatalogTools } from './catalog-tools.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createCatalog = (product, service) => {
	const common = createCatalogCommon(product, service);
	return {
		routes: [
			...createCatalogShop(product, service, common),
			...createCatalogProducts(product, service, common),
			...createCatalogFiles(product, service, common),
			...createCatalogTaxonomy(product, service, common),
			...createCatalogTools(product, service, common),
		],
		/**
		 * What the product grid and page need: where product and category pages are, and the page size.
		 * @param {Site} s
		 */
		widgetSettings: async (s) => {
			const { productUrl, categoryUrl, pageSize } = await s.values('catalog');
			return { catalog: { productUrl, categoryUrl, pageSize } };
		},
	};
};

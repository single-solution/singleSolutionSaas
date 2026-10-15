/**
 * The catalog (PLAN 0.8.8 Catalog, Items, Admin tools, Catalog SEO): products with variants, categories, brands,
 * attributes, stock locations and stock, grades and serials, images and videos in the merchant's storage, size charts,
 * search (basic or Atlas Search), listings and filters, the product page, CSV, bulk actions and AI copy. The routes live in `catalog-*.js`; this joins them and
 * gives the visitor widgets their settings. The catalog holds no personal data (no data-rights answers).
 * @module
 */
import { createCatalogCharts } from './catalog-charts.js';
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
			...createCatalogCharts(product, service, common),
			...createCatalogTools(product, service, common),
		],
		/**
		 * What the product grid and page need: where product and category pages are, the page size and what shoppers
		 * are told of stock (E9); and the merchant's item types, by which the catalog admin's editors show their type
		 * pickers and sections (dynamic model §1), and the units packages are typed in (E13).
		 * @param {Site} s
		 */
		widgetSettings: async (s) => {
			const { productUrl, categoryUrl, variantQuery, pageSize, showStock, lowStockShown, weightUnit, sizeUnit } =
				await s.values('catalog');
			const types = await s.list('item_types');
			return {
				catalog: {
					productUrl,
					categoryUrl,
					variantQuery,
					pageSize,
					showStock,
					lowStockShown,
					types,
					// the units staff type and read package weights and sizes in (E13)
					weightUnit,
					sizeUnit,
					// the merchant's unit states (E38)
					unitStates: s.has('grades_serials') ? await s.list('unit_states') : [],
				},
			};
		},
	};
};
